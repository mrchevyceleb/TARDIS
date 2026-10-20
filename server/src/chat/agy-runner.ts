import { prepareSessionStateDelta } from './sessionContext.ts';
/** Agy engine lane — Google's Antigravity CLI (`agy`) on Matt's subscription.
 *
 *  Protocol (probed 2026-10-14, headless): one persistent
 *  `agy --input-format stream-json --output-format stream-json` process per
 *  lane. Each NDJSON line `{"event":"user","message":{role,content}}` written
 *  to stdin runs one turn; stdout replies with `{"event":…}` envelopes:
 *    init        → system/init (conversation_id, model, tools)
 *    step_update → user_input DONE | agent_response ACTIVE/DONE (text_delta)
 *    result      → the turn's terminal outcome (SUCCESS/ERROR, response, usage)
 *  agy has no system-prompt flag, so the persona + operating guidance ride the
 *  top of each turn's message content (same composition Pi builds). agy runs
 *  its own built-in tools under --dangerously-skip-permissions; its tool steps
 *  are not yet mapped into the transcript (v1 limit, see the PR).
 *
 *  AgySession mirrors PiSession's public surface so register.ts, teamBus and
 *  the session registry treat every lane alike, and it writes the SAME
 *  claude-shaped event vocabulary into the same durable thread log, so the
 *  transcript, the UI, compaction and engine switches are unchanged. */

import { type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnLaneWorker } from '../lib/workerReap.ts';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { assertSubscriptionLane, agySubscriptionEnvironment } from './subscription-policy.ts';
import { computerGuidance } from '../devices/context.ts';
import { redactComputerImages } from '../devices/transcript.ts';
import { setSessionId } from './sessions.ts';
import { appendEventLog, appendEventLogSync, flushEventLog, isPlumbingEvent, latestEventLogSeq, loadEventLogSync, reserveEventLogSeq, type PersistedEvent } from './event-log-store.ts';
import { maybeAutoCompact, noteUserTurn, bankRotation, isRotationOwed, clearRotation, peekEnginePrimerThroughSeq, refreshCompactForRotation } from './compaction.ts';
import { contextRotationDue, recordContextUsage, recordContextRotation } from './contextBudget.ts';
import { isAgentThread, isBackgroundChatId, logKeyFor } from './threadKey.ts';
import { recallBlockForTurn, recallEligibleTurn } from './autoRecall.ts';
import { personaPromptFor } from './personaPrompts.ts';
import { prioritiesBlockFor } from '../lib/prioritiesStore.ts';
import { agentForChatId, noteAgentLane } from './agents.ts';
import { adaptImagesForTextModel } from './vision-adapter.ts';
import { saveChatAttachments } from '../routes/chatAttachments.ts';
import { conversationGuidanceForTurn, laneContextForTurn } from './conversation-guidance.ts';
import { isVoiceChatId, isRobotVoiceChatId, robotVoiceAddendum, THREAD_VOICE_STYLE_ADDENDUM, VOICE_STYLE_ADDENDUM } from './voicePrompt.ts';
import { TRANSCRIPT_GUIDANCE } from './transcriptGuidance.ts';
import { emptyTurnOrigin, noteTurnPeer, type TurnOrigin } from './providerSwitch.ts';
import { longCallGateEnv } from './longCallGate.ts';
import { wellFormedText } from '../lib/wellFormed.ts';
import { laneTagFor, shareBackgroundLaneEvent, type CliKind, type SeqEvent, type SessionEvent } from './runner.ts';
import { plainEnglishWritingBlockFor } from './plain-english-guidance.ts';

const EVENT_BUFFER_SIZE = 2000;
/** Init is immediate on a healthy spawn (probed); a live process that never
 *  emits init is retired so the lane respawns instead of hanging a send. */
export const AGY_READY_TIMEOUT_MS = 45_000;
/** A turn with no frames at all for this long is stalled (a healthy turn
 *  streams steps continuously): fail it and retire the lane instead of
 *  staying busy forever on a silent protocol break. */
const AGY_TURN_STALL_MS = 10 * 60_000;
/** Minimum gap between teammate-triggered boundary interrupts on the same
 *  lane (human messages are never rate-limited). Matches ClaudeSession. */
const PEER_BOUNDARY_INTERRUPT_GAP_MS = 60_000;
/** How long an automation turn runs before a teammate's handoff may end it
 *  at a tool boundary. Matches ClaudeSession. */
const PEER_AUTOMATION_TURN_GRACE_MS = 60_000;
/** Short settle window after a tool step closes before firing a boundary
 *  interrupt, so a batched sibling tool's ACTIVE frame arrives and holds the
 *  turn open instead of getting hit by SIGINT. */
const BOUNDARY_SETTLE_MS = 100;
const PAUSED_NOTE_TTL_MS = 10 * 60_000;
const KEY_STATE_MAX_AGE_MS = 60 * 60_000;
/** Prepended to the turn that follows a boundary interrupt. */
const PAUSED_FOR_MESSAGE_NOTE = '<rivendell-steer>Your previous turn was paused right after a tool call finished, so the message below reaches you as a normal message. Answer it first. Then, unless it changes the plan, carry on with what you were doing; the transcript above shows where you stopped.</rivendell-steer>';
/** Preserved across AgySession replacements (interrupt retires the old
 *  process and getOrCreateSession spawns a new one for the same key). */
const pausedForMessageByKey = new Map<string, { at: number; summary: string }>();
const lastBoundaryInterruptAtByKey = new Map<string, number>();

function pruneKeyState(now: number): void {
  for (const [k, v] of pausedForMessageByKey) if (now - v.at > PAUSED_NOTE_TTL_MS) pausedForMessageByKey.delete(k);
  for (const [k, at] of lastBoundaryInterruptAtByKey) if (now - at > KEY_STATE_MAX_AGE_MS) lastBoundaryInterruptAtByKey.delete(k);
}

type Listener = (e: SeqEvent) => void;
type ChatImage = { mediaType: string; base64: string };

const finiteCount = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const mergeUsage = (usage: unknown, fallback: { input: number; output: number; cacheRead: number }): { input: number; output: number; cacheRead: number } => {
  const rec = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : {};
  const pick = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  // Per-field: a terminal counter present, valid and positive wins for its
  // field; a missing or malformed one keeps the sanitized step accumulation
  // for that field; an explicit zero keeps a positive accumulation (a broken
  // terminal counter reports 0; a genuine 0 matches a 0 accumulation), so a
  // partial terminal usage can never zero out real counts and starve rotation.
  const mergeField = (v: unknown, fb: number): number => {
    const n = pick(v);
    if (n === undefined) return fb;
    if (n === 0 && fb > 0) return fb;
    return n;
  };
  return {
    input: mergeField(rec.input_tokens, fallback.input),
    output: mergeField(rec.output_tokens, fallback.output),
    cacheRead: mergeField(rec.cache_read_tokens, fallback.cacheRead),
  };
};

/** The agy binary. Do NOT rely on bare `agy` through PATH (same rule as the
 *  codex resolver): TARDIS is started by npm, which prepends every ancestor
 *  node_modules/.bin, so a stale shadow could take the lane. Prefer the
 *  standalone install, allow an explicit override, then PATH. */
export function resolveAgyBin(): string {
  const explicit = process.env.RIVENDELL_AGY_BIN;
  if (explicit) return explicit;
  const standalone = join(homedir(), '.local', 'bin', 'agy');
  return existsSync(standalone) ? standalone : 'agy';
}

/** One buffered step per step_index while the pump serializes emission (see
 *  AgySession.pumpSteps). */
type AgyStepBuffer = {
  kind: 'text' | 'tool';
  text: string;
  done: boolean;
  opened: boolean;
  closed: boolean;
  demoted?: boolean;
  name?: string;
  parameters?: unknown;
  output?: string;
  toolUseId?: string;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
};

