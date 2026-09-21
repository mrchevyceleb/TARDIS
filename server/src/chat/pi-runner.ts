/** Pi harness for the GLM and Grok lanes.
 *
 *  Why not the claude binary: Claude Code puts thousands of tokens of its own
 *  tone, format and workflow rules ABOVE the persona, so a teammate's
 *  instructions about how to talk lose to the harness. Pi takes the whole
 *  system prompt from us (`--system-prompt`), speaks to xai, zai and Fireworks
 *  natively (no transform proxy, no model-id validation, images pass through),
 *  and runs headless over a JSON-RPC stdio protocol (`--mode rpc`).
 *
 *  PiSession mirrors ClaudeSession's public surface so register.ts, teamBus and
 *  the session registry treat both alike, and it writes the SAME claude-shaped
 *  event vocabulary into the same durable thread log, so the transcript, the
 *  UI, compaction and engine switches are unchanged.
 *
 *  Mapping (Pi -> TARDIS):
 *    session                       -> system/init (session_id)
 *    message_update text/thinking  -> stream_event content_block_delta
 *    message_end (assistant)       -> assistant {text|thinking|tool_use blocks}
 *    tool_execution_end            -> user {tool_result}
 *    agent_end / abort / error     -> result (+ terminal notice), turnEnd */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { STATE_DIR } from '../config.ts';
import { assertSubscriptionLane, subscriptionEnvironment } from './subscription-policy.ts';
import { computerGuidance } from '../devices/context.ts';
import { redactComputerImages } from '../devices/transcript.ts';
import { setSessionId } from './sessions.ts';
import { appendEventLog, appendEventLogSync, flushEventLog, isPlumbingEvent, loadEventLogSync } from './event-log-store.ts';
import { noteUserTurn, peekEnginePrimerThroughSeq } from './compaction.ts';
import { isAgentThread, logKeyFor } from './threadKey.ts';
import { personaPromptFor } from './personaPrompts.ts';
import { agentForChatId, noteAgentLane } from './agents.ts';
import { adaptImagesForTextModel } from './vision-adapter.ts';
import { isRobotVoiceChatId, isVoiceChatId, robotVoiceAddendum, THREAD_VOICE_STYLE_ADDENDUM, VOICE_STYLE_ADDENDUM } from './voicePrompt.ts';
import { saveChatAttachments } from '../routes/chatAttachments.ts';
import { conversationGuidanceForTurn } from './conversation-guidance.ts';
import { TRANSCRIPT_GUIDANCE } from './transcriptGuidance.ts';
import { noteZaiPlanQuota, zaiModeFor, type ZaiMode } from './zaiQuota.ts';
import { laneMcpServers, type CliKind, type SeqEvent, type SessionEvent } from './runner.ts';

const EVENT_BUFFER_SIZE = 2000;
const PI_SESSION_DIR = join(STATE_DIR, 'pi-sessions');
const HERE = dirname(fileURLToPath(import.meta.url));
const TEAM_EXTENSION = join(HERE, '..', '..', 'pi', 'tardis-team-mcp.ts');
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');

/** The Pi binary. /usr/bin/pi on some hosts is an unrelated Lisp; prefer the
 *  bun/npm install and let RIVENDELL_PI_BIN override. */
function piBinary(): string {
  const configured = process.env.RIVENDELL_PI_BIN?.trim();
  if (configured) return configured;
  const bun = join(homedir(), '.bun', 'bin', 'pi');
  return existsSync(bun) ? bun : 'pi';
}

/** Extensions Pi loads for a TARDIS lane. Discovery is off (`--no-extensions`)
 *  so TUI-only extensions and anything with side effects stay out; these are
 *  the provider catalogs, the bash safety guards, and our MCP bridge. */
