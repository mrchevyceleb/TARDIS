// Team bus — agent-to-agent messaging. Any teammate can message any other
// teammate through the `rivendell-team` MCP tool (see server/scripts/team-mcp.mjs);
// delivery lands in the recipient's home thread as a `peer_message` event
// (rendered with the sender's identity, not as a user turn) and wakes the
// recipient's engine for a real turn. Guards: active-cycle detection, rate
// limits, text cap, and per-recipient FIFO delivery — long legitimate chains
// stay open without allowing a tight runaway loop or losing busy handoffs.

import { randomUUID } from 'node:crypto';
import { ELROND_WORKSPACE_PATH } from '../config.ts';
import { brainForAgent, cliForAgentEngine, listAgents, type Agent } from './agents.ts';
import { backgroundChatId, backgroundLaneEnabled, bareChatId, isBackgroundChatId, logKeyFor } from './threadKey.ts';
import { extractVisibleTurns } from './threadWindow.ts';
import { JsonStore, type StoredRecord } from '../lib/jsonStore.ts';

// Late import to dodge a require cycle (runner imports nothing from here, but
// both sides touch shared graph modules — keeping this lazy is cheap insurance).
type SessionLike = {
  send: (text: string, images?: unknown, opts?: Record<string, unknown>) => Promise<void>;
  isBusy?: () => boolean;
  canAcceptNativeHumanSteer?: () => boolean;
  requestBoundaryInterrupt?: (opts?: { human?: boolean }) => (() => void) | null;
  activeSelection?: () => { model?: string; effort?: string };
  spawnModel?: string;
  spawnEffort?: string;
  latestSeq: () => number;
  subscribe: (
    fn: (event: {
      seq?: number;
      lane?: string;
      ev?: { type?: string; event?: { type?: string; deliveryId?: string; continuing?: boolean; unread?: boolean; message?: string } };
    }) => void,
    sinceSeq?: number,
    countSubscriber?: boolean,
  ) => () => void;
  key: string;
  logKey: string;
  chatId?: string;
};

async function getRunner() {
  const mod = await import('./runner.ts');
  return mod as unknown as {
    getOrCreateSession: (opts: { cli: string; repoPath: string; chatId: string; model?: string; effort?: string; recycleOnMismatch?: boolean }) => Promise<SessionLike>;
    activeChatSessions: () => Array<{ cli: string; cwd: string; chatId: string; busy: boolean }>;
    isClaudeFamilyCli: (cli: string) => boolean;
  };
}

/** Which of an agent's two live sessions a delivery runs in. `main` is the
 *  home lane the person talks to; `bg` is the background lane. */
export type AgentLane = 'main' | 'bg';

/** Everything that is not the person typing or speaking runs in the
 *  background lane, unless the kill switch is off. Codex and Banana engines
 *  keep their single lane: background lanes live on the Claude-family
 *  registry (claude binary or Pi), which mirrors them into the home view. */
function resolveLane(cli: string, requested: AgentLane, runner: { isClaudeFamilyCli: (cli: string) => boolean }): AgentLane {
  if (requested === 'main' || !backgroundLaneEnabled()) return 'main';
  return runner.isClaudeFamilyCli(cli) ? 'bg' : 'main';
}

/** An event from the other lane, mirrored into a home session for viewers. */
function foreignLaneEvent(event: { lane?: string }, lane: AgentLane): boolean {
  return (event.lane === 'bg') !== (lane === 'bg');
}

function chainKey(agentId: string, lane: AgentLane): string {
  return `${agentId}|${lane}`;
}

/** Backward-compatible export for callers that resolve an engine lane. */
export const cliForEngine = cliForAgentEngine;

function findAgent(ref: string): Agent | undefined {
  const needle = ref.trim().toLowerCase();
  return listAgents().find((a) => a.id === needle || a.name.trim().toLowerCase() === needle);
}

// ---- guards ----------------------------------------------------------------

const MAX_TEXT = 8000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX = 20;
const PAIR_MAX = 8;

const globalDeliveries: number[] = [];
const pairDeliveries = new Map<string, number[]>();

function rateOk(pairKey: string): { ok: boolean; reason?: string } {
  const now = Date.now();
  while (globalDeliveries.length && now - globalDeliveries[0] > GLOBAL_WINDOW_MS) globalDeliveries.shift();
  if (globalDeliveries.length >= GLOBAL_MAX) return { ok: false, reason: 'team message rate limit reached — wait a minute' };
  const arr = pairDeliveries.get(pairKey) ?? [];
  while (arr.length && now - arr[0] > GLOBAL_WINDOW_MS) arr.shift();
  if (arr.length >= PAIR_MAX) return { ok: false, reason: 'this pair is rate limited — wait a minute' };
  globalDeliveries.push(now);
  arr.push(now);
  pairDeliveries.set(pairKey, arr);
  return { ok: true };
}

// One teammate can receive a human turn and several handoffs at the same time.
// Serialize the handoffs, then wait for the natural turn boundary rather than
// making every sender poll and retry. Routines keep their separate defer policy.
const RECIPIENT_IDLE_WAIT_MS = 30 * 60_000;
const DELIVERY_REFUSAL_BACKOFF_MAX_MS = 30_000;
const ASYNC_RETRY_MS = 15_000;
const recipientDeliveryTails = new Map<string, Promise<void>>();
const synchronousReplyEdges = new Map<string, number>();
const admittedQueuedDeliveries = new Set<string>();

export type TeamChain = {
  id: string;
  edges: string[];
  route: string[];
};
type ActiveInboundChain = TeamChain & { deliveryId: string; at: number };
// While a teammate is handling a peer turn, any team_message calls they make
// inherit that collaboration's route automatically. Repeating a directed edge
// closes a real loop; merely having a long route never blocks legitimate work.
const activeInboundChains = new Map<string, ActiveInboundChain>();

type QueuedTeamDelivery = StoredRecord & {
  fromId: string;
  fromName: string;
  fromRole?: string;
  toId: string;
  text: string;
  hop: number;
  /** Explicit priority flag from team_message: this record sorts with
   *  person-sourced records, ahead of older teammate chatter. */
  priority?: true;
  chainId?: string;
  chainEdges?: string[];
  chainRoute?: string[];
};

function chainForQueuedDelivery(record: QueuedTeamDelivery): TeamChain {
  return {
    id: record.chainId ?? record.id,
    edges: record.chainEdges?.length
      ? [...record.chainEdges]
      : [replyEdge(record.fromId, record.toId)],
    route: record.chainRoute?.length
      ? [...record.chainRoute]
      : [record.fromId, record.toId],
  };
}

const queuedDeliveryStore = new JsonStore<QueuedTeamDelivery>('team-delivery-queue.json', []);
let queueStoreTail: Promise<void> = Promise.resolve();
const activeQueuedRecipients = new Set<string>();
const queuedRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function queueStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = queueStoreTail.then(operation, operation);
  queueStoreTail = result.then(() => undefined, () => undefined);
  return result;
}

