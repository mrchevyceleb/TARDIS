/** Automatic continue after a model provider cuts a running turn.
 *
 *  Two causes share one machine. A GLM child freezes its provider (Z.ai
 *  coding plan or Fireworks) into its environment, so when the plan window
 *  closes under a running turn the turn fails and the child has to be
 *  replaced. An OpenRouter-family lane can be cut mid-response by the
 *  provider itself: a retryable HTTP failure ends the turn as a failed
 *  result, and an aborted response stream ends it as a normal-looking result
 *  whose work never landed (on those lanes the tool call arrives in one
 *  piece at the END of a response). Measured Oct 21 on Felix's lane: each
 *  cut left it dark 12-31 minutes until a person noticed.
 *
 *  The runner that saw the cut schedules one automatic continue: once the old
 *  child has exited (an OpenRouter cut never lost it), the lane respawns on
 *  the new provider if it must (resuming the same native session, see
 *  preferResumeAfterProviderCut) and gets a short "continue where you left
 *  off" prompt instead of a replay of the original message, so finished side
 *  effects are not redone. A human message already queued for the lane, or
 *  any other message that reaches it first, takes the turn instead and
 *  carries the same context (providerCutGuidance). A cut that cannot be
 *  continued leaves an unread notice and tells the teammate whose handoff
 *  did not run. */

import { randomUUID } from 'node:crypto';
import type { CliKind, SeqEvent } from './runner.ts';
import type { ZaiMode } from './zaiQuota.ts';
import { appendEventLogDurable, appendEventLogSync, flushEventLog, loadEventLogSync, reserveEventLogSeq } from './event-log-store.ts';
import { agentForChatId, brainForAgent, cliForAgentEngine, listAgents } from './agents.ts';
import { isBackgroundChatId } from './threadKey.ts';

/** Stream event that opens an automatic continue turn. Not rendered: the
 *  `_terminal_error` notice before it already says what happened. */
export const PROVIDER_CONTINUE_EVENT = '_provider_continue';

/** A GLM provider switch (`from`/`to`), or an OpenRouter-family engine whose
 *  provider dropped the turn (`engine`). The marker rides the cut notice so
 *  the next ordinary message carries the cut guidance (pendingProviderCut). */
export type ProviderCut = { from: ZaiMode; to: ZaiMode } | { engine: 'openrouter' | 'openrouter2' };

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

/** The continue prompt for the cut cause. An OpenRouter-family cut adds the
 *  write-size rule, because that is what keeps the next attempt from dying
 *  the same way: one oversized tool call outlasts the provider's response
 *  cutoff (measured Oct 21 on Felix's lane: every 62 KB single Write since
 *  1:18pm was cut at about 120s with nothing on disk; under 15 KB lands). */
export function providerContinuePrompt(cut: ProviderCut): string {
  if (!('engine' in cut)) return PROVIDER_CONTINUE_PROMPT;
  return [
    'The model provider dropped your last turn mid-response, so it ended before it finished.',
    'Continue exactly where you left off. Work that already finished stays done: check your history and do not repeat tool calls or side effects that already happened.',
    'Keep each Write or Edit under about 15 KB: build big files in pieces, or with a script run through job_start. One oversized tool call can outlast the provider\'s response cutoff and get cut off the same way again.',
  ].join(' ');
}

const PROVIDER_CUT_GUIDANCE = [
  '<rivendell-provider-cut>',
  'Your previous turn was cut off by a model provider failure before it finished. Work that already finished stays done, so do not repeat tool calls or side effects that already happened. If that earlier work is unfinished, finish it along with this message.',
  '</rivendell-provider-cut>',
].join('\n');

const OPENROUTER_CUT_GUIDANCE = [
  '<rivendell-provider-cut>',
  'Your previous turn was cut off by a model provider failure before it finished. Work that already finished stays done, so do not repeat tool calls or side effects that already happened. If that earlier work is unfinished, finish it along with this message.',
  'Keep each Write or Edit under about 15 KB (build big files in pieces, or with a script run through job_start), so a single tool call cannot outlast the provider\'s response cutoff again.',
  '</rivendell-provider-cut>',
].join('\n');

/** Who a cut belongs to, for the shared continue copy. A GLM cut is GLM moving
 *  providers; an engine cut is that provider dropping the turn. */
