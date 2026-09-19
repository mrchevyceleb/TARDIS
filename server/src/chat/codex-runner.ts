import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_APP_TURN_SCRIPT } from '../config.ts';
import { localMcpCodexArgs } from './local-mcp.ts';
import { officeMcpCodexArgs } from './office-mcp.ts';
import { computerGuidance } from '../devices/context.ts';
import { redactComputerImages } from '../devices/transcript.ts';
import type { CliKind, SessionEvent, SeqEvent } from './runner.ts';
import { getSessionId, setSessionId } from './sessions.ts';
import { appendEventLog, appendEventLogSync, clearEventLog, compactEventLog, flushEventLog, isPlumbingEvent, latestEventLogSeq, loadEventLogForCompactionSync, loadEventLogSync, reserveEventLogSeq, type PersistedEvent } from './event-log-store.ts';
import { crashTombstoneEvent, crashTombstoneText , restartMarkerEvent } from './crashTombstone.ts';
import { maybeAutoCompact, refreshCompactForRotation, noteUserTurn, bankRotation, isRotationOwed, clearRotation, peekEnginePrimerThroughSeq, clearThreadMemory, compactedThroughSeq } from './compaction.ts';
import { contextRotationDue, recordContextUsage, recordContextRotation } from './contextBudget.ts';
import { extractVisibleTurns, WINDOW_TURNS } from './threadWindow.ts';
import { lastEngineOf, logKeyFor } from './threadKey.ts';
import { personaPromptFor } from './personaPrompts.ts';
import { longCallGateEnv } from './longCallGate.ts';
import { agentForChatId, noteAgentLane } from './agents.ts';
import { fileProviderErrorMessage, isTransientFileProviderError } from '../lib/fileProvider.ts';
import { assertMemoryAvailableForSpawn, MemoryPressureSpawnError } from './memory.ts';
import { accountEnv, accountEnvForAccount, accountFromChatId } from '../lib/accountResolver.ts';
import { codexHomeFor, codexRolloutMissing, latestThreadIdFromEvents } from './codex-threads.ts';
import { resolveCodexBin, resolveCodexSelection } from './codex-models.ts';
import { buildCodexAppServerArgs, shouldRetryEmptyCodexTurn } from './codex-args.ts';
import { HUB_WRITE_LOCK_PROMPT } from '../lib/hubPaths.ts';
import { chatAttachmentPath, saveChatAttachments } from '../routes/chatAttachments.ts';
import { conversationGuidanceForTurn } from './conversation-guidance.ts';
import { THREAD_VOICE_STYLE_ADDENDUM } from './voicePrompt.ts';
import { isPersonMessage, REPLY_NUDGE_NOTE, replyNudgeEvent, ReplyWatch } from './replyNudge.ts';
import { noteProviderGateFailure } from '../lib/providerGateAlert.ts';

const CODEX_BIN = resolveCodexBin();
console.log(`[chat codex] binary: ${CODEX_BIN}`);

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // Never signal pid <= 1: process.kill(-1) hits every process this user owns.
  if (!child.pid || child.pid <= 1) return;
  const descendants = collectDescendantPids(child.pid);
  try { child.kill(signal); } catch {}
  try { process.kill(-child.pid, signal); } catch {}
  for (const pid of descendants.reverse()) {
    try { process.kill(pid, signal); } catch {}
  }
}

/** Resolve once the child has fully exited. SIGTERM first; SIGKILL after 3s
 *  if still alive. Returns immediately if the child is already dead.
 *  Used by shutdown() so the next app-server resume only starts after the
 *  prior child has released the rollout. Without this, a replacement races
 *  the dying turn's final writes and can read partial state. */
async function waitForTreeExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    child.once('error', done);
  });
  terminateProcessTree(child, 'SIGTERM');
  const sigkill = setTimeout(() => {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
  }, 3000);
  sigkill.unref();
  await exited;
  clearTimeout(sigkill);
}

function collectDescendantPids(pid: number): number[] {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 1000 });
    const children = out
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 1);
    return children.flatMap((childPid) => [childPid, ...collectDescendantPids(childPid)]);
  } catch {
    return [];
  }
}

// OneDrive's fileproviderd daemon intermittently holds an exclusive lock on
// `.codex/config.toml` while syncing, which surfaces in Codex as
// "Resource deadlock avoided (os error 11)" at startup and kills the turn.
// We probe the file before spawning so the sync window can clear; reading it
// from Node also tends to "warm" the placeholder so Codex's own read on the
// heels of ours succeeds.
const PROJECT_CONFIG_PROBE_RETRIES = 8;
const PROJECT_CONFIG_PROBE_DELAY_MS = 250;
type ProjectConfigProbeResult =
  | { ok: true }
  | { ok: false; message: string };

async function probeProjectConfigFile(path: string): Promise<ProjectConfigProbeResult> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= PROJECT_CONFIG_PROBE_RETRIES; attempt += 1) {
    try {
      await readFile(path, 'utf8');
      return { ok: true };
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT: no project config — nothing to probe, codex will skip it.
      if (code === 'ENOENT') return { ok: true };
      if (!isTransientFileProviderError(err)) {
        // Any other read failure: log and let codex try anyway.
        console.warn(`[chat codex] project config probe failed: ${fileProviderErrorMessage(err)}`);
        return { ok: true };
      }
      if (attempt === PROJECT_CONFIG_PROBE_RETRIES) break;
      await new Promise((r) => setTimeout(
        r,
        Math.min(1500, PROJECT_CONFIG_PROBE_DELAY_MS * (attempt + 1)),
      ));
    }
  }

  return {
    ok: false,
    message:
      `OneDrive is still locking ${path} after ${PROJECT_CONFIG_PROBE_RETRIES + 1} read attempts. ` +
      `Retry in a moment, or move ASSISTANT-HUB off OneDrive. Last error: ${fileProviderErrorMessage(lastErr)}`,
  };
}

async function probeProjectConfig(cwd: string): Promise<ProjectConfigProbeResult> {
  for (const path of [join(cwd, '.codex', 'config.toml'), join(cwd, '.codex', 'hooks.json')]) {
    const result = await probeProjectConfigFile(path);
    if (!result.ok) return result;
  }
  return { ok: true };
}

const EVENT_BUFFER_SIZE = 2000;

// Each turn uses a fresh Codex app-server adapter process. Unlike `codex exec`,
// app-server exposes true same-turn `turn/steer`; the adapter preserves the
// existing `item.started` / `item.completed` JSONL contract. We normalize those
// events into the same claude-shaped stream vocabulary the front-end already
// understands, so the reducer does not need engine-specific state.

export type Listener = (e: SeqEvent) => void;

