import { assertSelectedEngine } from './engineHandover.ts';
import { prepareSessionStateDelta } from './sessionContext.ts';
/** Muse engine lane — Meta's Muse Code CLI (`muse`) on Matt's Muse Code
 *  subscription. The subscription covers only the CLI's own signed-in
 *  credential, so this lane drives the CLI and never calls api.meta.ai.
 *
 *  Protocol (probed 2026-10-24, muse 1.4.13): one headless
 *  `muse exec --json --session-id <uuid>` child per turn. The same session id
 *  resumes the native conversation on the next turn (and mints it on the
 *  first), so the lane object is long-lived while each turn's process is not.
 *  stdout is JSONL records `{stream:{kind:'session',id}, payload_type, payload}`:
 *    run.output.delta           → assistant text delta
 *    task.lifecycle.proposed    → task_kind `tool.<name>` opens a tool call
 *    task.lifecycle.scheduled   → idempotency_key `tool:<call_id>` links it
 *    tool.result                → call_id + text closes it
 *    run.usage                  → token totals and the plan allowance
 *    run.terminal.<state>       → completed | failed | cancelled, final text
 *  The persona and operating guidance ride `-c run.developer_prompt` on every
 *  turn (additive to Muse's own prompt, so they survive its compaction); the
 *  office MCP servers ride `-c mcpServers.<name>` with every env leaf passed
 *  as a whole-value `${VAR}` (the only form the CLI accepts).
 *
 *  MuseSession mirrors AgySession's public surface so register.ts, teamBus
 *  and the session registry treat every lane alike, and writes the same
 *  claude-shaped event vocabulary into the same durable thread log. */

import { type ChildProcessByStdio } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { spawnLaneWorker } from '../lib/workerReap.ts';
import { stateDir } from '../config.ts';
import { assertSubscriptionLane, museSubscriptionEnvironment } from './subscription-policy.ts';
import { computerGuidance, computerOwnerKey } from '../devices/context.ts';
import { redactComputerImages } from '../devices/transcript.ts';
import { setSessionId } from './sessions.ts';
import { appendEventLog, appendEventLogSync, flushEventLog, isPlumbingEvent, latestEventLogSeq, loadEventLogSync, reserveEventLogSeq, type PersistedEvent } from './event-log-store.ts';
import { maybeAutoCompact, noteUserTurn, bankRotation, clearRotation, peekEnginePrimerThroughSeq, refreshCompactForRotation } from './compaction.ts';
import { contextRotationDue, recordContextUsage, recordContextRotation } from './contextBudget.ts';
import { isAgentThread, isBackgroundChatId, logKeyFor } from './threadKey.ts';
import { recallBlockForTurn, recallEligibleTurn } from './autoRecall.ts';
import { personaPromptFor } from './personaPrompts.ts';
import { agentForChatId, noteAgentLane } from './agents.ts';
import { adaptImagesForTextModel } from './vision-adapter.ts';
import { chatAttachmentPath, saveChatAttachments } from '../routes/chatAttachments.ts';
import { conversationGuidanceForTurn, laneContextForTurn } from './conversation-guidance.ts';
import { isVoiceChatId, isRobotVoiceChatId, robotVoiceAddendum, THREAD_VOICE_STYLE_ADDENDUM, VOICE_STYLE_ADDENDUM } from './voicePrompt.ts';
import { TRANSCRIPT_GUIDANCE } from './transcriptGuidance.ts';
import { emptyTurnOrigin, noteTurnPeer, type TurnOrigin } from './providerSwitch.ts';
import { longCallGateEnv } from './longCallGate.ts';
import { wellFormedText } from '../lib/wellFormed.ts';
import { officeMcpConfig } from './office-mcp.ts';
import { laneMcpServers, laneTagFor, shareBackgroundLaneEvent, type CliKind, type SeqEvent, type SessionEvent } from './runner.ts';
import { plainEnglishWritingBlockFor } from './plain-english-guidance.ts';
import { boundaryInterruptEligible, personStartedTurn, type BoundaryTurnState } from './boundaryPolicy.ts';
import { noteMuseAllowance, resolveMuseBin, resolveMuseModel } from './muse-models.ts';

const EVENT_BUFFER_SIZE = 2000;
/** Readiness is local (no process until the first turn), so this only bounds
 *  the registry's wait on a session that could not even start. */
export const MUSE_READY_TIMEOUT_MS = 10_000;
const MUSE_TERMINAL_EXIT_GRACE_MS = 10_000;
/** A turn with no stdout records at all for this long is stalled. Longer
 *  than agy's bound: Muse emits nothing while one long shell tool runs. */
const MUSE_TURN_STALL_MS = 20 * 60_000;
const BOUNDARY_SETTLE_MS = 100;
const PAUSED_NOTE_TTL_MS = 10 * 60_000;
const KEY_STATE_MAX_AGE_MS = 60 * 60_000;
const PAUSED_FOR_MESSAGE_NOTE = '<rivendell-steer>Your previous turn was paused right after a tool call finished, so the message below reaches you as a normal message. Answer it first. Then, unless it changes the plan, carry on with what you were doing; the transcript above shows where you stopped.</rivendell-steer>';
/** Built-in servers the lane cannot work without; an optional server that
 *  fails its startup is dropped for the session instead of failing turns. */