function cutWho(cut: ProviderCut): string {
  return 'engine' in cut ? (cut.engine === 'openrouter' ? 'OpenRouter' : 'OpenRouter Personal') : 'GLM';
}

/** " on <provider>" for a GLM cut; empty for an engine cut (the provider is
 *  already the who, so naming it twice reads wrong). */
function cutOnWhere(cut: ProviderCut): string {
  return 'engine' in cut ? '' : ` on ${cut.to === 'fireworks' ? 'Fireworks' : 'the Z.ai coding plan'}`;
}

/** "the switch" for a GLM cut; "the cut" for an engine cut. */
function cutAfterWhat(cut: ProviderCut): string {
  return 'engine' in cut ? 'the cut' : 'the switch';
}

/** The cut's identity for a PROVIDER_CONTINUE_EVENT: from/to for a GLM
 *  provider switch, engine for an OpenRouter-family cut. */
export function providerCutEventFields(cut: ProviderCut): { from: string; to: string } | { engine: string } {
  return 'engine' in cut ? { engine: cut.engine } : { from: cut.from, to: cut.to };
}

type Seqish = { ev?: any } | null | undefined;

/** The provider cut that ended this thread's last turn, until a later turn
 *  actually reaches the model. An echoed message whose prompt never got
 *  submitted does not settle it; that retry still needs the guidance. */
export function pendingProviderCut(events: ReadonlyArray<Seqish>): ProviderCut | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const outer = events[i]?.ev;
    const inner = outer?.type === 'event' ? outer.event : null;
    const type = inner?.type;
    // A background subagent's own frames are not the lane reaching the model.
    if (inner?.parent_tool_use_id) continue;
    // Model output, a provider-accepted prompt, or a finished turn after the
    // cut: some later turn picked it up. An explicit Stop settles it too.
    if (type === 'assistant' || type === 'stream_event' || type === 'peer_delivery_accepted' || type === '_interrupted') return null;
    if (type === 'result' && inner.is_error !== true) return null;
    if (type === '_terminal_error' && inner.providerCut && typeof inner.providerCut === 'object') {
      const { from, to, engine } = inner.providerCut as { from?: unknown; to?: unknown; engine?: unknown };
      if ((from === 'plan' || from === 'fireworks') && (to === 'plan' || to === 'fireworks')) return { from, to };
      if (engine === 'openrouter' || engine === 'openrouter2') return { engine };
      return null;
    }
  }
  return null;
}

/** Context for the first ordinary message after a cut, so a human or teammate
 *  message that beats the automatic continue still finishes the cut work. An
 *  engine cut also carries the write-size rule (see providerContinuePrompt). */
export function providerCutGuidance(events: ReadonlyArray<Seqish>): string {
  const cut = pendingProviderCut(events);
  if (!cut) return '';
  return 'engine' in cut ? OPENROUTER_CUT_GUIDANCE : PROVIDER_CUT_GUIDANCE;
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

export function humanQueued(logKey: string): boolean {
  try { return queuedHumanProbe?.(logKey) === true; } catch { return false; }
}

// ---- scheduling ----------------------------------------------------------------

type RetiringSession = {
  isDisposed(): boolean;
  processExited(): boolean;
  hasStaleZaiProvider(): boolean;
  isBusy(): boolean;
  /** Claude lanes only; a Pi child is never kept for background work. */
  hasBackgroundWork?(): boolean;
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

/** Newest job per thread (the one a fresh cut can fold into). */
const jobs = new Map<string, Job>();
/** Every job still running, so Stop, Fresh and shutdown reach older ones too. */
const runningJobs = new Set<Job>();
/** A kept-for-background-work child can hold the continue this long. */
const BACKGROUND_HOLD_MS = 6 * 60 * 60_000;
/** A retired child gets SIGKILL after 3s; this only bounds a missing exit. */
const EXIT_WAIT_MS = 15_000;

/** A failure notice waits this long for a busy lane to go idle. */
const NOTICE_IDLE_WAIT_MS = 6 * 60 * 60_000;
/** The continue waits this long behind queued or competing turns. */
const COMPETING_WAIT_MS = 30 * 60_000;

/** How long a sent continue waits for its correlated receipt (the model's
 *  first real response) before the job re-judges the thread. send() resolves
 *  on the stdin write, which proves nothing about the provider; slow lanes
 *  take 30-90s just to the first frame, so minutes, not seconds. */
const CONTINUE_ACCEPT_WAIT_MS = 5 * 60_000;

type ContinueOutcome = 'accepted' | 'rejected' | 'ended' | 'timeout';

function waitForTurnEnd(session: ContinuableSession, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => {};
    const done = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    unsubscribe = session.subscribe((se) => {
      if (se.ev?.type === 'turnEnd' || se.ev?.type === 'closed') done();
    }, -1, false);
    if (!session.isBusy()) done();
  });
}