let nextSyntheticId = 1;
const synth = (prefix: string) => `${prefix}_${nextSyntheticId++}`;
type ChatImage = { mediaType: string; base64: string };
type CodexSendOptions = {
  model?: unknown;
  effort?: unknown;
  peerFrom?: string;
  peerFromRole?: string;
  peerText?: string;
  peerDeliveryId?: string;
  /** App-server `turn/steer` admission was checked by teamBus/register. */
  allowNativePeerSteer?: boolean;
  allowNativeHumanSteer?: boolean;
  signal?: AbortSignal;
  clientMsgId?: string;
  skipAttachments?: boolean;
  /** A human steer's images ride the mid-turn channel as saved files named in
   * the text (the channel itself is text only), so a picture never has to wait
   * for the turn to end. Same contract as the Claude runner. */
  imagesAsFiles?: boolean;
  /** Internal one-shot recovery after a truly empty, side-effect-free exit. */
  emptyRetryDepth?: number;
  suppressEcho?: boolean;
  seedOverride?: string;
  voiceMode?: boolean;
};
type CodexSessionOptions = {
  recoverContextOnNextTurn?: boolean;
  cli?: CliKind;
  durableHistory?: PersistedEvent[];
};
type ToolUseBlock = { index: number; toolUseId: string };
type CodexUsage = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
};
type CodexTurnState = {
  messageId: string;
  nextBlockIndex: number;
  toolUseBlocks: Map<string, ToolUseBlock>;
  usage: CodexUsage | null;
};
type NativeSteerWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const CODEX_TURN_PREAMBLE = [
  '<samwise-codex-runtime>',
  'When you run shell commands that may take more than a few seconds or need polling, use exec_command with tty=true. This includes gh run watch, dev servers, test watchers, and other watch or follow commands.',
  'If you see "stdin is closed for this session", rerun the command with tty=true.',
  'Nothing you start in the background can report back to you. A backgrounded shell, nohup job or watcher never wakes you when it finishes, and it may be stopped when your turn ends. Run what you need the result of in the foreground, or poll it to completion inside this turn. If something must outlive the turn, tell the person what is running, where its output goes, and that you will not see it finish.',
  'When searching files, use `rg` or `rg --files` with scoped paths and exclusions for `node_modules`, `.git`, build output, and cloud-sync trees. Do not run broad recursive `grep` or `find` over the home directory, workspace hubs, or ASSISTANT-HUB.',
  'Give spawned subagents the same search constraint before asking them to inspect code.',
  'TARDIS companions are reached ONLY through the rivendell-team team_message MCP tool (mcp__rivendell_team__team_message in Codex). They are not Codex collaboration agents. Never use native send_message, list_agents, spawn_agent, followup_task, or a /root/... route for a companion handoff. A busy companion is durably queued, not unavailable. Never claim a handoff attempt unless the rivendell-team MCP call actually occurred.',
  HUB_WRITE_LOCK_PROMPT,
  '</samwise-codex-runtime>',
].join('\n');

const imageExtension = (mediaType: string): string => {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/gif') return 'gif';
  if (mediaType === 'image/webp') return 'webp';
  const subtype = mediaType.split('/')[1]?.split('+')[0] ?? 'img';
  return subtype.replace(/[^a-z0-9]/gi, '') || 'img';
};

const CODEX_TRACING_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+[\w_]+(?:::[\w_]+)*:/;
const CODEX_PROJECT_CONFIG_ERROR = /(config\.toml|hooks\.json|project config|error loading config)/i;

function isIgnorableCodexStderr(line: string): boolean {
  if (/Reading additional input from stdin/i.test(line)) return true;
  if (/failed to record rollout items/i.test(line)) return true;
  if (/write_stdin failed: stdin is closed for this session/i.test(line)) return true;
  return CODEX_TRACING_LINE.test(line);
}

export class CodexSession {
  readonly key: string;
  /** Durable-history key — engine-free for agent home threads (threadKey.ts). */
  readonly logKey: string;
  readonly cli: CliKind;
  readonly cwd: string;
  readonly chatId: string;
  private listeners = new Set<Listener>();
  private subscriberCount = 0;
  private threadId: string | null = null;
  /** Next turn seeds persona + rolling compact + last 50 on a fresh thread. */
  private seedWindowOnNextTurn = false;
  private contextMaintenance: Promise<void> | null = null;

  private consumeWindowSeed(): boolean {
    return this.seedWindowOnNextTurn;
  }

  private ackWindowSeed(): Promise<void> {
    if (!this.seedWindowOnNextTurn) return Promise.resolve();
    this.seedWindowOnNextTurn = false;
    return clearRotation(this.logKey);
  }

  /** Forever-thread compaction check — see server/src/chat/compaction.ts. */
  private async rotateContextAtBoundary(): Promise<void> {
    if (!contextRotationDue(this.logKey) || this.busy || this.dead) return;
    const refreshed = await refreshCompactForRotation({
      key: this.logKey, cli: this.cli, chatId: this.chatId, events: this.eventLog,
      isBusy: () => this.busy || this.dead, emit: (ev) => this.emit(ev as any), rotate: () => false,
    });
    if (!refreshed || this.busy || this.dead) return;
    await setSessionId(this.cli, this.cwd, '', this.chatId);
    if (this.dead) return;
    this.threadId = null;
    this.seedWindowOnNextTurn = true;
    bankRotation(this.logKey);
    recordContextRotation(this.logKey);
  }

  /** Forever-thread compaction check — see server/src/chat/compaction.ts. */
  private async maybeCompact(): Promise<void> {
    try {
      await maybeAutoCompact({
        key: this.logKey,
        cli: this.cli,
        chatId: this.chatId,
        events: this.eventLog,
        isBusy: () => this.busy,
        emit: (ev) => this.emit(ev as any),
        rotate: async () => {
          this.seedWindowOnNextTurn = true;
          this.threadId = null;
          await setSessionId(this.cli, this.cwd, '', this.chatId);
          bankRotation(this.logKey);
          return false;
        },
      });
    } catch (err) {
      console.warn(`[chat ${this.cli}] compaction check failed for ${this.logKey}:`, (err as Error).message);
    }
  }
  private busy = false;
  private dead = false;
  private currentChild: ChildProcess | null = null;
  /** True after app-server announces turn/started and until turn/completed. */
  private nativeSteerReady = false;
  private nativeSteerWaiters = new Map<string, NativeSteerWaiter>();
  /** Has the person's message got visible text yet; see replyNudge.ts. */
  private readonly replyWatch: ReplyWatch;
  /** Set by shutdown() before the SIGTERM so the in-flight send()'s exit
   *  handler knows not to emit a stray result/turnEnd — the steer/stop
   *  caller is driving the next state itself. */
  private intentionalKill = false;
  private eventLog: SeqEvent[] = [];
  private nextSeq = 1;
  private lastActivityAtMs = Date.now();
  private recoverContextOnNextTurn = false;
  private threadIdWrite: Promise<void> = Promise.resolve();
  private cancellationEmitted = false;
  /** Model of the most recent turn — stamped onto persisted events so a merged
   *  thread log can say which brain produced which turn. */
  private turnModel: string | null = null;
  private turnEffort: string | null = null;
  /** Codex doesn't need a warmup turn — ready immediately. */
  readonly ready: Promise<boolean> = Promise.resolve(true);

