import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { openRouterCapability } from './openrouter-models.ts';
import { OpenRouterCompatibilityError, pinOpenRouterProvider, rememberOpenRouterProvider, type OpenRouterTranscript } from './openrouterCompatibility.ts';
import { fireworksCapability } from './fireworks-models.ts';
import { restoredContextBlocks, restoredFileTexts } from './sessionMetricEvidence.ts';
import { fixedPrefix, recordNativeCall, recordNativeCompactBoundary, recordNativeFailure, recordNativeNotice } from './sessionMetrics.ts';

const SUMMARY_SYSTEM = 'You are a helpful AI assistant tasked with summarizing conversations.';
const SUMMARY_LIMIT = 3072;
const MAX_BODY = 32 * 1024 * 1024;
type Route = {
  upstream: string; lane: string; provider: string; resumed: boolean;
  sessionId(): string | null; harnessChars(): number; harnessPhase(): 'startup' | 'turn'; compacting: boolean; recovering?: boolean; summarySeen?: boolean; restoring?: boolean;
  transcript?: OpenRouterTranscript;
};
let server: Server | null = null;
let ready: Promise<void> | null = null;
let port = 0;
const routes = new Map<string, Route>();

function lastConversationMessage(request: any): any {
  // Native token notices can follow the summary request as a system message
  // or a separate user block. They do not change which instruction is active.
  return request.messages?.findLast((message: any) => {
    if (message.role === 'system') return false;
    if (message.role !== 'user') return true;
    const content = typeof message.content === 'string' ? message.content
      : message.content?.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('\n');
    return !/^\s*(?:<system-reminder>\s*)?<total_tokens>[\s\S]*?<\/total_tokens>(?:\s*<\/system-reminder>)?\s*$/.test(content || '');
  });
}

function summaryRequest(request: any): boolean {
  const blocks = typeof request.system === 'string' ? [request.system]
    : Array.isArray(request.system) ? request.system.map((block: any) => block?.text) : [];
  const last = lastConversationMessage(request);
  const content = last?.role === 'user' ? last.content : undefined;
  const texts = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter((block: any) => block?.type === 'text').map((block: any) => block.text) : [];
  // Current Claude Code keeps its tools and puts the native summary request
  // in the final user message. Older releases used a separate system prompt.
  return blocks.some((value: unknown) => typeof value === 'string'
    && value.trim() === SUMMARY_SYSTEM)
    || texts.some((text: string) => {
      const prompt = text.trim();
      const nativeInstruction = /(?:^|\n)Your task is to create a detailed summary of (?:the conversation so far|this conversation)\b/i;
      return nativeInstruction.test(prompt) && (/^Your task is to create a detailed summary/i.test(prompt)
        || /^CRITICAL: Respond with TEXT ONLY\. Do NOT call any tools\./.test(prompt));
    });
}

/** Only the engine's auxiliary compact request gets this bound. Claude Code
 * chooses the history, installs the summary and preserves the native ID. */