/** Queue the one automatic continue for a cut turn. A second cut on the same
 *  thread before it runs (a kept child waking and failing again) folds in. */
/** One pending continue per lane: an agent's home and background lanes share
 *  a log but each continues its own cut turn. */
function laneJobKey(job: { logKey: string; chatId: string }): string {
  return `${job.logKey}\0${job.chatId}`;
}

// ---- engine-cut budget --------------------------------------------------------

/** At most this many OpenRouter-family continues per lane per window, so a
 *  hard-down provider stops with the unread notice instead of retrying in a
 *  loop. Budget is spent only on a continue that actually reached the model
 *  (runJob, on acceptance): a cut that folds into a still-waiting job, a send
 *  that never opened, or a job cancelled before it ran costs nothing, so dead
 *  attempts never lock a healthy lane out of its recoveries. */
const OPENROUTER_CONTINUE_CAP = 4;
const OPENROUTER_CONTINUE_WINDOW_MS = 20 * 60_000;
const openRouterContinues = new Map<string, number[]>();

/** Tests only. */
export function resetProviderSwitchState(): void {
  openRouterContinues.clear();
}

/** True when this lane may have another automatic continue right now. */
export function openRouterContinueBudget(lane: { logKey: string; chatId: string }, now = Date.now()): boolean {
  const stamps = (openRouterContinues.get(laneJobKey(lane)) ?? []).filter((t) => now - t < OPENROUTER_CONTINUE_WINDOW_MS);
  openRouterContinues.set(laneJobKey(lane), stamps);
  return stamps.length < OPENROUTER_CONTINUE_CAP;
}

/** Record one engine-cut continue that actually reached the model. Spent on
 *  acceptance in runJob, never at schedule time. */
export function spendOpenRouterContinue(lane: { logKey: string; chatId: string }, now = Date.now()): void {
  openRouterContinues.set(laneJobKey(lane), [...(openRouterContinues.get(laneJobKey(lane)) ?? []), now]);
}

export function scheduleProviderContinue(request: ProviderContinueRequest): void {
  const existing = jobs.get(laneJobKey(request));
  // A job still waiting for its old child absorbs the new cut. One already
  // past that point cannot see it, so the new cut gets its own job.
  if (existing && !existing.cancelled && !existing.started) {
    existing.noticeSeq = Math.max(existing.noticeSeq, request.noticeSeq);
    existing.cut = request.cut;
    existing.retiring = request.retiring;
    existing.origin = mergeOrigins(existing.origin, request.origin);
    return;
  }
  // A job already past its wait keeps watching its own cut; the new one
  // inherits its teammates so a later failure still tells them.
  const origin = existing && !existing.cancelled
    ? mergeOrigins(request.origin, { peers: existing.origin.peers, human: false, automation: request.origin.automation })
    : request.origin;
  const job: Job = { ...request, origin, cancelled: false, started: false };
  jobs.set(laneJobKey(request), job);
  runningJobs.add(job);
  console.warn(`[chat ${request.cli}] provider ${'engine' in request.cut
    ? `cut this turn on ${request.logKey} (${request.cut.engine})`
    : `switched mid-turn on ${request.logKey} (${request.cut.from} -> ${request.cut.to})`}; continuing automatically`);
  void runJob(job).finally(() => {
    runningJobs.delete(job);
    if (jobs.get(laneJobKey(job)) === job) jobs.delete(laneJobKey(job));
  });
}

/** Service shutdown: a continue still waiting to run dies with the process.
 *  Leave its unread notice synchronously so the cut is not silent after the
 *  restart. */