  constructor(cwd: string, chatId: string, threadId: string | null, opts: CodexSessionOptions = {}) {
    this.cwd = cwd;
    this.chatId = chatId;
    this.cli = opts.cli ?? 'codex';
    this.key = keyOf(this.cli, cwd, chatId);
    this.logKey = logKeyFor(this.cli, cwd, chatId);
    this.replyWatch = new ReplyWatch(() => agentForChatId(chatId)?.id ?? chatId, this.cli);
    this.threadId = threadId;
    this.recoverContextOnNextTurn = opts.recoverContextOnNextTurn === true;

    // Mirror the claude path: rehydrate eventLog from disk so a server
    // restart between turns doesn't strand a reconnecting client whose
    // sinceSeq is past the new in-memory latestSeq.
    try {
      const restored = loadEventLogSync(this.logKey);
      if (restored.events.length > 0) {
        this.eventLog = restored.events;
        this.nextSeq = restored.nextSeq;
        console.log(
          `[chat codex] restored ${restored.events.length} event(s) from disk for ${this.logKey} (nextSeq=${this.nextSeq})`,
        );
      }
    } catch (err) {
      console.warn(`[chat codex] event-log restore failed for ${this.logKey}:`, (err as Error).message);
    }
    // A different brain spoke last on this thread: its rollout is not ours to
    // resume, so seed compact+50 from the COMPLETE shared log and mark the
    // handover. The 2,000-event replay tail can contain less than one tool-heavy
    // turn and is not a safe continuity source.
    const durableHistory = opts.durableHistory ?? loadEventLogForCompactionSync(this.logKey);
    const history = durableHistory.length ? durableHistory : this.eventLog;
    const priorEngine = lastEngineOf(history);
    const switchedFrom = priorEngine && priorEngine !== this.cli ? priorEngine : null;
    if (switchedFrom) {
      this.seedWindowOnNextTurn = true;
      this.threadId = null;
      this.recoverContextOnNextTurn = true;
      void this.clearPersistedThreadId();
      console.warn(
        `[chat codex] model switch on ${this.logKey}: ${switchedFrom} → ${this.cli} — seeding compact+50 from the thread log`,
      );
      this.emit({
        type: 'event',
        event: { type: '_engine_switch', from: switchedFrom, to: this.cli, ts: Date.now() },
      } as SessionEvent);
    }
    // Never exec-resume a rollout jsonl (tool novels). Seed compact(history − last50) + last 50.
    const visible = extractVisibleTurns(history);
    if (!switchedFrom && (isRotationOwed(this.logKey) || visible.length > WINDOW_TURNS)) {
      this.seedWindowOnNextTurn = true;
      this.threadId = null;
      this.recoverContextOnNextTurn = true;
      void this.clearPersistedThreadId();
      console.warn(
        `[chat codex] seeding compact+50 for ${this.logKey} (visible=${visible.length}, owed=${isRotationOwed(this.logKey)}) — will not exec-resume a rollout dump`,
      );
    } else if (!switchedFrom && !this.threadId && this.eventLog.length > 0) {
      this.recoverContextOnNextTurn = true;
      console.warn(`[chat codex] no saved thread id for ${this.logKey}; will recover context from event log on next turn`);
    }
    void compactEventLog(this.logKey, compactedThroughSeq(this.logKey));
  }