/** One FIFO per recipient: a single delivery worker per agent serializes
 *  every admission to it, so a person-sourced record can never race the
 *  teammate worker onto the same session (two parallel FIFOs once admitted
 *  both at once — refusals, duplicate echoes). Person-sourced records still
 *  never wait behind teammate chatter: the drain sorts them first inside the
 *  one FIFO. */
function queueKeyOf(record: { toId: string }): string {
  return record.toId;
}

function replyEdge(fromId: string, toId: string): string {
  return `${fromId}->${toId}`;
}

export function extendTeamChain(
  parent: TeamChain | undefined,
  fromId: string,
  toId: string,
): { chain: TeamChain; repeatsEdge: boolean } {
  const edge = replyEdge(fromId, toId);
  if (parent) {
    return {
      chain: {
        id: parent.id,
        edges: [...parent.edges, edge],
        route: [...parent.route, toId],
      },
      // Retained as diagnostic metadata only. Repeating a historical edge is
      // normal collaboration; only a currently blocked reply path is a cycle.
      repeatsEdge: parent.edges.includes(edge),
    };
  }
  return {
    chain: { id: randomUUID(), edges: [edge], route: [fromId, toId] },
    repeatsEdge: false,
  };
}

function inheritedTeamChain(fromId: string, toId: string, fromLane: AgentLane): { chain: TeamChain; repeatsEdge: boolean } {
  // Keyed per lane: a handoff the background lane is handling never leaks its
  // collaboration chain into a message sent from the person's own lane.
  const key = chainKey(fromId, fromLane);
  let parent = activeInboundChains.get(key);
  // Turn-end normally clears this. The expiry is only crash insurance for a
  // listener that could not observe its terminal event.
  if (parent && Date.now() - parent.at > 2 * 60 * 60_000) {
    activeInboundChains.delete(key);
    parent = undefined;
  }
  return extendTeamChain(parent, fromId, toId);
}

function activateInboundChain(
  recipientId: string,
  lane: AgentLane,
  chain: TeamChain,
  deliveryId: string,
  session: SessionLike,
  admittedSeq: number,
): void {
  const key = chainKey(recipientId, lane);
  const active: ActiveInboundChain = { ...chain, deliveryId, at: Date.now() };
  activeInboundChains.set(key, active);
  let unsubscribe: (() => void) | null = null;
  const clear = () => {
    if (activeInboundChains.get(key)?.deliveryId === deliveryId) {
      activeInboundChains.delete(key);
    }
    unsubscribe?.();
    unsubscribe = null;
  };
  try {
    unsubscribe = session.subscribe((event) => {
      if ((event.seq ?? 0) <= admittedSeq) return;
      if (event.ev?.type === 'turnEnd' || event.ev?.type === 'closed') clear();
    }, session.latestSeq(), false);
  } catch {
    clear();
  }
}

function addReplyEdge(key: string): void {
  synchronousReplyEdges.set(key, (synchronousReplyEdges.get(key) ?? 0) + 1);
}

function removeReplyEdge(key: string): void {
  const next = (synchronousReplyEdges.get(key) ?? 1) - 1;
  if (next > 0) synchronousReplyEdges.set(key, next);
  else synchronousReplyEdges.delete(key);
}

function hasReplyPath(fromId: string, toId: string): boolean {
  const pending = [fromId];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === toId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const [edge, count] of synchronousReplyEdges) {
      if (count <= 0) continue;
      const splitAt = edge.indexOf('->');
      if (splitAt < 0 || edge.slice(0, splitAt) !== current) continue;
      pending.push(edge.slice(splitAt + 2));
    }
  }
  return false;
}

function enqueueForRecipient<T>(recipientId: string, work: () => Promise<T>): { job: Promise<T>; queued: boolean } {
  const previous = recipientDeliveryTails.get(recipientId);
  const job = (previous ?? Promise.resolve()).catch(() => undefined).then(work);
  const tail = job.then(() => undefined, () => undefined);
  recipientDeliveryTails.set(recipientId, tail);
  void tail.then(() => {
    if (recipientDeliveryTails.get(recipientId) === tail) recipientDeliveryTails.delete(recipientId);
  });
  return { job, queued: Boolean(previous) };
}

/** Atomically claim an idle recipient tail for a synchronous reply wait. There
 * are no awaits between the map check and enqueue, so two concurrent callers
 * cannot both decide they are first and then block behind each other. */
function tryEnqueueForRecipient<T>(recipientId: string, work: () => Promise<T>): Promise<T> | null {
  if (recipientDeliveryTails.has(recipientId)) return null;
  return enqueueForRecipient(recipientId, work).job;
}

export type DeliveryBoundary = 'idle' | 'steerable' | 'closed' | 'timeout' | 'aborted';

/** Wait until a busy recipient either finishes or enters Claude's verified
 * tool-execution steering window. Listening to every emitted event matters:
 * waiting only for turnEnd strands the first queued handoff behind a long turn,
 * and that FIFO tail then makes every later (including urgent) handoff look
 * locked out even while the recipient executes dozens of tools.
 *
 * `acceptSteer` must mirror the caller's admission test, and is re-evaluated at
 * every decision point rather than captured, so a window that opens or closes
 * mid-wait is judged against current state. A steering window the caller will
 * refuse is not a boundary: reporting it resolves this promise with no delay,
 * and a caller that loops on the refusal then spins the event loop flat out for
 * the whole wait window. When the caller cannot steer, only a real turnEnd or
 * closed ends the wait. */
export function waitForDeliveryBoundary(
  session: SessionLike,
  timeoutMs: number,
  signal?: AbortSignal,
  acceptSteer: () => boolean = () => true,
  interruptAtBoundary: false | 'human' | 'peer' = false,
): Promise<DeliveryBoundary> {
  if (signal?.aborted) return Promise.resolve('aborted');
  if (session.isBusy?.() !== true) return Promise.resolve('idle');
  if (acceptSteer() && session.canAcceptNativeHumanSteer?.() === true) return Promise.resolve('steerable');
  // A teammate or the Desk is waiting on this busy session: end its turn at the
  // next tool boundary so the handoff arrives as a real turn, not as text
  // inside a tool result. Scheduled/automation senders wait for the natural end.
  const releaseBoundary = interruptAtBoundary ? session.requestBoundaryInterrupt?.({ human: interruptAtBoundary === 'human' }) ?? null : null;
  const sinceSeq = session.latestSeq();
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const onAbort = () => done('aborted');
    const done = (outcome: DeliveryBoundary) => {
      if (settled) return;
      settled = true;
      releaseBoundary?.();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      resolve(outcome);
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      done('aborted');
      return;
    }
    try {
      const stop = session.subscribe((event) => {
        if (event.ev?.type === 'turnEnd') done('idle');
        else if (event.ev?.type === 'closed') done('closed');
        else if (acceptSteer() && session.canAcceptNativeHumanSteer?.() === true) done('steerable');
      }, sinceSeq, false);
      unsubscribe = stop;
      if (settled) stop();
    } catch {
      done('closed');
      return;
    }
    // Close both check/subscribe races: the turn can finish, or a tool can
    // begin, between the initial snapshots and listener registration.
    if (session.isBusy?.() !== true) done('idle');
    else if (acceptSteer() && session.canAcceptNativeHumanSteer?.() === true) done('steerable');
  });
}