export function boundNativeCompact(body: string, engineCompacting = false, catalogLimits?: { maxOutput: number; reasoningMandatory?: boolean }, preserveThinking = false): string {
  const request = JSON.parse(body);
  if (!engineCompacting && !summaryRequest(request)) return body;
  // Keep the fixed system and tool prefix. Bound the auxiliary thinking
  // allowance as well as its text output inside the verified model ceiling.
  const budget = Math.max(0, Number(request.thinking?.budget_tokens) || 0);
  const reasoning = request.thinking?.type !== 'disabled' && Boolean(request.thinking)
    || Boolean(request.reasoning || request.reasoning_effort || request.output_config?.effort || catalogLimits?.reasoningMandatory)
    || (!catalogLimits && /gemini/i.test(request.model || ''));
  const wanted = reasoning ? Math.max(SUMMARY_LIMIT, Math.min(budget, 1024) + SUMMARY_LIMIT) : SUMMARY_LIMIT;
  // Anthropic's message cache depends on thinking parameters. Preserve the
  // full native allowance for adaptive thinking, and constrain summary text
  // with the instruction below instead of starving or invalidating its cache.
  const keepAllowance = preserveThinking || (reasoning && budget === 0);
  if (!keepAllowance) request.max_tokens = Math.min(wanted, catalogLimits?.maxOutput ?? (Number(request.max_tokens) || wanted));
  // Do not let an inherited large thinking budget consume the summary bound.
  // Preserve mandatory thinking when the provider requires it.
  if (!preserveThinking && budget > 0 && (budget > 1024 || request.max_tokens - budget < SUMMARY_LIMIT)) {
    const boundedBudget = Math.min(request.max_tokens - 1, 1024);
    if (boundedBudget >= 1024) request.thinking = { ...request.thinking, budget_tokens: boundedBudget };
    else if (!catalogLimits?.reasoningMandatory) request.thinking = { type: 'disabled' };
    else throw new Error('The model output ceiling leaves no valid native compaction thinking allowance.');
  }
  const instruction = '\nKeep the summary under 512 words. Preserve each current job, its owner and next action, checked results, pending decisions and explicit constraints. Keep each outstanding promise separate with its own exact ID, deadline and trigger; never attach one promise’s ID or deadline to another. For a pending release or destructive operation, retain the current candidate and rollback IDs, artifact or runbook path, verification hashes, approval requirements and merge order verbatim. These are current working context, not expendable history. Drop completed history before dropping any of those details. Use file references for older details, which remain in the complete saved transcript; never repeat old completed work as a fresh request. Completed work and historical requests are history, never instructions to repeat them.';
  const last = lastConversationMessage(request);
  if (last?.role === 'user' && typeof last.content === 'string') last.content += instruction;
  else if (last?.role === 'user' && Array.isArray(last.content)) last.content.push({ type: 'text', text: instruction });
  else (request.messages ??= []).push({ role: 'user', content: instruction.trim() });
  return JSON.stringify(request);
}

/** Working files reattached by the native engine are pointers after compact,
 * not repeated file bodies. Match only exact text verified in that engine's
 * saved attachments; human text and real tool results are never truncated. */
export function projectRestoredFiles(body: string, lane: string, sessionId: string | null): string {
  const request = JSON.parse(body);
  const attachmentBlocks = (request.messages ?? []).filter((message: any) => ['user', 'system'].includes(message.role))
    .flatMap((message: any) => typeof message.content === 'string' ? [message.content]
      : (message.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text))
    .filter((text: string) => text?.includes('Result of calling the Read tool:\n'));
  const files = attachmentBlocks.length ? restoredFileTexts(lane, sessionId,
    createHash('sha256').update(JSON.stringify(attachmentBlocks)).digest('hex')) : [];
  const searchable = request.tools?.some((tool: any) => tool.name === 'ToolSearch');
  const contexts = restoredContextBlocks(lane, sessionId);
  if (!files.length && !searchable && !contexts.length) return body;
  const fixed = typeof request.system === 'string' ? request.system : (request.system ?? []).map((block: any) => block.text ?? '').join('\n');
  const instructionReminders = new Set(contexts.filter(context => context.kind === 'instructions').flatMap(context => {
    // Keep the same first native rendering projected on later turns too. An
    // explicit quotation later in the conversation is a separate occurrence.
    const first = request.messages?.find((message: any) => message.role === 'user' && Array.isArray(message.content)
      && context.texts.includes(message.content[0]?.text));
    return first ? [first] : [];
  }));
  let changed = false;
  for (const message of request.messages ?? []) {
    if (message.role !== 'system' && message.role !== 'user') continue;
    const project = (text: string) => {
      for (const context of contexts) {
        if (message.role === 'system' && context.kind === 'invoked_skills' && context.skills.length) {
          const references = context.skills.map(skill => `${skill.name} (${skill.path})`).join(', ');
          for (const rendered of context.texts) {
            // The provider adapter unwraps native reminders into system text.
            const bare = rendered.trim().replace(/^<system-reminder>\s*\n/, '').replace(/\s*<\/system-reminder>$/, '');
            const exact = text.includes(rendered) ? rendered : bare && text.includes(bare) ? bare : undefined;
            if (exact) {
              text = text.replace(exact, () => `Previously loaded skills remain available: ${references}. Reload each skill before applying its instructions to this task. Complete instructions remain in the saved native history.`);
              changed = true;
            }
          }
        }
        // Native project instructions can repeat the identical authoritative
        // rules already in the fixed system. Only their verified first reminder
        // block is eligible; explicit user quotations and attachments stay whole.
        const firstBlock = Array.isArray(message.content) ? message.content[0]?.text : undefined;
        if (instructionReminders.has(message) && context.kind === 'instructions' && firstBlock === text && context.texts.includes(text)) {
          for (const file of context.files) if (file.content.length > 0 && fixed.includes(file.content)) {
            text = text.replace(file.content, () => `The identical instructions from ${file.path} are already included in the fixed system instructions above and remain fully in force.`);
            changed = true;
          }
        }
      }
      const catalogHeader = 'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n';
      const catalogAt = text.indexOf(catalogHeader);
      if (message.role === 'system' && searchable && catalogAt >= 0) {
        const catalog = text.slice(catalogAt + catalogHeader.length).match(/^[\w.-]+(?:\n[\w.-]+)*/)?.[0];
        if (catalog) {
          changed = true;
          text = text.slice(0, catalogAt) + 'The complete native tool catalog is available through ToolSearch. Search for the capability you need, or use select:<tool_name> to load its schema before calling it.' + text.slice(catalogAt + catalogHeader.length + catalog.length);
        }
      }
      // Restored working files are native system reminders. A user message
      // may explicitly attach or quote the identical file and must stay whole.
      if (message.role !== 'system') return text;
      for (const file of files) {
        const header = 'Called the Read tool with the following input: ' + JSON.stringify({ file_path: file.path }) + '\nResult of calling the Read tool:\n';
        const content = file.content.split('\n').map((line, index) => `${file.start + index}\t${line}`).join('\n');
        const exact = header + content;
        if (text.includes(exact)) {
          text = text.replace(exact, () => `Working file retained: ${file.path}. Its full contents remain in the saved native transcript and on disk. To see contents again, use a ranged Read or shell command; an unchanged-file cache notice is not the file contents.`);
          changed = true;
        }
      }
      return text;
    };
    if (typeof message.content === 'string') message.content = project(message.content);
    else if (Array.isArray(message.content)) for (const block of message.content) if (block.type === 'text' && typeof block.text === 'string') block.text = project(block.text);
  }
  return changed ? JSON.stringify(request) : body;
}