  subscribe(fn: Listener, sinceSeq = -1, countSubscriber = true): () => void {
    if (sinceSeq >= 0) {
      for (const se of this.eventLog) {
        if (se.seq > sinceSeq) fn(se);
      }
    }
    this.listeners.add(fn);
    if (countSubscriber) this.subscriberCount += 1;
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(fn);
      if (countSubscriber) {
        this.subscriberCount = Math.max(0, this.subscriberCount - 1);
        if (this.subscriberCount === 0) this.lastActivityAtMs = Date.now();
      }
    };
  }

  /** Reserve and return the next seq (tombstone writes race a dying session's
   *  own emit path — never let two events share a seq). */
  reserveSeq(): number {
    const seq = reserveEventLogSeq(this.logKey, this.nextSeq);
    this.nextSeq = seq + 1;
    return seq;
  }

  latestSeq(): number {
    return latestEventLogSeq(this.logKey, this.nextSeq - 1);
  }

  isAlive(): boolean {
    return !this.dead;
  }

  isBusy(): boolean {
    return this.busy;
  }

  activeSelection(): { model?: string; effort?: string } {
    return {
      model: this.turnModel ?? undefined,
      effort: this.turnEffort ?? undefined,
    };
  }

  /** Codex app-server accepts true same-turn input through `turn/steer` during
   * inference and tool execution. Unlike `codex exec`, no turn boundary or
   * process interruption is required. */
  canAcceptNativeHumanSteer(): boolean {
    return this.busy
      && this.nativeSteerReady
      && this.currentChild?.exitCode === null
      && this.currentChild.stdin?.writable === true;
  }

  private settleNativeSteer(requestId: string, error?: Error): void {
    const waiter = this.nativeSteerWaiters.get(requestId);
    if (!waiter) return;
    this.nativeSteerWaiters.delete(requestId);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  private rejectNativeSteers(error: Error): void {
    for (const requestId of this.nativeSteerWaiters.keys()) {
      this.settleNativeSteer(requestId, error);
    }
  }

  private sendNativeSteer(text: string, requestId: string): Promise<void> {
    const child = this.currentChild;
    if (!this.canAcceptNativeHumanSteer() || !child?.stdin) {
      return Promise.reject(new Error('the active Codex turn closed before steering'));
    }
    const existing = this.nativeSteerWaiters.get(requestId);
    if (existing) {
      return new Promise((resolve, reject) => {
        const priorResolve = existing.resolve;
        const priorReject = existing.reject;
        existing.resolve = () => { priorResolve(); resolve(); };
        existing.reject = (error) => { priorReject(error); reject(error); };
      });
    }
    return new Promise((resolve, reject) => {
      this.nativeSteerWaiters.set(requestId, { resolve, reject });
      child.stdin!.write(`${JSON.stringify({ type: 'steer', requestId, text })}\n`, (error) => {
        if (error) this.settleNativeSteer(requestId, error);
      });
    });
  }

  sessionId(): string | null {
    return this.threadId;
  }

  listenerCount(): number {
    return this.subscriberCount;
  }

  lastActivityAt(): number {
    return this.lastActivityAtMs;
  }

  /** Async so Stop/Fresh can await the child's full exit (SIGKILL fallback at
   *  3s) before the next app-server resume. Without the await, the dying
   *  child's final rollout writes race the resume read. */
  async shutdown(): Promise<void> {
    if (this.dead) return;
    const shouldEmitCancellation = this.busy;
    this.dead = true;
    this.nativeSteerReady = false;
    this.rejectNativeSteers(new Error('Codex session stopped'));
    const latestThreadId = this.threadId ?? latestThreadIdFromEvents(this.eventLog, this.cli);
    if (latestThreadId) {
      await this.persistThreadId(latestThreadId);
    }
    const child = this.currentChild;
    if (child && child.exitCode === null) {
      this.intentionalKill = true;
      await waitForTreeExit(child);
    }
    await this.threadIdWrite.catch(() => undefined);
    if (shouldEmitCancellation) this.emitCancellationTurnEnd();
  }

  private persistThreadId(threadId: string): Promise<void> {
    this.threadId = threadId;
    this.threadIdWrite = this.threadIdWrite.then(
      () => setSessionId(this.cli, this.cwd, threadId, this.chatId),
      () => setSessionId(this.cli, this.cwd, threadId, this.chatId),
    );
    return this.threadIdWrite;
  }

  private clearPersistedThreadId(): Promise<void> {
    this.threadId = null;
    this.threadIdWrite = this.threadIdWrite.then(
      () => setSessionId(this.cli, this.cwd, '', this.chatId),
      () => setSessionId(this.cli, this.cwd, '', this.chatId),
    );
    return this.threadIdWrite;
  }

  private emitCancellationTurnEnd(): void {
    if (this.cancellationEmitted) return;
    this.cancellationEmitted = true;
    this.busy = false;
    this.currentChild = null;
    this.nativeSteerReady = false;
    this.rejectNativeSteers(new Error('Codex turn interrupted'));
    this.emit({ type: 'event', event: { type: '_interrupted', ts: Date.now() } });
    this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
  }

  async send(text: string, images?: ChatImage[], opts: CodexSendOptions = {}): Promise<void> {
    if (this.contextMaintenance) await this.contextMaintenance;
    if (opts.signal?.aborted) return;
    if (this.busy) {
      const nativeSteerAllowed = opts.peerFrom
        ? opts.allowNativePeerSteer === true
        : opts.allowNativeHumanSteer === true;
      if (!nativeSteerAllowed) {
        // A caller that did not win native admission must wait for a boundary;
        // never turn concurrent stdin into implicit steering.
        if (!opts.peerFrom) {
          // The register layer counts a resolved send() as delivered. Emitting
          // an error event and returning used to make a busy-turn human send
          // look delivered while the text never reached Codex. Throw instead
          // so the caller rejects the steer honestly.
          throw new Error('Codex is still answering. Queue guidance or wait for the current turn.');
        }
        return;
      }
      if (!this.canAcceptNativeHumanSteer()) {
        throw new Error('the active Codex steer channel closed before delivery');
      }
      let steerText = text;
      let steerAttachments: Array<{ id: string; mediaType: string }> = [];
      if (images?.length) {
        if (!opts.imagesAsFiles || opts.peerFrom) {
          throw new Error('Images cannot attach mid-turn. Wait for this turn to finish, then send them again.');
        }
        steerAttachments = opts.skipAttachments ? [] : await saveChatAttachments(images);
        if (opts.signal?.aborted) return;
        // The save awaited: the turn may have ended meanwhile. The caller treats
        // this as a closed window and sends the pictures as a normal new turn.
        if (!this.canAcceptNativeHumanSteer()) {
          throw new Error('the active Codex steer channel closed before delivery');
        }
        const paths = steerAttachments.map((a) => chatAttachmentPath(a.id));
        steerText = paths.length
          ? `${text}\n\n[Matt attached ${paths.length === 1 ? 'a screenshot' : `${paths.length} screenshots`}. Open ${paths.length === 1 ? 'it' : 'them'} with the view_image tool before replying: ${paths.join(', ')}]`
          : `${text}\n\n[Matt attached ${images.length === 1 ? 'a screenshot' : 'screenshots'} that could not be saved. Ask him to resend if it matters.]`;
      }

      await this.sendNativeSteer(
        steerText,
        opts.peerDeliveryId ?? opts.clientMsgId ?? randomUUID(),
      );
      // Echo only after app-server accepted turn/steer. This is the same durable
      // admission contract used for a brand-new turn, without a fake turnStart.
      if (opts.peerFrom) {
        this.emit({
          type: 'event',
          event: {
            type: 'peer_message',
            from: opts.peerFrom,
            fromRole: opts.peerFromRole ?? '',
            text: opts.peerText !== undefined ? opts.peerText : text,
            ...(opts.peerDeliveryId ? { deliveryId: opts.peerDeliveryId } : {}),
            ts: Date.now(),
          },
        });
        if (isPersonMessage(opts)) this.replyWatch.arm();
        if (opts.peerDeliveryId) {
          this.emit({
            type: 'event',
            event: { type: 'peer_delivery_accepted', deliveryId: opts.peerDeliveryId, ts: Date.now() },
          });
        }
      } else {
        this.emit({
          type: 'event',
          event: {
            type: '_user_echo',
            text,
            imageCount: images?.length ?? 0,
            attachments: steerAttachments,
            clientMsgId: opts.clientMsgId,
            ts: Date.now(),
          },
        });
        noteUserTurn(this.logKey);
        noteAgentLane(this.chatId, this.cli);
        this.replyWatch.arm();
      }
      return;
    }
    const { model: codexModel, effort: codexEffort } = resolveCodexSelection(
      opts.model,
      opts.effort,
    );
    this.turnModel = codexModel;
    this.turnEffort = codexEffort;
    this.busy = true;
    this.cancellationEmitted = false;
    if (!opts.suppressEcho) this.replyWatch.reset();
    const recoverContextThisTurn = this.recoverContextOnNextTurn;
    const historyThroughSeq = this.latestSeq();
    const fallbackHistory = this.eventLog.slice();
    // Echo for reconnect replay (codex's events don't re-emit the user prompt).
    // peerFrom marks a team-bus delivery: sender-tagged bubble, no compaction tick.
    if (opts.signal?.aborted) {
      this.busy = false;
      return;
    }
    if (opts.peerFrom && !opts.suppressEcho) {
      this.emit({ type: 'turnStart' });
      this.emit({
        type: 'event',
        event: {
          type: 'peer_message',
          from: opts.peerFrom,
          fromRole: opts.peerFromRole ?? '',
          text: opts.peerText !== undefined ? opts.peerText : text,
          ...(opts.peerDeliveryId ? { deliveryId: opts.peerDeliveryId } : {}),
          ts: Date.now(),
        },
      });
      if (isPersonMessage(opts)) this.replyWatch.arm();
    } else if (!opts.suppressEcho) {
      let attachments: Array<{ id: string; mediaType: string }>;
      try {
        attachments = opts.skipAttachments ? [] : await saveChatAttachments(images);
      } catch (error) {
        this.busy = false;
        throw error;
      }
      if (opts.signal?.aborted) {
        this.busy = false;
        return;
      }
      await flushEventLog(this.logKey);
      if (opts.signal?.aborted) {
        this.busy = false;
        return;
      }
      try {
        this.emit({
          type: 'event',
          event: { type: '_user_echo', text, imageCount: images?.length ?? 0, attachments, clientMsgId: opts.clientMsgId, ts: Date.now() },
        });
      } catch (error) {
        this.busy = false;
        throw error;
      }
      noteUserTurn(this.logKey); // compaction cadence (monotonic)
      noteAgentLane(this.chatId, this.cli); // historical lane diagnostics
      this.replyWatch.arm();
    }

    try {
      assertMemoryAvailableForSpawn('codex');
    } catch (error) {
      this.busy = false;
      this.emit({
        type: 'error',
        code: error instanceof MemoryPressureSpawnError ? error.code : undefined,
        retryable: true,
        message: (error as Error).message,
      });
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
      return;
    }

    let imageTempDir: string | null = null;
    const cleanupImages = () => {
      if (imageTempDir) void rm(imageTempDir, { recursive: true, force: true });
    };

    const imagePaths: string[] = [];
    try {
      if (images?.length) {
        imageTempDir = await mkdtemp(join(tmpdir(), 'samwise-codex-images-'));
        for (const [index, image] of images.entries()) {
          if (!image.mediaType.startsWith('image/')) {
            throw new Error(`unsupported image media type: ${image.mediaType}`);
          }
          const path = join(imageTempDir, `image-${index + 1}.${imageExtension(image.mediaType)}`);
          await writeFile(path, Buffer.from(image.base64, 'base64'));
          imagePaths.push(path);
        }
      }
    } catch (e) {
      cleanupImages();
      this.busy = false;
      this.emit({ type: 'error', message: `image preparation failed: ${(e as Error).message}` });
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
      return;
    }

    // Account-pinned lanes (chatId carries `__acct__<account>`) force that exact
    // login; everything else keeps the per-repo account-map resolution. Resolved
    // before the seed so the rollout lookup below reads the same CODEX_HOME the
    // turn will bill.
    const forcedAccount = accountFromChatId(this.chatId);
    const childEnv = forcedAccount ? accountEnvForAccount(forcedAccount, this.cwd) : accountEnv(this.cwd);
    // Resuming a rollout codex no longer has fails the whole turn with "no
    // rollout found for thread id …" before the model sees the prompt. Check
    // first: an unresumable thread becomes a fresh one seeded with the compact
    // window, which costs context rather than the answer.
    if (this.threadId && codexRolloutMissing(codexHomeFor(childEnv), this.threadId)) {
      const unresumable = this.threadId;
      // Drops the in-memory id synchronously; a failed write is not worth
      // wedging a busy lane over, and the next turn re-checks the rollout.
      await this.clearPersistedThreadId().catch(() => undefined);
      this.seedWindowOnNextTurn = true;
      console.warn(
        `[chat codex] no rollout for thread ${unresumable} on ${this.logKey} — starting a fresh thread and seeding the window`,
      );
    }
    const hasSeedOverride = typeof opts.seedOverride === 'string';
    const seedWindow = !hasSeedOverride && (this.consumeWindowSeed() || recoverContextThisTurn);
    const seed = hasSeedOverride
      ? opts.seedOverride as string
      : seedWindow
        ? await peekEnginePrimerThroughSeq(this.logKey, historyThroughSeq, fallbackHistory)
        : '';
    if (seed) {
      this.recoverContextOnNextTurn = false;
      if (!hasSeedOverride) {
        this.emit({
          type: 'event',
          event: { type: '_context_recovered', chars: seed.length, ts: Date.now() },
        });
      }
    } else if (recoverContextThisTurn) {
      this.recoverContextOnNextTurn = false;
    }
    const personaScope = personaPromptFor(this.chatId);
    const conversationGuidance = conversationGuidanceForTurn({
      chatId: this.chatId, logKey: this.logKey, historyThroughSeq,
      peerFrom: opts.peerFrom,
      peerFromRole: opts.peerFromRole,
    });
    const prompt = `${computerGuidance(this.chatId, agentForChatId(this.chatId)?.name ?? 'Companion', !opts.peerFrom && opts.peerFromRole !== 'automation', false, !(seedWindow || hasSeedOverride))}\n\n${personaScope ? `${personaScope}\n\n---\n\n` : ''}${CODEX_TURN_PREAMBLE}\n\n${seed ? `${seed}\n\n---\n\n` : ''}${conversationGuidance ? `${conversationGuidance}\n\n` : ''}${opts.voiceMode ? `${THREAD_VOICE_STYLE_ADDENDUM}\n\n` : ''}${text}`;
    // The operator's browser bridge, the same MCP server Claude lanes get. Passed as
    // -c overrides rather than written into ~/.codex/config.toml so this stays
    // scoped to TARDIS.
    const browserMcpEntry = process.env.RIVENDELL_BROWSER_MCP?.trim() || '';
    const browserMcpArgs: string[] = [];
    if (browserMcpEntry && existsSync(browserMcpEntry)) {
      browserMcpArgs.push(
        '-c', 'mcp_servers.rivendell-browser.command="node"',
        '-c', `mcp_servers.rivendell-browser.args=${JSON.stringify([browserMcpEntry])}`,
      );
    }
    const laneName = agentForChatId(this.chatId)?.name;
    browserMcpArgs.push(...localMcpCodexArgs(laneName ?? 'Teammate', { unnamedLane: !laneName }), ...officeMcpCodexArgs());
    const appServerArgs = buildCodexAppServerArgs([...browserMcpArgs, '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"']);

    // Wait for OneDrive to release its sync lock on .codex/config.toml so
    // codex's own read at startup doesn't fail with EDEADLK and kill the turn.
    const configProbe = await probeProjectConfig(this.cwd);
    if (!configProbe.ok) {
      cleanupImages();
      this.busy = false;
      this.emit({
        type: 'error',
        code: 'CODEX_PROJECT_CONFIG_LOCKED',
        retryable: true,
        message: configProbe.message,
      });
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
      return;
    }
    if (this.dead) {
      cleanupImages();
      this.emitCancellationTurnEnd();
      return;
    }

    const turnStartedAtMs = Date.now();
    const child = spawn(process.execPath, [CODEX_APP_TURN_SCRIPT], {
      cwd: this.cwd,
      // The marker tells the installed long-call gate hook this is a TARDIS agent turn.
      env: { ...childEnv, ...longCallGateEnv(this.chatId) },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.currentChild = child;
    // The adapter queues turn/steer requests received during app-server startup
    // and flushes them against the announced active turn id.
    this.nativeSteerReady = true;

    // Synthesize a claude-shaped message_start so the reducer's turn handling
    // stays consistent across CLIs.
    const turnState: CodexTurnState = {
      messageId: synth('msg'),
      nextBlockIndex: 0,
      toolUseBlocks: new Map(),
      usage: null,
    };
    // Tracks whether this turn produced any model-visible progress so we can
    // surface a real error when Codex exits empty (the "thinking then nothing"
    // UX failure mode). Codex can return exit 1 with zero agent_message and
    // almost no stderr, which used to leave TARDIS with only a silent
    // error_during_execution result and no chat-visible reason.
    let producedAgentMessage = false;
    let sawActionableItem = false;
    let sawTurnCompleted = false;
    let peerAdmissionSettled = false;
    let settlePeerAdmission: (accepted: boolean) => void = () => {};
    const peerAdmission = opts.peerDeliveryId
      ? new Promise<boolean>((resolve) => {
          settlePeerAdmission = (accepted) => {
            if (peerAdmissionSettled) return;
            peerAdmissionSettled = true;
            resolve(accepted);
          };
        })
      : null;
    const stderrChunks: string[] = [];
    let transientProjectConfigError: string | null = null;

    const rememberTransientProjectConfigError = (text: string) => {
      if (!isTransientFileProviderError(text) || !CODEX_PROJECT_CONFIG_ERROR.test(text)) return false;
      transientProjectConfigError =
        'OneDrive locked Codex project config while Codex was starting. ' +
        `Retry in a moment, or move ASSISTANT-HUB off OneDrive. Last error: ${text}`;
      this.emit({
        type: 'error',
        code: 'CODEX_PROJECT_CONFIG_LOCKED',
        retryable: true,
        message: transientProjectConfigError,
      });
      return true;
    };

    const handleStdoutLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        if (ev?.type === 'turn.failed' || ev?.type === 'error') {
          noteProviderGateFailure('Codex', () => agentForChatId(this.chatId)?.name ?? this.chatId, String(ev.error?.message ?? ev.message ?? ''));
        }
        if (ev?.type === 'rivendell.steer.accepted' && typeof ev.request_id === 'string') {
          this.settleNativeSteer(ev.request_id);
          return;
        }
        if (ev?.type === 'rivendell.steer.rejected' && typeof ev.request_id === 'string') {
          this.settleNativeSteer(
            ev.request_id,
            new Error(typeof ev.message === 'string' ? ev.message : 'Codex rejected same-turn steering'),
          );
          return;
        }
        if (ev?.type === 'turn.started') {
          this.nativeSteerReady = true;
          if (opts.peerDeliveryId && !peerAdmissionSettled) {
            this.emit({
              type: 'event',
              event: { type: 'peer_delivery_accepted', deliveryId: opts.peerDeliveryId, ts: Date.now() },
            });
            settlePeerAdmission(true);
          }
        }
        if (ev?.type === 'item.completed' && ev?.item?.type === 'agent_message') {
          producedAgentMessage = true;
        }
        if (
          (ev?.type === 'item.started' || ev?.type === 'item.completed')
          && typeof ev?.item?.type === 'string'
          && !['reasoning', 'agent_message', 'error'].includes(ev.item.type)
        ) {
          sawActionableItem = true;
        }
        if (ev?.type === 'turn.completed') {
          sawTurnCompleted = true;
          this.nativeSteerReady = false;
        }
        this.handleCodexEvent(ev, turnState);
        this.watchReply(ev);
      } catch {
        // Non-JSON line — ignore.
      }
    };
    let buf = '';
    const flushStdout = () => {
      if (buf.trim()) handleStdoutLine(buf);
      buf = '';
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        handleStdoutLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    });
    child.stdout.on('end', flushStdout);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Codex stderr mixes real failures with structured internal tracing.
      // The common `write_stdin failed: stdin is closed` trace is Codex's own
      // recovery path after a non-TTY command, not a user-actionable chat
      // error, so keep it out of the transcript.
      for (const raw of chunk.split('\n')) {
        const text = raw.trim();
        if (!text) continue;
        noteProviderGateFailure('Codex', () => agentForChatId(this.chatId)?.name ?? this.chatId, text);
        if (isIgnorableCodexStderr(text)) continue;
        if (rememberTransientProjectConfigError(text)) continue;
        stderrChunks.push(text);
        this.emit({ type: 'error', message: text });
      }
    });

    let childTerminalHandled = false;
    child.on('close', async (code, signal) => {
      if (childTerminalHandled) return;
      childTerminalHandled = true;
      flushStdout();
      settlePeerAdmission(false);
      console.log(
        `[chat codex] child close cwd=${this.cwd} code=${code} threadId=${this.threadId ?? '-'}`,
      );
      // Keep busy=true until the matching turnEnd is ready to emit. Clearing it
      // here allowed team delivery to start during the persistence awaits below;
      // this old turn's delayed turnEnd then completed the NEW delivery waiter.
      this.currentChild = null;
      this.nativeSteerReady = false;
      this.rejectNativeSteers(new Error('Codex turn process closed'));
      cleanupImages();
      // Intentional kill (shutdown driven by steer/stop): the WS register
      // layer is already binding a new session and emitting its own turnStart.
      // A result/turnEnd from this dying turn would race that and dirty the
      // transcript.
      if (this.intentionalKill) return;
      const stderrText = stderrChunks.join('\n').trim();
      if (code !== 0 && !transientProjectConfigError && rememberTransientProjectConfigError(stderrText)) {
        stderrChunks.length = 0;
      }
      this.closeDanglingToolBlocks(turnState, code, transientProjectConfigError ?? stderrText);
      // Killed mid-turn (OOM SIGKILL / 137) with no reply delivered. An `error`
      // event reaches the UI but NOT the model window — extractVisibleTurns only
      // keeps user/assistant turns — so the next turn would see a blank window
      // and report it did nothing. Leave an assistant-shaped marker instead.
      if (!producedAgentMessage && (signal === 'SIGKILL' || code === 137)) {
        try {
          this.emit(crashTombstoneEvent(crashTombstoneText({
            cli: 'codex',
            cwd: this.cwd,
            sessionId: this.threadId,
            code: code ?? null,
            signal: signal ?? null,
            ranMs: Date.now() - turnStartedAtMs,
          })));
        } catch (err) {
          console.warn('[chat codex] tombstone emit failed:', (err as Error).message);
        }
      }
      // Surface empty / hard-fail turns. Codex sometimes starts a task and then
      // completes with last_agent_message=null + exit 1 and no useful stderr.
      // Without an explicit error event the UI just drops out of "thinking".
      const emptyTurn =
        !producedAgentMessage && !transientProjectConfigError && (code !== 0 || !sawTurnCompleted);
      const retryEmptyTurn = !opts.signal?.aborted && shouldRetryEmptyCodexTurn({
        code,
        signal,
        producedAgentMessage,
        sawActionableItem,
        sawTurnCompleted,
        stderr: stderrText,
        transientProjectConfigError: Boolean(transientProjectConfigError),
        retryDepth: opts.emptyRetryDepth ?? 0,
      });
      if (retryEmptyTurn) {
        const failedThread = this.threadId;
        this.threadId = null;
        await setSessionId(this.cli, this.cwd, '', this.chatId);
        let retrySeed = seed;
        if (!retrySeed) {
          retrySeed = await peekEnginePrimerThroughSeq(this.logKey, historyThroughSeq, fallbackHistory).catch(() => '');
        }
        this.seedWindowOnNextTurn = false;
        this.recoverContextOnNextTurn = false;
        this.busy = false;
        console.warn(`[chat codex] empty exit from ${failedThread ?? 'new thread'} — retrying once on a fresh thread`);
        try {
          await this.send(text, images, {
            ...opts,
            emptyRetryDepth: (opts.emptyRetryDepth ?? 0) + 1,
            suppressEcho: true,
            seedOverride: retrySeed,
            skipAttachments: true,
          });
        } catch (error) {
          this.busy = false;
          this.emit({ type: 'error', message: `Codex retry failed before starting: ${(error as Error).message}` });
          this.emitClaudeEvent({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            session_id: this.threadId ?? undefined,
          });
          this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
        }
        return;
      }
      if (emptyTurn) {
        const detail = stderrText
          ? stderrText.slice(0, 500)
          : `codex exit ${code ?? 'null'} with no agent message (thread ${this.threadId ?? 'new'})`;
        this.emit({
          type: 'error',
          message:
            code === 0
              ? `Codex finished without a reply. ${detail}`
              : `Codex failed before producing a reply. ${detail}`,
        });
      } else if (code !== 0 && !transientProjectConfigError && stderrText) {
        // Non-empty stderr already emitted line-by-line above; if filtering ate
        // everything, still leave a breadcrumb.
        if (stderrChunks.length === 0) {
          this.emit({
            type: 'error',
            message: `Codex exited ${code} without a delivered reply.`,
          });
        }
      }
      // Emit a result event so the front-end flips status back to 'ready'.
      // Forward codex's per-turn token usage (captured from `turn.completed`)
      // mapped to claude's field names so the same client-side meter works.
      this.emitClaudeEvent({
        type: 'result',
        subtype: code === 0 ? 'success' : 'error_during_execution',
        is_error: code !== 0,
        session_id: this.threadId ?? undefined,
        usage: turnState.usage ?? undefined,
      });
      if (emptyTurn && code !== 0) {
        // Drop poisoned thread ids after empty hard-fails so the next send
        // starts clean instead of resuming a corpse that keeps exiting 1.
        // Do not go through persistThreadId('') — that would leave this.threadId as ''.
        const deadThread = this.threadId;
        this.threadId = null;
        await setSessionId(this.cli, this.cwd, '', this.chatId);
        this.seedWindowOnNextTurn = true;
        if (deadThread) {
          console.warn(
            `[chat codex] cleared poisoned thread ${deadThread} after empty exit ${code}`,
          );
        }
      } else if (this.threadId) {
        if (seed) await this.ackWindowSeed();
        await this.persistThreadId(this.threadId);
      }
      this.busy = false;
      const rotationDue = contextRotationDue(this.logKey) && code === 0;
      if (rotationDue) {
        this.contextMaintenance = this.rotateContextAtBoundary().catch((err) => {
          console.warn(`[context-rotation] ${this.logKey}: deferred after maintenance failure`, (err as Error).message);
        }).finally(() => { this.contextMaintenance = null; });
      }
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
      // Forever-thread housekeeping: compact after successful turns only —
      // error/interrupt paths retry on the next clean turn end.
      if (!rotationDue) void this.maybeCompact();
    });

    child.on('error', (err) => {
      if (childTerminalHandled) return;
      childTerminalHandled = true;
      flushStdout();
      settlePeerAdmission(false);
      this.busy = false;
      this.currentChild = null;
      this.nativeSteerReady = false;
      this.rejectNativeSteers(err);
      cleanupImages();
      this.closeDanglingToolBlocks(turnState, null, err.message);
      this.emit({ type: 'error', message: `codex spawn failed: ${err.message}` });
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
    });

    child.stdin!.write(`${JSON.stringify({
      type: 'start',
      codexBin: CODEX_BIN,
      appServerArgs,
      cwd: this.cwd,
      threadId: this.threadId,
      model: codexModel,
      effort: codexEffort,
      prompt,
      imagePaths,
    })}\n`, (error) => {
      if (error) child.emit('error', error);
    });

    if (peerAdmission) await peerAdmission;
  }

  // ── private ────────────────────────────────────────────────

  ingestExternalEvent(se: SeqEvent): void {
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    for (const fn of this.listeners) fn(se);
  }

  private emit(msg: SessionEvent): void {
    msg = redactComputerImages(msg);
    if (isPlumbingEvent(msg)) return;
    this.lastActivityAtMs = Date.now();
    const se: SeqEvent = { seq: this.reserveSeq(), ev: msg, at: Date.now() };
    const persisted = { ...se, eng: this.cli, ...(this.turnModel ? { mdl: this.turnModel } : {}) };
    const durableUserEcho = msg.type === 'event' && msg.event?.type === '_user_echo';
    if (durableUserEcho && !appendEventLogSync(this.logKey, persisted)) {
      throw new Error('could not durably accept the user message');
    }
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) {
      this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    }
    if (!durableUserEcho) appendEventLog(this.logKey, persisted);
    for (const fn of this.listeners) fn(se);
  }

  /** Forward an event already in claude stream-json shape. */
  private emitClaudeEvent(event: any): void {
    this.emit({ type: 'event', event });
  }

  /** The person's message needs visible text (an agent_message), and a turn
   *  that has run tools without one gets the harness note as a native turn/steer,
   *  which cancels nothing. Checked as each tool item completes. */
  private watchReply(ev: any): void {
    try {
      const item = ev?.item;
      if (typeof item?.type !== 'string') return;
      if (item.type === 'agent_message') {
        if (ev.type === 'item.completed' && typeof item.text === 'string' && item.text.trim()) this.replyWatch.noteText();
        return;
      }
      if (item.type === 'reasoning' || item.type === 'error') return;
      if (ev.type === 'item.started') {
        this.replyWatch.noteTool(String(item.id));
        return;
      }
      if (ev.type !== 'item.completed' || !this.canAcceptNativeHumanSteer()) return;
      const nudge = this.replyWatch.claim();
      if (!nudge) return;
      this.sendNativeSteer(REPLY_NUDGE_NOTE, randomUUID())
        .then(() => this.emit(replyNudgeEvent(nudge)))
        .catch((err) => {
          this.replyWatch.release(nudge);
          console.warn('[reply-nudge] codex steer failed:', (err as Error).message);
        });
    } catch (err) {
      console.warn('[reply-nudge] codex check failed:', (err as Error).message);
    }
  }

  private handleCodexEvent(
    ev: any,
    state: CodexTurnState,
  ): void {
    if (ev?.type === 'rivendell.context_usage') {
      recordContextUsage(this.logKey, 'codex', ev.usage);
      return;
    }
    if (!ev || typeof ev !== 'object') return;

    // Capture the thread id for resume on later turns.
    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
      void this.persistThreadId(ev.thread_id);
      this.emitClaudeEvent({
        type: 'system',
        subtype: 'init',
        session_id: ev.thread_id,
      });
      return;
    }

    if (ev.type === 'turn.started') {
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: state.messageId, role: 'assistant' },
        },
      });
      return;
    }

    if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
      const idx = state.nextBlockIndex++;
      const toolUseId = synth('tool');
      state.toolUseBlocks.set(ev.item.id, {
        index: idx,
        toolUseId,
      });
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'tool_use', id: toolUseId, name: 'Bash' },
        },
      });
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: idx,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ command: ev.item.command ?? '' }),
          },
        },
      });
      return;
    }

    if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') {
      const block = state.toolUseBlocks.get(ev.item.id);
      if (!block) return;
      this.emitClaudeEvent({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: block.index },
      });
      // Emit a synthetic user message carrying the tool_result, the way
      // claude does, so the reducer attaches the output to the right block.
      const output: string = ev.item.aggregated_output ?? '';
      this.emitClaudeEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: block.toolUseId,
              content: [{ type: 'text', text: output }],
            },
          ],
        },
      });
      state.toolUseBlocks.delete(ev.item.id);
      return;
    }

    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
      const idx = state.nextBlockIndex++;
      const text: string = typeof ev.item.text === 'string' ? ev.item.text : '';
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'text', text: '', phase: ev.item.phase },
        },
      });
      this.emitClaudeEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text },
        },
      });
      this.emitClaudeEvent({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: idx },
      });
      return;
    }

    // Capture per-turn token usage from `turn.completed` so the front-end
    // context meter has real numbers instead of leftover Claude figures.
    // Codex reports `input_tokens` (full prompt incl. cache) and
    // `cached_input_tokens` (cache hits) — map to claude's field names.
    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      const u = ev.usage as Record<string, number | undefined>;
      const input = Number(u.input_tokens ?? 0);
      const cached = Number(u.cached_input_tokens ?? 0);
      const output = Number(u.output_tokens ?? 0);
      const effectiveInput = cached > 0 && cached < input ? input - cached : input;
      state.usage = {
        // Codex reports huge cumulative cache-read counts. For the context
        // meter, show the effective fresh input instead of reconstructing the
        // full cache history and producing impossible multi-million totals.
        input_tokens: Math.max(0, effectiveInput),
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: output,
      };
      return;
    }

    // Other event types — ignore.
  }

  private closeDanglingToolBlocks(
    state: CodexTurnState,
    code: number | null,
    detail: string,
  ): void {
    if (state.toolUseBlocks.size === 0) return;

    const fallback = code === 0
      ? 'Codex finished before reporting command output.'
      : `Codex exited before this command returned${typeof code === 'number' ? ` (code ${code})` : ''}.`;
    const text = detail || fallback;

    for (const block of state.toolUseBlocks.values()) {
      this.emitClaudeEvent({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: block.index },
      });
      this.emitClaudeEvent({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: block.toolUseId,
              content: [{ type: 'text', text }],
            },
          ],
        },
      });
    }
    state.toolUseBlocks.clear();
  }
}