function waitForSessionProgress(
  session: SessionLike,
  sinceSeq: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || session.latestSeq() > sinceSeq) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const onAbort = () => done();
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, timeoutMs));
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const stop = session.subscribe(() => done(), sinceSeq, false);
      unsubscribe = stop;
      if (settled) stop();
    } catch {
      done();
      return;
    }
    if (session.latestSeq() > sinceSeq) done();
  });
}

/** A fixed pause after a provider refusal. Unlike waitForSessionProgress it is not
 *  cut short by streaming output from the run that caused the refusal; only the
 *  turn ending, the session closing or an abort end it early. */
function waitForRefusalPause(
  session: SessionLike,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe: () => void = () => {};
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, timeoutMs));
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
    try {
      unsubscribe = session.subscribe((se) => {
        if (se.ev?.type === 'turnEnd' || se.ev?.type === 'closed') done();
      }, session.latestSeq(), false);
      if (finished) unsubscribe();
    } catch {
      done();
    }
  });
}

/** The lane a person-sourced message (Desk answer, voice continuation) should
 *  take: the one that can act now. Prefers the person's main lane, falls back
 *  to the background lane when main is tied up and background is free, and
 *  otherwise stays on main, where the human message-boundary interrupt makes
 *  room within a step. Probes only already-running sessions — it never
 *  spawns one just to look. */
async function personLanePreference(agent: Agent): Promise<AgentLane> {
  const runner = await getRunner();
  for (const lane of ['main', 'bg'] as AgentLane[]) {
    const { cli, chatKey } = agentLogKey(agent, lane);
    const active = runner.activeChatSessions().find((session) => session.cli === cli && session.chatId === chatKey);
    // No session yet means it spawns idle; an idle session can act now.
    if (!active || active.busy !== true) return lane;
  }
  return 'main';
}

/** Person-sourced queued deliveries (Desk answers, voice continuations). */
function personSourced(record: { fromRole?: string }): boolean {
  return record.fromRole === 'desk' || record.fromRole === 'voice';
}

/** Records that sort to the front of an admitted batch: person-sourced
 *  (Desk answers, voice continuations) plus explicitly priority-flagged
 *  teammate messages. Sort order only; lane routing and interrupt class
 *  key off from.role, never off this. */
function sortsAhead(record: { fromRole?: string; priority?: boolean }): boolean {
  return personSourced(record) || record.priority === true;
}

async function getRecipientSessionForDelivery(
  agent: Agent,
  deadline: number,
  signal?: AbortSignal,
  deferIfBusy = false,
  interruptAtBoundary: false | 'human' | 'peer' = false,
  requestedLane: AgentLane = 'main',
): Promise<{ session: SessionLike; waited: boolean; nativeSteer: boolean; model?: string; effort?: string; lane: AgentLane }> {
  const runner = await getRunner();
  let waited = false;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('sender stopped before delivery');
    const currentAgent = findAgent(agent.id) ?? agent;
    const home = agentLogKey(currentAgent);
    const lane = resolveLane(home.cli, requestedLane, runner);
    const { cli, chatKey, model, effort } = agentLogKey(currentAgent, lane);
    let session: SessionLike;
    try {
      const conflictingBusyLane = runner.activeChatSessions().some((active) => (
        active.busy && active.chatId === chatKey && active.cli !== cli
      ));
      if (conflictingBusyLane) {
        throw new Error('the recipient is finishing a turn on its previous brain');
      }
      session = await runner.getOrCreateSession({
        cli,
        repoPath: ELROND_WORKSPACE_PATH,
        chatId: chatKey,
        model,
        effort,
        recycleOnMismatch: true,
      });
    } catch (error) {
      throw new Error(`recipient engine failed to start: ${(error as Error).message}`);
    }
    if (signal?.aborted) throw new Error('sender stopped before delivery');
    // The brain can change while a cold runner is spawning. Resolve again at
    // the no-await admission edge; if it moved, loop and bind the new canonical
    // engine/model instead of handing the caller a stale session.
    const latestAgent = findAgent(agent.id) ?? agent;
    const latest = agentLogKey(latestAgent);
    if (latest.cli !== cli || latest.model !== model || latest.effort !== effort) {
      waited = true;
      continue;
    }
    const recipientBusy = session.isBusy?.() === true;
    if (!recipientBusy) return { session, waited, nativeSteer: false, model, effort, lane };
    // Same-turn steer is cheap and keeps babysitter/cron jobs from waiting for
    // a 40-minute Codex turn to finish. Prefer it even when the caller asked
    // to defer-if-busy (routines, MCP fire-and-forget).
    // One source of truth for "would this caller admit a steer right now?" —
    // shared with the wait below so the two can never disagree. It re-reads the
    // live selection and the agent's current brain on every call, so a rebrain
    // mid-wait is picked up at the next session event instead of staying pinned
    // to a snapshot taken before the wait began.
    const steerAdmissible = () => {
      const selected = session.activeSelection?.() ?? {
        model: session.spawnModel,
        effort: session.spawnEffort,
      };
      const brain = agentLogKey(findAgent(agent.id) ?? agent);
      return (!brain.model || selected.model === brain.model)
        && (!brain.effort || selected.effort === brain.effort);
    };
    if (steerAdmissible() && session.canAcceptNativeHumanSteer?.() === true) {
      return { session, waited, nativeSteer: true, model, effort, lane };
    }
    // A synchronous MCP tool call must never sit behind somebody else's long
    // turn until Claude Code's ~5 minute tool timeout. The message is already
    // durable; let the outbox worker wait in the background and return to the
    // sender immediately. Only defer when we cannot steer this turn.
    if (deferIfBusy) throw new Error(`${agent.name} is busy; durable delivery will continue automatically`);
    waited = true;
    // Only a steering window this caller would actually admit counts as a
    // boundary. A turn still running a superseded brain can only be joined
    // once it ends, so wait for that instead of re-testing the same refusal.
    const outcome = await waitForDeliveryBoundary(
      session,
      Math.max(1, deadline - Date.now()),
      signal,
      steerAdmissible,
      interruptAtBoundary,
    );
    if (outcome === 'aborted') throw new Error('sender stopped before delivery');
    if (outcome === 'timeout') break;
    // Re-resolve after every idle, closed, or steerable boundary. A closed
    // process or a mid-thread rebrain may replace the session object, and a
    // steering window can close before admission, in which case we wait again.
    // Crucially, a future tool window wakes this loop instead of pinning the
    // recipient FIFO until the entire long-running turn ends.
  }

  throw new Error(`${agent.name} did not reach an admissible delivery boundary within ${Math.round(RECIPIENT_IDLE_WAIT_MS / 60_000)} minutes`);
}