const REQUIRED_MCP = new Set(['rivendell-team']);
const MCP_STARTUP_FAILURE = /Required MCP server `([^`]+)` failed during startup/;
const pausedForMessageByKey = new Map<string, { at: number; summary: string }>();
const lastBoundaryInterruptAtByKey = new Map<string, number>();

function pruneKeyState(now: number): void {
  for (const [k, v] of pausedForMessageByKey) if (now - v.at > PAUSED_NOTE_TTL_MS) pausedForMessageByKey.delete(k);
  for (const [k, at] of lastBoundaryInterruptAtByKey) if (now - at > KEY_STATE_MAX_AGE_MS) lastBoundaryInterruptAtByKey.delete(k);
}

type Listener = (e: SeqEvent) => void;
type ChatImage = { mediaType: string; base64: string };
type MuseTool = { toolUseId: string; name: string; closed: boolean };

const finiteCount = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function turnDir(): string {
  const dir = join(stateDir(), 'muse-turns');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** `mcp__rivendell_team__team_list` → `team_list`; built-ins keep their name. */
function toolLabel(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return m ? m[1] : name;
}

export class MuseSession {
  readonly key: string;
  readonly logKey: string;
  readonly cli: CliKind;
  readonly cwd: string;
  readonly chatId: string;
  readonly spawnModel: string;
  readonly spawnEffort: string;
  readonly ready: Promise<boolean>;
  private resolveReady!: (ok: boolean) => void;

  /** The current turn's `muse exec` child; null between turns. */
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  /** The native Muse session: the saved id on resume, else minted here (the
   *  CLI accepts a caller-chosen id and creates the session on first use). */
  private museSessionId: string;
  private readonly startedResumeId: string | null;
  private sessionPersisted = false;
  private resumeFailed = false;
  private listeners = new Set<Listener>();
  private eventLog: SeqEvent[] = [];
  private nextSeq = 1;
  private lastActivityAtMs = Date.now();
  private lastFrameAtMs = Date.now();
  private disposed = false;
  private initSeen = false;
  private turnStartedAt: number | null = null;
  private turnSeq = 0;
  private automationTurn = false;
  /** The open turn was started by the person's own message: only a waiting
   *  person may end it at a tool boundary (boundaryPolicy.ts). */
  private personTurn = false;
  private boundaryInterruptWanted = false;
  private boundaryWaiters = 0;
  private boundaryHumanWaiters = 0;
  private boundaryGeneration = 0;
  private boundarySettleTimer: NodeJS.Timeout | null = null;
  private lastBoundaryInterruptAt = 0;
  private pausedForMessage = false;
  /** Set by Stop: the open turn closes as cancelled when its child exits. */
  private stopping = false;
  private seedWindowOnNextTurn = false;
  private terminalNoticeEmitted = false;
  private terminalSeen = false;
  private buffer = '';
  private malformedFrames = 0;
  private stallTimer: NodeJS.Timeout | null = null;
  /** Leaders whose whole group is being ended; cleared when the leader exits. */
  private readonly groupKillPids = new Set<number>();
  private stderrTail = '';
  private turnUsage = { input: 0, output: 0, cacheRead: 0, calls: 0 };
  private turnFailed: { message: string; code?: string } | null = null;
  private pendingStateAccepts: Array<() => void> = [];
  /** The open assistant text message, if any (one at a time). */
  private textOpen = false;
  private textBuf = '';
  private lastAssistantText = '';
  private toolsByTask = new Map<string, MuseTool>();
  private taskByCall = new Map<string, string>();
  private completedTools: string[] = [];
  /** Turn activity seen (text or tools): an MCP startup failure after this is
   *  a real turn failure, never a silent retry. */
  private turnActivity = false;
  private skippedMcp = new Set<string>();
  /** Files written for this turn (prompt), removed when the turn's child exits. */
  private turnFiles: string[] = [];
  /** Respawn input for an MCP-startup retry of the same turn. */
  private turnSpawn: { promptFile: string; images: string[] } | null = null;
  private turnOrigin: TurnOrigin = emptyTurnOrigin();
  private laneSyncSeq?: number;
  private get contextKey(): string {
    return isBackgroundChatId(this.chatId) ? `${this.logKey}|bg` : this.logKey;
  }

  constructor(cli: CliKind, cwd: string, chatId: string, resumeId: string | null, model: string, effort: string, seedFirst = false, switchedFrom: string | null = null) {
    if (cli !== 'muse') throw new Error(`MuseSession cannot run the ${cli} lane`);
    this.cli = cli;
    this.cwd = cwd;
    this.chatId = chatId;
    this.key = `${cli}|${cwd}|${chatId}`;
    this.logKey = logKeyFor(cli, cwd, chatId);
    pruneKeyState(Date.now());
    this.lastBoundaryInterruptAt = lastBoundaryInterruptAtByKey.get(this.key) ?? 0;
    // Belt and braces: the registry already resolves, but a contributor id
    // must never reach --model from any caller.
    this.spawnModel = resolveMuseModel(model);
    this.spawnEffort = effort;
    this.seedWindowOnNextTurn = seedFirst;
    this.startedResumeId = resumeId;
    this.museSessionId = resumeId ?? randomUUID();
    this.sessionPersisted = Boolean(resumeId);
    this.ready = new Promise<boolean>((res) => { this.resolveReady = res; });

    try {
      const restored = loadEventLogSync(this.logKey);
      if (restored.events.length > 0) {
        this.eventLog = restored.events;
        this.nextSeq = restored.nextSeq;
      }
    } catch (err) {
      console.warn(`[chat ${cli}/muse] event-log restore failed for ${this.logKey}:`, (err as Error).message);
    }
    if (switchedFrom && switchedFrom !== cli) {
      this.emit({ type: 'event', event: { type: '_engine_switch', from: switchedFrom, to: cli, model: this.spawnModel, ts: Date.now() } } as SessionEvent);
    }
    // No process lives between turns, so the lane is ready at once; an
    // install or sign-in problem surfaces as the first turn's honest failure.
    queueMicrotask(() => {
      if (this.disposed) { this.resolveReady(false); return; }
      this.initSeen = true;
      console.log(`[chat ${cli}/muse] ready model=${this.spawnModel} effort=${this.spawnEffort} session=${this.museSessionId.slice(0, 8)}${resumeId ? ' (resume)' : ''}`);
      this.emit({ type: 'event', event: { type: 'system', subtype: 'init', cwd: this.cwd, session_id: this.museSessionId, model: this.spawnModel, harness: 'muse' } });
      this.resolveReady(true);
    });
  }

  /** The persona + operating guidance, sent as Muse's developer prompt. */
  private developerPrompt(): string {
    const voice = isVoiceChatId(this.chatId);
    const voiceAddendum = voice
      ? [VOICE_STYLE_ADDENDUM, isRobotVoiceChatId(this.chatId) ? robotVoiceAddendum(this.chatId) : null].filter(Boolean).join('\n\n')
      : null;
    const persona = personaPromptFor(this.chatId);
    const name = agentForChatId(this.chatId)?.name ?? 'a teammate';
    const operating = [
      `You are ${name}, a teammate aboard TARDIS, Matt's always-on office, running on Muse Code. You have file, shell and edit tools for this workspace, plus the rivendell-team MCP tools (mcp__rivendell_team__team_message, team_status, board_cards, priorities and friends) for talking to other teammates and working the office board, and assistant_* tools for email, calendar, tasks and integrations when they are mounted.`,
      'TARDIS teammates are reached ONLY through the rivendell-team team_message tool. Never use Muse session messaging or subagents to contact them.',
      'Do the work yourself with tools; report outcomes plainly; never claim something is done that you did not verify.',
      'Never end a turn on a stated intention. If you say you are checking, looking at, or about to do something, do it with tools in this same turn before you stop. The only things worth stopping for are a question the person must answer or a teammate reply you are waiting on, and say which.',
      'External side effects stay draft-first unless the person explicitly asked you to send, post or deploy.',
      'Nothing you start in the background can report back to you. A backgrounded shell, nohup job or watcher never wakes you when it finishes, and it may be stopped when your turn ends. Run what you need the result of in the foreground, or poll it to completion inside this turn. If something must outlive the turn, tell the person what is running, where its output goes, and that you will not see it finish.',
    ].join('\n');
    return [persona, voiceAddendum, operating, isAgentThread(this.chatId) ? TRANSCRIPT_GUIDANCE : null].filter(Boolean).join('\n\n');
  }

  /** `-c mcpServers.<name>=…` args plus the env their `${VAR}` leaves name.
   *  Same server set the Pi bridge mounts, plus the office hub when set. */
  private mcpArgs(): { args: string[]; env: Record<string, string> } {
    const args: string[] = [];
    const env: Record<string, string> = {};
    if (process.env.RIVENDELL_SIDE_COPY === '1') return { args, env };
    const agent = agentForChatId(this.chatId);
    const servers = laneMcpServers(agent?.name, isBackgroundChatId(this.chatId), computerOwnerKey(this.cwd, this.chatId), agent?.id);
    let i = 0;
    for (const [name, server] of Object.entries(servers)) {
      if (this.skippedMcp.has(name)) continue;
      const leafEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(server.env ?? {})) {
        const varName = `TARDIS_MUSE_MCP_${i}_${k.replace(/[^A-Za-z0-9_]/g, '_')}`;
        env[varName] = v;
        leafEnv[k] = `\${${varName}}`;
      }
      i += 1;
      args.push('-c', `mcpServers.${name}=${JSON.stringify({ command: server.command, args: server.args, ...(Object.keys(leafEnv).length ? { env: leafEnv } : {}) })}`);
    }
    let office: ReturnType<typeof officeMcpConfig> = null;
    try { office = officeMcpConfig(); } catch (err) { console.warn(`[chat ${this.cli}/muse] office MCP skipped: ${(err as Error).message}`); }
    if (office && !this.skippedMcp.has('office-mcp')) {
      env.TARDIS_MUSE_OFFICE_AUTH = `Bearer ${office.token}`;
      args.push('-c', `mcpServers.office-mcp=${JSON.stringify({ url: office.url, headers: { Authorization: '${TARDIS_MUSE_OFFICE_AUTH}' } })}`);
    }
    return { args, env };
  }

  // ---- per-turn process -------------------------------------------------------------

  private spawnTurn(promptFile: string, images: string[]): void {
    const { args: mcp, env: mcpEnv } = this.mcpArgs();
    const env = museSubscriptionEnvironment(process.env);
    Object.assign(env, mcpEnv);
    env.SAMWISE_ACCOUNT = this.cli;
    Object.assign(env, longCallGateEnv(this.chatId));
    const args = [
      'exec', '--json',
      '--prompt-file', promptFile,
      '--model', this.spawnModel,
      '--reasoning-effort', this.spawnEffort,
      // Never the training mode: the catalog default is a contributor model.
      '--contributor-mode', 'off',
      '--session-id', this.museSessionId,
      // A headless lane cannot answer approval prompts or questions.
      '--disable-approval', '--approval-judge', 'off', '--disable-sandbox',
      '--disable-request-user-input',
      '--trust-workspace',
      ...images.flatMap((p) => ['--image', p]),
      '-c', `run.developer_prompt=${JSON.stringify(wellFormedText(this.developerPrompt()))}`,
      ...mcp,
    ];
    this.buffer = '';
    this.stderrTail = '';
    this.malformedFrames = 0;
    const child = spawnLaneWorker(resolveMuseBin(), args, { cwd: this.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable, Readable, Readable>;
    this.child = child;
    try { child.stdin.end(); } catch { /* closed */ }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (this.child === child) this.onStdout(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.on('error', (err) => {
      console.error(`[chat ${this.cli}/muse] process error:`, err.message);
      if (this.child !== child) return;
      this.turnFailed ??= { message: `muse could not start: ${err.message}`, code: 'error' };
      // Some error kinds never fire exit; close the turn here.
      this.onChildGone(child, null, null);
    });
    // Finish on `close` so trailing records drain from the pipes first; a
    // descendant still holding stdout open gets a short grace after `exit`.
    child.on('exit', (code, signal) => {
      setTimeout(() => this.onChildGone(child, code, signal), 2_000).unref();
    });
    child.on('close', (code, signal) => this.onChildGone(child, code, signal));
  }

  private onChildGone(child: ChildProcessByStdio<Writable, Readable, Readable>, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    // Drain a final record that arrived without its newline.
    if (this.buffer.trim()) this.onStdout('\n');
    this.child = null;
    // Stop and shutdown end the whole group the moment the leader is gone,
    // so no shell descendant of the cancelled turn outlives it.
    if ((this.stopping || this.disposed || this.groupKillPids.delete(child.pid ?? 0)) && child.pid && child.pid > 1) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    }
    const retry = this.mcpRetryWanted();
    if (retry && this.turnSpawn && !this.disposed && !this.stopping) {
      console.warn(`[chat ${this.cli}/muse] optional MCP server ${retry} failed to start; retrying the turn without it`);
      this.skippedMcp.add(retry);
      this.turnFailed = null;
      this.terminalSeen = false;
      this.spawnTurn(this.turnSpawn.promptFile, this.turnSpawn.images);
      return;
    }
    this.clearTurnFiles();
    if (this.turnStartedAt !== null) {
      if (this.stopping && !this.pausedForMessage) {
        this.turnFailed = { message: 'This turn was cancelled before it finished.', code: 'aborted' };
      } else if (!this.terminalSeen && !this.pausedForMessage) {
        const detail = this.stderrDetail();
        this.turnFailed ??= { message: detail || `muse exited (code ${code ?? signal})`, code: 'exit' };
      }
      this.finishTurn();
    }
    this.stopping = false;
    if (this.disposed) {
      const se: SeqEvent = { seq: this.latestSeq(), ev: { type: 'closed', code, signal, intentional: true } };
      for (const fn of this.listeners) fn(se);
    }
  }

  /** The optional MCP server to drop when this turn failed only because it
   *  could not start (nothing ran yet, so a retry is side-effect free). */
  private mcpRetryWanted(): string | null {
    if (this.turnActivity || !this.turnFailed) return null;
    const name = MCP_STARTUP_FAILURE.exec(this.turnFailed.message)?.[1];
    return name && !REQUIRED_MCP.has(name) && !this.skippedMcp.has(name) ? name : null;
  }

  private stderrDetail(): string {
    const lines = this.stderrTail.split('\n').map((l) => l.replace(/^muse:\s*/, '').trim()).filter(Boolean);
    const useful = lines.filter((l) => /fail|error|refus|denied|expired|log ?in|limit|unauthor/i.test(l));
    return (useful.at(-1) ?? '').slice(0, 300);
  }

  private clearTurnFiles(): void {
    for (const f of this.turnFiles.splice(0)) { try { rmSync(f, { force: true }); } catch { /* gone */ } }
    this.turnSpawn = null;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { this.noteMalformedFrame(line); continue; }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.payload_type !== 'string' || !rec.payload || typeof rec.payload !== 'object') {
        this.noteMalformedFrame(line);
        continue;
      }
      this.malformedFrames = 0;
      try { this.handleRecord(rec); } catch (err) {
        console.error(`[chat ${this.cli}/muse] record handling failed:`, (err as Error).message);
      }
    }
  }

  // ---- record normalisation -------------------------------------------------------

  private stream(event: Record<string, unknown>): void {
    this.emit({ type: 'event', event: { type: 'stream_event', event, session_id: this.museSessionId } });
  }

  private openMessage(): void {
    this.stream({ type: 'message_start', message: { id: randomUUID(), type: 'message', role: 'assistant', content: [], model: this.spawnModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } });
  }

  private closeText(): void {
    if (!this.textOpen) return;
    this.textOpen = false;
    if (this.textBuf.trim()) this.lastAssistantText = this.textBuf;
    this.textBuf = '';
    this.stream({ type: 'content_block_stop', index: 0 });
    this.stream({ type: 'message_delta', delta: { stop_reason: this.turnFailed ? null : 'end_turn', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    this.stream({ type: 'message_stop' });
  }

  private closeTool(tool: MuseTool, text: string, isError: boolean): void {
    if (tool.closed) return;
    tool.closed = true;
    this.completedTools.push(tool.name);
    this.emit({ type: 'event', event: { type: 'user', parent_tool_use_id: null, session_id: this.museSessionId, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.toolUseId, ...(isError ? { is_error: true } : {}), content: [{ type: 'text', text: text.slice(0, 8000) }] }] } } });
    this.maybeFireBoundaryInterrupt();
  }

  private handleRecord(rec: any): void {
    this.lastActivityAtMs = Date.now();
    this.lastFrameAtMs = Date.now();
    if (this.turnStartedAt === null) return;
    const streamId = rec.stream?.kind === 'session' && typeof rec.stream.id === 'string' ? rec.stream.id : null;
    if (streamId && streamId !== this.museSessionId) {
      if (this.startedResumeId) this.resumeFailed = true;
      this.turnFailed ??= { message: 'Muse Code answered on a different session than the saved one; the saved ID was retained.', code: 'protocol' };
      if (this.child) this.killChild(this.child, true);
      return;
    }
    if (streamId && !this.sessionPersisted) {
      this.sessionPersisted = true;
      void setSessionId(this.cli, this.cwd, this.museSessionId, this.chatId);
    }
    const p = rec.payload;
    const type: string = rec.payload_type;
    if (type === 'run.output.delta') {
      const text = typeof p.text === 'string' ? p.text : '';
      if (!text) return;
      this.turnActivity = true;
      this.pendingStateAccepts.splice(0).forEach((accept) => accept());
      if (!this.textOpen) {
        this.textOpen = true;
        this.openMessage();
        this.stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      }
      this.textBuf += text;
      this.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      return;
    }
    if (type === 'task.lifecycle.proposed') {
      const kind = typeof p.event?.task_kind === 'string' ? p.event.task_kind : '';
      const taskId = typeof p.event?.task_id === 'string' ? p.event.task_id : '';
      // Only tool tasks are shown; model calls and reminder agents are plumbing.
      if (!kind.startsWith('tool.') || !taskId || this.toolsByTask.has(taskId)) return;
      this.turnActivity = true;
      this.pendingStateAccepts.splice(0).forEach((accept) => accept());
      this.closeText();
      const name = kind.slice('tool.'.length) || 'tool';
      const tool: MuseTool = { toolUseId: randomUUID(), name, closed: false };
      this.toolsByTask.set(taskId, tool);
      this.openMessage();
      this.stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.toolUseId, name, input: {} } });
      this.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
      this.stream({ type: 'content_block_stop', index: 0 });
      this.stream({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } });
      this.stream({ type: 'message_stop' });
      return;
    }
    if (type === 'task.lifecycle.scheduled') {
      const key = typeof p.event?.idempotency_key === 'string' ? p.event.idempotency_key : '';
      const taskId = typeof p.event?.task_id === 'string' ? p.event.task_id : '';
      if (key.startsWith('tool:') && this.toolsByTask.has(taskId)) this.taskByCall.set(key.slice('tool:'.length), taskId);
      return;
    }
    if (type === 'task.lifecycle.failed' || type === 'task.lifecycle.cancelled' || type === 'task.lifecycle.rejected') {
      const taskId = typeof p.event?.task_id === 'string' ? p.event.task_id : '';
      const tool = this.toolsByTask.get(taskId);
      if (tool) this.closeTool(tool, String(p.event?.reason ?? type.slice('task.lifecycle.'.length)), true);
      return;
    }
    if (type === 'tool.result') {
      const callId = typeof p.call_id === 'string' ? p.call_id : '';
      const taskId = this.taskByCall.get(callId);
      const tool = taskId ? this.toolsByTask.get(taskId) : undefined;
      if (!tool) return;
      const outcome = p.correlation_facts?.outcome;
      this.closeTool(tool, typeof p.text === 'string' ? p.text : '', typeof outcome === 'string' && outcome !== 'success');
      return;
    }
    if (type === 'run.usage') {
      // One record per turn with totals across every model call in it.
      let input = 0, cached = 0, output = 0, calls = 0;
      for (const m of Array.isArray(p.models) ? p.models : []) {
        input += finiteCount(m?.input_tokens);
        cached += finiteCount(m?.cached_tokens);
        output += finiteCount(m?.output_tokens);
        calls += finiteCount(m?.calls);
      }
      this.turnUsage = { input: Math.max(0, input - cached), output, cacheRead: Math.min(cached, input), calls: calls || finiteCount(p.calls) };
      noteMuseAllowance(p.allowance);
      return;
    }
    if (type.startsWith('run.terminal.')) {
      this.terminalSeen = true;
      const terminal = typeof p.terminal === 'string' ? p.terminal : type.slice('run.terminal.'.length);
      const text = typeof p.text === 'string' ? p.text : '';
      if (terminal === 'completed') {
        if (text.trim() && !this.textBuf.trim() && !this.lastAssistantText.trim()) this.lastAssistantText = text;
      } else if (!this.pausedForMessage && !this.stopping) {
        const reason = typeof p.reason === 'string' && p.reason ? p.reason : `Muse Code run ${terminal}`;
        this.turnFailed ??= { message: reason, code: /limit|allowance|quota|429|exhaust/i.test(reason) ? 'usage_limit' : terminal === 'cancelled' ? 'aborted' : 'error' };
      }
      // The child exits right after; the turn closes on its exit so the
      // process is gone before the lane accepts another turn. A leader that
      // hangs past the terminal record is ended rather than left busy.
      const child = this.child;
      if (child) setTimeout(() => { if (this.child === child) this.killChild(child, true); }, MUSE_TERMINAL_EXIT_GRACE_MS).unref();
      return;
    }
  }

  private noteMalformedFrame(line: string): void {
    this.malformedFrames += 1;
    if (this.malformedFrames <= 5) console.warn(`[chat ${this.cli}/muse] unparsable stdout record (${this.malformedFrames}): ${line.slice(0, 200)}`);
    if (this.turnStartedAt !== null && this.malformedFrames >= 3 && this.child) {
      this.malformedFrames = 0;
      this.turnFailed ??= { message: 'Muse Code stream records became unparsable (protocol change?)', code: 'protocol' };
      this.killChild(this.child, true);
    }
  }

  private armStallWatchdog(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    const arm = (ms: number): void => {
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        if (this.disposed || this.turnStartedAt === null) return;
        const silentFor = Date.now() - this.lastFrameAtMs;
        if (silentFor < MUSE_TURN_STALL_MS) { arm(Math.max(MUSE_TURN_STALL_MS - silentFor, 2_000)); return; }
        this.turnFailed ??= { message: `Muse Code turn stalled (no records for ${Math.round(MUSE_TURN_STALL_MS / 60_000)} minutes)`, code: 'stalled' };
        if (this.child) this.killChild(this.child, true);
        else this.finishTurn();
      }, ms);
      this.stallTimer.unref();
    };
    arm(MUSE_TURN_STALL_MS + 2_000);
  }

  /** SIGINT the leader (Muse flushes its session log and exits), then on a
   *  grace terminate the whole process group when `group` (Stop: shell tool
   *  children must not outlive the turn). A message-boundary pause signals
   *  only the leader so a backgrounded job the agent started survives. */
  private killChild(child: ChildProcessByStdio<Writable, Readable, Readable>, group: boolean): void {
    const pid = child.pid;
    try { child.kill('SIGINT'); } catch { /* gone */ }
    if (!pid || pid <= 1) return;
    if (group) this.groupKillPids.add(pid);
    setTimeout(() => {
      if (group) {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
        setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3_000).unref();
      } else if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3_000).unref();
      }
    }, 1_500).unref();
  }

  private hasOpenTool(): boolean {
    for (const t of this.toolsByTask.values()) if (!t.closed) return true;
    return false;
  }

  private completedToolSummary(): string {
    return this.completedTools.length > 0 ? `Completed tool steps before pause: ${this.completedTools.map(toolLabel).join(', ')}.` : '';
  }

  private boundaryTurnState(): BoundaryTurnState {
    return { humanWaiters: this.boundaryHumanWaiters, personTurn: this.personTurn, automationTurn: this.automationTurn, turnStartedAt: this.turnStartedAt ?? 0, lastInterruptAt: this.lastBoundaryInterruptAt };
  }

  private maybeFireBoundaryInterrupt(): void {
    if (!this.boundaryInterruptWanted || this.turnStartedAt === null || this.disposed || this.stopping) return;
    if (this.hasOpenTool()) return;
    const now = Date.now();
    const eligible = boundaryInterruptEligible(this.boundaryTurnState(), now);
    if (!eligible || this.boundarySettleTimer) return;
    const turnSeq = this.turnSeq;
    this.boundarySettleTimer = setTimeout(() => {
      this.boundarySettleTimer = null;
      if (!this.boundaryInterruptWanted || this.turnStartedAt === null || this.turnSeq !== turnSeq || this.disposed || this.stopping) return;
      if (this.boundaryWaiters === 0 || this.hasOpenTool()) return;
      const firedAt = Date.now();
      const stillEligible = boundaryInterruptEligible(this.boundaryTurnState(), firedAt);
      if (!stillEligible) return;
      this.boundaryInterruptWanted = false;
      this.lastBoundaryInterruptAt = firedAt;
      lastBoundaryInterruptAtByKey.set(this.key, firedAt);
      void this.interrupt('message-boundary');
    }, BOUNDARY_SETTLE_MS);
    this.boundarySettleTimer.unref?.();
  }

  activeTurnStartedAt(): number | null {
    return this.turnStartedAt;
  }

  private finishTurn(): void {
    if (this.turnStartedAt === null) return;
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    if (this.pausedForMessage) {
      pausedForMessageByKey.set(this.key, { at: Date.now(), summary: this.completedToolSummary() });
    }
    this.closeText();
    // A tool still open at the end never got its result; close its card.
    for (const tool of this.toolsByTask.values()) if (!tool.closed) this.closeTool(tool, this.turnFailed ? 'The turn ended before this tool finished.' : '', Boolean(this.turnFailed));
    const failed = this.turnFailed;
    this.pendingStateAccepts = [];
    if (failed && !this.terminalNoticeEmitted) {
      this.terminalNoticeEmitted = true;
      const plain = failed.code === 'aborted'
        ? failed.message
        : `Muse Code could not answer this turn (${failed.message.slice(0, 160)}). Try again or switch brains.`;
      this.emit({ type: 'event', event: { type: '_terminal_error', message: plain, code: failed.code ?? 'error', retryable: failed.code !== 'aborted', ts: Date.now() } });
    }
    const usage = this.turnUsage;
    // run.usage totals every model call in the turn, so the per-call average
    // stands in for the window the last call occupied (meter and rotation).
    const calls = Math.max(1, usage.calls);
    const perCall = { input_tokens: Math.round(usage.input / calls), output_tokens: Math.round(usage.output / calls), cache_read_input_tokens: Math.round(usage.cacheRead / calls) };
    this.emit({ type: 'event', event: { type: 'result', subtype: failed ? 'error' : 'success', is_error: Boolean(failed), ...(failed ? { result: failed.message, errors: [failed.message] } : { result: this.lastAssistantText }), session_id: this.museSessionId, usage: perCall } });
    recordContextUsage(this.contextKey, 'muse', { ...perCall, cache_creation_input_tokens: 0 });
    this.lastAssistantText = '';
    this.textBuf = '';
    this.toolsByTask.clear();
    this.taskByCall.clear();
    this.completedTools = [];
    this.turnStartedAt = null;
    this.automationTurn = false;
    this.clearBoundaryRequest();
    this.turnFailed = null;
    this.emit({ type: 'turnEnd', sessionId: this.museSessionId });
    if (!failed && !this.disposed) {
      const rotationDue = contextRotationDue(this.contextKey);
      const housekeeping = async () => {
        if (rotationDue && (await this.rotateContextAtBoundary())) return;
        await this.maybeCompact();
      };
      void housekeeping().catch((err) => console.warn(`[context-rotation] ${this.logKey}: deferred after maintenance failure`, (err as Error).message));
    }
  }

  /** Turn-boundary context rotation, same policy as the Pi and Claude lanes:
   *  past the budget, refresh the durable compact, drop the native session id
   *  and retire the lane; the next send starts a fresh Muse session seeded
   *  with the compact plus recent turns. */
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
      if (!this.disposed) await setSessionId(this.cli, this.cwd, this.museSessionId, this.chatId);
      return true;
    }
    bankRotation(this.logKey);
    recordContextRotation(this.contextKey);
    this.shutdown('context-budget');
    return true;
  }

  private async maybeCompact(): Promise<void> {
    try {
      await maybeAutoCompact({
        key: this.logKey,
        cli: this.cli,
        chatId: this.chatId,
        events: this.eventLog,
        isBusy: () => this.turnStartedAt !== null,
        emit: (ev) => this.emit(ev as SessionEvent),
        rotate: () => !this.disposed,
      });
    } catch (err) {
      console.warn(`[chat ${this.cli}/muse] compaction check failed for ${this.logKey}:`, (err as Error).message);
    }
  }

  // ---- public surface (mirrors AgySession) ----------------------------------------

  subscribe(fn: Listener, sinceSeq = -1, _countSubscriber = true): () => void {
    this.listeners.add(fn);
    if (sinceSeq >= 0) for (const se of this.eventLog) if (se.seq > sinceSeq) fn(se);
    return () => { this.listeners.delete(fn); };
  }
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
  isAlive(): boolean { return !this.disposed; }
  isDisposed(): boolean { return this.disposed; }
  /** True once no turn process is running (none lives between turns). */
  processExited(): boolean { return this.child === null; }
  postNotice(event: Record<string, unknown>): boolean {
    if (this.disposed) return false;
    this.emit({ type: 'event', event });
    return true;
  }
  isBusy(): boolean { return this.turnStartedAt !== null || this.child !== null; }
  isAutomationTurn(): boolean { return this.turnStartedAt !== null && this.automationTurn; }
  /** One `muse exec` runs one whole turn and takes no input mid-run, so a
   *  human message during a busy turn waits for a tool boundary instead. */
  canAcceptNativeHumanSteer(): boolean { return false; }
  requestBoundaryInterrupt(opts: { human?: boolean } = {}): (() => void) | null {
    const human = opts.human === true;
    if (this.turnStartedAt === null || !this.isAlive()) return null;
    this.boundaryInterruptWanted = true;
    this.boundaryWaiters += 1;
    if (human) this.boundaryHumanWaiters += 1;
    if (human && !this.hasOpenTool() && this.completedTools.length > 0) this.maybeFireBoundaryInterrupt();
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
        if (this.boundarySettleTimer) { clearTimeout(this.boundarySettleTimer); this.boundarySettleTimer = null; }
      }
    };
  }
  private clearBoundaryRequest(): void {
    this.boundaryInterruptWanted = false;
    this.boundaryWaiters = 0;
    this.boundaryHumanWaiters = 0;
    this.boundaryGeneration += 1;
    if (this.boundarySettleTimer) { clearTimeout(this.boundarySettleTimer); this.boundarySettleTimer = null; }
  }
  sessionId(): string | null { return this.museSessionId; }
  startedWithResume(): boolean { return this.startedResumeId !== null; }
  hasResumeFailed(): boolean { return this.resumeFailed; }
  hasStaleZaiProvider(): boolean { return false; }
  activeSelection(): { model?: string; effort?: string } { return { model: this.spawnModel, effort: this.spawnEffort }; }
  async waitForInitOrExit(timeoutMs: number): Promise<'initialized' | 'closed' | 'timeout'> {
    const ok = await Promise.race([this.ready, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs).unref())]);
    return ok === 'timeout' ? 'timeout' : ok ? 'initialized' : 'closed';
  }
  ingestExternalEvent(se: SeqEvent): void {
    if (this.disposed) return;
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    for (const fn of this.listeners) fn(se);
  }

  async send(text: string, images?: ChatImage[], opts: { peerFrom?: string; peerFromRole?: string; peerText?: string; peerDeliveryId?: string; allowNativePeerSteer?: boolean; allowNativeHumanSteer?: boolean; signal?: AbortSignal; clientMsgId?: string; humanOrigin?: boolean; skipAttachments?: boolean; voiceMode?: boolean; providerContinue?: unknown; echoText?: string; replyTo?: { from: string; snippet: string } } = {}): Promise<void> {
    assertSelectedEngine(this.chatId, this.cli);
    assertSubscriptionLane(this.cli);
    if (opts.signal?.aborted) return;
    if (!this.isAlive()) throw new Error('session has exited');
    await this.ready;
    // One process per turn: a second `muse exec` on the same session while
    // one runs (or is still stopping) would interleave two turns.
    if (this.turnStartedAt !== null || this.child !== null) {
      if (opts.peerFrom) return;
      throw new Error('the current turn must reach a safe boundary before guidance is delivered');
    }
    const automationRequest = opts.peerFromRole === 'automation';
    this.turnStartedAt = Date.now();
    this.pendingStateAccepts = [];
    this.turnSeq++;
    this.automationTurn = automationRequest;
    this.personTurn = personStartedTurn(opts);
    this.clearBoundaryRequest();
    this.pausedForMessage = false;
    this.stopping = false;
    this.terminalNoticeEmitted = false;
    this.terminalSeen = false;
    this.turnFailed = null;
    this.turnActivity = false;
    this.turnUsage = { input: 0, output: 0, cacheRead: 0, calls: 0 };
    this.textOpen = false;
    this.textBuf = '';
    this.lastAssistantText = '';
    this.toolsByTask.clear();
    this.taskByCall.clear();
    this.completedTools = [];
    this.turnOrigin = emptyTurnOrigin();
    this.emit({ type: 'turnStart' });
    this.armStallWatchdog();
    const openedSeq = this.turnSeq;
    const abandon = () => {
      if (this.turnStartedAt === null || this.turnSeq !== openedSeq) return;
      if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
      this.turnStartedAt = null; this.automationTurn = false;
      this.clearBoundaryRequest();
      this.clearTurnFiles();
      if (!this.disposed) this.emit({ type: 'turnEnd', sessionId: this.museSessionId });
    };
    const historyThroughSeq = this.latestSeq();
    const wantSeed = this.seedWindowOnNextTurn;
    let pausedNote = '';
    try {
      const seed = wantSeed ? await peekEnginePrimerThroughSeq(this.logKey, historyThroughSeq, this.eventLog.slice()) : '';
      if (opts.signal?.aborted) { abandon(); return; }

      let attachments: Array<{ id: string; mediaType: string }> = [];
      if (!opts.peerFrom && !opts.skipAttachments && images?.length) attachments = await saveChatAttachments(images);
      // Muse takes images natively (--image). Saved attachments are validated
      // files already; anything else (peer images) rides as a description.
      const imagePaths = attachments.map((a) => chatAttachmentPath(a.id));
      let promptText = text;
      if (images?.length && imagePaths.length === 0) {
        const result = await adaptImagesForTextModel({ text, images, modelSupportsImages: false });
        if (result.adapted) { promptText = result.text; console.log(`[chat ${this.cli}/muse] vision adapter: ${result.note}`); }
        if (opts.signal?.aborted || !this.isAlive()) { abandon(); return; }
      }

      if (opts.peerFrom) {
        noteTurnPeer(this.turnOrigin, opts.peerFrom, opts.peerFromRole, opts.peerText ?? text);
        if (opts.peerFromRole !== 'automation') this.turnOrigin.human = true;
        if (automationRequest) this.turnOrigin.automation = true;
        this.emit({ type: 'event', event: { type: 'peer_message', startsTurn: true, from: opts.peerFrom, fromRole: opts.peerFromRole ?? '', text: opts.peerText !== undefined ? opts.peerText : text, ...(opts.peerDeliveryId ? { deliveryId: opts.peerDeliveryId } : {}), ts: Date.now() } });
      } else {
        await flushEventLog(this.logKey);
        if (opts.signal?.aborted) { abandon(); return; }
        this.emit({ type: 'event', event: { type: '_user_echo', startsTurn: true, text: opts.echoText ?? text, imageCount: images?.length ?? 0, attachments, clientMsgId: opts.clientMsgId, humanOrigin: opts.humanOrigin === true, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}), ts: Date.now() } });
        noteUserTurn(this.logKey);
        noteAgentLane(this.chatId, this.cli);
        this.turnOrigin.human = true;
      }

      const guidance = conversationGuidanceForTurn({
        chatId: this.chatId, logKey: this.logKey, historyThroughSeq, peerFrom: opts.peerFrom,
        peerFromRole: opts.peerFromRole,
        hidden: false,
      });
      const laneContext = laneContextForTurn({ chatId: this.chatId, logKey: this.logKey, sinceSeq: this.laneSyncSeq ?? null, throughSeq: historyThroughSeq, seeded: Boolean(seed) });
      const recall = !automationRequest
        && recallEligibleTurn(this.chatId, { peerFrom: opts.peerFrom, peerFromRole: opts.peerFromRole, voiceMode: opts.voiceMode })
        ? await recallBlockForTurn({ cli: this.cli, cwd: this.cwd, chatId: this.chatId, logKey: this.logKey, messageText: opts.peerText ?? text })
        : '';
      if (opts.signal?.aborted) { abandon(); return; }
      const pausedEntry = !automationRequest ? pausedForMessageByKey.get(this.key) : undefined;
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
      const computerContext = computerGuidance(this.cwd, this.chatId, agentForChatId(this.chatId)?.name ?? 'Companion', humanTurn, false, !wantSeed);
      const stateDelta = await prepareSessionStateDelta(this.chatId);
      const priorities = stateDelta.text;
      const plainEnglish = plainEnglishWritingBlockFor({ cli: this.cli, model: this.spawnModel, voiceMode: opts.voiceMode, humanTurn });
      const message = `${computerContext}\n\n${priorities ? `${priorities}\n\n` : ''}${seed ? `${seed}\n\n---\n\n` : ''}${continuation}${plainEnglish ? `\n\n${plainEnglish}` : ''}`;

      // The prompt goes through a 0600 file, never argv (size limits, `ps`).
      const promptFile = join(turnDir(), `prompt-${randomUUID()}.md`);
      writeFileSync(promptFile, wellFormedText(message), { mode: 0o600 });
      this.turnFiles.push(promptFile);
      // Stop during the awaits above already closed this turn: never spawn it.
      if (opts.signal?.aborted || this.disposed || this.stopping || this.turnStartedAt === null || this.turnSeq !== openedSeq) {
        abandon();
        if (this.turnStartedAt === null) this.clearTurnFiles();
        return;
      }
      this.turnSpawn = { promptFile, images: imagePaths };
      this.spawnTurn(promptFile, imagePaths);
      this.pendingStateAccepts.push(stateDelta.accept);
    } catch (error) {
      if (wantSeed) this.seedWindowOnNextTurn = true;
      abandon();
      this.emit({ type: 'error', message: `Muse Code turn failed before it started: ${(error as Error).message}` });
      return;
    }
    this.laneSyncSeq = historyThroughSeq;
    if (pausedNote) pausedForMessageByKey.delete(this.key);
    if (wantSeed) {
      this.seedWindowOnNextTurn = false;
      void clearRotation(this.logKey);
    }
    if (opts.peerDeliveryId) this.emit({ type: 'event', event: { type: 'peer_delivery_accepted', deliveryId: opts.peerDeliveryId, ts: Date.now() } });
  }

  /** Stop ends the turn's process group (Muse runs shell tools as children);
   *  the turn closes as cancelled when the leader exits, with a backstop.
   *  A message-boundary pause fires only after a tool finished and signals
   *  only the leader. The lane stays usable: the next send resumes the same
   *  native session in a new process. */
  async interrupt(reason = 'interrupt'): Promise<boolean> {
    const boundaryPause = reason === 'message-boundary';
    if (!boundaryPause) {
      this.pausedForMessage = false;
      pausedForMessageByKey.delete(this.key);
    }
    if (this.disposed || this.turnStartedAt === null) return false;
    const child = this.child;
    if (boundaryPause) {
      this.pausedForMessage = true;
      pausedForMessageByKey.set(this.key, { at: Date.now(), summary: this.completedToolSummary() });
    } else {
      this.stopping = true;
    }
    this.clearBoundaryRequest();
    this.emit({ type: 'event', event: { type: '_interrupted', ts: Date.now() } });
    if (!child) {
      // Still preparing the prompt: nothing to signal; close the books now.
      if (!boundaryPause) this.turnFailed = { message: 'This turn was cancelled before it finished.', code: 'aborted' };
      this.finishTurn();
      return true;
    }
    this.killChild(child, !boundaryPause);
    const turnSeq = this.turnSeq;
    setTimeout(() => {
      if (this.turnStartedAt === null || this.turnSeq !== turnSeq) return;
      if (!this.pausedForMessage) this.turnFailed = { message: 'This turn was cancelled before it finished.', code: 'aborted' };
      this.finishTurn();
    }, 5_000).unref();
    return true;
  }

  shutdown(reason = 'unspecified'): void {
    if (this.disposed) return;
    // Close an open turn while emit still works (emit refuses once disposed).
    if (this.turnStartedAt !== null) {
      if (!this.pausedForMessage) this.turnFailed ??= { message: 'This turn was cancelled before it finished.', code: 'aborted' };
      this.finishTurn();
    }
    this.clearBoundaryRequest();
    this.disposed = true;
    this.resolveReady(false);
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    console.log(`[chat ${this.cli}/muse] shutdown key=${this.key} reason=${reason}`);
    const child = this.child;
    if (child) {
      // onChildGone emits the intentional close once the process is gone.
      this.killChild(child, true);
      return;
    }
    this.clearTurnFiles();
    const se: SeqEvent = { seq: this.latestSeq(), ev: { type: 'closed', code: 0, signal: null, intentional: true } };
    for (const fn of this.listeners) fn(se);
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