function keyOf(cli: CliKind, cwd: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  return normalized === 'main' ? `${cli}|${cwd}` : `${cli}|${cwd}|${normalized}`;
}

/** Manager keyed by cwd + chat id, matching the claude session map. */
const codexSessions = new Map<string, CodexSession>();

export function publishCodexExternalEvent(logKey: string, se: SeqEvent): void {
  for (const session of codexSessions.values()) {
    if (session.logKey === logKey) session.ingestExternalEvent(se);
  }
}

/** See markBusyLanesRestarting in runner.ts. */
export function markBusyCodexLanesRestarting(signal: string): number {
  let marked = 0;
  for (const s of codexSessions.values()) {
    if (!s.isBusy()) continue;
    try {
      const session = s as unknown as { logKey: string; reserveSeq(): number; cli: string };
      if (appendEventLogSync(session.logKey, {
        seq: session.reserveSeq(),
        at: Date.now(),
        ev: restartMarkerEvent(signal) as never,
        eng: session.cli,
      })) marked++;
    } catch (err) {
      console.warn(`[tardis] restart tombstone failed for ${s.key}:`, (err as Error).message);
    }
  }
  return marked;
}

export function activeCodexSessions(): {
  cli: CliKind;
  cwd: string;
  chatId: string;
  busy: boolean;
  sessionId: string | null;
  lastActivityAt: number;
}[] {
  return Array.from(codexSessions.values()).map((s) => ({
    cli: s.cli,
    cwd: s.cwd,
    chatId: s.chatId,
    busy: s.isBusy(),
    sessionId: s.sessionId(),
    lastActivityAt: s.lastActivityAt(),
  }));
}

