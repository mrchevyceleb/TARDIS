/** Automatic continue after GLM's model provider switches mid-turn.
 *
 *  A GLM child freezes its provider (Z.ai coding plan or Fireworks) into its
 *  environment, so when the plan window closes under a running turn the turn
 *  fails and the child has to be replaced. The replacement used to wait for
 *  the NEXT send, so a teammate handoff or a routine that hit the wall just
 *  stopped, and nobody was told.
 *
 *  Now the runner that saw the cut schedules one automatic continue: once the
 *  old child has exited, the lane respawns on the new provider (resuming the
 *  same native session, see preferResumeAfterProviderCut) and gets a short
 *  "continue where you left off" prompt instead of a replay of the original
 *  message, so finished side effects are not redone. A human message already
 *  queued for the lane, or any other message that reaches it first, takes the
 *  turn instead and carries the same context (providerCutGuidance). A cut that
 *  cannot be continued leaves an unread notice and tells the teammate whose
 *  handoff did not run. */

import { randomUUID } from 'node:crypto';
import type { CliKind, SeqEvent } from './runner.ts';
import type { ZaiMode } from './zaiQuota.ts';
import { appendEventLogDurable, appendEventLogSync, flushEventLog, loadEventLogSync, reserveEventLogSeq } from './event-log-store.ts';
import { agentForChatId, brainForAgent, cliForAgentEngine, listAgents } from './agents.ts';

/** Stream event that opens an automatic continue turn. Not rendered: the
 *  `_terminal_error` notice before it already says what happened. */
export const PROVIDER_CONTINUE_EVENT = '_provider_continue';

export type ProviderCut = { from: ZaiMode; to: ZaiMode };

/** Who a turn was for, so a cut turn can be continued in the same role and a
 *  teammate whose handoff did not run can be told. */
export type TurnOrigin = {
  /** Teammate (or routine) deliveries admitted into the turn. `notice` marks
   *  a "your handoff did not run" message, which is never answered in kind:
   *  two GLM teammates with a closed plan would otherwise ping-pong forever. */
  peers: Array<{ from: string; role: string; notice?: boolean }>;
  /** A person typed into it (drives the computer-use context). */
  human: boolean;
  /** A scheduled routine started it. */
  automation: boolean;
};

/** What a runner's send() needs to open an automatic continue turn. */
export type ProviderContinueOpts = { id: string; origin: TurnOrigin; cut: ProviderCut };

export function emptyTurnOrigin(): TurnOrigin {
  return { peers: [], human: false, automation: false };
}

const HANDOFF_NOT_RUN = 'Handoff did not run.';

/** Record a delivery admitted into the current turn. */
export function noteTurnPeer(origin: TurnOrigin, from: string, role: string | undefined, text: string): void {
  const entry = { from, role: role ?? '', notice: text.startsWith(HANDOFF_NOT_RUN) || undefined };
  if (!origin.peers.some((peer) => peer.from === entry.from && peer.role === entry.role && Boolean(peer.notice) === Boolean(entry.notice))) {
    origin.peers.push(entry);
  }
}

export const PROVIDER_CONTINUE_PROMPT = [
  'The model provider switched mid-turn, so your last turn was cut off before it finished.',
  'Continue exactly where you left off. Work that already finished stays done: check your history and do not repeat tool calls or side effects that already happened.',
].join(' ');

const PROVIDER_CUT_GUIDANCE = [
  '<rivendell-provider-cut>',
  'Your previous turn was cut off by a model provider failure before it finished. Work that already finished stays done, so do not repeat tool calls or side effects that already happened. If that earlier work is unfinished, finish it along with this message.',
  '</rivendell-provider-cut>',
].join('\n');

type Seqish = { ev?: any } | null | undefined;

/** The provider cut that ended this thread's last turn, if no message has
 *  reached the thread since. */
export function pendingProviderCut(events: ReadonlyArray<Seqish>): ProviderCut | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const outer = events[i]?.ev;
    const inner = outer?.type === 'event' ? outer.event : null;
    const type = inner?.type;
    if (type === '_user_echo' || type === 'peer_message' || type === PROVIDER_CONTINUE_EVENT) return null;
    // A later turn that finished (a native wake, say) settled the cut.
    if (type === 'result' && inner.is_error !== true) return null;
    if (type === '_terminal_error' && inner.providerCut && typeof inner.providerCut === 'object') {
      const { from, to } = inner.providerCut as { from?: unknown; to?: unknown };
      if ((from === 'plan' || from === 'fireworks') && (to === 'plan' || to === 'fireworks')) return { from, to };
      return null;
    }
  }
  return null;
}