export class AgySession {
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
  /** agy's own conversation id, captured from `init` and resumed via
   *  --conversation on the next spawn. */
  private agyConversationId: string | null = null;
  private readonly startedResumeId: string | null;
  /** A spawn that carried a saved --conversation id and died before init. */
  private resumeFailed = false;
  private listeners = new Set<Listener>();
  private eventLog: SeqEvent[] = [];
  private nextSeq = 1;
  private lastActivityAtMs = Date.now();
  /** Updated only on a valid stdout frame (never by local emits/notices):
   *  the stall watchdog's clock, so unrelated session events cannot postpone
   *  the retirement of a silently-stalled agy process. */
  private lastFrameAtMs = Date.now();
  /** Set the moment Stop begins: the process group is being terminated, so
   *  this instance must never accept another send — a terminal result during
   *  the kill grace would otherwise close the turn's books and make it look
   *  idle while the group dies. */
  private retiring = false;
  private disposed = false;
  private initSeen = false;
  private turnStartedAt: number | null = null;
  /** Bumped whenever a turn opens, so a late failure can tell its turn from a newer one. */
  private turnSeq = 0;
  private automationTurn = false;
  private boundaryInterruptWanted = false;
  private boundaryWaiters = 0;
  private boundaryHumanWaiters = 0;
  private boundaryGeneration = 0;
  private boundarySettleTimer: NodeJS.Timeout | null = null;
  private lastBoundaryInterruptAt = 0;
  private pausedForMessage = false;
  private seedWindowOnNextTurn = false;
  private terminalNoticeEmitted = false;
  private buffer = '';
  /** Consecutive unparsable or unrecognized stdout frames; resets on a
   *  recognized envelope. */
  private malformedFrames = 0;
  /** Stall watchdog for the open turn (see armStallWatchdog). */
  private stallTimer: NodeJS.Timeout | null = null;
  private turnUsage = { input: 0, output: 0, cacheRead: 0 };
  /** The terminal result's authoritative usage for the open turn, preferred
   *  over the step accumulation (steps may repeat the conversation input per
   *  API call, so summing them double-counts). */
  private resultUsage: { input: number; output: number; cacheRead: number } | null = null;
  private turnFailed: { message: string; code?: string } | null = null;
  private pendingStateAccepts: Array<() => void> = [];
  /** Buffered step frames by step_index, emitted strictly in step order (see
   *  pumpSteps): text accumulates until its message opens; a tool step buffers
   *  its card fields until it opens. DONE frames carry only deltas, never the
   *  assembled step text. */
  private stepBuffers = new Map<number, AgyStepBuffer>();
  /** The step_index whose message is currently open in the stream. The
   *  stream protocol addresses blocks by index inside ONE open message, so
   *  two concurrently open messages would misroute later deltas into the
   *  wrong bubble: a step only opens once every lower step_index has
   *  closed. */
  private liveStepIdx: number | null = null;
  /** Final assistant text of the turn; the client's `result.result` recovery
   *  path re-renders it if the streamed blocks never made it on screen. */
  private lastAssistantText = '';
  private suppressResultText = false;
  /** Who the current turn is for (see ClaudeSession.turnOrigin). */
  private turnOrigin: TurnOrigin = emptyTurnOrigin();
  /** Last shared-log seq this process was told about by the lane recap. */
  private laneSyncSeq?: number;
  /** Each lane runs its own native context; the transcript is shared. */
  private get contextKey(): string {
    return isBackgroundChatId(this.chatId) ? `${this.logKey}|bg` : this.logKey;
  }