export function pruneIdleCodexSessions(ttlMs: number, now = Date.now()): number {
  let pruned = 0;
  for (const [key, session] of codexSessions) {
    if (session.isBusy()) continue;
    if (session.listenerCount() > 0) continue;
    if (now - session.lastActivityAt() < ttlMs) continue;
    // Idle reaper: no listeners, not busy, so we can fire-and-forget the
    // SIGTERM. We don't need to await the child exit here — there's no
    // racing resume to worry about.
    void session.shutdown();
    codexSessions.delete(key);
    pruned += 1;
  }
  return pruned;
}

export async function getOrCreateCodexSession(opts: {
  repoPath: string;
  chatId?: string;
  cli?: CliKind;
}): Promise<CodexSession> {
  const cwd = opts.repoPath;
  const chatId = opts.chatId || 'main';
  const cli = opts.cli ?? 'codex';
  const key = keyOf(cli, cwd, chatId);
  const existing = codexSessions.get(key);
  if (existing && existing.isAlive()) {
    await flushEventLog(existing.logKey);
    const priorEngine = lastEngineOf(loadEventLogSync(existing.logKey).events);
    if (!existing.isBusy() && priorEngine && priorEngine !== cli) {
      // This Codex rollout predates turns written by another brain. Resuming it
      // would answer from stale context even though the UI thread is shared.
      codexSessions.delete(key);
      await existing.shutdown();
    } else {
      return existing;
    }
  }

  const threadId = (await getSessionId(cli, cwd, chatId)) ?? null;
  const logKey = logKeyFor(cli, cwd, chatId);
  await flushEventLog(logKey);
  const durableHistory = loadEventLogForCompactionSync(logKey);
  const session = new CodexSession(cwd, chatId, threadId, { cli, durableHistory });
  codexSessions.set(key, session);
  return session;
}