/** Context for the first ordinary message after a cut, so a human or teammate
 *  message that beats the automatic continue still finishes the cut work. */
export function providerCutGuidance(events: ReadonlyArray<Seqish>): string {
  return pendingProviderCut(events) ? PROVIDER_CUT_GUIDANCE : '';
}

/** A respawn right after a cut resumes the native session even where the
 *  ordinary heuristics would reseed from the visible thread: only the native
 *  session holds the cut turn's tool calls, and it is exactly the context the
 *  retired child had a moment ago. */
export function preferResumeAfterProviderCut(events: ReadonlyArray<Seqish>): boolean {
  return pendingProviderCut(events) !== null;
}

// ---- human queue probe --------------------------------------------------------

let queuedHumanProbe: ((logKey: string) => boolean) | null = null;

/** The chat socket layer owns queued human steers and sends. It registers a
 *  probe so the automatic continue never jumps ahead of one. */
export function setQueuedHumanProbe(probe: ((logKey: string) => boolean) | null): void {
  queuedHumanProbe = probe;
}

function humanQueued(logKey: string): boolean {
  try { return queuedHumanProbe?.(logKey) === true; } catch { return false; }
}

// ---- scheduling ----------------------------------------------------------------

type RetiringSession = {
  isDisposed(): boolean;
  processExited(): boolean;
  hasStaleZaiProvider(): boolean;
  subscribe(fn: (se: SeqEvent) => void, sinceSeq?: number, countSubscriber?: boolean): () => void;
};

type ContinuableSession = {
  isBusy(): boolean;
  isAlive(): boolean;
  latestSeq(): number;
  subscribe(fn: (se: SeqEvent) => void, sinceSeq?: number, countSubscriber?: boolean): () => void;
  send(text: string, images?: undefined, opts?: Record<string, unknown>): Promise<void>;
};

export type ProviderContinueRequest = {
  cli: CliKind;
  cwd: string;
  chatId: string;
  logKey: string;
  model: string;
  effort: string;
  /** Seq of the notice that closed the cut turn. */
  noticeSeq: number;
  cut: ProviderCut;
  origin: TurnOrigin;
  /** The child that was cut. The continue waits for it to exit so two
   *  processes never resume the same native session at once. */
  retiring: RetiringSession;
};

type Job = ProviderContinueRequest & { cancelled: boolean; started: boolean };

const jobs = new Map<string, Job>();
/** A kept-for-background-work child can hold the continue this long. */
const BACKGROUND_HOLD_MS = 6 * 60 * 60_000;
/** A retired child gets SIGKILL after 3s; this only bounds a missing exit. */
const EXIT_WAIT_MS = 15_000;

/** Queue the one automatic continue for a cut turn. A second cut on the same
 *  thread before it runs (a kept child waking and failing again) folds in. */
export function scheduleProviderContinue(request: ProviderContinueRequest): void {
  const existing = jobs.get(request.logKey);
  // A job still waiting for its old child absorbs the new cut. One already
  // past that point cannot see it, so the new cut gets its own job.
  if (existing && !existing.cancelled && !existing.started) {
    existing.noticeSeq = Math.max(existing.noticeSeq, request.noticeSeq);
    existing.cut = request.cut;
    existing.retiring = request.retiring;
    existing.origin = mergeOrigins(existing.origin, request.origin);
    return;
  }
  const job: Job = { ...request, cancelled: false, started: false };
  jobs.set(request.logKey, job);
  console.warn(`[chat ${request.cli}] provider switched mid-turn on ${request.logKey} (${request.cut.from} -> ${request.cut.to}); continuing automatically`);
  void runJob(job).finally(() => {
    if (jobs.get(job.logKey) === job) jobs.delete(job.logKey);
  });
}

/** Service shutdown: a continue still waiting to run dies with the process.
 *  Leave its unread notice synchronously so the cut is not silent after the
 *  restart. */
export function markPendingProviderContinuesInterrupted(): number {
  let marked = 0;
  for (const job of [...jobs.values()]) {
    job.cancelled = true;
    jobs.delete(job.logKey);
    const label = job.cut.to === 'fireworks' ? 'Fireworks' : 'the Z.ai coding plan';
    const event = providerCutNoticeEvent(`TARDIS restarted before GLM could continue on ${label}. Send again to continue.`, job.cut, { unread: true });
    try {
      const written = appendEventLogSync(job.logKey, { seq: reserveEventLogSeq(job.logKey), at: Date.now(), ev: { type: 'event', event }, eng: job.cli, mdl: job.model });
      if (written) marked += 1;
    } catch (err) {
      console.warn(`[chat ${job.cli}] could not note the interrupted continue on ${job.logKey}: ${(err as Error).message}`);
    }
  }
  return marked;
}