export function markNativeHandoverRecovery(baseUrl: string | undefined, recovering: boolean): void {
  if (!baseUrl) return;
  const route = routes.get(new URL(baseUrl).pathname.slice(1));
  if (route) route.recovering = recovering;
}

export function markNativeCompacting(baseUrl: string | undefined, compacting: boolean): void {
  if (!baseUrl) return;
  const route = routes.get(new URL(baseUrl).pathname.slice(1));
  if (route) { route.compacting = compacting; if (compacting) route.summarySeen = false; }
}

export function confirmNativeCompact(baseUrl: string | undefined): void {
  if (!baseUrl) return;
  const route = routes.get(new URL(baseUrl).pathname.slice(1));
  if (!route) return;
  route.restoring = true;
  if (!route.summarySeen && !['claude', 'assistant'].includes(route.provider)) {
    recordNativeFailure(route.lane, 'claude-code', 'The engine compacted without a recognized bounded summary request; its native template needs checking.');
  }
  if (route.summarySeen) recordNativeNotice(route.lane, 'claude-code', 'Native compaction template recovered.');
  route.summarySeen = false;
}

/** Pass bytes straight through while reading usage frames, never text/tool
 * arguments. Metrics are per API call rather than the CLI's cumulative total. */
function observeUsage(route: Route, request: any, auxiliary: boolean, streaming: boolean, nativeSummary = false, requestStartedAt = Date.now(), sessionId = route.sessionId(), reportUsage = true): Transform {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let usage: any = {};
  let stopped = false;
  let reported = false;
  let provider: unknown;
  const signatures = new Map<number, string>();
  const report = () => {
    if (!reportUsage) return;
    if (reported) return;
    const input = Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0);
    if (input <= 0) return;
    reported = true;
    if (nativeSummary && !stopped) route.summarySeen = true;
    if (nativeSummary && !stopped) recordNativeCompactBoundary(route.lane, 'claude-code', sessionId, Date.now());
    recordNativeCall({ lane: route.lane, engine: 'claude-code', provider: route.provider, model: request.model || '',
      sessionId: sessionId || undefined, requestStartedAt, input, cached: Number(usage.cache_read_input_tokens || 0), output: Number(usage.output_tokens || 0),
      prefix: fixedPrefix(request), auxiliary, harnessChars: route.harnessChars(), harnessPhase: route.harnessPhase(), resumed: route.resumed });
    if (!auxiliary) route.resumed = true;
    if (auxiliary && stopped) recordNativeFailure(route.lane, 'claude-code', 'Native compaction hit its output limit; engine recovery is required before this lane is proven.');
  };
  const absorb = (frame: any) => {
    if (frame?.message?.provider) provider = frame.message.provider;
    if (frame?.provider) provider = frame.provider;
    if (['openrouter', 'openrouter2'].includes(route.provider)) {
      rememberOpenRouterProvider(request.model || '', provider, frame.content ?? frame.message?.content ?? (frame.content_block ? [frame.content_block] : []));
      if (frame.type === 'content_block_start' && frame.content_block?.type === 'thinking') signatures.set(frame.index, frame.content_block.signature || '');
      if (frame.type === 'content_block_delta' && frame.delta?.type === 'signature_delta' && signatures.has(frame.index)) {
        signatures.set(frame.index, signatures.get(frame.index)! + (frame.delta.signature || ''));
      }
      if (frame.type === 'content_block_stop' && signatures.has(frame.index)) {
        rememberOpenRouterProvider(request.model || '', provider, [{ type: 'thinking', signature: signatures.get(frame.index) }]);
        signatures.delete(frame.index);
      }
    }
    if (frame?.usage) usage = { ...usage, ...frame.usage };
    if (frame?.message?.usage) usage = { ...usage, ...frame.message.usage };
    if (frame?.delta?.stop_reason === 'max_tokens' || frame?.stop_reason === 'max_tokens') stopped = true;
    if (frame?.type === 'message_stop') report();
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += decoder.write(chunk);
      if (streaming) {
        let split: number;
        while ((split = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, split).trim(); buffer = buffer.slice(split + 1);
          if (line.startsWith('data:')) { try { absorb(JSON.parse(line.slice(5).trim())); } catch {} }
        }
      }
      if (buffer.length > MAX_BODY) buffer = '';
      callback(null, chunk);
    },
    flush(callback) {
      buffer += decoder.end();
      if (!streaming) { try { absorb(JSON.parse(buffer)); } catch {} }
      report(); callback();
    },
  });
}