// ---- delivery ----------------------------------------------------------------

/** Resolve an agent's live session key. Account routing, when configured, is
 * derived server-side from the workspace rather than baked into public IDs. */
export function agentLogKey(agent: Agent, lane: AgentLane = 'main'): { cli: string; chatKey: string; model?: string; effort?: string } {
  const brain = brainForAgent(agent);
  return {
    cli: cliForAgentEngine(brain.engine),
    chatKey: lane === 'bg' ? backgroundChatId(agent.home) : agent.home,
    model: brain.model,
    effort: brain.effort,
  };
}

/** Fire-and-forget delivery into an agent's home thread (routines path). */
export async function sendToAgentHome(
  agent: Agent,
  text: string,
  /** `lane` defaults to the background lane; a job or watch started from the
   *  home lane reports back there. */
  opts: { peerFrom: string; peerFromRole?: string; peerText?: string; lane?: AgentLane },
): Promise<{ delivered: boolean; reason?: string }> {
  let session: SessionLike;
  let model: string | undefined;
  let effort: string | undefined;
  let nativeSteer = false;
  try {
    // Never skip because the agent is busy. Wait for idle or a steer window,
    // same as teammate delivery. A watched Hall tab is not a skip.
    const admission = await getRecipientSessionForDelivery(
      agent,
      Date.now() + RECIPIENT_IDLE_WAIT_MS,
      undefined,
      false,
      false,
      opts.lane ?? 'bg',
    );
    session = admission.session;
    model = admission.model;
    effort = admission.effort;
    nativeSteer = admission.nativeSteer;
  } catch (e) {
    return { delivered: false, reason: `engine unavailable: ${(e as Error).message}` };
  }
  const deliveryId = randomUUID();
  let echoed = false;
  let providerAccepted = false;
  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = session.subscribe((event) => {
      const inner = event.ev?.type === 'event' ? event.ev.event : undefined;
      if (inner?.type === 'peer_message' && inner.deliveryId === deliveryId) echoed = true;
      if (inner?.type === 'peer_delivery_accepted' && inner.deliveryId === deliveryId) providerAccepted = true;
    }, session.latestSeq(), false);
    await session.send(text, undefined, {
      peerFrom: opts.peerFrom,
      peerFromRole: opts.peerFromRole,
      peerText: opts.peerText,
      peerDeliveryId: deliveryId,
      allowNativePeerSteer: nativeSteer,
      model,
      effort,
    });
  } catch (e) {
    return { delivered: false, reason: `delivery failed: ${(e as Error).message}` };
  } finally {
    unsubscribe?.();
  }
  return echoed && providerAccepted
    ? { delivered: true }
    : { delivered: false, reason: echoed
        ? 'provider did not accept the routine prompt — deferred'
        : 'agent became busy before routine admission — deferred' };
}


export type TeamMessageResult = {
  delivered: boolean;
  to?: string;
  reason?: string;
  reply?: string;
  hop?: number;
  /** No delivery was needed because this exact directed edge already ran in
   * the inherited collaboration chain. Returned as success, not a wall. */
  loopClosed?: boolean;
  /** Accepted by the durable asynchronous path instead of making the caller retry. */
  queued?: boolean;
};

type TeamDelivery = {
  from: Agent;
  to: Agent;
  text: string;
  hop: number;
  chain: TeamChain;
  waitForReply: boolean;
  /** Synchronous MCP callers return as soon as a busy recipient is detected;
   * the durable outbox owns eventual delivery. */
  deferIfBusy?: boolean;
  signal?: AbortSignal;
  /** Stable for persisted async jobs, so restart recovery can dedupe receipts. */
  deliveryId?: string;
  onAdmitted?: (session: SessionLike) => Promise<void>;
};

function hasDurableDeliveryReceipt(logKey: string, deliveryId: string): boolean {
  try {
    return loadEventLogSync(logKey).events.some((event) => {
      const outer = event.ev;
      const inner = outer?.type === 'event' ? outer.event : undefined;
      return inner?.type === 'peer_delivery_accepted' && inner.deliveryId === deliveryId;
    });
  } catch {
    return false;
  }
}

