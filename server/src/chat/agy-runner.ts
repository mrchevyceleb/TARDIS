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

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { assertSubscriptionLane, subscriptionEnvironment } from './subscription-policy.ts';
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
import { laneTagFor, shareBackgroundLaneEvent, type CliKind, type SeqEvent, type SessionEvent } from './runner.ts';

const EVENT_BUFFER_SIZE = 2000;
/** Init is immediate on a healthy spawn (probed); a live process that never
 *  emits init is retired so the lane respawns instead of hanging a send. */
const AGY_READY_TIMEOUT_MS = 45_000;

type Listener = (e: SeqEvent) => void;
type ChatImage = { mediaType: string; base64: string };

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
  private disposed = false;
  private initSeen = false;
  private turnStartedAt: number | null = null;
  /** Bumped whenever a turn opens, so a late failure can tell its turn from a newer one. */
  private turnSeq = 0;
  private automationTurn = false;
  private seedWindowOnNextTurn = false;
  private terminalNoticeEmitted = false;
  private buffer = '';
  /** Consecutive unparsable stdout frames; resets on any good frame. */
  private malformedFrames = 0;
  private turnUsage = { input: 0, output: 0, cacheRead: 0 };
  private turnFailed: { message: string; code?: string } | null = null;
  private currentMsgId: string | null = null;
  /** A content block is open for the current agent_response step. */
  private stepBlockOpen = false;
  /** Accumulated text_delta of the current agent_response step; the DONE
   *  frame carries only deltas, never the assembled step text. */
  private stepText = '';
  /** Final assistant text of the turn; the client's `result.result` recovery
   *  path re-renders it if the streamed blocks never made it on screen. */
  private lastAssistantText = '';
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

    const env = subscriptionEnvironment(process.env);
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
      ...(resumeId ? ['--conversation', resumeId] : []),
    ];
    this.child = spawn(resolveAgyBin(), args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable, Readable, Readable>;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) console.warn(`[chat ${cli}/agy] ${line.slice(0, 300)}`);
    });
    this.child.on('error', (err) => {
      console.error(`[chat ${cli}/agy] spawn error:`, err.message);
      this.emit({ type: 'error', message: `agy failed to start: ${err.message}`, fatal: true });
      this.resolveReady(false);
    });
    this.child.on('exit', (code, signal) => this.onExit(code, signal));
    console.log(`[chat ${cli}/agy] spawned model=${this.spawnModel} effort=${this.spawnEffort}${resumeId ? ' (resume)' : ''}`);
  }

  private markInit(conversationId: string, model: string): void {
    if (this.initSeen) return;
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
      const line = JSON.stringify({ event: 'user', message: { role: 'user', content } }) + '\n';
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
      this.malformedFrames = 0;
      try { this.handleEvent(msg); } catch (err) {
        console.error(`[chat ${this.cli}/agy] event handling failed:`, (err as Error).message);
      }
    }
  }

  // ---- event normalisation --------------------------------------------------------

  private handleEvent(ev: any): void {
    this.lastActivityAtMs = Date.now();
    switch (ev.event) {
      case 'init': {
        const conversationId = typeof ev.conversation_id === 'string' ? ev.conversation_id : '';
        if (conversationId) this.markInit(conversationId, String(ev.init?.model ?? this.spawnModel));
        return;
      }
      case 'step_update': {
        const step = ev.step_update;
        if (!step || step.step_type !== 'agent_response') return;
        const sid = this.agyConversationId ?? '';
        const stream = (event: Record<string, unknown>) => this.emit({ type: 'event', event: { type: 'stream_event', event, session_id: sid } });
        if (typeof step.text_delta === 'string' && step.text_delta.length > 0) {
          if (!this.stepBlockOpen) {
            this.stepBlockOpen = true;
            this.stepText = '';
            this.currentMsgId = randomUUID();
            stream({ type: 'message_start', message: { id: this.currentMsgId, type: 'message', role: 'assistant', content: [], model: this.spawnModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } });
            stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          }
          this.stepText += step.text_delta;
          stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text_delta } });
        }
        if (step.state === 'DONE') this.finishStep(stream, step);
        return;
      }
      case 'result': {
        const result = ev.result ?? {};
        if (this.turnStartedAt === null) {
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
        if (result.status === 'ERROR') {
          this.turnFailed = { message: String(result.error ?? 'agy returned an error'), code: 'error' };
        } else {
          const response = typeof result.response === 'string' ? result.response : '';
          if (response.trim()) this.lastAssistantText = response;
        }
        this.finishTurn();
        return;
      }
      default:
        return;
    }
  }

  /** Bounded diagnostics for unparsable frames: a protocol change must never
   *  hang a turn silently. Three consecutive malformed frames while a turn is
   *  open fail that turn as a protocol break; the counter resets on any good
   *  frame, so an isolated bad line never kills a healthy turn. */
  private noteMalformedFrame(line: string): void {
    this.malformedFrames += 1;
    if (this.malformedFrames <= 5) console.warn(`[chat ${this.cli}/agy] unparsable stdout frame (${this.malformedFrames}): ${line.slice(0, 200)}`);
    if (this.turnStartedAt !== null && this.malformedFrames >= 3) {
      this.malformedFrames = 0;
      this.turnFailed = { message: 'agy stream frames became unparsable (protocol change?)', code: 'protocol' };
      this.finishTurn();
    }
  }

  /** Close the streamed step into a full assistant message (claude-shaped). */
  private finishStep(stream: (event: Record<string, unknown>) => void, step: any): void {
    const usageRaw = step.usage ?? {};
    const count = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const usage = {
      input_tokens: count(usageRaw.input_tokens),
      output_tokens: count(usageRaw.output_tokens),
      cache_read_input_tokens: count(usageRaw.cache_read_tokens),
      cache_creation_input_tokens: 0,
    };
    this.turnUsage.input += usage.input_tokens;
    this.turnUsage.output += usage.output_tokens;
    this.turnUsage.cacheRead += usage.cache_read_input_tokens;
    // Same context-size accounting as the other lanes: the last assistant
    // message of a turn carries the live window size.
    recordContextUsage(this.contextKey, 'agy', usage);
    if (!this.stepBlockOpen) return; // a step with no streamed text (not seen live; nothing to close)
    this.stepBlockOpen = false;
    const sid = this.agyConversationId ?? '';
    const text = this.stepText;
    this.stepText = '';
    stream({ type: 'content_block_stop', index: 0 });
    if (text.trim()) this.lastAssistantText = text;
    const msgId = this.currentMsgId ?? randomUUID();
    this.emit({ type: 'event', event: { type: 'assistant', parent_tool_use_id: null, session_id: sid, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { id: msgId, type: 'message', role: 'assistant', model: this.spawnModel, content: [{ type: 'text', text: String(text ?? '') }], stop_reason: 'end_turn', stop_sequence: null, usage } } });
    this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }, session_id: sid } });
    this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'message_stop' }, session_id: sid } });
    this.currentMsgId = null;
  }

  /** Unconditional stream finalization: a terminal path (result, exit,
   *  interrupt) can arrive while a response step is still open, and an
   *  unclosed block would let the next turn's deltas continue this message. */
  private finalizeOpenStep(): void {
    if (!this.stepBlockOpen) return;
    this.stepBlockOpen = false;
    const sid = this.agyConversationId ?? '';
    const usage = { input_tokens: this.turnUsage.input, output_tokens: this.turnUsage.output, cache_read_input_tokens: this.turnUsage.cacheRead, cache_creation_input_tokens: 0 };
    this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sid } });
    this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: this.turnFailed ? null : 'end_turn', stop_sequence: null }, usage }, session_id: sid } });
    this.emit({ type: 'event', event: { type: 'stream_event', event: { type: 'message_stop' }, session_id: sid } });
    this.currentMsgId = null;
  }

  private finishTurn(): void {
    if (this.turnStartedAt === null) return;
    this.finalizeOpenStep();
    const failed = this.turnFailed;
    if (failed && !this.terminalNoticeEmitted) {
      this.terminalNoticeEmitted = true;
      const detail = failed.message;
      const plain = `Gemini could not answer this turn (${detail.slice(0, 160)}). Try again or switch brains.`;
      this.emit({ type: 'event', event: { type: '_terminal_error', message: plain, code: failed.code ?? 'error', retryable: true, ts: Date.now() } });
    }
    this.emit({ type: 'event', event: { type: 'result', subtype: failed ? 'error' : 'success', is_error: Boolean(failed), ...(failed ? {} : { result: this.lastAssistantText }), session_id: this.agyConversationId ?? '', usage: { input_tokens: this.turnUsage.input, output_tokens: this.turnUsage.output, cache_read_input_tokens: this.turnUsage.cacheRead } } });
    this.lastAssistantText = '';
    this.turnStartedAt = null;
    this.automationTurn = false;
    this.turnFailed = null;
    this.emit({ type: 'turnEnd', sessionId: this.agyConversationId ?? undefined });
    // Keep the rolling memory current on the agy lane too: past the budget the
    // lane rotates at this boundary, exactly like the Pi lanes.
    if (!failed) {
      const rotationDue = contextRotationDue(this.contextKey);
      const housekeeping = async () => {
        if (rotationDue && (await this.rotateContextAtBoundary())) return;
        await this.maybeCompact();
      };
      void housekeeping().catch((err) => console.warn(`[context-rotation] ${this.logKey}: deferred after maintenance failure`, (err as Error).message));
    }
  }

  /** Turn-boundary context rotation, same policy as the other lanes: past the
   *  budget, refresh the durable compact, drop the agy conversation id and
   *  shut the warm process down; the next prompt respawns seeded with compact
   *  plus the last 50 turns. */
  private async rotateContextAtBoundary(): Promise<boolean> {
    if (!contextRotationDue(this.contextKey) || this.turnStartedAt !== null || this.disposed) return false;
    const refreshed = await refreshCompactForRotation({
      key: this.logKey, cli: this.cli, chatId: this.chatId, events: this.eventLog,
      isBusy: () => this.turnStartedAt !== null || this.disposed,
      emit: (ev) => this.emit(ev as SessionEvent), rotate: () => false,
    });
    if (!refreshed || this.turnStartedAt !== null || this.disposed) return true;
    await setSessionId(this.cli, this.cwd, '', this.chatId);
    if (this.turnStartedAt !== null || this.disposed) {
      if (!this.disposed) await setSessionId(this.cli, this.cwd, this.agyConversationId ?? '', this.chatId);
      return true;
    }
    bankRotation(this.logKey);
    recordContextRotation(this.contextKey);
    this.shutdown('context-budget');
    return true;
  }

  /** Forever-thread compaction check, see compaction.ts. */
  private async maybeCompact(): Promise<void> {
    try {
      await maybeAutoCompact({
        key: this.logKey,
        cli: this.cli,
        chatId: this.chatId,
        events: this.eventLog,
        isBusy: () => this.turnStartedAt !== null,
        emit: (ev) => this.emit(ev as SessionEvent),
        rotate: () => !this.disposed && this.isAlive(),
      });
    } catch (err) {
      console.warn(`[chat ${this.cli}/agy] compaction check failed for ${this.logKey}:`, (err as Error).message);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const intentional = this.disposed;
    console.log(`[chat ${this.cli}/agy] exit code=${code} signal=${signal ?? '-'} initSeen=${this.initSeen}${intentional ? ' (intentional)' : ''}`);
    if (!this.initSeen) {
      this.resolveReady(false);
      // A spawn that carried a saved --conversation id and died before init is
      // a failed resume: clear the stored id so the next spawn starts fresh,
      // and report it so the registry's fresh-session fallback engages instead
      // of retrying the stale id forever.
      if (this.startedResumeId) {
        this.resumeFailed = true;
        void setSessionId(this.cli, this.cwd, '', this.chatId);
      }
    }
    if (!intentional && this.turnStartedAt !== null) {
      this.turnFailed = { message: `agy exited (code ${code ?? signal})`, code: 'exit' };
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
  async prewarm(): Promise<void> { await this.ready; }
  isPrewarming(): boolean { return !this.initSeen && !this.disposed; }
  listenerCount(): number { return this.listeners.size; }
  lastActivityAt(): number { return this.lastActivityAtMs; }
  isAlive(): boolean { return this.child.exitCode === null && !this.disposed; }
  isDisposed(): boolean { return this.disposed; }
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

  async send(text: string, images?: ChatImage[], opts: { peerFrom?: string; peerFromRole?: string; peerText?: string; peerDeliveryId?: string; allowNativePeerSteer?: boolean; allowNativeHumanSteer?: boolean; signal?: AbortSignal; clientMsgId?: string; humanOrigin?: boolean; skipAttachments?: boolean; voiceMode?: boolean; providerContinue?: unknown } = {}): Promise<void> {
    assertSubscriptionLane(this.cli);
    if (opts.signal?.aborted) return;
    if (!this.isAlive()) throw new Error('session has exited');
    // A live process that never emits init would hang this send forever; race
    // readiness against a generous bound and retire the hung lane so the next
    // send respawns it instead of inheriting the zombie.
    let readyTimer: NodeJS.Timeout | undefined;
    const readyOk = await Promise.race([
      this.ready,
      new Promise<boolean>((resolve) => { readyTimer = setTimeout(() => resolve(false), AGY_READY_TIMEOUT_MS); }),
    ]);
    if (readyTimer) clearTimeout(readyTimer);
    if (!readyOk) {
      this.shutdown('ready-timeout');
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
      this.turnSeq++;
      this.automationTurn = automationRequest;
      this.terminalNoticeEmitted = false;
      this.turnFailed = null;
      this.turnUsage = { input: 0, output: 0, cacheRead: 0 };
      this.turnOrigin = emptyTurnOrigin();
      this.emit({ type: 'turnStart' });
    }
    const openedSeq = this.turnSeq;
    const abandon = () => {
      if (!startsNewTurn || this.turnStartedAt === null || this.turnSeq !== openedSeq) return;
      this.turnStartedAt = null; this.automationTurn = false;
      if (!this.disposed) this.emit({ type: 'turnEnd', sessionId: this.agyConversationId ?? undefined });
    };
    const historyThroughSeq = this.latestSeq();
    const wantSeed = this.seedWindowOnNextTurn;
    const seed = wantSeed ? await peekEnginePrimerThroughSeq(this.logKey, historyThroughSeq, this.eventLog.slice()) : '';
    if (opts.signal?.aborted) { abandon(); return; }

    let attachments: Array<{ id: string; mediaType: string }> = [];
    try {
      if (!opts.peerFrom && !opts.skipAttachments && images?.length) attachments = await saveChatAttachments(images);
    } catch (error) { abandon(); throw error; }

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
      this.emit({ type: 'event', event: { type: '_user_echo', text, imageCount: images?.length ?? 0, attachments, clientMsgId: opts.clientMsgId, humanOrigin: opts.humanOrigin === true, ts: Date.now() } });
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
    const continuation = isAgentThread(this.chatId)
      ? ['<rivendell-continuation>', `Warm continuation of the existing conversation. Host time: ${new Date().toString()}.`, 'Do not repeat session-start rituals.', '</rivendell-continuation>', ...(guidance ? ['', guidance] : []), ...(laneContext ? ['', laneContext] : []), ...(recall ? ['', recall] : []), ...(opts.voiceMode ? ['', THREAD_VOICE_STYLE_ADDENDUM] : []), '', promptText].join('\n')
      : recall ? `${recall}\n\n${promptText}` : promptText;
    const humanTurn = !opts.peerFrom && opts.peerFromRole !== 'automation';
    // Full computer rules ride the seed message that starts a fresh agy window;
    // later messages of the same warm process get the brief form.
    const computerContext = computerGuidance(this.cwd, this.chatId, agentForChatId(this.chatId)?.name ?? 'Companion', humanTurn, !startsNewTurn, !wantSeed);
    const priorities = prioritiesBlockFor(agentForChatId(this.chatId)?.id);
    const message = `${this.systemPromptBlock()}\n\n${computerContext}\n\n${priorities ? `${priorities}\n\n` : ''}${seed ? `${seed}\n\n---\n\n` : ''}${continuation}`;

    try {
      await this.writeUserLine(message);
    } catch (error) {
      if (wantSeed) this.seedWindowOnNextTurn = true;
      abandon();
      this.emit({ type: 'error', message: `agy rejected the input: ${(error as Error).message}` });
      return;
    }
    // The recap reached the model; the next turn recaps only what came after.
    if (startsNewTurn) this.laneSyncSeq = historyThroughSeq;
    if (wantSeed) {
      this.seedWindowOnNextTurn = false;
      // The seed was delivered, so the rotation debt that asked for it is paid.
      void clearRotation(this.logKey);
    }
    if (opts.peerDeliveryId) this.emit({ type: 'event', event: { type: 'peer_delivery_accepted', deliveryId: opts.peerDeliveryId, ts: Date.now() } });
  }

  /** Stop: agy has no abort input event, so v1 signals the process. A SIGINT
   *  that agy treats as a kill is still recoverable — the exit path closes the
   *  turn as failed and the next send respawns the lane. */
  async interrupt(reason = 'interrupt'): Promise<boolean> {
    if (!this.isAlive() || this.turnStartedAt === null) return false;
    this.emit({ type: 'event', event: { type: '_interrupted', ts: Date.now() } });
    try { this.child.kill('SIGINT'); } catch { /* gone */ }
    void reason;
    return true;
  }

  shutdown(reason = 'unspecified'): void {
    if (this.disposed) return;
    this.disposed = true;
    console.log(`[chat ${this.cli}/agy] shutdown key=${this.key} reason=${reason}`);
    try { this.child.stdin.end(); } catch { /* closed */ }
    // Never signal pid <= 1: process.kill(-1) hits every process this user owns.
    const pid = this.child.pid;
    if (!pid || pid <= 1) return;
    try { process.kill(-pid, 'SIGTERM'); } catch { try { this.child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
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