function piExtensions(): string[] {
  const ext = join(PI_AGENT_DIR, 'extensions');
  // pi-grok registers the `xai-oauth` provider (SuperGrok); without it every
  // Grok spawn dies with "Unknown provider".
  const wanted = ['auto-provider-models.ts', 'pi-grok/index.ts', 'bash-timeout-guard.ts', 'bash-self-kill-guard.ts'];
  const configured = process.env.RIVENDELL_PI_EXTENSIONS?.split(',').map((s) => s.trim()).filter(Boolean);
  const files = (configured ?? wanted).map((f) => (f.startsWith('/') ? f : join(ext, f))).filter(existsSync);
  return [...files, TEAM_EXTENSION];
}

export type PiProvider = { provider: string; model: string; env: Record<string, string>; mode: ZaiMode | 'xai' };

/** Which Pi provider and model a lane runs on, and the one key it may see. */
export function piProviderFor(cli: CliKind, model: string): PiProvider {
  if (cli === 'xai') {
    // v1 uses xAI's API key. The SuperGrok OAuth provider (pi-grok, `xai-oauth`)
    // has no headless credential wired in Pi yet; RIVENDELL_PI_XAI_PROVIDER
    // switches to it once that login exists.
    const provider = process.env.RIVENDELL_PI_XAI_PROVIDER?.trim() || 'xai';
    return { provider, model, env: { GROK_API_KEY: process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? '' }, mode: 'xai' };
  }
  const bare = model.replace(/\[1m\]$/, '');
  if (zaiModeFor(model) === 'fireworks') {
    const key = process.env.RIVENDELL_ZAI_FALLBACK_API_KEY ?? process.env.FIREWORKS_API_KEY ?? '';
    return { provider: 'fireworks', model: `accounts/fireworks/models/${bare.replace(/\./g, 'p')}`, env: { FIREWORKS_API_KEY: key }, mode: 'fireworks' };
  }
  return { provider: 'zai', model: bare, env: { ZAI_API_KEY: process.env.Z_AI_API_KEY ?? '' }, mode: 'plan' };
}

export function usePiHarness(cli: CliKind): boolean {
  const setting = (cli === 'zai' ? process.env.RIVENDELL_GLM_HARNESS : cli === 'xai' ? process.env.RIVENDELL_XAI_HARNESS : '')?.trim().toLowerCase();
  if (cli !== 'zai' && cli !== 'xai') return false;
  return setting !== 'claude';
}

type Listener = (e: SeqEvent) => void;
type ChatImage = { mediaType: string; base64: string };
type RpcResponse = { id?: string; type: 'response'; command: string; success: boolean; error?: string; data?: unknown };

export class PiSession {
  readonly key: string;
  readonly logKey: string;
  readonly cli: CliKind;
  readonly cwd: string;
  readonly chatId: string;
  readonly spawnModel: string;
  readonly spawnEffort: string;
  readonly ready: Promise<boolean>;
  private resolveReady!: (ok: boolean) => void;

  private child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly provider: PiProvider;
  private readonly zaiMode: ZaiMode;
  private readonly piSessionId: string;
  private readonly startedResumeId: string | null;
  private listeners = new Set<Listener>();
  private eventLog: SeqEvent[] = [];
  private nextSeq = 1;
  private lastActivityAtMs = Date.now();
  private disposed = false;
  private initSeen = false;
  private turnStartedAt: number | null = null;
  private automationTurn = false;
  private activeToolIds = new Set<string>();
  private seedWindowOnNextTurn = false;
  private terminalNoticeEmitted = false;
  private buffer = '';
  private pendingRpc = new Map<string, (r: RpcResponse) => void>();
  private nextRpcId = 1;
  private turnUsage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  private turnFailed: { message: string; code?: string } | null = null;
  private currentMsgId: string | null = null;
  /** Final assistant text of the turn; the client's `result.result` recovery
   *  path re-renders it if the streamed blocks never made it on screen. */
  private lastAssistantText = '';