export function markPendingProviderContinuesInterrupted(): number {
  let marked = 0;
  const noted = new Set<string>();
  for (const job of [...runningJobs]) {
    job.cancelled = true;
    runningJobs.delete(job);
    jobs.delete(laneJobKey(job));
    if (noted.has(job.logKey)) continue;
    noted.add(job.logKey);
    const event = providerCutNoticeEvent(`TARDIS restarted before ${cutWho(job.cut)} could continue${cutOnWhere(job.cut)}. Send again to continue.`, job.cut, { unread: true });
    try {
      const written = appendEventLogSync(job.logKey, { seq: reserveEventLogSeq(job.logKey), at: Date.now(), ev: { type: 'event', event }, eng: job.cli, mdl: job.model });
      if (written) marked += 1;
    } catch (err) {
      console.warn(`[chat ${job.cli}] could not note the interrupted continue on ${job.logKey}: ${(err as Error).message}`);
    }
  }
  return marked;
}

/** Stop and Fresh cancel a continue that has not run yet. A Stop also marks
 *  the thread, so the cut is not picked back up by the next message or a
 *  reload that still shows "continuing". Fresh wipes the thread instead. */
export function cancelProviderContinue(logKey: string, opts: { stopped?: boolean } = {}): void {
  for (const key of [...jobs.keys()]) if (key.startsWith(`${logKey}\0`)) jobs.delete(key);
  // One per lane: each lane's cut needs its own Stop marker.
  const cancelled = new Map<string, Job>();
  for (const job of [...runningJobs]) {
    if (job.logKey !== logKey) continue;
    job.cancelled = true;
    runningJobs.delete(job);
    cancelled.set(job.chatId, job);
    console.warn(`[chat ${job.cli}] automatic continue on ${logKey} cancelled`);
  }
  if (opts.stopped) for (const job of cancelled.values()) void postThreadEvent(job, { type: '_interrupted', ts: Date.now() });
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
    // Kept for background work: done once its provider healed on its own, or
    // once the work drained and it sits idle (the lookup retires it then).
    if (kept && (!old.hasStaleZaiProvider() || (!old.isBusy() && !old.hasBackgroundWork?.()))) return true;
    const limit = kept ? BACKGROUND_HOLD_MS : EXIT_WAIT_MS;
    const left = started + limit - Date.now();
    // A disposed child past its SIGKILL backstop is gone in every way that
    // matters; a kept one past the hold is not coming back in time.
    if (left <= 0) return !kept;
    await waitForClose(old, Math.min(left, 15_000));
  }
  return false;
}

/** Where this job's cut stands in the durable thread: still waiting for a
 *  turn to pick it up, settled by a later turn that reached the model, or
 *  owned by a newer cut (which has its own outcome). */
async function cutState(job: Job): Promise<'pending' | 'settled' | 'superseded' | 'stopped'> {
  try { await flushEventLog(job.logKey); } catch { /* best effort */ }
  // Only this job's lane: the sibling lane's turns never settle or own its cut.
  const background = isBackgroundChatId(job.chatId);
  const events = loadEventLogSync(job.logKey).events.filter((event) => (event.lane === 'bg') === background);
  for (let i = events.length - 1; i >= 0 && events[i].seq > job.noticeSeq; i -= 1) {
    const outer = events[i].ev as { type?: string; event?: { type?: string; providerCut?: unknown; unread?: unknown } };
    if (outer?.type === 'event' && outer.event?.type === '_terminal_error' && outer.event.providerCut) {
      // A newer cut that is continuing owns the work (and our teammates, see
      // scheduleProviderContinue). One that stopped leaves them to us.
      return outer.event.unread === true ? 'stopped' : 'superseded';
    }
  }
  return pendingProviderCut(events) ? 'pending' : 'settled';
}

/** Resolve on a busy lane's next turn boundary (or `timeoutMs`), otherwise
 *  after a short real delay. Always yields to the timer queue: a queued human
 *  steer on an idle lane is still spawning, and a promise-only retry loop
 *  would starve the very event loop it is waiting on. */
function waitForBoundaryOrDelay(session: ContinuableSession | null, timeoutMs: number): Promise<void> {
  if (session?.isBusy()) return waitForTurnEnd(session, timeoutMs);
  return new Promise((resolve) => { const t = setTimeout(resolve, 250); t.unref?.(); });
}