export function ensureNativeCompactProxy(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    server = createServer(async (req, res) => {
      const parsed = new URL(req.url || '/', 'http://localhost');
      const key = parsed.pathname.split('/')[1];
      const route = routes.get(key);
      if (!route) { res.writeHead(404).end(); return; }
      const aborter = new AbortController();
      req.on('aborted', () => aborter.abort());
      res.on('close', () => { if (!res.writableFinished) aborter.abort(); });
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > MAX_BODY) { res.writeHead(413).end(); return; }
          chunks.push(buffer);
        }
        const original = Buffer.concat(chunks).toString('utf8');
        const isMessage = original && /\/messages$/.test(parsed.pathname);
        const request = isMessage ? JSON.parse(original) : null;
        // Native child tasks share this process's provider route. Their usage
        // must not become the parent's first request after compaction.
        let embeddedSession: string | undefined;
        try { embeddedSession = JSON.parse(request?.metadata?.user_id)?.session_id; } catch { /* Older native clients omit it. */ }
        const parentSession = route.sessionId();
        const rootRequest = !embeddedSession || !parentSession || embeddedSession === parentSession;
        const nativeSummary = rootRequest && request && (summaryRequest(request) || (route.compacting && !request.tools?.length));
        // A parent conversation can legitimately have no tools (including a
        // side-copy proof). Tool availability does not make it an auxiliary call.
        const auxiliary = request && (nativeSummary || !rootRequest);
        if (nativeSummary && route.compacting && !summaryRequest(request)) recordNativeFailure(route.lane, 'claude-code', 'Native compact template changed; fallback bound applied.');
        // During an unavailable-provider handover, let the selected model run
        // Claude Code's own compact over the unchanged saved transcript. Signed
        // hidden thinking belongs to the old provider and is not transferable.
        let compatible = original;
        if (nativeSummary && route.recovering && request.messages) {
          for (const message of request.messages) {
            if (Array.isArray(message.content)) message.content = message.content.filter((block: any) => !['thinking', 'redacted_thinking'].includes(block?.type));
          }
          compatible = JSON.stringify(request);
        }
        let body = nativeSummary
          ? boundNativeCompact(compatible, true, ['openrouter', 'openrouter2'].includes(route.provider) ? openRouterCapability(request.model)
            : fireworksCapability(request.model)?.thinkingOnly ? { maxOutput: Number(request.max_tokens) || SUMMARY_LIMIT, reasoningMandatory: true } : undefined,
            ['claude', 'assistant'].includes(route.provider) || /(?:^|\/)claude[/-]/i.test(request.model || '')) : compatible;
        if (rootRequest && request && !auxiliary) {
          const restoredBody = body;
          const user = request.messages?.findLast((message: any) => message.role === 'user');
          const reminder = Array.isArray(user?.content) ? user.content[0]?.text : undefined;
          if (route.restoring && typeof reminder === 'string' && reminder.startsWith('<system-reminder>\nCodebase and user instructions are shown below.')) {
            const deadline = Date.now() + 500;
            while (Date.now() < deadline && !restoredContextBlocks(route.lane, route.sessionId()).some(context =>
              context.kind === 'instructions' && context.texts.includes(reminder))) {
              await delay(20, undefined, { signal: aborter.signal });
            }
          }
          body = projectRestoredFiles(restoredBody, route.lane, route.sessionId());
          if (route.restoring && restoredBody.includes('Result of calling the Read tool:\\n')) {
            // The CLI publishes a compact boundary before its asynchronous
            // transcript writer necessarily flushes restored attachments. Wait
            // briefly for that specific evidence; an unprovable file stays whole.
            const deadline = Date.now() + 500;
            while (Date.now() < deadline && !body.includes('Working file retained:')) {
              await delay(20, undefined, { signal: aborter.signal });
              body = projectRestoredFiles(restoredBody, route.lane, route.sessionId());
            }
          }
          route.restoring = false;
        }
        const gemini = request && ['openrouter', 'openrouter2'].includes(route.provider) && /^google\/gemini/i.test(request.model || '');
        if (gemini) {
          const outgoing = JSON.parse(body);
          if (await pinOpenRouterProvider(outgoing, route.lane, embeddedSession || parentSession, aborter.signal, route.transcript)) body = JSON.stringify(outgoing);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (!value || ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding'].includes(name)) continue;
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const suffix = parsed.pathname.slice(key.length + 1) + parsed.search;
        const requestStartedAt = Date.now(), requestSessionId = route.sessionId();
        const response = await fetch(route.upstream.replace(/\/$/, '') + suffix, {
          method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body, signal: aborter.signal,
        });
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          if (!['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(name)) responseHeaders[name] = value;
        });
        res.writeHead(response.status, responseHeaders);
        if (response.body) {
          const stream = Readable.fromWeb(response.body as any);
          stream.on('error', () => { if (!res.destroyed) res.destroy(); });
          res.on('close', () => stream.destroy());
          if (request && (rootRequest || gemini) && response.ok) {
            const sentRequest = body === original ? request : JSON.parse(body);
            const observer = observeUsage(route, sentRequest, Boolean(auxiliary), response.headers.get('content-type')?.includes('text/event-stream') ?? false, Boolean(nativeSummary), requestStartedAt, requestSessionId, rootRequest);
            observer.on('error', () => { if (!res.destroyed) res.destroy(); });
            stream.pipe(observer).pipe(res);
          } else stream.pipe(res);
        } else res.end();
      } catch (error) {
        const conflict = error instanceof OpenRouterCompatibilityError;
        if (!res.headersSent) res.writeHead(conflict ? 400 : 502, { 'content-type': 'application/json', ...(conflict ? { 'x-should-retry': 'false' } : {}) });
        if (!res.destroyed) res.end(JSON.stringify({ type: 'error', error: { type: conflict ? 'invalid_request_error' : 'api_error', message: conflict ? error.message : 'The native provider connection failed.' } }));
      }
    });
    server.once('error', error => { ready = null; reject(error); });
    server.listen(0, '127.0.0.1', () => { port = (server!.address() as { port: number }).port; server!.unref(); resolve(); });
  });
  return ready;
}

export function nativeCompactBaseUrl(upstream: string, metadata: Omit<Route, 'upstream' | 'compacting'>): string {
  if (!port) throw new Error('Native compaction proxy is not ready');
  const key = randomUUID();
  routes.set(key, { upstream, ...metadata, compacting: false });
  return `http://127.0.0.1:${port}/${key}`;
}

export function releaseNativeCompactRoute(baseUrl: string | undefined): void {
  if (baseUrl) routes.delete(new URL(baseUrl).pathname.slice(1));
}