async function runTeamDelivery(delivery: TeamDelivery): Promise<TeamMessageResult> {
  const { from, to, text, hop, chain, waitForReply, signal, onAdmitted, deferIfBusy = false } = delivery;
  const deliveryId = delivery.deliveryId ?? randomUUID();
  const deadline = Date.now() + RECIPIENT_IDLE_WAIT_MS;
  let waited = false;
  let providerRefusals = 0;
  const replyInstruction = from.role === 'voice'
    ? '(This is the user continuing your own voice conversation. Reply in this thread. Do not team_message Voice. Ending the audio call does not cancel this work. External side effects remain draft/review-first. The call already has a spoken line. Do not write a second, different Hall answer unless the caller needs a result, blocker, or question they cannot hear.)'
    : from.role === 'desk'
    ? `(${from.name} is the human owner, not a teammate, and reads the answer on the Desk card. Reply there with board_card_comment. Do not team_message ${from.name}.)`
    : waitForReply
    ? `(Reply inline in this turn. Your final answer is returned automatically to ${from.name}; no second team_message call is needed.)`
    : `(Reply inline for the thread. If ${from.name} needs the result, use team_message(to: "${from.name}", text: ..., wait: false); busy teammates are queued automatically.)`;
  const prompt = [
    from.role === 'voice' ? '[continuation of the user’s voice request in your own thread]'
      : from.role === 'desk' ? `[comment from ${from.name} on the Desk]`
      : `[message from teammate ${from.name}${from.role ? ` (${from.role})` : ''} — handoff ${hop}]`,
    text,
    '',
    replyInstruction,
  ].join('\n');

  while (Date.now() < deadline) {
    let session: SessionLike;
    let nativeSteer = false;
    let model: string | undefined;
    let effort: string | undefined;
    let lane: AgentLane;
    try {
      // The person's own voice continues in their lane; every other sender
      // (teammates, the Desk, TARDIS notices, robots) runs in the background.
      const admission = await getRecipientSessionForDelivery(
        to, deadline, signal, deferIfBusy,
        from.role === 'automation' ? false : from.role === 'desk' || from.role === 'voice' ? 'human' : 'peer',
        from.role === 'voice' || from.role === 'desk' ? await personLanePreference(to) : 'bg',
      );
      session = admission.session;
      lane = admission.lane;
      nativeSteer = admission.nativeSteer;
      model = admission.model;
      effort = admission.effort;
      waited ||= admission.waited;
    } catch (error) {
      return { delivered: false, to: to.name, hop, queued: waited || undefined, reason: (error as Error).message };
    }
    if (signal?.aborted) {
      return { delivered: false, to: to.name, hop, queued: waited || undefined, reason: 'sender stopped before delivery' };
    }
    if (
      delivery.deliveryId
      && (admittedQueuedDeliveries.has(deliveryId) || hasDurableDeliveryReceipt(session.logKey, deliveryId))
    ) {
      await onAdmitted?.(session);
      admittedQueuedDeliveries.delete(deliveryId);
      return { delivered: true, to: to.name, hop, queued: true, reason: 'delivery was already accepted before retry' };
    }

    // Correlate admission and completion to this exact peer turn. A human can
    // win the tiny race after the idle check; in that case no matching
    // peer_message is emitted and this FIFO worker simply waits and retries.
    let admittedSeq: number | null = null;
    let providerAccepted = false;
    let chainActivated = false;
    /** A GLM provider cut ended this turn: continuing on its own, or not. */
    const providerCut: { seen: { continuing: boolean; message: string } | null } = { seen: null };
    const maybeActivateChain = () => {
      if (chainActivated || !providerAccepted || admittedSeq === null) return;
      chainActivated = true;
      activateInboundChain(to.id, lane, chain, deliveryId, session, admittedSeq);
    };
    type WaitOutcome =
      | { kind: 'completed'; endSeq: number }
      | { kind: 'closed' }
      | { kind: 'aborted' }
      | { kind: 'timeout' };
    let settled = false;
    let finishWait!: (outcome: WaitOutcome) => void;
    const turnDoneP = new Promise<WaitOutcome>((resolve) => {
      finishWait = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => finishWait({ kind: 'aborted' });
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = session.subscribe((event) => {
        if (foreignLaneEvent(event, lane)) return;
        const inner = event.ev?.type === 'event' ? event.ev.event : undefined;
        if (inner?.type === 'peer_message' && inner.deliveryId === deliveryId) {
          admittedSeq = event.seq ?? session.latestSeq();
          maybeActivateChain();
          return;
        }
        if (inner?.type === 'peer_delivery_accepted' && inner.deliveryId === deliveryId) {
          providerAccepted = true;
          maybeActivateChain();
          return;
        }
        if (
          inner?.type === '_terminal_error'
          && admittedSeq !== null
          && (event.seq ?? 0) > admittedSeq
          && (inner.continuing === true || inner.unread === true)
        ) {
          providerCut.seen = { continuing: inner.continuing === true, message: typeof inner.message === 'string' ? inner.message : '' };
        }
        if (event.ev?.type === 'turnEnd' && providerAccepted && admittedSeq !== null && (event.seq ?? 0) > admittedSeq) {
          finishWait({ kind: 'completed', endSeq: event.seq ?? session.latestSeq() });
        } else if (event.ev?.type === 'closed' && admittedSeq !== null) {
          finishWait({ kind: 'closed' });
        }
      }, session.latestSeq(), false);
    } catch (error) {
      return { delivered: false, to: to.name, hop, queued: waited || undefined, reason: `delivery listener failed: ${(error as Error).message}` };
    }

    try {
      await session.send(prompt, undefined, {
        peerFrom: from.name,
        peerFromRole: from.role,
        // The control envelope belongs to the model, not the visible feed.
        peerText: text,
        peerDeliveryId: deliveryId,
        allowNativePeerSteer: nativeSteer,
        model,
        effort,
        signal,
      });
    } catch (error) {
      unsubscribe?.();
      return { delivered: false, to: to.name, hop, queued: waited || undefined, reason: `delivery failed: ${(error as Error).message}` };
    }

    if (admittedSeq === null || !providerAccepted) {
      // Another sender claimed the turn first, or the runner failed after the
      // visible peer echo but before the provider accepted its prompt. Never
      // delete the outbox row or accept another turn's completion; retry.
      unsubscribe?.();
      waited = true;
      // Re-enter admission promptly, but always cross an event-loop boundary.
      // A failed idle admission may report neither busy nor steerable; without
      // this bounded progress wait it can spin in microtasks and repeatedly
      // spawn/claim the same recipient for the full 30-minute deadline.
      // When the provider refused a prompt we had already echoed, every retry
      // writes another echo plus an error into the thread's event log, so those
      // back off (250ms doubling to 30s) instead of retrying four times a second.
      if (admittedSeq !== null) providerRefusals++;
      const remaining = Math.max(1, deadline - Date.now());
      if (providerRefusals > 0) {
        await waitForRefusalPause(
          session,
          Math.min(DELIVERY_REFUSAL_BACKOFF_MAX_MS, 250 * 2 ** Math.min(providerRefusals - 1, 8), remaining),
          signal,
        );
      } else {
        await waitForSessionProgress(session, session.latestSeq(), Math.min(250, remaining), signal);
      }
      continue;
    }

    if (delivery.deliveryId) admittedQueuedDeliveries.add(deliveryId);
    try {
      await onAdmitted?.(session);
      admittedQueuedDeliveries.delete(deliveryId);
    } catch (error) {
      // The peer receipt is already in the durable event stream. Keep the
      // queue record so startup recovery can dedupe and retry only the ack.
      console.warn(`[team] could not acknowledge durable delivery ${deliveryId}: ${(error as Error).message}`);
    }

    if (!waitForReply) {
      unsubscribe?.();
      return { delivered: true, to: to.name, hop, queued: waited || undefined };
    }

    // Node/undici's default response-header deadline is about five minutes.
    // Returning before it prevents Claude Code from turning a successful,
    // durable handoff into the opaque `ERROR: fetch failed` users saw at 5:00.
    const REPLY_WAIT_MS = 4 * 60_000;
    if (signal?.aborted) finishWait({ kind: 'aborted' });
    else signal?.addEventListener('abort', onAbort, { once: true });
    if (!settled) {
      timer = setTimeout(() => finishWait({ kind: 'timeout' }), REPLY_WAIT_MS);
      timer.unref?.();
    }

    const result: TeamMessageResult = { delivered: true, to: to.name, hop, queued: waited || undefined };
    try {
      const outcome = await turnDoneP;
      if (outcome.kind === 'completed') {
        result.reply = await readLastReply(session.logKey, admittedSeq, outcome.endSeq, lane).catch(() => undefined);
        if (!result.reply) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          result.reply = await readLastReply(session.logKey, admittedSeq, outcome.endSeq, lane).catch(() => undefined);
        }
        if (providerCut.seen?.continuing) {
          result.reason = `${to.name}'s model provider switched mid-turn, so any reply here is partial. ${to.name} is continuing automatically and the rest will land in its thread`;
        } else if (providerCut.seen) {
          result.reason = `${to.name}'s turn stopped before finishing: ${providerCut.seen.message}`;
        } else if (!result.reply) result.reason = 'reply not captured (check the thread) — delivered';
      } else if (outcome.kind === 'timeout') {
        result.reason = `${to.name} is still working after ${Math.round(REPLY_WAIT_MS / 60_000)} minutes — delivery remains in their thread`;
      } else if (outcome.kind === 'closed') {
        result.reason = `${to.name}'s engine closed after accepting the delivery — check their thread`;
      } else {
        result.reason = `sender stopped waiting — delivery remains in ${to.name}'s thread`;
      }
      return result;
    } finally {
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    delivered: false,
    to: to.name,
    hop,
    queued: waited || undefined,
    reason: `${to.name} did not accept the queued delivery within ${Math.round(RECIPIENT_IDLE_WAIT_MS / 60_000)} minutes`,
  };
}

async function acknowledgeQueuedDelivery(record: QueuedTeamDelivery, session: SessionLike): Promise<void> {
  // Persist and verify the provider-accepted receipt before deleting the outbox
  // row. A swallowed event-log write can never lose the message.
  await flushEventLog(session.logKey);
  if (!hasDurableDeliveryReceipt(session.logKey, record.id)) {
    throw new Error('accepted delivery receipt did not reach the event log');
  }
  await queueStoreOperation(() => queuedDeliveryStore.delete(record.id));
}

/** The joined-delivery block for each batch record after the lead. Mirrors
 *  runTeamDelivery's own prompt headers so every message keeps its sender. */
function batchDeliveryBlock(record: QueuedTeamDelivery): string {
  const header = record.fromRole === 'desk'
    ? `[comment from ${record.fromName} on the Desk]`
    : record.fromRole === 'voice'
    ? '[continuation of the user\u2019s voice request in your own thread]'
    : `[message from teammate ${record.fromName}${record.fromRole ? ` (${record.fromRole})` : ''} \u2014 handoff ${record.hop}]`;
  return `${header}\n${record.text}`;
}

// Bounds for one admitted batch turn. Unbounded, a 34-message backlog (each
// record can carry 8,000 characters) would hand the recipient a prompt
// hundreds of KB long — past admission and provider context limits — and
// retry forever without draining. Overflow stays queued; the next admission
// takes it, so a big backlog clears in a few turns instead of one or 34.
const MAX_BATCH_DELIVERIES = 8;
const MAX_BATCH_TEXT_CHARS = 24_000;

/** Sender class for batch compatibility: the reply instruction an admitted
 *  turn carries is built from the lead's role, so only same-class records
 *  can share it (Desk answers answer on the card, voice continuations
 *  continue the call, automation stays automation, teammates reply inline). */
function batchRoleClass(record: { fromRole?: string }): 'desk' | 'voice' | 'automation' | 'teammate' {
  if (record.fromRole === 'desk') return 'desk';
  if (record.fromRole === 'voice') return 'voice';
  if (record.fromRole === 'automation') return 'automation';
  return 'teammate';
}

/** Whether a queued record can ride the lead's admitted turn without losing
 *  its own routing. The lead's collaboration chain is the only one the turn
 *  can activate (one active chain slot per lane), so a record carrying an
 *  explicit chain joins only an identical one; plain handoffs join freely and
 *  lose only synthesized route metadata, which every sender can read from the
 *  thread anyway. */
function batchJoinable(lead: QueuedTeamDelivery, record: QueuedTeamDelivery): boolean {
  if (batchRoleClass(lead) !== batchRoleClass(record)) return false;
  const explicit = (r: QueuedTeamDelivery) => Boolean(r.chainId || r.chainEdges?.length || r.chainRoute?.length);
  if (!explicit(lead) && !explicit(record)) return true;
  if (explicit(lead) !== explicit(record)) return false;
  const leadChain = chainForQueuedDelivery(lead);
  const recordChain = chainForQueuedDelivery(record);
  return leadChain.id === recordChain.id
    && leadChain.edges.join('\u0000') === recordChain.edges.join('\u0000')
    && leadChain.route.join('\u0000') === recordChain.route.join('\u0000');
}

/** Ack a joined batch: the lead record's durable receipt proves the whole
 *  joined prompt was accepted (one send, one peer echo), so persist a
 *  per-record receipt for every other message before deleting them — a
 *  restart mid-ack must never redeliver the tail of a batch. */
async function acknowledgeQueuedBatch(records: QueuedTeamDelivery[], session: SessionLike): Promise<void> {
  const [lead, ...rest] = records;
  await flushEventLog(session.logKey);
  if (!hasDurableDeliveryReceipt(session.logKey, lead.id)) {
    throw new Error('accepted delivery receipt did not reach the event log');
  }
  for (const record of rest) {
    if (hasDurableDeliveryReceipt(session.logKey, record.id)) continue;
    await appendEventLogDurable(session.logKey, {
      seq: reserveEventLogSeq(session.logKey),
      ev: { type: 'event', event: { type: 'peer_delivery_accepted', deliveryId: record.id } } as PersistedEvent['ev'],
    });
  }
  for (const record of records) {
    await queueStoreOperation(() => queuedDeliveryStore.delete(record.id));
  }
}

function retryDelay(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ASYNC_RETRY_MS);
    timer.unref?.();
  });
}