async function runJob(job: Job): Promise<void> {
  const who = cutWho(job.cut);
  const onWhere = cutOnWhere(job.cut);
  try {
    const retired = await waitForRetirement(job);
    if (job.cancelled) return;
    job.started = true;
    if (!retired) {
      await stopJob(job, `Background work kept the old session busy too long for ${who} to continue${onWhere}. Send again to continue.`, `${who} could not continue${onWhere} while background work held its old session`);
      return;
    }
    const runner = await import('./runner.ts');
    const deadline = Date.now() + COMPETING_WAIT_MS;
    let session: ContinuableSession | null = null;
    let writes = 0;
    // A queued human message or another turn may take the lane first. It
    // carries the cut guidance, so the job only watches: the cut counts as
    // settled once a later turn actually reached the model. If that turn never
    // got there (a failed submit, a Stop-free abort), the continue still runs.
    while (!job.cancelled) {
      const state = await cutState(job);
      if (job.cancelled) return;
      if (state === 'stopped') {
        // The turn that took the lane was cut too and nothing will finish it;
        // its notice is already on the thread. Tell this cut's teammates.
        await notifyHandoffSenders(job.chatId, job.origin, `${who}'s model provider failed again before the work could continue`);
        return;
      }
      if (state !== 'pending') {
        console.warn(`[chat ${job.cli}] automatic continue on ${job.logKey} not needed: ${state === 'settled' ? 'a later turn picked the cut work up' : 'a newer cut owns the thread'}`);
        return;
      }
      const live = (session?.isAlive() ? session : null) ?? (runner.liveLaneSession(job.logKey, job.chatId) as unknown as ContinuableSession | null);
      if (humanQueued(job.logKey) || live?.isBusy()) {
        if (Date.now() >= deadline) {
          await stopJob(job, `${who} could not continue${onWhere}: the thread stayed busy too long. Send again to continue.`, `${who} could not continue${onWhere} while the thread stayed busy`);
          return;
        }
        await waitForBoundaryOrDelay(live, 2_000);
        continue;
      }
      if (!session || !session.isAlive()) {
        let { model, effort } = job;
        const agent = agentForChatId(job.chatId);
        if (agent) {
          // Brains are server-authoritative. A switch while the old child
          // exited wins over the continue; the next message goes to the new brain.
          const brain = brainForAgent(agent);
          if (cliForAgentEngine(brain.engine) !== job.cli) {
            await stopJob(job, `This thread switched brains before ${who} could continue${onWhere}. Send again to continue.`, `the agent switched brains before ${who} could continue`);
            return;
          }
          model = brain.model ?? model;
          effort = brain.effort ?? effort;
        }
        session = await runner.getOrCreateSession({
          cli: job.cli,
          repoPath: job.cwd,
          chatId: job.chatId,
          model,
          effort,
        }) as unknown as ContinuableSession;
        // The spawn awaited: re-check the thread before writing.
        continue;
      }
      const id = randomUUID();
      const target: ContinuableSession = session;
      // The prompt's real receipt arrives with the model's first response
      // (peer_delivery_accepted), 30-90s after the stdin write on slow lanes,
      // and a refusal or a turn end can arrive just as late. Judge the send by
      // its correlated outcome, never at write time: send() resolves on the
      // write callback, which proves nothing about the provider.
      let settleOutcome!: (value: ContinueOutcome) => void;
      const outcome = new Promise<ContinueOutcome>((resolve) => { settleOutcome = resolve; });
      const outcomeTimer = setTimeout(() => settleOutcome('timeout'), CONTINUE_ACCEPT_WAIT_MS);
      outcomeTimer.unref?.();
      let finished = false;
      const finishOutcome = (value: ContinueOutcome) => {
        if (finished) return;
        finished = true;
        clearTimeout(outcomeTimer);
        unsubscribe();
        settleOutcome(value);
      };
      const unsubscribe = target.subscribe((se) => {
        const outer = se.ev as { type?: string; event?: { type?: string; id?: string; deliveryId?: string } };
        if (outer?.type === 'turnEnd' || outer?.type === 'closed') { finishOutcome('ended'); return; }
        if (outer?.type !== 'event') return;
        // Both runners emit this only once the prompt really reached the
        // provider (the model's first real response / RPC accepted), same as
        // a teammate delivery. Never at write time.
        if (outer.event?.type === 'peer_delivery_accepted' && outer.event.deliveryId === id) finishOutcome('accepted');
        if (outer.event?.type === 'peer_delivery_rejected' && outer.event.deliveryId === id) finishOutcome('rejected');
      }, target.latestSeq(), false);
      try {
        await target.send(providerContinuePrompt(job.cut), undefined, {
          providerContinue: { id, origin: job.origin, cut: job.cut },
          peerDeliveryId: id,
        });
      } catch (err) {
        finishOutcome('rejected');
        throw err;
      }
      const result = await outcome;
      if (job.cancelled) return;
      if (result === 'accepted') {
        // The continuation turn owns the cut work from here. Budget is spent
        // only now: a continue that never reached the model costs nothing.
        if ('engine' in job.cut) spendOpenRouterContinue(job);
        return;
      }
      // Rejected at the CLI, the turn ended before this continue's own
      // acceptance, or nothing correlated arrived in time. Let cutState judge
      // what actually happened on the thread (bounded, so a runner that keeps
      // declining without going busy cannot spin this loop).
      if (++writes < 4) continue;
      await stopJob(job, `${who} could not continue${onWhere}. Send again to continue.`, `${who} could not continue${onWhere} after ${cutAfterWhat(job.cut)}`);
      return;
    }
  } catch (err) {
    if (job.cancelled) return;
    const message = (err as Error)?.message ?? String(err);
    console.warn(`[chat ${job.cli}] automatic continue on ${job.logKey} failed: ${message}`);
    await stopJob(job, `${who} could not restart${onWhere} to continue (${message.slice(0, 160)}). Send again to continue.`, `${who} could not restart${onWhere} to continue`);
  }
}