/** Stop and Fresh cancel a continue that has not started yet. */
export function cancelProviderContinue(logKey: string): void {
  const job = jobs.get(logKey);
  if (!job) return;
  job.cancelled = true;
  jobs.delete(logKey);
  console.warn(`[chat ${job.cli}] automatic continue on ${logKey} cancelled`);
}

function mergeOrigins(a: TurnOrigin, b: TurnOrigin): TurnOrigin {
  const peers = [...a.peers];
  for (const peer of b.peers) {
    if (!peers.some((p) => p.from === peer.from && p.role === peer.role && Boolean(p.notice) === Boolean(peer.notice))) peers.push(peer);
  }
  return { peers, human: a.human || b.human, automation: a.automation && b.automation };
}

function waitForClose(session: RetiringSession, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {};
    const timer = setTimeout(() => { unsubscribe(); resolve(); }, Math.max(1, timeoutMs));
    timer.unref?.();
    try {
      unsubscribe = session.subscribe((se) => {
        if (se.ev?.type !== 'closed') return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }, -1, false);
    } catch {
      clearTimeout(timer);
      resolve();
    }
    if (session.processExited()) {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}

/** True once the cut child can no longer race the continue: it exited, or it
 *  was kept for background work and its provider came back on its own. */
async function waitForRetirement(job: Job): Promise<boolean> {
  const started = Date.now();
  while (!job.cancelled) {
    const old = job.retiring;
    if (old.processExited()) return true;
    const kept = !old.isDisposed();
    if (kept && !old.hasStaleZaiProvider()) return true;
    const limit = kept ? BACKGROUND_HOLD_MS : EXIT_WAIT_MS;
    const left = started + limit - Date.now();
    // A disposed child past its SIGKILL backstop is gone in every way that
    // matters; a kept one past the hold is not coming back in time.
    if (left <= 0) return !kept;
    await waitForClose(old, Math.min(left, 15_000));
  }
  return false;
}

async function supersededSince(job: Job, session?: ContinuableSession): Promise<string | null> {
  if (humanQueued(job.logKey)) return 'a queued human message takes the turn';
  if (session?.isBusy()) return 'another message already took the turn';
  try { await flushEventLog(job.logKey); } catch { /* best effort */ }
  const later = loadEventLogSync(job.logKey).events.some((event) => {
    if (event.seq <= job.noticeSeq) return false;
    const outer = event.ev as { type?: string; event?: { type?: string } };
    const type = outer?.type === 'event' ? outer.event?.type : undefined;
    return type === '_user_echo' || type === 'peer_message' || type === PROVIDER_CONTINUE_EVENT;
  });
  return later ? 'a newer message already resumed the thread' : null;
}

async function runJob(job: Job): Promise<void> {
  const label = job.cut.to === 'fireworks' ? 'Fireworks' : 'the Z.ai coding plan';
  try {
    const retired = await waitForRetirement(job);
    if (job.cancelled) return;
    job.started = true;
    if (!retired) {
      await stopJob(job, `Background work kept the old GLM session busy too long to continue on ${label}. Send again to continue.`, 'GLM could not switch providers while background work held its old session');
      return;
    }
    const earlier = await supersededSince(job);
    if (job.cancelled) return;
    if (earlier) {
      console.warn(`[chat ${job.cli}] automatic continue on ${job.logKey} skipped: ${earlier}`);
      return;
    }
    let { model, effort } = job;
    const agent = agentForChatId(job.chatId);
    if (agent) {
      // Brains are server-authoritative. A switch while the old child exited
      // wins over the continue; the next message goes to the new brain.
      const brain = brainForAgent(agent);
      if (cliForAgentEngine(brain.engine) !== job.cli) {
        await stopJob(job, `This thread switched brains before GLM could continue on ${label}. Send again to continue.`, 'the agent switched brains before GLM could continue');
        return;
      }
      model = brain.model ?? model;
      effort = brain.effort ?? effort;
    }
    const runner = await import('./runner.ts');
    const session = await runner.getOrCreateSession({
      cli: job.cli,
      repoPath: job.cwd,
      chatId: job.chatId,
      model,
      effort,
    }) as unknown as ContinuableSession;
    if (job.cancelled) return;
    const claimed = await supersededSince(job, session);
    if (job.cancelled) return;
    if (claimed) {
      console.warn(`[chat ${job.cli}] automatic continue on ${job.logKey} skipped: ${claimed}`);
      return;
    }
    const id = randomUUID();
    let admitted = false;
    const unsubscribe = session.subscribe((se) => {
      const outer = se.ev as { type?: string; event?: { type?: string; id?: string } };
      if (outer?.type === 'event' && outer.event?.type === PROVIDER_CONTINUE_EVENT && outer.event.id === id) admitted = true;
    }, session.latestSeq(), false);
    try {
      await session.send(PROVIDER_CONTINUE_PROMPT, undefined, {
        providerContinue: { id, origin: job.origin, cut: job.cut },
      });
    } finally {
      unsubscribe();
    }
    if (admitted || job.cancelled) return;
    // The lane went busy between the check and the write: that turn carries
    // the cut guidance, so nothing is lost.
    if (session.isBusy()) return;
    await stopJob(job, `GLM could not continue on ${label}. Send again to continue.`, `GLM could not continue on ${label} after the switch`);
  } catch (err) {
    if (job.cancelled) return;
    const message = (err as Error)?.message ?? String(err);
    console.warn(`[chat ${job.cli}] automatic continue on ${job.logKey} failed: ${message}`);
    await stopJob(job, `GLM could not restart on ${label} to continue (${message.slice(0, 160)}). Send again to continue.`, `GLM could not restart on ${label} to continue`);
  }
}

async function stopJob(job: Job, message: string, reason: string): Promise<void> {
  if (job.cancelled) return;
  await postProviderCutNotice(job, message);
  await notifyHandoffSenders(job.chatId, job.origin, reason);
}

/** Durable, unread notice for a cut that no automatic continue will finish.
 *  Written through the live session when there is one (it owns the seq
 *  allocator for its thread), straight to the log otherwise. */
async function postProviderCutNotice(job: Job, message: string): Promise<void> {
  const event = providerCutNoticeEvent(message, job.cut, { unread: true });
  try {
    const runner = await import('./runner.ts');
    const live = runner.liveLaneSession(job.logKey);
    if (live?.postNotice(event)) return;
    const persisted = { seq: reserveEventLogSeq(job.logKey), at: Date.now(), ev: { type: 'event' as const, event }, eng: job.cli, mdl: job.model };
    const saved = appendEventLogDurable(job.logKey, persisted);
    runner.publishExternalThreadEvent(job.logKey, persisted);
    await saved;
  } catch (err) {
    console.warn(`[chat ${job.cli}] could not post the provider-cut notice on ${job.logKey}: ${(err as Error).message}`);
  }
}

/** The `_terminal_error` that closes (or follows) a cut turn. `continuing`
 *  renders it as a switch rather than a failure; `unread` badges it. */
export function providerCutNoticeEvent(
  message: string,
  cut: ProviderCut,
  flags: { continuing?: boolean; unread?: boolean; code?: string; discardSynthetic?: boolean } = {},
): Record<string, unknown> {
  return {
    type: '_terminal_error',
    message,
    code: flags.code ?? 'provider_switch',
    retryable: flags.continuing ? undefined : true,
    providerCut: cut,
    ...(flags.continuing ? { continuing: true } : {}),
    ...(flags.unread ? { unread: true } : {}),
    ...(flags.discardSynthetic ? { discardSynthetic: true } : {}),
    ts: Date.now(),
  };
}

/** Tell each teammate whose handoff was in the cut turn that it did not run,
 *  over the ordinary team bus (durable, fire-and-forget). Routines, voice and
 *  Desk comments are not teammates; the unread notice covers those. */
export async function notifyHandoffSenders(chatId: string, origin: TurnOrigin, reason: string): Promise<void> {
  const recipient = agentForChatId(chatId);
  if (!recipient || origin.peers.length === 0) return;
  const agents = listAgents();
  const told = new Set<string>();
  for (const peer of origin.peers) {
    const role = peer.role.trim().toLowerCase();
    if (peer.notice || role === 'automation' || role === 'voice' || role === 'desk') continue;
    const sender = agents.find((a) => a.name.trim().toLowerCase() === peer.from.trim().toLowerCase());
    if (!sender || sender.id === recipient.id || told.has(sender.id)) continue;
    told.add(sender.id);
    try {
      const { deliverTeamMessage } = await import('./teamBus.ts');
      const result = await deliverTeamMessage({
        from: recipient.name,
        to: sender.name,
        text: `${HANDOFF_NOT_RUN} Your handoff to ${recipient.name} stopped before finishing: ${reason}. Nothing retries it automatically. Resend it once ${recipient.name} is working again, or hand it to someone else if it cannot wait.`,
        wait: false,
      });
      if (!result.delivered) console.warn(`[team] could not tell ${sender.name} their handoff to ${recipient.name} did not run: ${result.reason ?? 'unknown'}`);
    } catch (err) {
      console.warn(`[team] could not tell ${sender.name} their handoff to ${recipient.name} did not run: ${(err as Error).message}`);
    }
  }
}