async function drainQueuedRecipient(queueKey: string): Promise<void> {
  // Snapshot this worker's batch. Handoffs accepted while it runs are scheduled
  // as the next batch, behind any synchronous delivery already waiting on the
  // same recipient tail.
  const batch = (await queueStoreOperation(() => queuedDeliveryStore.list()))
    .filter((item) => queueKeyOf(item) === queueKey)
    // Person-sourced records (Desk answers, voice continuations) and
    // priority-flagged messages jump teammate chatter; within each group
    // oldest first, so a joined delivery reads newest-last.
    .sort((a, b) => (Number(sortsAhead(b)) - Number(sortsAhead(a)))
      || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

  for (const record of batch) {
    while (true) {
      const stillQueued = await queueStoreOperation(async () =>
        (await queuedDeliveryStore.list()).some((item) => item.id === record.id));
      if (!stillQueued) break;

      const to = findAgent(record.toId);
      if (!to) {
        console.warn(`[team] queued delivery ${record.id} is waiting for missing teammate ${record.toId}`);
        await retryDelay();
        continue;
      }
      // One admission for the whole still-queued batch, bounded and
      // routing-compatible. A boundary per message is what backed deliveries
      // up for an hour on busy lanes (34 queued for one Kimi K3 recipient,
      // one message per 10-25 s step), so every still-queued message for this
      // recipient rides the same admitted turn: person messages first
      // (Matt's Desk answers never sit behind teammate chatter), oldest first
      // within each group. Only records that keep their own routing join
      // (same sender class, and no explicit chain unless it matches the
      // lead's), and the join is capped by count and characters so an
      // admitted turn never grows past admission limits. Whatever does not
      // fit stays queued and the next admission takes it.
      const candidates = (await queueStoreOperation(() => queuedDeliveryStore.list()))
        .filter((item) => queueKeyOf(item) === queueKey)
        .sort((a, b) => (Number(sortsAhead(b)) - Number(sortsAhead(a)))
          || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
      if (candidates.length === 0) break;
      const lead = candidates[0];
      const siblings = [lead];
      let batchChars = lead.text.length;
      for (const candidate of candidates.slice(1)) {
        if (siblings.length >= MAX_BATCH_DELIVERIES) break;
        if (!batchJoinable(lead, candidate)) continue;
        const block = batchDeliveryBlock(candidate);
        if (batchChars + block.length > MAX_BATCH_TEXT_CHARS) continue;
        siblings.push(candidate);
        batchChars += block.length;
      }
      const from = findAgent(lead.fromId) ?? {
        id: lead.fromId,
        name: lead.fromName,
        role: lead.fromRole ?? '',
        engine: '',
        home: '',
        createdAt: 0,
      };
      const joinedText = siblings.length > 1
        ? [lead.text, '', ...siblings.slice(1).map(batchDeliveryBlock)].join('\n')
        : lead.text;
      const result = await runTeamDelivery({
        from,
        to,
        text: joinedText,
        hop: lead.hop,
        chain: chainForQueuedDelivery(lead),
        waitForReply: false,
        deliveryId: lead.id,
        onAdmitted: (session) => acknowledgeQueuedBatch(siblings, session),
      });
      const remains = await queueStoreOperation(async () =>
        (await queuedDeliveryStore.list()).some((item) => item.id === record.id));
      if (!result.delivered || remains) {
        console.warn(`[team] queued delivery ${lead.fromName} -> ${to.name} will retry: ${result.reason ?? 'durable acknowledgement pending'}`);
        await retryDelay();
        continue;
      }
      break;
    }
  }
}

function scheduleQueuedRecipient(queueKey: string, delayMs = 0): void {
  if (activeQueuedRecipients.has(queueKey) || queuedRetryTimers.has(queueKey)) return;
  const launch = () => {
    queuedRetryTimers.delete(queueKey);
    if (activeQueuedRecipients.has(queueKey)) return;
    activeQueuedRecipients.add(queueKey);
    const { job } = enqueueForRecipient(queueKey, () => drainQueuedRecipient(queueKey));
    void job.catch((error) => {
      console.warn(`[team] durable queue for ${queueKey} paused after an error: ${(error as Error).message}`);
    }).finally(async () => {
      activeQueuedRecipients.delete(queueKey);
      try {
        const remains = await queueStoreOperation(async () =>
          (await queuedDeliveryStore.list()).some((item) => queueKeyOf(item) === queueKey));
        if (remains) scheduleQueuedRecipient(queueKey, ASYNC_RETRY_MS);
      } catch (error) {
        console.warn(`[team] could not inspect durable queue for ${queueKey}: ${(error as Error).message}`);
        scheduleQueuedRecipient(queueKey, ASYNC_RETRY_MS);
      }
    });
  };

  if (delayMs <= 0) {
    launch();
    return;
  }
  const timer = setTimeout(launch, delayMs);
  timer.unref?.();
  queuedRetryTimers.set(queueKey, timer);
}

/** Resume accepted fire-and-forget handoffs after a TARDIS restart. */
export async function resumeQueuedTeamDeliveries(): Promise<number> {
  const records = await queueStoreOperation(() => queuedDeliveryStore.list());
  new Set(records.map(queueKeyOf)).forEach((queueKey) => scheduleQueuedRecipient(queueKey));
  return records.length;
}

export function teamMessageWaitRequested(wait: boolean | undefined): boolean {
  // Preserve the original raw HTTP contract. team-mcp.mjs explicitly sends
  // false when its caller omits wait, giving agents async-by-default behavior
  // without silently changing other API clients.
  return wait !== false;
}

export async function deliverTeamMessage(input: {
  from: string;
  to: string;
  text: string;
  /** voice: the user's own call continuing in the thread. desk: the human
   *  owner commenting on a Desk card (`from` is their display name). */
  source?: 'voice' | 'desk';
  /** Internal admission notification; fires only after the outbox is durable. */
  onQueued?: () => void;
  hop?: number;
  wait?: boolean;
  /** Priority flag: this record sorts with person-sourced records, ahead of
   *  older teammate chatter. Sort order only; nothing else changes. */
  priority?: boolean;
  signal?: AbortSignal;
  /** The sender's own lane (from its team MCP), for chain inheritance. */
  fromLane?: AgentLane;
}): Promise<TeamMessageResult> {
  const hop = Math.max(1, Math.floor(input.hop ?? 1));
  const text = (input.text ?? '').trim().slice(0, MAX_TEXT);
  if (!text) return { delivered: false, reason: 'empty message' };

  const to = findAgent(input.to);
  if (!to) return { delivered: false, reason: `no teammate named "${input.to}" — call team_list first` };
  const from = input.source === 'voice'
    ? { id: `voice-${to.id}`, name: 'Voice', role: 'voice', engine: '', home: '', createdAt: 0 }
    : input.source === 'desk'
    // Agent ids are slugs, so the colon keeps this from ever resolving to one.
    ? { id: 'desk:owner', name: input.from.trim() || 'Owner', role: 'desk', engine: '', home: '', createdAt: 0 }
    : findAgent(input.from) ?? { id: 'unknown', name: input.from || 'Unknown', role: '', engine: '', home: '', createdAt: 0 };
  if (to.id === from.id && input.from.trim().toLowerCase() === to.name.trim().toLowerCase()) {
    return { delivered: false, reason: 'that is you — no need to message yourself' };
  }

  const { chain } = inheritedTeamChain(from.id, to.id, input.fromLane === 'bg' ? 'bg' : 'main');
  const requestedWaitForReply = teamMessageWaitRequested(input.wait);
  // Historical route repetition is never a reason to discard a message. Only
  // a CURRENT synchronous wait path can deadlock; that exact case is degraded
  // to durable fire-and-forget below so the text still reaches its recipient.
  // If adding from -> to closes any active wait path (A -> B -> C -> A), the
  // closing leg becomes durable fire-and-forget. Its text is preserved and all
  // blocked turns can finish; direct and longer cycles behave identically.
  const closesReplyCycle = requestedWaitForReply && hasReplyPath(to.id, from.id);
  const waitForReply = requestedWaitForReply && !closesReplyCycle;

  const rl = rateOk(replyEdge(from.id, to.id));
  if (!rl.ok) return { delivered: false, reason: rl.reason };

  const fifoKey = queueKeyOf({ toId: to.id });
  const queuedBehindAnotherTurn = recipientDeliveryTails.has(fifoKey);
  let record: QueuedTeamDelivery;
  try {
    // Every handoff enters the durable outbox BEFORE it can wait on another
    // agent. `wait:true` only controls this HTTP caller's reply wait; a service
    // restart never erases the underlying delivery.
    record = await queueStoreOperation(() => queuedDeliveryStore.create({
      fromId: from.id,
      fromName: from.name,
      fromRole: from.role || undefined,
      toId: to.id,
      text,
      hop,
      priority: input.priority === true ? true : undefined,
      chainId: chain.id,
      chainEdges: chain.edges,
      chainRoute: chain.route,
    }));
  } catch (error) {
    return { delivered: false, to: to.name, hop, reason: `could not persist queued delivery: ${(error as Error).message}` };
  }

  try { input.onQueued?.(); } catch (error) {
    console.warn('[team] admission observer failed:', (error as Error).message);
  }

  if (!waitForReply) {
    scheduleQueuedRecipient(queueKeyOf(record));
    return {
      delivered: true,
      to: to.name,
      hop,
      queued: true,
      reason: closesReplyCycle
        ? 'stored durably to avoid a cross-agent reply cycle; delivery is automatic'
        : queuedBehindAnotherTurn
          ? 'stored durably behind an earlier handoff; delivery is automatic'
          : 'stored durably; it will steer a compatible active turn immediately or use the next idle boundary',
    };
  }

  if (queuedBehindAnotherTurn) {
    scheduleQueuedRecipient(queueKeyOf(record));
    return {
      delivered: true,
      to: to.name,
      hop,
      queued: true,
      reason: 'stored durably behind an earlier handoff; delivery is automatic and no retry is needed',
    };
  }

  const job = tryEnqueueForRecipient(fifoKey, () => runTeamDelivery({
    from,
    to,
    text,
    hop,
    chain,
    waitForReply: true,
    signal: input.signal,
    deliveryId: record.id,
    deferIfBusy: true,
    onAdmitted: (session) => acknowledgeQueuedDelivery(record, session),
  }));
  if (!job) {
    scheduleQueuedRecipient(queueKeyOf(record));
    return {
      delivered: true,
      to: to.name,
      hop,
      queued: true,
      reason: 'stored durably behind another handoff; delivery is automatic and no retry is needed',
    };
  }

  const edge = replyEdge(from.id, to.id);
  addReplyEdge(edge);
  try {
    const result = await job;
    const remains = await queueStoreOperation(async () =>
      (await queuedDeliveryStore.list()).some((item) => item.id === record.id));
    if (!result.delivered && input.signal?.aborted) {
      if (remains) await queueStoreOperation(() => queuedDeliveryStore.delete(record.id));
      return result;
    }
    if (remains) scheduleQueuedRecipient(queueKeyOf(record));
    if (!result.delivered && remains) {
      return {
        delivered: true,
        to: to.name,
        hop,
        queued: true,
        reason: 'reply wait ended, but the handoff remains durably queued and will deliver automatically',
      };
    }
    return result;
  } catch (error) {
    if (input.signal?.aborted) {
      await queueStoreOperation(() => queuedDeliveryStore.delete(record.id));
      return { delivered: false, to: to.name, hop, reason: 'sender stopped before delivery' };
    }
    scheduleQueuedRecipient(queueKeyOf(record));
    return {
      delivered: true,
      to: to.name,
      hop,
      queued: true,
      reason: `reply wait failed, but the handoff remains durably queued: ${(error as Error).message}`,
    };
  } finally {
    removeReplyEdge(edge);
  }
}

// ---- reply extraction ---------------------------------------------------------

import { appendEventLogDurable, flushEventLog, loadEventLogSync, reserveEventLogSeq, type PersistedEvent } from './event-log-store.ts';

/** Read the recipient's authoritative shared-thread tail for this exact turn. */
async function readLastReply(logKey: string, minSeq = 0, maxSeq = Number.POSITIVE_INFINITY, lane: AgentLane = 'main'): Promise<string | undefined> {
  try { await flushEventLog(logKey); } catch { /* best-effort */ }
  const { events } = loadEventLogSync(logKey);
  // The other lane may have spoken in the same seq range; the reply is this lane's.
  const bounded = events.filter((event) => event.seq >= minSeq && event.seq <= maxSeq && !foreignLaneEvent(event, lane));
  // One shared transcript extractor handles Claude's full assistant messages
  // plus Codex/Banana stream-only content blocks, while excluding tool results.
  const reply = [...extractVisibleTurns(bounded)].reverse().find((turn) => turn.role === 'assistant');
  return reply?.text.trim() || undefined;
}

// ---- introspection ------------------------------------------------------------

type TeamAvailabilitySession = {
  cli: string;
  cwd: string;
  chatId: string;
  busy: boolean;
};

export function teamAvailability(
  agent: Agent,
  sessions: readonly TeamAvailabilitySession[],
  queued: readonly Pick<QueuedTeamDelivery, 'toId'>[],
): { status: 'working' | 'queued' | 'idle'; busy: boolean; queuedMessages: number; activeCli?: string; background?: boolean } {
  const busyLanes = sessions.filter((session) => (
    session.cwd === ELROND_WORKSPACE_PATH
    && bareChatId(session.chatId) === bareChatId(agent.home)
    && session.busy
  ));
  const active = busyLanes.find((session) => !isBackgroundChatId(session.chatId)) ?? busyLanes[0];
  const queuedMessages = queued.filter((delivery) => delivery.toId === agent.id).length;
  return {
    status: active ? 'working' : queuedMessages > 0 ? 'queued' : 'idle',
    busy: Boolean(active),
    queuedMessages,
    ...(active ? { activeCli: active.cli } : {}),
    // Only the background lane is working: the person's own lane is free.
    ...(active && isBackgroundChatId(active.chatId) ? { background: true } : {}),
  };
}

/** Ground-truth process activity, not inferred assignments or intentions. */
export async function teamRoster() {
  const runner = await getRunner();
  // Queue first, live sessions second. A delivery transitions queue → busy in
  // that order; this snapshot order cannot observe neither side of the handoff.
  const queued = await queueStoreOperation(() => queuedDeliveryStore.list());
  const sessions = runner.activeChatSessions();
  return listAgents().map((agent) => {
    const brain = brainForAgent(agent);
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      engine: brain.engine,
      model: brain.model,
      effort: brain.effort,
      ...teamAvailability(agent, sessions, queued),
    };
  });
}

/** Recent visible texts from an agent's authoritative shared home thread. */
export async function teamRecent(name: string, limit = 8): Promise<Array<{ who: 'agent' | 'user' | 'peer'; text: string }>> {
  const agent = findAgent(name);
  if (!agent) return [];
  const { cli, chatKey } = agentLogKey(agent);
  const logKey = logKeyFor(cli, ELROND_WORKSPACE_PATH, chatKey);
  // Polls commonly happen immediately after delivery/turnEnd; wait for the
  // append chain so team_recent never reports an empty stale disk tail.
  try { await flushEventLog(logKey); } catch { /* best-effort */ }
  const { events } = loadEventLogSync(logKey);
  return extractVisibleTurns(events).slice(-limit).map((turn) => {
    const peer = turn.role === 'user' ? /^\[([^\]]+)]\s+([\s\S]*)$/.exec(turn.text) : null;
    return {
      who: turn.role === 'assistant' ? 'agent' as const : peer ? 'peer' as const : 'user' as const,
      text: (peer?.[2] ?? turn.text).replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  });
}