async function stopJob(job: Job, message: string, reason: string): Promise<void> {
  if (job.cancelled) return;
  await postProviderCutNotice(job, message);
  // A Stop or Fresh can land while the notice waited for an idle lane (hours
  // are allowed); never publish a failure, or tell handoff senders, for a job
  // that was cancelled in the meantime.
  if (job.cancelled) return;
  await notifyHandoffSenders(job.chatId, job.origin, reason);
}

/** Durable, unread notice for a cut that no automatic continue will finish.
 *  Written through the live session when there is one (it owns the seq
 *  allocator for its thread), straight to the log otherwise. */
async function postProviderCutNotice(job: Job, message: string): Promise<void> {
  try {
    const runner = await import('./runner.ts');
    const deadline = Date.now() + NOTICE_IDLE_WAIT_MS;
    const event = providerCutNoticeEvent(message, job.cut, { unread: true });
    // Never drop a failure notice into the middle of someone else's turn: the
    // UI and the team bus would read it as that turn failing. The idle check
    // and the post share one synchronous slice, so no turn can start between.
    for (;;) {
      if (job.cancelled) return;
      const live = runner.liveLaneSession(job.logKey, job.chatId);
      if (!live?.isBusy()) {
        if (live?.postNotice(event)) return;
        break;
      }
      if (Date.now() >= deadline) {
        console.warn(`[chat ${job.cli}] provider-cut notice on ${job.logKey} dropped: the thread never went idle`);
        return;
      }
      await waitForTurnEnd(live as unknown as ContinuableSession, Math.min(60_000, deadline - Date.now()));
    }
    const persisted = { seq: reserveEventLogSeq(job.logKey), at: Date.now(), ev: { type: 'event' as const, event }, eng: job.cli, mdl: job.model, ...runner.laneTagFor(job.chatId) };
    const saved = appendEventLogDurable(job.logKey, persisted);
    runner.publishExternalThreadEvent(job.logKey, persisted);
    await saved;
  } catch (err) {
    console.warn(`[chat ${job.cli}] could not post the provider-cut notice on ${job.logKey}: ${(err as Error).message}`);
  }
}

/** Append a standalone event to a job's thread: through the live session
 *  (it owns the seq allocator) or, with none, straight to the durable log. */
async function postThreadEvent(job: Job, event: Record<string, unknown>): Promise<void> {
  try {
    const runner = await import('./runner.ts');
    const live = runner.liveLaneSession(job.logKey, job.chatId);
    if (live && !live.isBusy() && live.postNotice(event)) return;
    if (live) return; // a turn is running; it already settles the cut
    const persisted = { seq: reserveEventLogSeq(job.logKey), at: Date.now(), ev: { type: 'event' as const, event }, eng: job.cli, mdl: job.model, ...runner.laneTagFor(job.chatId) };
    const saved = appendEventLogDurable(job.logKey, persisted);
    runner.publishExternalThreadEvent(job.logKey, persisted);
    await saved;
  } catch (err) {
    console.warn(`[chat ${job.cli}] could not mark ${job.logKey}: ${(err as Error).message}`);
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