export function shutdownAllCodexSessions(): void {
  // Process-exit path: fire-and-forget the SIGTERM. Node will reap children
  // as the event loop drains.
  for (const s of codexSessions.values()) void s.shutdown();
  codexSessions.clear();
}

/** Kill the in-flight Codex adapter and wait for it to fully exit before
 *  returning. Stop/Fresh need the await so the next app-server resume does not
 *  race the dying child's writes to the rollout. */
export async function interruptCodex(opts: { repoPath: string; chatId?: string; cli?: CliKind }): Promise<void> {
  const cwd = opts.repoPath;
  const key = keyOf(opts.cli ?? 'codex', cwd, opts.chatId || 'main');
  const s = codexSessions.get(key);
  if (s) {
    codexSessions.delete(key);
    await s.shutdown();
  }
}

/** Drop the stored thread id so the next codex spawn starts a fresh thread. */
export async function freshStartCodex(opts: {
  repoPath: string;
  chatId?: string;
  cli?: CliKind;
}): Promise<CodexSession> {
  const cwd = opts.repoPath;
  const chatId = opts.chatId || 'main';
  const cli = opts.cli ?? 'codex';
  const key = keyOf(cli, cwd, chatId);
  const existing = codexSessions.get(key);
  if (existing) {
    codexSessions.delete(key);
    await existing.shutdown();
  }
  await setSessionId(cli, cwd, '', chatId);
  // Wipe the durable log before the new session loads it, so a reset thread
  // can't be resurrected by a full (sinceSeq=0) replay from an empty client.
  const logKey = logKeyFor(cli, cwd, chatId);
  // Delete external compact memory before the visible transcript, so a remote
  // failure leaves the old thread coherent and Fresh can be retried safely.
  await clearThreadMemory(logKey, chatId);
  await clearEventLog(logKey);
  const session = new CodexSession(cwd, chatId, null, { cli, durableHistory: [] });
  codexSessions.set(key, session);
  return session;
}