  constructor(cli: CliKind, cwd: string, chatId: string, resumeId: string | null, model: string, effort: string, seedFirst = false, switchedFrom: string | null = null) {
    assertSubscriptionLane(cli);
    this.cli = cli;
    this.cwd = cwd;
    this.chatId = chatId;
    this.key = `${cli}|${cwd}|${chatId}`;
    this.logKey = logKeyFor(cli, cwd, chatId);
    this.spawnModel = model;
    this.spawnEffort = effort;
    this.seedWindowOnNextTurn = seedFirst;
    this.startedResumeId = resumeId;
    this.piSessionId = resumeId ?? randomUUID();
    this.provider = piProviderFor(cli, model);
    this.zaiMode = this.provider.mode === 'xai' ? 'plan' : this.provider.mode;
    this.ready = new Promise<boolean>((res) => { this.resolveReady = res; });

    try {
      const restored = loadEventLogSync(this.logKey);
      if (restored.events.length > 0) {
        this.eventLog = restored.events;
        this.nextSeq = restored.nextSeq;
      }
    } catch (err) {
      console.warn(`[chat ${cli}/pi] event-log restore failed for ${this.logKey}:`, (err as Error).message);
    }
    if (switchedFrom && switchedFrom !== cli) {
      this.emit({ type: 'event', event: { type: '_engine_switch', from: switchedFrom, to: cli, model: this.spawnModel, ts: Date.now() } } as SessionEvent);
    }

    mkdirSync(PI_SESSION_DIR, { recursive: true });
    const env = subscriptionEnvironment(process.env);
    Object.assign(env, this.provider.env);
    env.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
    // The full lane set, not just the built-ins: without the assistant-mcp
    // proxy a Pi lane had no email, Slack or calendar tools at all.
    env.RIVENDELL_PI_MCP = JSON.stringify(laneMcpServers(agentForChatId(chatId)?.name));
    env.SAMWISE_ACCOUNT = cli;

    const args = [
      '--mode', 'rpc',
      '--provider', this.provider.provider,
      '--model', this.provider.model,
      '--thinking', this.spawnEffort,
      '--system-prompt', this.systemPrompt(),
      '--session-dir', PI_SESSION_DIR,
      '--session-id', this.piSessionId,
      '--no-extensions',
      ...piExtensions().flatMap((e) => ['-e', e]),
    ];
    this.child = spawn(piBinary(), args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable, Readable, Readable>;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line && !/auto-provider-models|interrupt-guard/.test(line)) console.warn(`[chat ${cli}/pi] ${line.slice(0, 300)}`);
    });
    this.child.on('error', (err) => {
      console.error(`[chat ${cli}/pi] spawn error:`, err.message);
      this.emit({ type: 'error', message: `pi failed to start: ${err.message}`, fatal: true });
      this.resolveReady(false);
    });
    this.child.on('exit', (code, signal) => this.onExit(code, signal));
    console.log(`[chat ${cli}/pi] spawned ${this.provider.provider}/${this.provider.model} thinking=${this.spawnEffort} session=${this.piSessionId.slice(0, 8)}${resumeId ? ' (resume)' : ''}`);
    // rpc mode does not print a `session` header until the first prompt, so
    // probe readiness: the first successful get_state means extensions are
    // loaded and the MCP bridge is up. Init is emitted from its data.
    void this.rpc({ type: 'get_state' }, 45_000).then((r) => {
      if (r.success) this.markInit((r.data as any)?.sessionId);
      else if (!this.initSeen && !this.disposed) { console.warn(`[chat ${cli}/pi] not ready: ${r.error}`); this.resolveReady(this.child.exitCode === null); }
    });
  }

  private markInit(sessionId?: string): void {
    if (this.initSeen) return;
    this.initSeen = true;
    console.log(`[chat ${this.cli}/pi] ready ${this.provider.provider}/${this.provider.model} session=${this.piSessionId.slice(0, 8)}`);
    void setSessionId(this.cli, this.cwd, this.piSessionId, this.chatId);
    this.emit({ type: 'event', event: { type: 'system', subtype: 'init', cwd: this.cwd, session_id: sessionId ?? this.piSessionId, model: this.provider.model, harness: 'pi' } });
    this.resolveReady(true);
  }

  /** The whole system prompt. Persona first and alone at the top: this is
   *  the point of the harness. Then only what a TARDIS teammate must know. */
  private systemPrompt(): string {
    const voice = isVoiceChatId(this.chatId);
    const voiceAddendum = voice
      ? [VOICE_STYLE_ADDENDUM, isRobotVoiceChatId(this.chatId) ? robotVoiceAddendum(this.chatId) : null].filter(Boolean).join('\n\n')
      : null;
    const persona = personaPromptFor(this.chatId);
    const name = agentForChatId(this.chatId)?.name ?? 'a teammate';
    const operating = [
      `You are ${name}, a teammate aboard TARDIS, Matt's always-on office. You have file, shell and edit tools for this workspace, plus team tools (team_message, team_status and friends) for talking to other teammates, and assistant_* tools for email, calendar, tasks and integrations.`,
      'Do the work yourself with tools; report outcomes plainly; never claim something is done that you did not verify.',
      'External side effects stay draft-first unless the person explicitly asked you to send, post or deploy.',
    ].join('\n');
    return [persona, voiceAddendum, operating, isAgentThread(this.chatId) ? TRANSCRIPT_GUIDANCE : null].filter(Boolean).join('\n\n');
  }

  // ---- rpc transport -----------------------------------------------------------

  private rpc(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
    const id = `r${this.nextRpcId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pendingRpc.delete(id); resolve({ id, type: 'response', command: String(command.type), success: false, error: 'timeout' }); }, timeoutMs);
      this.pendingRpc.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.child.stdin.write(JSON.stringify({ id, ...command }) + '\n', (err) => {
        if (err) { clearTimeout(timer); this.pendingRpc.delete(id); resolve({ id, type: 'response', command: String(command.type), success: false, error: err.message }); }
      });
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    // Strict LF framing per Pi's RPC docs (never readline: it splits on U+2028).
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'response') {
        const cb = typeof msg.id === 'string' ? this.pendingRpc.get(msg.id) : undefined;
        if (cb) { this.pendingRpc.delete(msg.id); cb(msg as RpcResponse); }
        continue;
      }
      try { this.handleEvent(msg); } catch (err) {
        console.error(`[chat ${this.cli}/pi] event handling failed:`, (err as Error).message);
      }
    }
  }

  // ---- event normalisation --------------------------------------------------------

  private handleEvent(ev: any): void {
    this.lastActivityAtMs = Date.now();
    switch (ev.type) {
      case 'session': {
        this.markInit(typeof ev.id === 'string' ? ev.id : undefined);
        return;
      }
      case 'agent_start': {
        this.turnUsage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
        this.turnFailed = null;
        this.lastAssistantText = '';
        return;
      }
      case 'message_update': {
        // Mirror the Anthropic stream lifecycle exactly: the client opens a
        // turn on message_start, a block on content_block_start (tool cards get
        // their name there), appends on delta, closes on stop, and reads
        // stop_reason off message_delta. Deltas alone leave one orphan block.
        const d = ev.assistantMessageEvent;
        if (!d) return;
        const sid = this.piSessionId;
        const stream = (event: Record<string, unknown>) => this.emit({ type: 'event', event: { type: 'stream_event', event, session_id: sid } });
        switch (d.type) {
          case 'start':
            this.currentMsgId = randomUUID();
            stream({ type: 'message_start', message: { id: this.currentMsgId, type: 'message', role: 'assistant', content: [], model: this.provider.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } });
            return;
          case 'text_start':
            stream({ type: 'content_block_start', index: d.contentIndex, content_block: { type: 'text', text: '' } });
            return;
          case 'text_delta':
            stream({ type: 'content_block_delta', index: d.contentIndex, delta: { type: 'text_delta', text: d.delta } });
            return;
          case 'text_end':
            stream({ type: 'content_block_stop', index: d.contentIndex });
            return;
          case 'thinking_start':
            stream({ type: 'content_block_start', index: d.contentIndex, content_block: { type: 'thinking', thinking: '' } });
            return;
          case 'thinking_delta':
            stream({ type: 'content_block_delta', index: d.contentIndex, delta: { type: 'thinking_delta', thinking: d.delta } });
            return;
          case 'thinking_end':
            stream({ type: 'content_block_stop', index: d.contentIndex });
            return;
          case 'toolcall_end': {
            // Pi only knows the call's name and arguments at the end, so the
            // whole tool block is opened, filled and closed here.
            const call = d.toolCall ?? {};
            const id = String(call.id ?? '');
            this.activeToolIds.add(id);
            stream({ type: 'content_block_start', index: d.contentIndex, content_block: { type: 'tool_use', id, name: String(call.name ?? ''), input: {} } });
            stream({ type: 'content_block_delta', index: d.contentIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments ?? {}) } });
            stream({ type: 'content_block_stop', index: d.contentIndex });
            return;
          }
          default:
            return;
        }
      }
      case 'message_end': {
        const m = ev.message;
        if (!m || m.role !== 'assistant') return;
        const content = (Array.isArray(m.content) ? m.content : []).map((b: any) => {
          if (b.type === 'text') return { type: 'text', text: String(b.text ?? '') };
          if (b.type === 'thinking') return { type: 'thinking', thinking: String(b.thinking ?? '') };
          if (b.type === 'toolCall' || b.type === 'tool_use') {
            this.activeToolIds.add(String(b.id));
            return { type: 'tool_use', id: String(b.id), name: String(b.name ?? ''), input: b.arguments ?? b.input ?? {} };
          }
          return null;
        }).filter(Boolean);
        const u = m.usage ?? {};
        this.turnUsage.input += Number(u.input ?? 0);
        this.turnUsage.output += Number(u.output ?? 0);
        this.turnUsage.cacheRead += Number(u.cacheRead ?? 0);
        this.turnUsage.cost += Number(u.cost?.total ?? 0);
        if (m.stopReason === 'error' || m.stopReason === 'aborted') {
          this.turnFailed = { message: String(m.errorMessage ?? m.stopReason), code: m.stopReason };
        }
        // Pi: stop | toolUse | length | error | aborted  ->  Anthropic vocabulary
        const stopReason = m.stopReason === 'toolUse' ? 'tool_use' : m.stopReason === 'stop' ? 'end_turn' : m.stopReason === 'length' ? 'max_tokens' : null;
        const usage = { input_tokens: u.input ?? 0, output_tokens: u.output ?? 0, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: 0 };
        const msgId = this.currentMsgId ?? randomUUID();
        const textOut = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        if (textOut.trim()) this.lastAssistantText = textOut;
        if (content.length) {
          this.emit({ type: 'event', event: { type: 'assistant', parent_tool_use_id: null, session_id: this.piSessionId, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { id: msgId, type: 'message', role: 'assistant', model: m.model ?? this.provider.model, content, stop_reason: stopReason, stop_sequence: null, usage } } });
        }
        this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage }, session_id: this.piSessionId } });
        this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'message_stop' }, session_id: this.piSessionId } });
        this.currentMsgId = null;
        return;
      }
      case 'tool_execution_end': {
        this.activeToolIds.delete(String(ev.toolCallId));
        const result = ev.result ?? {};
        const parts = Array.isArray(result.content) ? result.content : [];
        const text = parts.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')).join('\n');
        this.emit({ type: 'event', event: { type: 'user', parent_tool_use_id: null, session_id: this.piSessionId, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: String(ev.toolCallId), content: text || (typeof result === 'string' ? result : JSON.stringify(result).slice(0, 4000)), is_error: ev.isError === true }] } } });
        return;
      }
      case 'agent_end': {
        this.finishTurn();
        return;
      }
      default:
        return;
    }
  }

  private finishTurn(): void {
    if (this.turnStartedAt === null) return;
    const failed = this.turnFailed;
    if (failed) {
      const detail = failed.message;
      // The same quota detector the claude lane uses; a Pi GLM turn reports the
      // Z.ai body verbatim in errorMessage.
      if (this.zaiMode === 'plan') noteZaiPlanQuota({ type: 'result', api_error_status: /429|1308|1310|limit/i.test(detail) ? 429 : undefined, result: detail });
      if (!this.terminalNoticeEmitted) {
        this.terminalNoticeEmitted = true;
        const label = this.cli === 'xai' ? 'Grok' : 'GLM';
        const message = failed.code === 'aborted'
          ? 'This turn was cancelled before it finished.'
          : `${label} could not answer this turn (${detail.slice(0, 160)}). Try again or switch brains.`;
        this.emit({ type: 'event', event: { type: '_terminal_error', message, code: failed.code, retryable: failed.code !== 'aborted', ts: Date.now() } });
      }
    }
    this.emit({ type: 'event', event: { type: 'result', subtype: failed ? 'error' : 'success', is_error: Boolean(failed), ...(failed ? {} : { result: this.lastAssistantText }), session_id: this.piSessionId, total_cost_usd: this.turnUsage.cost, usage: { input_tokens: this.turnUsage.input, output_tokens: this.turnUsage.output, cache_read_input_tokens: this.turnUsage.cacheRead } } });
    this.lastAssistantText = '';
    this.turnStartedAt = null;
    this.automationTurn = false;
    this.activeToolIds.clear();
    this.emit({ type: 'turnEnd', sessionId: this.piSessionId });
    const stale = this.hasStaleZaiProvider();
    if (stale) this.shutdown(`zai-provider-switch-${zaiModeFor(this.spawnModel)}`);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const intentional = this.disposed;
    console.log(`[chat ${this.cli}/pi] exit code=${code} signal=${signal ?? '-'} initSeen=${this.initSeen}${intentional ? ' (intentional)' : ''}`);
    if (!this.initSeen) this.resolveReady(false);
    if (!intentional && this.turnStartedAt !== null) {
      this.turnFailed = { message: `pi exited (code ${code ?? signal})`, code: 'exit' };
      this.finishTurn();
    }
    for (const cb of this.pendingRpc.values()) cb({ type: 'response', command: 'exit', success: false, error: 'exited' });
    this.pendingRpc.clear();
    if (intentional) {
      const se: SeqEvent = { seq: this.latestSeq(), ev: { type: 'closed', code, signal, intentional: true } };
      for (const fn of this.listeners) fn(se);
    } else {
      this.emit({ type: 'closed', code, signal });
    }
  }

  // ---- public surface (mirrors ClaudeSession) ------------------------------------

  subscribe(fn: Listener, sinceSeq = -1, _countSubscriber = true): () => void {
    this.listeners.add(fn);
    if (sinceSeq >= 0) for (const se of this.eventLog) if (se.seq > sinceSeq) fn(se);
    return () => { this.listeners.delete(fn); };
  }
  reserveSeq(): number { return this.nextSeq++; }
  latestSeq(): number { return this.nextSeq - 1; }
  async prewarm(): Promise<void> { await this.ready; }
  isPrewarming(): boolean { return !this.initSeen && !this.disposed; }
  listenerCount(): number { return this.listeners.size; }
  lastActivityAt(): number { return this.lastActivityAtMs; }
  isAlive(): boolean { return this.child.exitCode === null && !this.disposed; }
  isDisposed(): boolean { return this.disposed; }
  isBusy(): boolean { return this.turnStartedAt !== null; }
  isAutomationTurn(): boolean { return this.turnStartedAt !== null && this.automationTurn; }
  /** Pi's `steer` is delivered at the next tool boundary — always safe. */
  canAcceptNativeHumanSteer(): boolean { return this.turnStartedAt !== null; }
  sessionId(): string | null { return this.piSessionId; }
  startedWithResume(): boolean { return this.startedResumeId !== null; }
  hasResumeFailed(): boolean { return false; }
  hasStaleZaiProvider(): boolean { return this.cli === 'zai' && zaiModeFor(this.spawnModel) !== this.zaiMode; }
  activeSelection(): { model?: string; effort?: string } { return { model: this.spawnModel, effort: this.spawnEffort }; }
  async waitForInitOrExit(timeoutMs: number): Promise<'initialized' | 'closed' | 'timeout'> {
    const ok = await Promise.race([this.ready, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))]);
    return ok === 'timeout' ? 'timeout' : ok ? 'initialized' : 'closed';
  }
  ingestExternalEvent(se: SeqEvent): void {
    if (this.disposed) return;
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    for (const fn of this.listeners) fn(se);
  }

  async send(text: string, images?: ChatImage[], opts: { peerFrom?: string; peerFromRole?: string; peerText?: string; peerDeliveryId?: string; allowNativePeerSteer?: boolean; allowNativeHumanSteer?: boolean; signal?: AbortSignal; clientMsgId?: string; skipAttachments?: boolean; voiceMode?: boolean } = {}): Promise<void> {
    assertSubscriptionLane(this.cli);
    if (opts.signal?.aborted) return;
    if (!this.isAlive()) throw new Error('session has exited');
    await this.ready;
    const startsNewTurn = this.turnStartedAt === null;
    if (!startsNewTurn) {
      if (opts.peerFrom && !opts.allowNativePeerSteer) return;
      if (!opts.peerFrom && !opts.allowNativeHumanSteer) throw new Error('the current turn must reach a safe boundary before guidance is delivered');
      if (this.automationTurn && !opts.peerFrom) throw new Error('human message is waiting for the automation turn to finish');
    }
    const automationRequest = opts.peerFromRole === 'automation';
    if (startsNewTurn) {
      this.turnStartedAt = Date.now();
      this.automationTurn = automationRequest;
      this.activeToolIds.clear();
      this.terminalNoticeEmitted = false;
      this.turnFailed = null;
    }
    const abandon = () => {
      if (!startsNewTurn || this.turnStartedAt === null) return;
      this.turnStartedAt = null; this.automationTurn = false; this.activeToolIds.clear();
      if (!this.disposed) this.emit({ type: 'turnEnd', sessionId: this.piSessionId });
    };
    const historyThroughSeq = this.latestSeq();
    const wantSeed = this.seedWindowOnNextTurn;
    const seed = wantSeed ? await peekEnginePrimerThroughSeq(this.logKey, historyThroughSeq, this.eventLog.slice()) : '';
    if (opts.signal?.aborted) { abandon(); return; }

    let attachments: Array<{ id: string; mediaType: string }> = [];
    try {
      if (!opts.peerFrom && !opts.skipAttachments && images?.length) attachments = await saveChatAttachments(images);
    } catch (error) { abandon(); throw error; }

    // Text-only GLM gets a description instead of pixels; Grok and GLM Flash
    // take the image natively.
    let promptText = text;
    let outImages = images;
    const modelSupportsImages = this.cli === 'xai' || /flash/i.test(this.spawnModel);
    if (!modelSupportsImages && images?.length) {
      const result = await adaptImagesForTextModel({ text, images, modelSupportsImages: false });
      if (result.adapted) { promptText = result.text; outImages = undefined; console.log(`[chat ${this.cli}/pi] vision adapter: ${result.note}`); }
      if (opts.signal?.aborted || !this.isAlive()) { abandon(); return; }
    }

    if (opts.peerFrom) {
      if (startsNewTurn) this.emit({ type: 'turnStart' });
      this.emit({ type: 'event', event: { type: 'peer_message', from: opts.peerFrom, fromRole: opts.peerFromRole ?? '', text: opts.peerText !== undefined ? opts.peerText : text, ...(opts.peerDeliveryId ? { deliveryId: opts.peerDeliveryId } : {}), ts: Date.now() } });
    } else {
      await flushEventLog(this.logKey);
      if (opts.signal?.aborted) { abandon(); return; }
      this.emit({ type: 'event', event: { type: '_user_echo', text, imageCount: images?.length ?? 0, attachments, clientMsgId: opts.clientMsgId, ts: Date.now() } });
      noteUserTurn(this.logKey);
      noteAgentLane(this.chatId, this.cli);
    }

    const guidance = conversationGuidanceForTurn({ chatId: this.chatId, logKey: this.logKey, historyThroughSeq, peerFrom: opts.peerFrom, peerFromRole: opts.peerFromRole });
    const continuation = isAgentThread(this.chatId)
      ? ['<rivendell-continuation>', `Warm continuation of the existing conversation. Host time: ${new Date().toString()}.`, 'Do not repeat session-start rituals.', '</rivendell-continuation>', ...(guidance ? ['', guidance] : []), ...(opts.voiceMode ? ['', THREAD_VOICE_STYLE_ADDENDUM] : []), '', promptText].join('\n')
      : promptText;
    const computerContext = computerGuidance(this.chatId, agentForChatId(this.chatId)?.name ?? 'Companion', !opts.peerFrom && opts.peerFromRole !== 'automation');
    const message = `${computerContext}\n\n${seed ? `${seed}\n\n---\n\n` : ''}${continuation}`;
    const piImages = outImages?.map((img) => ({ type: 'image', data: img.base64, mimeType: img.mediaType }));

    const command = startsNewTurn
      ? { type: 'prompt', message, ...(piImages?.length ? { images: piImages } : {}) }
      : { type: 'steer', message, ...(piImages?.length ? { images: piImages } : {}) };
    const response = await this.rpc(command);
    if (!response.success) {
      if (wantSeed) this.seedWindowOnNextTurn = true;
      abandon();
      this.emit({ type: 'error', message: `pi rejected the prompt: ${response.error ?? 'unknown'}` });
      return;
    }
    if (wantSeed) this.seedWindowOnNextTurn = false;
    if (opts.peerDeliveryId) this.emit({ type: 'event', event: { type: 'peer_delivery_accepted', deliveryId: opts.peerDeliveryId, ts: Date.now() } });
  }

  /** Stop is the only thing that may end a turn. Pi's abort drains to idle,
   *  after which agent_end closes the turn through the normal path. */
  async interrupt(reason = 'interrupt'): Promise<boolean> {
    if (!this.isAlive() || this.turnStartedAt === null) return false;
    this.emit({ type: 'event', event: { type: '_interrupted', ts: Date.now() } });
    const response = await this.rpc({ type: 'abort' }, 20_000);
    if (!response.success) { console.warn(`[chat ${this.cli}/pi] abort (${reason}) failed: ${response.error}`); return false; }
    return true;
  }

  shutdown(reason = 'unspecified'): void {
    if (this.disposed) return;
    this.disposed = true;
    console.log(`[chat ${this.cli}/pi] shutdown key=${this.key} reason=${reason}`);
    try { this.child.stdin.end(); } catch { /* closed */ }
    try { process.kill(-this.child.pid!, 'SIGTERM'); } catch { try { this.child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-this.child.pid!, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
  }

  private emit(msg: SessionEvent): void {
    msg = redactComputerImages(msg);
    if (this.disposed || isPlumbingEvent(msg)) return;
    this.lastActivityAtMs = Date.now();
    const se: SeqEvent = { seq: this.reserveSeq(), ev: msg };
    const persisted = { ...se, eng: this.cli, mdl: this.spawnModel };
    const durableUserEcho = msg.type === 'event' && (msg as any).event?.type === '_user_echo';
    if (durableUserEcho && !appendEventLogSync(this.logKey, persisted)) throw new Error('could not durably accept the user message');
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    if (!durableUserEcho) appendEventLog(this.logKey, persisted);
    for (const fn of this.listeners) fn(se);
  }
}