  constructor(cli: CliKind, cwd: string, chatId: string, resumeId: string | null, model: string, effort: string, seedFirst = false, switchedFrom: string | null = null) {
    if (cli !== 'agy') throw new Error(`AgySession cannot run the ${cli} lane`);
    this.cli = cli;
    this.cwd = cwd;
    this.chatId = chatId;
    this.key = `${cli}|${cwd}|${chatId}`;
    this.logKey = logKeyFor(cli, cwd, chatId);
    pruneKeyState(Date.now());
    this.lastBoundaryInterruptAt = lastBoundaryInterruptAtByKey.get(this.key) ?? 0;
    this.spawnModel = model;
    this.spawnEffort = effort;
    this.seedWindowOnNextTurn = seedFirst;
    this.startedResumeId = resumeId;
    this.ready = new Promise<boolean>((res) => { this.resolveReady = res; });

    try {
      const restored = loadEventLogSync(this.logKey);
      if (restored.events.length > 0) {
        this.eventLog = restored.events;
        this.nextSeq = restored.nextSeq;
      }
    } catch (err) {
      console.warn(`[chat ${cli}/agy] event-log restore failed for ${this.logKey}:`, (err as Error).message);
    }
    if (switchedFrom && switchedFrom !== cli) {
      this.emit({ type: 'event', event: { type: '_engine_switch', from: switchedFrom, to: cli, model: this.spawnModel, ts: Date.now() } } as SessionEvent);
    }

    const env = agySubscriptionEnvironment(process.env);
    env.SAMWISE_ACCOUNT = cli;
    // Marks this as a TARDIS agent turn for the long-call gate extension (see longCallGate.ts).
    Object.assign(env, longCallGateEnv(chatId));

    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', this.spawnModel,
      '--effort', this.spawnEffort,
      // A headless lane cannot answer agy's permission prompts; without this
      // a tool step would hang the turn forever waiting for a review.
      '--dangerously-skip-permissions',
      // agy's own absolute turn bound (a Go duration string, like its 0s
      // default): a protocol change that renames the terminal event still
      // ends the turn server-side.
      '--print-timeout', '3600s',
      ...(resumeId ? ['--conversation', resumeId] : []),
    ];
    this.child = spawnLaneWorker(resolveAgyBin(), args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable, Readable, Readable>;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) console.warn(`[chat ${cli}/agy] ${line.slice(0, 300)}`);
    });
    this.child.on('error', (err) => {
      console.error(`[chat ${cli}/agy] process error:`, err.message);
      this.emit({ type: 'error', message: `agy process error: ${err.message}`, fatal: true });
      this.resolveReady(false);
      // Pre-init, resolveReady(false) routes the failure through the spawn
      // flow (breaker count, registry delete, honest startup error), so
      // nothing else is needed. Mid-session that flow is long done: an open
      // turn would wait out the full watchdog on a dead process, and with no
      // exit event (some error kinds never fire one) exitCode stays null so
      // isAlive() would keep handing the dead session out. Close the turn
      // honestly, then retire the process.
      if (this.initSeen) {
        if (this.turnStartedAt !== null) {
          // A process error during Stop's kill grace is the cancellation Stop
          // asked for, not an engine failure (same honesty as onExit); a
          // message-boundary pause closes cleanly without failing the turn.
          if (!this.pausedForMessage) {
            this.turnFailed = this.retiring
              ? { message: 'This turn was cancelled before it finished.', code: 'aborted' }
              : { message: `agy process error: ${err.message}`, code: 'error' };
          }
          this.finishTurn();
        }
        this.shutdown('child-error');
      }
    });
    this.child.on('exit', (code, signal) => this.onExit(code, signal));
    console.log(`[chat ${cli}/agy] spawned model=${this.spawnModel} effort=${this.spawnEffort}${resumeId ? ' (resume)' : ''}`);
  }

  private markInit(conversationId: string, model: string): void {
    if (this.initSeen) return;
    // A late init from a process already retired (ready-timeout, shutdown,
    // or Stop's kill grace) must never persist its conversation id, emit, or
    // resolve readiness: the next spawn would resume a conversation
    // belonging to a dead process.
    if (this.disposed || this.retiring) return;
    if (this.startedResumeId && conversationId !== this.startedResumeId) {
      this.emit({ type: 'error', message: 'Antigravity did not resume its saved conversation. The saved ID and queued messages were retained.', fatal: true });
      this.resolveReady(false);
      this.shutdown('native resume mismatch');
      return;
    }
    this.initSeen = true;
    this.agyConversationId = conversationId;
    console.log(`[chat ${this.cli}/agy] ready ${model} conversation=${conversationId.slice(0, 8)}`);
    void setSessionId(this.cli, this.cwd, conversationId, this.chatId);
    this.emit({ type: 'event', event: { type: 'system', subtype: 'init', cwd: this.cwd, session_id: conversationId, model, harness: 'agy' } });
    this.resolveReady(true);
  }

  /** The persona + operating guidance. agy takes no system-prompt flag, so
   *  this rides the top of every turn's message content. */
  private systemPromptBlock(): string {
    const voice = isVoiceChatId(this.chatId);
    const voiceAddendum = voice
      ? [VOICE_STYLE_ADDENDUM, isRobotVoiceChatId(this.chatId) ? robotVoiceAddendum(this.chatId) : null].filter(Boolean).join('\n\n')
      : null;
    const persona = personaPromptFor(this.chatId);
    const name = agentForChatId(this.chatId)?.name ?? 'a teammate';
    const operating = [
      `You are ${name}, a teammate aboard TARDIS, Matt's always-on office. You have file, shell and edit tools for this workspace, plus team tools (team_message, team_status and friends) for talking to other teammates, and assistant_* tools for email, calendar, tasks and integrations.`,
      'Do the work yourself with tools; report outcomes plainly; never claim something is done that you did not verify.',
      'Never end a turn on a stated intention. If you say you are checking, looking at, or about to do something, do it with tools in this same turn before you stop. The only things worth stopping for are a question the person must answer or a teammate reply you are waiting on, and say which.',
      'External side effects stay draft-first unless the person explicitly asked you to send, post or deploy.',
      'Nothing you start in the background can report back to you. A backgrounded shell, nohup job or watcher never wakes you when it finishes, and it may be stopped when your turn ends. Run what you need the result of in the foreground, or poll it to completion inside this turn. If something must outlive the turn, tell the person what is running, where its output goes, and that you will not see it finish.',
    ].join('\n');
    return [persona, voiceAddendum, operating, isAgentThread(this.chatId) ? TRANSCRIPT_GUIDANCE : null].filter(Boolean).join('\n\n');
  }

  // ---- line transport ---------------------------------------------------------------

  private writeUserLine(content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Well-formed at the transport boundary: agy's line parser rejects a
      // lone surrogate the same way codex's does.
      const line = JSON.stringify({ event: 'user', message: { role: 'user', content: wellFormedText(content) } }) + '\n';
      this.child.stdin.write(line, (err) => { if (err) reject(err); else resolve(); });
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    // Strict LF framing (never readline: it splits on U+2028).
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { this.noteMalformedFrame(line); continue; }
      // Only a structurally valid envelope (an object carrying a string
      // `event`) clears the malformed-frame counter: a parsable but wrong-
      // shaped frame (null, an array, a changed schema) counts toward the
      // protocol-break retirement exactly like an unparsable one.
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.event !== 'string') {
        this.noteMalformedFrame(line);
        continue;
      }
      // Only a RECOGNIZED envelope resets the malformed-frame counter: an
      // unrecognized event name (a protocol change that renamed the terminal
      // event) counts toward the protocol-break retirement, never passes as
      // healthy traffic.
      if (msg.event !== 'init' && msg.event !== 'step_update' && msg.event !== 'result') {
        this.noteMalformedFrame(line);
        continue;
      }
      // A recognized name is not yet a healthy frame: the envelope's required
      // payload must be present (init: a conversation_id string; step_update:
      // a step object carrying a step_type; result: a result object — the
      // pinned protocol carries all three). A recognized name with a missing
      // or wrong-typed payload counts as a malformed frame, so a stream of
      // empty step_update envelopes cannot keep a broken turn alive
      // (resetting the counter, refreshing activity) until the CLI's timeout.
      const payloadOk =
        (msg.event === 'init' && typeof msg.conversation_id === 'string' && msg.conversation_id.length > 0) ||
        (msg.event === 'step_update' && msg.step_update && typeof msg.step_update === 'object' && !Array.isArray(msg.step_update) && typeof msg.step_update.step_type === 'string') ||
        (msg.event === 'result' && msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result));
      if (!payloadOk) {
        this.noteMalformedFrame(line);
        continue;
      }
      this.malformedFrames = 0;
      try { this.handleEvent(msg); } catch (err) {
        console.error(`[chat ${this.cli}/agy] event handling failed:`, (err as Error).message);
      }
    }
  }

  // ---- event normalisation --------------------------------------------------------

  private handleEvent(ev: any): void {
    this.lastActivityAtMs = Date.now();
    this.lastFrameAtMs = Date.now();
    switch (ev.event) {
      case 'init': {
        const conversationId = typeof ev.conversation_id === 'string' ? ev.conversation_id : '';
        if (conversationId) this.markInit(conversationId, String(ev.init?.model ?? this.spawnModel));
        return;
      }
      case 'step_update': {
        const step = ev.step_update;
        if (!step) return;
        if (step.step_type === 'error_message') {
          const detail = step.error_message ?? step.error ?? step.text ?? step.text_delta ?? 'agy reported an upstream error';
          const message = typeof detail === 'string' ? detail : String(detail?.message ?? JSON.stringify(detail));
          this.turnFailed = { message, code: /429|RESOURCE_EXHAUSTED|quota/i.test(message) ? 'usage_limit' : 'error' };
          return;
        }
        if (step.step_type !== 'tool' && step.step_type !== 'agent_response') return;
        const sid = this.agyConversationId ?? '';
        const stream = (event: Record<string, unknown>) => this.emit({ type: 'event', event: { type: 'stream_event', event, session_id: sid } });
        const idx = typeof step.step_index === 'number' ? step.step_index : -1;
        let buf = this.stepBuffers.get(idx);
        if (!buf) {
          buf = step.step_type === 'tool'
            ? { kind: 'tool', text: '', done: false, opened: false, closed: false }
            : { kind: 'text', text: '', done: false, opened: false, closed: false };
          this.stepBuffers.set(idx, buf);
        }
        if (buf.closed) return; // a late frame for an already-emitted step
        const wasLiveText = buf.kind === 'text' && buf.opened && this.liveStepIdx === idx;
        const isTerminalState = step.state === 'DONE' || step.state === 'ERROR' || step.state === 'FAILED' || step.state === 'CANCELLED';
        if (buf.kind === 'tool') {
          const info = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info : {};
          if (typeof step.tool_name === 'string' && step.tool_name) buf.name = step.tool_name;
          else if (typeof info.name === 'string' && info.name) buf.name = info.name;
          if (info.parameters !== undefined) buf.parameters = info.parameters;
          if (isTerminalState) {
            buf.done = true;
            const raw = info.output ?? info.error;
            buf.output = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw) ?? '';
          }
        } else {
          if (typeof step.text_delta === 'string' && step.text_delta.length > 0) buf.text += step.text_delta;
          if (isTerminalState) {
            buf.done = true;
            const u = step.usage ?? {};
            const usage = {
              input_tokens: finiteCount(u.input_tokens),
              output_tokens: finiteCount(u.output_tokens),
              cache_read_input_tokens: finiteCount(u.cache_read_tokens),
            };
            buf.usage = usage;
            this.turnUsage.input += usage.input_tokens;
            this.turnUsage.output += usage.output_tokens;
            this.turnUsage.cacheRead += usage.cache_read_input_tokens;
          }
        }
        // A live step's new delta streams immediately (before any close this
        // DONE frame may carry); a not-yet-opened step's text emits with its
        // message when the pump opens it.
        if (wasLiveText && typeof step.text_delta === 'string' && step.text_delta.length > 0) {
          stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text_delta } });
        }
        this.pumpSteps(stream);
        return;
      }
      case 'result': {
        const result = ev.result ?? {};
        if (this.turnStartedAt === null) {
          if (this.pausedForMessage) return;
          // A result with no open turn of ours: an input line agy rejected
          // outright, or a self-run we never asked for. Surface it, never drop it.
          const error = typeof result.error === 'string' && result.error ? result.error : '';
          const response = typeof result.response === 'string' ? result.response : '';
          const message = error || response || 'agy reported a result with no turn in flight';
          if (error) this.emit({ type: 'error', message: `agy rejected the input: ${error}` });
          else this.emit({ type: 'event', event: { type: '_agy_unexpected_result', response: response.slice(0, 2000), ts: Date.now() } } as SessionEvent);
          console.warn(`[chat ${this.cli}/agy] result with no open turn: ${message.slice(0, 160)}`);
          return;
        }
        // Fail closed: only the documented SUCCESS status commits a result;
        // missing, renamed, malformed or unknown statuses are failures (except
        // when retiring for a message-boundary pause, where SIGINT ends the
        // turn cleanly at the completed tool boundary).
        const resultCounts = result.usage ?? {};
        const emptySuccess = result.status === 'SUCCESS' && !String(result.response ?? this.lastAssistantText).trim()
          && this.stepBuffers.size === 0 && !Number(resultCounts.input_tokens) && !Number(resultCounts.output_tokens);
        if (result.status !== 'SUCCESS' || result.error || emptySuccess) {
          if (!this.pausedForMessage) {
            this.turnFailed ??= { message: String(result.error ?? (emptySuccess ? 'agy returned an empty success with no model usage' : `agy returned status ${String(result.status ?? 'missing')}`)), code: 'error' };
          }
        } else {
          const response = typeof result.response === 'string' ? result.response : '';
          if (response.trim()) this.lastAssistantText = response;
          // The terminal result is the only reliable narration signal
          // (card-e2bd7a): the CLI repeats narration verbatim ahead of the
          // answer, so a closed text step whose text the result carries as a
          // whitespace-insensitive prefix — or equals, when a LATER text step
          // streamed the actual answer — is thinking, not a reply. Demote
          // those steps with agy_thinking markers emitted BEFORE the result
          // event (live and replay mark the same blocks) and strip the
          // narration out of the emitted result text, so the answer renders
          // exactly once and thinking never prints as it. Step position
          // alone is never the signal: a genuine multi-part reply separated
          // by tool activity carries no narration repeat and stays visible.
          if (response.trim()) {
            const squash = (s: string) => s.replace(/\s+/g, '');
            let effective = response;
            const ordered = [...this.stepBuffers.entries()].sort((a, b) => a[0] - b[0]);
            for (const [idx, b] of ordered) {
              if (b.kind !== 'text' || !b.text.trim() || b.demoted) continue;
              const bSq = squash(b.text);
              const rSq = squash(effective);
              if (bSq === rSq) {
                const laterAnswer = ordered.some(([j, o]) => j > idx && o.kind === 'text' && o.text.trim());
                if (laterAnswer) {
                  // The result repeats only the narration while a later step
                  // already streamed the answer: demote the narration and
                  // suppress the copy.
                  b.demoted = true;
                  this.emit({ type: 'event', event: { type: 'agy_thinking', step_index: idx, session_id: this.agyConversationId ?? '' } });
                }
                // Either way the result adds nothing over streamed text.
                this.suppressResultText = true;
              } else if (rSq.startsWith(bSq) && rSq.length > bSq.length) {
                // Narration prefix ahead of a longer answer: demote the
                // narration and strip it from the emitted result text.
                b.demoted = true;
                this.emit({ type: 'event', event: { type: 'agy_thinking', step_index: idx, session_id: this.agyConversationId ?? '' } });
                if (effective.startsWith(b.text)) effective = effective.slice(b.text.length);
              }
            }
            if (effective.trim() && effective !== response) this.lastAssistantText = effective;
          }
        }
        // The terminal result's usage merges with the step accumulation
        // per field: a present, valid terminal counter wins for its field;
        // a missing or malformed one keeps the accumulated count.
        this.resultUsage = mergeUsage(result.usage, { input: this.turnUsage.input, output: this.turnUsage.output, cacheRead: this.turnUsage.cacheRead });
        this.finishTurn();
        return;
      }
      default:
        return;
    }
  }

  /** Bounded diagnostics for unparsable or unrecognized frames: a protocol
   *  change must never hang a turn silently. Three consecutive such frames
   *  while a turn is open fail that turn as a protocol break (and retire the
   *  process, see below); the counter resets on any recognized envelope, so
   *  an isolated bad line never kills a healthy turn. */
  private noteMalformedFrame(line: string): void {
    this.malformedFrames += 1;
    if (this.malformedFrames <= 5) console.warn(`[chat ${this.cli}/agy] unparsable stdout frame (${this.malformedFrames}): ${line.slice(0, 200)}`);
    if (this.turnStartedAt !== null && this.malformedFrames >= 3) {
      this.malformedFrames = 0;
      this.turnFailed = { message: 'agy stream frames became unparsable (protocol change?)', code: 'protocol' };
      this.finishTurn();
      // The process is still running the request whose frames we can no
      // longer read; leaving it alive would let the now-idle lane accept
      // another input line while that request executes (concurrent turns,
      // misattributed results). Retire it: the next send spawns a fresh
      // session with a clean protocol.
      this.shutdown('protocol-break');
    }
  }

  /** Self-extending stall watchdog: armed once at turn open, re-arms at each
   *  ~10-minute checkpoint while frames keep arriving — re-armed for the
   *  REMAINING silence, never a fresh full window — and fails the turn
   *  (retiring the lane) when a checkpoint finds no real stdout frame for
   *  the whole window (the clock is lastFrameAtMs, never the general
   *  activity clock). A healthy turn streams steps continuously; total
   *  silence is a stall, never patience. */
  private armStallWatchdog(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    const arm = (ms: number): void => {
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        if (this.disposed || this.turnStartedAt === null) return;
        const silentFor = Date.now() - this.lastFrameAtMs;
        if (silentFor < AGY_TURN_STALL_MS) { arm(Math.max(AGY_TURN_STALL_MS - silentFor, 2_000)); return; }
        this.turnFailed = { message: `agy turn stalled (no frames for ${Math.round(AGY_TURN_STALL_MS / 60_000)} minutes)`, code: 'stalled' };
        this.finishTurn();
        this.shutdown('turn-stall');
      }, ms);
      this.stallTimer.unref();
    };
    arm(AGY_TURN_STALL_MS + 2_000);
  }

  /** Close the streamed step into a full assistant message (claude-shaped). */
  /** Serialize step emission strictly by step_index. agy interleaves steps
   *  (planner, tool, and agent steps overlap inside one turn), but the stream
   *  protocol addresses blocks by index inside one open message, so two
   *  concurrently open messages would misroute later deltas into the wrong
   *  bubble. A step only opens once every lower step_index has closed; a
   *  higher step's frames buffer meanwhile, its accumulated text emitting as
   *  one delta when its message opens. Emission order is therefore step
   *  order: one assistant message per step, in the order the steps began,
   *  tool steps as tool_use cards with their tool_result frames (the shapes
   *  the Claude lanes deliver — Oct 15: 14 GENERIC steps rendered zero tool
   *  cards, and planner bubbles rendered out of step order). */
  private pumpSteps(stream: (event: Record<string, unknown>) => void): void {
    const order = [...this.stepBuffers.entries()].filter(([, b]) => !b.closed).sort((a, b) => a[0] - b[0]);
    let closedToolStep = false;
    for (const [idx, buf] of order) {
      if (this.liveStepIdx !== null && this.liveStepIdx !== idx) break; // a lower step is still live
      if (!buf.opened) {
        // A tool card waits for its DONE frame: only then are the final name
        // and parameters known (a card opened on the first ACTIVE frame would
        // permanently freeze whatever that frame carried, and later frames
        // can never update a closed card).
        if (buf.kind === 'tool' && !buf.done) break;
        buf.opened = true;
        this.liveStepIdx = idx;
        if (buf.kind === 'tool') {
          this.emitToolCard(stream, buf);
        } else {
          stream({ type: 'message_start', step_index: idx, session_id: this.agyConversationId ?? '', message: { id: randomUUID(), type: 'message', role: 'assistant', content: [], model: this.spawnModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } });
          stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          if (buf.text) stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: buf.text } });
        }
      }
      if (!buf.done) break; // the live step is still streaming
      if (buf.kind === 'tool') {
        this.emit({ type: 'event', event: { type: 'user', parent_tool_use_id: null, session_id: this.agyConversationId ?? '', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: buf.toolUseId ?? '', content: [{ type: 'text', text: String(buf.output ?? '').slice(0, 8000) }] }] } } });
        closedToolStep = true;
      } else {
        // Serialized close, not arrival: lastAssistantText must end as the
        // final step's text, or a late-finishing lower-index planner step
        // would overwrite the response recovery when result.response is empty.
        if (buf.text.trim()) this.lastAssistantText = buf.text;
        stream({ type: 'content_block_stop', index: 0 });
        stream({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: buf.usage?.input_tokens ?? 0, output_tokens: buf.usage?.output_tokens ?? 0, cache_read_input_tokens: buf.usage?.cache_read_input_tokens ?? 0, cache_creation_input_tokens: 0 } });
        stream({ type: 'message_stop' });
      }
      buf.closed = true;
      this.liveStepIdx = null;
      // continue: pump the next buffered step
    }
    if (closedToolStep) this.maybeFireBoundaryInterrupt();
  }

  /** True while any buffered tool step has not yet finished and emitted its
   *  tool_result. Boundary interrupts never fire while a tool is in flight. */
  private hasOpenToolStep(): boolean {
    for (const b of this.stepBuffers.values()) {
      if (b.kind === 'tool' && !b.closed) return true;
    }
    return false;
  }

  private completedToolSummary(): string {
    const tools = [...this.stepBuffers.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, b]) => b.kind === 'tool' && b.closed)
      .map(([, b]) => b.name ?? 'tool');
    return tools.length > 0 ? `Completed tool steps before pause: ${tools.join(', ')}.` : '';
  }

  private maybeFireBoundaryInterrupt(): void {
    if (!this.boundaryInterruptWanted || this.turnStartedAt === null || this.disposed || this.retiring) return;
    if (this.hasOpenToolStep()) return;
    const now = Date.now();
    const eligible =
      (this.boundaryHumanWaiters > 0 || now - this.lastBoundaryInterruptAt >= PEER_BOUNDARY_INTERRUPT_GAP_MS)
      && (this.boundaryHumanWaiters > 0 || !this.automationTurn || now - this.turnStartedAt >= PEER_AUTOMATION_TURN_GRACE_MS);
    if (!eligible) return;
    if (this.boundarySettleTimer) return; // already settling
    const turn = this.turnStartedAt;
    const turnSeq = this.turnSeq;
    // Wait a short settle window so the completed tool_result event flushes and
    // any batched sibling tool's ACTIVE frame arrives before we signal the
    // leader process.
    this.boundarySettleTimer = setTimeout(() => {
      this.boundarySettleTimer = null;
      if (!this.boundaryInterruptWanted || this.turnStartedAt === null || this.turnStartedAt !== turn || this.turnSeq !== turnSeq || this.disposed || this.retiring) return;
      if (this.boundaryWaiters === 0) return;
      if (this.hasOpenToolStep()) return;
      const firedAt = Date.now();
      const stillEligible =
        (this.boundaryHumanWaiters > 0 || firedAt - this.lastBoundaryInterruptAt >= PEER_BOUNDARY_INTERRUPT_GAP_MS)
        && (this.boundaryHumanWaiters > 0 || !this.automationTurn || firedAt - (this.turnStartedAt ?? 0) >= PEER_AUTOMATION_TURN_GRACE_MS);
      if (!stillEligible) return;
      this.boundaryInterruptWanted = false;
      this.lastBoundaryInterruptAt = firedAt;
      lastBoundaryInterruptAtByKey.set(this.key, firedAt);
      void this.interrupt('message-boundary');
    }, BOUNDARY_SETTLE_MS);
    this.boundarySettleTimer.unref?.();
  }

  /** The active turn's start (ms) for the client's elapsed timer on reattach
   *  (register.ts ready payload); null when no turn is open. */
  activeTurnStartedAt(): number | null {
    return this.turnStartedAt;
  }

  private emitToolCard(stream: (event: Record<string, unknown>) => void, buf: AgyStepBuffer): void {
    const toolUseId = randomUUID();
    buf.toolUseId = toolUseId;
    const name = buf.name ?? 'tool';
    const input = buf.parameters == null ? '{}' : JSON.stringify(buf.parameters) ?? '{}';
    stream({ type: 'message_start', message: { id: randomUUID(), type: 'message', role: 'assistant', content: [], model: this.spawnModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name, input: {} } });
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } });
    stream({ type: 'content_block_stop', index: 0 });
    stream({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } });
    stream({ type: 'message_stop' });
  }

  /** Unconditional stream finalization: a terminal path (result, exit,
   *  interrupt) can arrive while a response step is still open, and an
   *  unclosed block would let the next turn's deltas continue this message.
   *  The open step's accumulated text is committed as the durable assistant
   *  message (and lastAssistantText), exactly like a DONE-closed step, so an
   *  empty terminal result.response cannot lose already-streamed text. */
  private finalizeOpenStep(): void {
    // A turn ending mid-step: close the live step's message (only one can be
    // open — see pumpSteps). The client's result handling also closes open
    // blocks and running tool cards, so this is belt-and-suspenders for the
    // stream protocol. No completion-time full-`assistant` frames.
    const sid = this.agyConversationId ?? '';
    if (this.liveStepIdx !== null) {
      const buf = this.stepBuffers.get(this.liveStepIdx);
      if (buf && buf.kind === 'text' && buf.opened && !buf.closed) {
        // Commit the accumulated text exactly like a serialized DONE close:
        // finishTurn reads this.lastAssistantText for the result event, so an
        // empty terminal result.response must not lose already-streamed
        // text to a stale or empty recovery string (Oct 15 final review).
        if (buf.text.trim()) this.lastAssistantText = buf.text;
        this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sid } });
        this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: this.turnFailed ? null : 'end_turn', stop_sequence: null }, usage: { input_tokens: this.turnUsage.input, output_tokens: this.turnUsage.output, cache_read_input_tokens: this.turnUsage.cacheRead, cache_creation_input_tokens: 0 } }, session_id: sid } });
        this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'message_stop' }, session_id: sid } });
      }
    }
    this.stepBuffers.clear();
    this.liveStepIdx = null;
  }

  private finishTurn(): void {
    if (this.turnStartedAt === null) return;
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    if (this.pausedForMessage) {
      pausedForMessageByKey.set(this.key, { at: Date.now(), summary: this.completedToolSummary() });
    }
    this.finalizeOpenStep();
    const failed = this.turnFailed;
    if (!failed) for (const accept of this.pendingStateAccepts) accept();
    this.pendingStateAccepts = [];
    if (failed && !this.terminalNoticeEmitted) {
      this.terminalNoticeEmitted = true;
      const detail = failed.message;
      const plain = `Gemini could not answer this turn (${detail.slice(0, 160)}). Try again or switch brains.`;
      this.emit({ type: 'event', event: { type: '_terminal_error', message: plain, code: failed.code ?? 'error', retryable: true, ts: Date.now() } });
    }
    const usage = this.resultUsage ?? { input: this.turnUsage.input, output: this.turnUsage.output, cacheRead: this.turnUsage.cacheRead };
    this.emit({ type: 'event', event: { type: 'result', subtype: failed ? 'error' : 'success', is_error: Boolean(failed), ...(failed ? { result: failed.message, errors: [failed.message] } : { result: this.suppressResultText ? '' : this.lastAssistantText }), session_id: this.agyConversationId ?? '', usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead } } });
    this.suppressResultText = false;
    // The turn's context accounting, once, at the boundary: the terminal
    // result's usage when it carried one, else the sanitized step accumulation.
    recordContextUsage(this.contextKey, 'agy', { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: 0 });
    this.lastAssistantText = '';
    this.turnStartedAt = null;
    this.automationTurn = false;
    this.clearBoundaryRequest();
    this.turnFailed = null;
    this.resultUsage = null;
    this.emit({ type: 'turnEnd', sessionId: this.agyConversationId ?? undefined });
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    // A Stop-begun retirement is an intentional close: an exit during the
    // kill grace must not masquerade as a crash (a retryable engine failure
    // instead of the cancellation it is), and the closed event rides the
    // intentional path.
    const intentional = this.disposed || this.retiring;
    console.log(`[chat ${this.cli}/agy] exit code=${code} signal=${signal ?? '-'} initSeen=${this.initSeen}${intentional ? ' (intentional)' : ''}`);
    if (!this.initSeen) {
      this.resolveReady(false);
      // A spawn that carried a saved --conversation id and died before init is
      // a failed resume — but only an UNINTENTIONAL exit proves that. An
      // intentional close (shutdown, ready-timeout retirement, or Stop racing
      // init) killed a healthy resume in progress and its saved id is still
      // valid: retain it so the next spawn resumes the same conversation
      // instead of silently starting a fresh one.
      if (this.startedResumeId && !intentional) {
        this.resumeFailed = true;
        // Retain the native conversation after a failed resume.
      }
    }
    if (!intentional && this.turnStartedAt !== null) {
      this.turnFailed = { message: `agy exited (code ${code ?? signal})`, code: 'exit' };
      this.finishTurn();
    }
    if (this.retiring && this.turnStartedAt !== null) {
      // Stop owns this turn: close it as cancelled, exactly once (the books
      // are still open only when agy's own result never landed during the
      // grace; finishTurn guards the rest). A message-boundary pause closes
      // cleanly without marking the turn failed.
      if (!this.pausedForMessage) {
        this.turnFailed = { message: 'This turn was cancelled before it finished.', code: 'aborted' };
      }
      this.finishTurn();
    }
    if (intentional) {
      const se: SeqEvent = { seq: this.latestSeq(), ev: { type: 'closed', code, signal, intentional: true } };
      for (const fn of this.listeners) fn(se);
    } else {
      this.emit({ type: 'closed', code, signal });
    }
  }

  // ---- public surface (mirrors ClaudeSession / PiSession) --------------------------

  subscribe(fn: Listener, sinceSeq = -1, _countSubscriber = true): () => void {
    this.listeners.add(fn);
    if (sinceSeq >= 0) for (const se of this.eventLog) if (se.seq > sinceSeq) fn(se);
    return () => { this.listeners.delete(fn); };
  }
  /** Shared per-log allocator: an agent's home and background lanes write one
   *  log, so two sessions must never hand out the same seq. */
  reserveSeq(): number {
    const seq = reserveEventLogSeq(this.logKey, this.nextSeq);
    this.nextSeq = seq + 1;
    return seq;
  }
  latestSeq(): number { return latestEventLogSeq(this.logKey, this.nextSeq - 1); }
  async prewarm(): Promise<void> { await this.awaitReadyBounded(); }
  isPrewarming(): boolean { return !this.initSeen && !this.disposed; }
  listenerCount(): number { return this.listeners.size; }
  lastActivityAt(): number { return this.lastActivityAtMs; }
  isAlive(): boolean { return this.child.exitCode === null && !this.disposed && !this.retiring; }
  /** True from the moment Stop begins (retiring) as well: a retiring session
   *  is teardown-in-progress, so the registry's replacement guard waits for
   *  the dying process to exit (its kill backstop bounds the wait) before a
   *  replacement resumes the same conversation — no concurrent conversation
   *  access or duplicated side effects during the kill grace. */
  isDisposed(): boolean { return this.disposed || this.retiring; }
  /** True once the agy process is gone, not merely asked to go. */
  processExited(): boolean { return this.child.exitCode !== null || this.child.signalCode !== null; }
  /** Append a standalone notice to this thread (between turns). */
  postNotice(event: Record<string, unknown>): boolean {
    if (this.disposed) return false;
    this.emit({ type: 'event', event });
    return true;
  }
  isBusy(): boolean { return this.turnStartedAt !== null; }
  isAutomationTurn(): boolean { return this.turnStartedAt !== null && this.automationTurn; }
  /** agy runs one turn per input line and never steers mid-turn, so a human
   *  message during a busy turn bounces to a boundary instead (see send). */
  canAcceptNativeHumanSteer(): boolean { return false; }
  /** Ask the open turn to end once the current tool step has finished (never
   *  while a tool is mid-flight), so the queued message can start the next turn
   *  on the same conversation id. Human messages also fire if no tool is
   *  currently open after a prior tool step completed; peer messages respect
   *  PEER_BOUNDARY_INTERRUPT_GAP_MS and PEER_AUTOMATION_TURN_GRACE_MS. */
  requestBoundaryInterrupt(opts: { human?: boolean } = {}): (() => void) | null {
    const human = opts.human === true;
    if (this.turnStartedAt === null || !this.isAlive()) return null;
    this.boundaryInterruptWanted = true;
    this.boundaryWaiters += 1;
    if (human) this.boundaryHumanWaiters += 1;
    // If a human message arrives between tool steps (after at least one tool
    // step already finished and with no tool currently in flight), run the
    // settled boundary check immediately instead of waiting for another tool.
    if (human && !this.hasOpenToolStep() && [...this.stepBuffers.values()].some((b) => b.kind === 'tool' && b.closed)) {
      this.maybeFireBoundaryInterrupt();
    }
    const generation = this.boundaryGeneration;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (generation !== this.boundaryGeneration) return;
      this.boundaryWaiters = Math.max(0, this.boundaryWaiters - 1);
      if (human) this.boundaryHumanWaiters = Math.max(0, this.boundaryHumanWaiters - 1);
      if (this.boundaryWaiters === 0) {
        this.boundaryInterruptWanted = false;
        if (this.boundarySettleTimer) {
          clearTimeout(this.boundarySettleTimer);
          this.boundarySettleTimer = null;
        }
      }
    };
  }
  private clearBoundaryRequest(): void {
    this.boundaryInterruptWanted = false;
    this.boundaryWaiters = 0;
    this.boundaryHumanWaiters = 0;
    this.boundaryGeneration += 1;
    if (this.boundarySettleTimer) {
      clearTimeout(this.boundarySettleTimer);
      this.boundarySettleTimer = null;
    }
  }
  sessionId(): string | null { return this.agyConversationId; }
  startedWithResume(): boolean { return this.startedResumeId !== null; }
  hasResumeFailed(): boolean { return this.resumeFailed; }
  hasStaleZaiProvider(): boolean { return false; }
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

  /** Bounded readiness, shared by send and prewarm: a live child that never
   *  emits init is retired (shutdown drops it from the registry) so the lane
   *  respawns instead of hanging the caller. Init is immediate on a healthy
   *  spawn, so the bound is generous, not tight. */
  private async awaitReadyBounded(): Promise<boolean> {
    let readyTimer: NodeJS.Timeout | undefined;
    const ok = await Promise.race([
      this.ready,
      new Promise<boolean>((resolve) => { readyTimer = setTimeout(() => resolve(false), AGY_READY_TIMEOUT_MS); }),
    ]);
    if (readyTimer) clearTimeout(readyTimer);
    if (!ok) this.shutdown('ready-timeout');
    return ok;
  }

  async send(text: string, images?: ChatImage[], opts: { peerFrom?: string; peerFromRole?: string; peerText?: string; peerDeliveryId?: string; allowNativePeerSteer?: boolean; allowNativeHumanSteer?: boolean; signal?: AbortSignal; clientMsgId?: string; humanOrigin?: boolean; skipAttachments?: boolean; voiceMode?: boolean; providerContinue?: unknown; echoText?: string; replyTo?: { from: string; snippet: string } } = {}): Promise<void> {
    assertSubscriptionLane(this.cli);
    if (opts.signal?.aborted) return;
    if (!this.isAlive()) throw new Error('session has exited');
    // A live process that never emits init would hang this send forever; the
    // shared bounded readiness retires the hung lane so the next send
    // respawns it instead of inheriting the zombie.
    if (!(await this.awaitReadyBounded())) {
      throw new Error('the agy session never became ready; the lane was retired and the next message respawns it');
    }
    const startsNewTurn = this.turnStartedAt === null;
    // agy has no native steer: one input line runs one whole turn, and a second
    // line written mid-turn would run concurrently whose result then lands as
    // an unexpected result with no open bookkeeping. So every mid-turn send is
    // rejected outright — peers quietly (the bus retries after the boundary),
    // humans with the boundary error. This is exactly what
    // canAcceptNativeHumanSteer(): false promises.
    if (!startsNewTurn) {
      if (opts.peerFrom) return;
      throw new Error('the current turn must reach a safe boundary before guidance is delivered');
    }
    const automationRequest = opts.peerFromRole === 'automation';
    if (startsNewTurn) {
      this.turnStartedAt = Date.now();
      this.pendingStateAccepts = [];
      this.turnSeq++;
      this.automationTurn = automationRequest;
      this.clearBoundaryRequest();
      this.pausedForMessage = false;
      this.terminalNoticeEmitted = false;
      this.turnFailed = null;
      this.suppressResultText = false;
      this.turnUsage = { input: 0, output: 0, cacheRead: 0 };
      this.resultUsage = null;
      this.turnOrigin = emptyTurnOrigin();
      this.emit({ type: 'turnStart' });
      this.armStallWatchdog();
    }
    const openedSeq = this.turnSeq;
    const abandon = () => {
      if (!startsNewTurn || this.turnStartedAt === null || this.turnSeq !== openedSeq) return;
      this.turnStartedAt = null; this.automationTurn = false;
      this.clearBoundaryRequest();
      if (!this.disposed) this.emit({ type: 'turnEnd', sessionId: this.agyConversationId ?? undefined });
    };
    const historyThroughSeq = this.latestSeq();
    const wantSeed = this.seedWindowOnNextTurn;
    let pausedNote = '';
    // One failure path for every fallible step between opening the turn and
    // agy accepting the input line: a rejection anywhere in here (primer
    // read, attachments, vision adaptation, log flush, the durable user
    // echo, recall, the context helpers, the stdin write) abandons the opened
    // turn instead of wedging the lane busy forever.
    let message = '';
    try {
      const seed = wantSeed ? await peekEnginePrimerThroughSeq(this.logKey, historyThroughSeq, this.eventLog.slice()) : '';
      if (opts.signal?.aborted) { abandon(); return; }

      let attachments: Array<{ id: string; mediaType: string }> = [];
      if (!opts.peerFrom && !opts.skipAttachments && images?.length) attachments = await saveChatAttachments(images);

      // v1 sends text only: agy's image input over stream-json is unverified, so
      // images ride as descriptions (see vision-adapter) rather than raw pixels.
      let promptText = text;
      if (images?.length) {
        const result = await adaptImagesForTextModel({ text, images, modelSupportsImages: false });
        if (result.adapted) { promptText = result.text; console.log(`[chat ${this.cli}/agy] vision adapter: ${result.note}`); }
        if (opts.signal?.aborted || !this.isAlive()) { abandon(); return; }
      }

      if (opts.peerFrom) {
        noteTurnPeer(this.turnOrigin, opts.peerFrom, opts.peerFromRole, opts.peerText ?? text);
        if (isPersonMessageOrigin(opts)) this.turnOrigin.human = true;
        if (startsNewTurn && automationRequest) this.turnOrigin.automation = true;
        this.emit({ type: 'event', event: { type: 'peer_message', from: opts.peerFrom, fromRole: opts.peerFromRole ?? '', text: opts.peerText !== undefined ? opts.peerText : text, ...(opts.peerDeliveryId ? { deliveryId: opts.peerDeliveryId } : {}), ts: Date.now() } });
      } else {
        await flushEventLog(this.logKey);
        if (opts.signal?.aborted) { abandon(); return; }
        this.emit({ type: 'event', event: { type: '_user_echo', text: opts.echoText ?? text, imageCount: images?.length ?? 0, attachments, clientMsgId: opts.clientMsgId, humanOrigin: opts.humanOrigin === true, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}), ts: Date.now() } });
        noteUserTurn(this.logKey);
        noteAgentLane(this.chatId, this.cli);
        this.turnOrigin.human = true;
      }

      const guidance = conversationGuidanceForTurn({
        chatId: this.chatId, logKey: this.logKey, historyThroughSeq, peerFrom: opts.peerFrom,
        peerFromRole: opts.peerFromRole,
        hidden: false,
      });
      const laneContext = startsNewTurn
        ? laneContextForTurn({ chatId: this.chatId, logKey: this.logKey, sinceSeq: this.laneSyncSeq ?? null, throughSeq: historyThroughSeq, seeded: Boolean(seed) })
        : '';
      // Auto-recall: recorded knowledge in front of every new human or teammate
      // turn; automation traffic never spends the search, and every source fails
      // open under a hard deadline.
      const recall = startsNewTurn && !automationRequest
        && recallEligibleTurn(this.chatId, { peerFrom: opts.peerFrom, peerFromRole: opts.peerFromRole, voiceMode: opts.voiceMode })
        ? await recallBlockForTurn({ cli: this.cli, cwd: this.cwd, chatId: this.chatId, logKey: this.logKey, messageText: opts.peerText ?? text })
        : '';
      if (opts.signal?.aborted) { abandon(); return; }
      const pausedEntry = startsNewTurn && !automationRequest ? pausedForMessageByKey.get(this.key) : undefined;
      if (pausedEntry && Date.now() - pausedEntry.at <= PAUSED_NOTE_TTL_MS) {
        pausedNote = pausedEntry.summary
          ? PAUSED_FOR_MESSAGE_NOTE.replace('</rivendell-steer>', ` ${pausedEntry.summary}</rivendell-steer>`)
          : PAUSED_FOR_MESSAGE_NOTE;
      } else if (pausedEntry) {
        pausedForMessageByKey.delete(this.key);
      }
      const continuation = isAgentThread(this.chatId)
        ? ['<rivendell-continuation>', `Warm continuation of the existing conversation. Host time: ${new Date().toString()}.`, 'Do not repeat session-start rituals.', '</rivendell-continuation>', ...(pausedNote ? ['', pausedNote] : []), ...(guidance ? ['', guidance] : []), ...(laneContext ? ['', laneContext] : []), ...(recall ? ['', recall] : []), ...(opts.voiceMode ? ['', THREAD_VOICE_STYLE_ADDENDUM] : []), '', promptText].join('\n')
        : [pausedNote, recall, promptText].filter(Boolean).join('\n\n');
      const humanTurn = !opts.peerFrom && opts.peerFromRole !== 'automation';
      // Full computer rules ride the seed message that starts a fresh agy window;
      // later messages of the same warm process get the brief form.
      const computerContext = wantSeed ? computerGuidance(this.cwd, this.chatId, agentForChatId(this.chatId)?.name ?? 'Companion', humanTurn, !startsNewTurn, !wantSeed) : '';
      const stateDelta = await prepareSessionStateDelta(this.chatId);
      const priorities = stateDelta.text;
      // Plain-English writing block (card-0d1015): agy is Gemini, whose
      // buried instructions lost to the long context, so the block rides at
      // the very END of the turn. Voice turns keep their own spoken-style
      // addendum, and automation/peer turns must stay silent or exact
      // (review 1 P0/P1: a last-position writing rule would push Gemini to
      // chatter instead of NO_UPDATE, or to speak backticks on a call).
      const plainEnglish = plainEnglishWritingBlockFor({ cli: this.cli, model: '', voiceMode: opts.voiceMode, humanTurn });
      message = `${wantSeed ? this.systemPromptBlock() : ''}\n\n${computerContext}\n\n${priorities ? `${priorities}\n\n` : ''}${seed ? `${seed}\n\n---\n\n` : ''}${continuation}${plainEnglish ? `\n\n${plainEnglish}` : ''}`;

      try {
        await this.writeUserLine(message);
        this.pendingStateAccepts.push(stateDelta.accept);
      } catch (error) {
        // A failed stdin write is an indeterminate protocol boundary: the old
        // request or a partial line may already be executing, so a later send
        // could recreate the overlapping-turn corruption. Retire the process;
        // the next send spawns a fresh session.
        if (wantSeed) this.seedWindowOnNextTurn = true;
        abandon();
        this.emit({ type: 'error', message: `agy input write failed: ${(error as Error).message}` });
        this.shutdown('stdin-write-failure');
        return;
      }
    } catch (error) {
      // The seed was not consumed by a delivered turn; keep it for the retry.
      if (wantSeed) this.seedWindowOnNextTurn = true;
      abandon();
      this.emit({ type: 'error', message: `agy turn failed before its input was accepted: ${(error as Error).message}` });
      return;
    }
    // The recap reached the model; the next turn recaps only what came after.
    if (startsNewTurn) {
      this.laneSyncSeq = historyThroughSeq;
      if (pausedNote) pausedForMessageByKey.delete(this.key);
    }
    if (wantSeed) {
      this.seedWindowOnNextTurn = false;
      // The seed was delivered, so the rotation debt that asked for it is paid.
      void clearRotation(this.logKey);
    }
    if (opts.peerDeliveryId) this.emit({ type: 'event', event: { type: 'peer_delivery_accepted', deliveryId: opts.peerDeliveryId, ts: Date.now() } });
  }

  /** Stop: agy has no abort input event, so v1 signals the process. Stop
   *  must end every side effect of the turn, not just the turn's books: agy
   *  runs its tools in-process, and a SIGINT the leader catches can leave
   *  shell children running after the turn itself closes. So an explicit Stop
   *  terminates the process GROUP on a short grace. A message-boundary pause,
   *  by contrast, fires only after the tool step finished and signals ONLY the
   *  agy leader process so any backgrounded shell/ssh job in the process group
   *  is never killed. The lane respawns (resuming its conversation id) on the
   *  next send. */
  async interrupt(reason = 'interrupt'): Promise<boolean> {
    const boundaryPause = reason === 'message-boundary';
    if (!boundaryPause) {
      this.pausedForMessage = false;
      pausedForMessageByKey.delete(this.key);
    }
    if (!this.isAlive() || this.turnStartedAt === null) return false;
    if (boundaryPause) {
      this.pausedForMessage = true;
      pausedForMessageByKey.set(this.key, { at: Date.now(), summary: this.completedToolSummary() });
    }
    // The process is being terminated: retire from reuse immediately, so a
    // terminal result landing during the kill grace (which closes the turn's
    // books and would make this instance look idle) can never accept a new
    // send into a process that is about to die. The registry spawns a
    // replacement (resuming the conversation id) on the next send.
    this.retiring = true;
    this.clearBoundaryRequest();
    this.emit({ type: 'event', event: { type: '_interrupted', ts: Date.now() } });
    const pid = this.child.pid;
    try { this.child.kill('SIGINT'); } catch { /* gone */ }
    setTimeout(() => {
      if (!pid || pid <= 1) return;
      if (boundaryPause) {
        try { this.child.kill('SIGTERM'); } catch { /* gone */ }
        setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* gone */ } }, 3_000).unref();
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
        setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3_000).unref();
      }
    }, 1_500).unref();
    const turnSeq = this.turnSeq;
    setTimeout(() => {
      if (this.disposed || this.turnStartedAt === null || this.turnSeq !== turnSeq) return;
      if (!this.pausedForMessage) {
        this.turnFailed = { message: 'This turn was cancelled before it finished.', code: 'aborted' };
      }
      this.finishTurn();
    }, 5_000).unref();
    return true;
  }

  shutdown(reason = 'unspecified'): void {
    if (this.disposed) return;
    // A cancellation Stop promised must land before disposal: emit() refuses
    // every event from a disposed session, so a turn still open here (shutdown
    // racing Stop's kill grace) would lose its promised cancelled terminal and
    // turnEnd at both later close sites — the 5s backstop returns on disposed,
    // and onExit's retiring branch finishes after disposal with every emit
    // swallowed. Close it now, while emit still works; turnStartedAt going
    // null makes both later sites skip, so the cancellation lands exactly once.
    if (this.retiring && this.turnStartedAt !== null) {
      if (!this.pausedForMessage) {
        this.turnFailed = { message: 'This turn was cancelled before it finished.', code: 'aborted' };
      }
      this.finishTurn();
    }
    this.clearBoundaryRequest();
    this.disposed = true;
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    console.log(`[chat ${this.cli}/agy] shutdown key=${this.key} reason=${reason}`);
    try { this.child.stdin.end(); } catch { /* closed */ }
    // Never signal pid <= 1: process.kill(-1) hits every process this user owns.
    const pid = this.child.pid;
    if (!pid || pid <= 1) return;
    if (this.pausedForMessage) {
      try { this.child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { this.child.kill('SIGTERM'); } catch { /* gone */ } }
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    }
  }

  private emit(msg: SessionEvent): void {
    msg = redactComputerImages(msg);
    if (this.disposed || isPlumbingEvent(msg)) return;
    this.lastActivityAtMs = Date.now();
    const se: SeqEvent = { seq: this.reserveSeq(), ev: msg, at: Date.now(), ...laneTagFor(this.chatId) };
    const persisted: PersistedEvent = { ...se, eng: this.cli, mdl: this.spawnModel };
    const durableUserEcho = msg.type === 'event' && (msg as any).event?.type === '_user_echo';
    if (durableUserEcho && !appendEventLogSync(this.logKey, persisted)) throw new Error('could not durably accept the user message');
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    if (!durableUserEcho) appendEventLog(this.logKey, persisted);
    for (const fn of this.listeners) fn(se);
    shareBackgroundLaneEvent(this, se);
  }
}

/** A peer delivery from a person (not an automation) marks the turn human. */
function isPersonMessageOrigin(opts: { peerFrom?: string; peerFromRole?: string }): boolean {
  return Boolean(opts.peerFrom) && opts.peerFromRole !== 'automation';
}
