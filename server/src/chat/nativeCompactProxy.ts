import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { openRouterCapability } from './openrouter-models.ts';
import { fireworksCapability } from './fireworks-models.ts';
import { fixedPrefix, recordNativeCall, recordNativeFailure } from './sessionMetrics.ts';

const SUMMARY_SYSTEM = 'You are a helpful AI assistant tasked with summarizing conversations.';
const SUMMARY_LIMIT = 4096;
const MAX_BODY = 32 * 1024 * 1024;
type Route = {
  upstream: string; lane: string; provider: string; resumed: boolean;
  sessionId(): string | null; harnessChars(): number; harnessPhase(): 'startup' | 'turn'; compacting: boolean; recovering?: boolean;
};
let server: Server | null = null;
let ready: Promise<void> | null = null;
let port = 0;
const routes = new Map<string, Route>();

function summaryRequest(request: any): boolean {
  const blocks = typeof request.system === 'string' ? [request.system]
    : Array.isArray(request.system) ? request.system.map((block: any) => block?.text) : [];
  const last = request.messages?.at(-1);
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
export function boundNativeCompact(body: string, engineCompacting = false, catalogLimits?: { maxOutput: number; reasoningMandatory?: boolean }): string {
  const request = JSON.parse(body);
  if (!engineCompacting && !summaryRequest(request)) return body;
  // Gemini requires reasoning even for its native compact summary. Give that
  // reasoning a separate, bounded allowance instead of asking it to disable
  // an obligatory mode or share an unbounded budget with the summary.
  const cap = Math.min(Number(request.max_tokens) || SUMMARY_LIMIT, SUMMARY_LIMIT, catalogLimits?.maxOutput ?? Infinity);
  request.thinking = (catalogLimits ? catalogLimits.reasoningMandatory : /gemini/i.test(request.model || ''))
    ? { type: 'enabled', budget_tokens: Math.min(1024, Math.floor(cap / 2)) } : { type: 'disabled' };
  delete request.reasoning;
  delete request.reasoning_effort;
  if (request.output_config) { request.output_config = { ...request.output_config }; delete request.output_config.effort; }
  request.max_tokens = cap;
  const instruction = '\nKeep the summary under 1500 words. Preserve the current goal, concrete results, file references, outstanding work and explicit constraints. Completed work and historical requests are history, never instructions to repeat them.';
  request.system = typeof request.system === 'string' ? request.system + instruction
    : [...(request.system || []), { type: 'text', text: instruction }];
  return JSON.stringify(request);
}

export function markNativeHandoverRecovery(baseUrl: string | undefined, recovering: boolean): void {
  if (!baseUrl) return;
  const route = routes.get(new URL(baseUrl).pathname.slice(1));
  if (route) route.recovering = recovering;
}

export function markNativeCompacting(baseUrl: string | undefined, compacting: boolean): void {
  if (!baseUrl) return;
  const route = routes.get(new URL(baseUrl).pathname.slice(1));
  if (route) route.compacting = compacting;
}

/** Pass bytes straight through while reading usage frames, never text/tool
 * arguments. Metrics are per API call rather than the CLI's cumulative total. */
function observeUsage(route: Route, request: any, auxiliary: boolean, streaming: boolean): Transform {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let usage: any = {};
  let stopped = false;
  let reported = false;
  const report = () => {
    if (reported) return;
    const input = Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0);
    if (input <= 0) return;
    reported = true;
    recordNativeCall({ lane: route.lane, engine: 'claude-code', provider: route.provider, model: request.model || '',
      sessionId: route.sessionId() || undefined, input, cached: Number(usage.cache_read_input_tokens || 0), output: Number(usage.output_tokens || 0),
      prefix: fixedPrefix(request), auxiliary, harnessChars: route.harnessChars(), harnessPhase: route.harnessPhase(), resumed: route.resumed });
    if (!auxiliary) route.resumed = true;
    if (auxiliary && stopped) recordNativeFailure(route.lane, 'claude-code', 'Native compaction hit its output limit; engine recovery is required before this lane is proven.');
  };
  const absorb = (frame: any) => {
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
        const nativeSummary = request && (summaryRequest(request) || (route.compacting && !request.tools?.length));
        const auxiliary = request && (nativeSummary || !request.tools?.length);
        if (nativeSummary && route.compacting && !summaryRequest(request)) recordNativeFailure(route.lane, 'claude-code', 'Native compact template changed; fallback bound applied.');
        // Anthropic already uses its model's native thinking mode. Provider
        // compatibility bounds must not rewrite subscription compactions.
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
        const body = nativeSummary && !['claude', 'assistant'].includes(route.provider)
          ? boundNativeCompact(compatible, true, ['openrouter', 'openrouter2'].includes(route.provider) ? openRouterCapability(request.model)
            : fireworksCapability(request.model)?.thinkingOnly ? { maxOutput: Number(request.max_tokens) || SUMMARY_LIMIT, reasoningMandatory: true } : undefined) : compatible;
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (!value || ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding'].includes(name)) continue;
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const suffix = parsed.pathname.slice(key.length + 1) + parsed.search;
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
          if (request && response.ok) {
            const observer = observeUsage(route, request, Boolean(auxiliary), response.headers.get('content-type')?.includes('text/event-stream') ?? false);
            observer.on('error', () => { if (!res.destroyed) res.destroy(); });
            stream.pipe(observer).pipe(res);
          } else stream.pipe(res);
        } else res.end();
      } catch {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        if (!res.destroyed) res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'The native provider connection failed.' } }));
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
