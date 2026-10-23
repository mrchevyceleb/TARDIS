import { acknowledgementOnly, claimOutbound, releaseOutbound, saveInformational, informationalPending, legacyActionableInformation, removeSavedInformation } from './messagingPolicy.ts';
// Team bus — agent-to-agent messaging. Any teammate can message any other
// teammate through the `rivendell-team` MCP tool (see server/scripts/team-mcp.mjs);
// delivery lands in the recipient's home thread as a `peer_message` event
// (rendered with the sender's identity, not as a user turn) and wakes the
// recipient's engine for a real turn. Guards: active-cycle detection, rate
// limits, text cap, and per-recipient FIFO delivery — long legitimate chains
// stay open without allowing a tight runaway loop or losing busy handoffs.

import { createHash, randomUUID } from 'node:crypto';
import { DESK_OWNER_NAME, ELROND_WORKSPACE_PATH } from '../config.ts';
import { agentForChatId, brainForAgent, cliForAgentEngine, listAgents, type Agent } from './agents.ts';
import { backgroundChatId, backgroundLaneEnabled, bareChatId, isBackgroundChatId, logKeyFor } from './threadKey.ts';
import { extractVisibleTurns } from './threadWindow.ts';
import { JsonStore, type StoredRecord } from '../lib/jsonStore.ts';
import { scanOutgoingPromise } from '../lib/promiseScan.ts';
import { inQuietHours, isQuietExemptLane, msUntilQuietEnd, recordQuietExemptWake } from '../lib/quietHours.ts';
import { LIVE_HOLD_CEILING_MS } from '../lib/laneLiveness.ts';
import { briefEnvelopeForHandoff, isCoderBrief } from './briefEnvelope.ts';
import { recordNativeFailure } from './sessionMetrics.ts';
import { freshThreadOnTask, freshTaskSenders, sessionDirectory } from './sessionPolicy.ts';
import { freshLifecycleStarted, freshLifecycleCompleted } from './freshLifecycle.ts';
import { persistThreadResetEpoch, noteThreadResetEpoch, persistThreadResetTaskState, threadResetTaskState, type ThreadResetTaskState } from './threadResetStore.ts';
import { clearThreadSessionIds } from './sessions.ts';
import type { CliKind } from './runner.ts';

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
      ev?: { type?: string; event?: { type?: string; deliveryId?: string; continuing?: boolean; unread?: boolean; message?: string; terminal?: boolean } };
    }) => void,
    sinceSeq?: number,
    countSubscriber?: boolean,
  ) => () => void;
  key: string;
  logKey: string;
  chatId?: string;
};


/** A stdin write is not a provider receipt. Keep listening through startup
 * so callers do not retry an admitted wake or accept an empty reply. */
async function sendWithAdmission(session: SessionLike, deliveryId: string, send: () => Promise<void>): Promise<void> {
  let finish = (_outcome: 'accepted' | 'rejected' | 'terminal' | 'closed' | 'timeout') => {};
  const admitted = new Promise<'accepted' | 'rejected' | 'terminal' | 'closed' | 'timeout'>(resolve => { finish = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = session.subscribe(event => {
    const inner = event.ev?.type === 'event' ? event.ev.event : undefined;
    if (inner?.type === 'peer_delivery_accepted' && inner.deliveryId === deliveryId) finish('accepted');
    if (inner?.type === 'peer_delivery_rejected' && inner.deliveryId === deliveryId) finish(inner.terminal ? 'terminal' : 'rejected');
    if (event.ev?.type === 'closed') finish('closed');
  }, session.latestSeq(), false);
  try {
    await send();
    // Maintenance can take several minutes before stdin is written. Neither
    // its turn end nor its elapsed time is a receipt for this delivery.
    timer = setTimeout(() => finish('timeout'), 4 * 60_000);
    timer.unref?.();
    const outcome = await admitted;
    if (outcome !== 'accepted') {
      if (outcome === 'timeout') recordNativeFailure(session.chatId ?? session.logKey, 'native',
        'A delivery received no provider acceptance within four minutes. It remains pending; it was not marked delivered.');
      throw Object.assign(new Error(outcome === 'terminal'
        ? 'The prior submission is ambiguous. Automatic replay stopped; the handoff is retained in a failure notice for review.'
        : `provider admission ${outcome}; the delivery remains pending`), { terminalDelivery: outcome === 'terminal' });
    }
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

async function getRunner() {
  const mod = await import('./runner.ts');
  return mod as unknown as {
    getOrCreateSession: (opts: { cli: string; repoPath: string; chatId: string; model?: string; effort?: string; recycleOnMismatch?: boolean }) => Promise<SessionLike>;
    activeChatSessions: () => Array<{ cli: string; cwd: string; chatId: string; busy: boolean; backgroundTasks?: string[] }>;
    isPersistentProcessCli: (cli: string) => boolean;
    beginThreadResetForLogKey: (logKey: string) => (() => void) | null;
    settleThreadSessionLookups: (opts: { cli: CliKind; repoPath: string; chatId?: string }) => Promise<void>;
    liveSessionsForLogKey: (logKey: string) => Array<{ cli: string; cwd: string; chatId: string; busy: boolean; backgroundTasks?: string[] }>;
    interruptSession: (opts: { cli: CliKind; repoPath: string; chatId?: string }) => Promise<void>;
    dropSession: (cli: CliKind, repoPath: string, chatId?: string) => void;
    freshStart: (opts: { cli: CliKind; repoPath: string; chatId?: string; model?: string; effort?: string }) => Promise<unknown>;
    trackedThreadLogKey: (opts: { cli: CliKind; repoPath: string; chatId?: string }) => string;
  };
}

/** The fresh-thread decision for one queued batch, keyed by the batch's
 *  durable task id rather than by agent, sender or timestamps. A task is
 *  owed a wipe until its own per-task reset state says `complete`; a later
 *  task with a different id is never suppressed by an earlier completion,
 *  and an interrupted `resetting` state resumes after a process restart. */
export function freshResetOwed(
  taskId: string | undefined,
  state: ThreadResetTaskState | undefined,
): boolean {
  if (!taskId) return false;
  return state?.taskId !== taskId || state.state !== 'complete';
}

/** A task start is a batch boundary (Codex review, Oct 23 2026): a marked
 *  record leads alone, so its wipe is never decided by an unmarked lead, and
 *  an unmarked lead never pulls a marked record along as a silent sibling
 *  (the marked record would ride the old thread and never reset). Marked
 *  records share one turn only when they carry the same durable task id:
 *  one task can be handed over as several capped records, and the wipe
 *  precedes the batch. Legacy marked rows without a task id keep the old
 *  same-sender grouping until they drain. */
export function batchJoinableFresh(lead: QueuedTeamDelivery, record: QueuedTeamDelivery): boolean {
  if ((lead.taskStart === true) !== (record.taskStart === true)) return false;
  if (lead.taskStart !== true) return true;
  if (lead.taskId || record.taskId) return lead.taskId === record.taskId;
  return lead.fromId === record.fromId;
}

/** Whether this handoff continues the conversation the sender is already
 *  having with the recipient: the sender's active inbound chain (the work
 *  it is currently handling) has already reached this recipient, so this
 *  send is a clarification, answer or follow-up inside that same work —
 *  never a new task. A first handoff in any direction starts a new chain
 *  leg, so the chain identity (request) and its edge set are the durable
 *  task signal Codex asked for, not timestamps or sender classes alone. */
export function chainContinues(parentChain: TeamChain | undefined, fromId: string, toId: string): boolean {
  return parentChain?.edges.includes(replyEdge(fromId, toId)) === true;
}

/** A wipe outcome that must hold the task instead of admitting it into the
 *  standing thread (Codex review, Oct 23 2026): busy, a reset already in
 *  flight, a brain switch, or any retryable failure. Anything else (notably
 *  a pre-destructive barrier refusal) falls open to ordinary delivery. */
export function freshHoldReason(wiped: { fresh: boolean; retryable?: boolean; reason?: string }): string | undefined {
  if (wiped.fresh) return undefined;
  if (wiped.retryable) return wiped.reason ?? 'fresh start failed after reset began';
  const reason = wiped.reason ?? '';
  if (/became busy|already resetting|brain changed/i.test(reason)) return reason;
  return undefined;
}

/** Server-side stamp decision (Codex verify Oct 23 2026: never infer a task
 *  boundary from timestamps or broad sender classes). A handoff opens a task
 *  only when: the recipient is flagged for fresh threads, the sender is a
 *  roster teammate speaking directly (no Desk/voice/Slack/channel or explicit
 *  person-sourced provenance, no nudge hold), the sender is a task source
 *  for this recipient — either named on the operator list, or (list empty) a
 *  lead briefing one of its coders — AND the handoff does not continue the
 *  conversation the sender is already having with this recipient (chain
 *  leg: a clarification, answer or follow-up inside work in flight carries
 *  the inbound chain's edge and never stamps). A first handoff from a task
 *  source stamps; the recipient's next one stamps again once the earlier
 *  work's chain has closed. Worker replies back never stamp for a lead that
 *  is not flagged. */
export function isTaskStartHandoff(opts: {
  senderId: string;
  recipientId: string;
  recipientHome: string;
  source?: string;
  personSourced?: boolean;
  nudgeHoldSince?: number;
  continuesChain?: boolean;
}): boolean {
  if (!opts.senderId || opts.source) return false;
  if (opts.personSourced === true) return false;
  if (opts.nudgeHoldSince !== undefined) return false;
  if (opts.continuesChain === true) return false;
  if (!freshThreadOnTask(opts.recipientHome)) return false;
  const allowed = freshTaskSenders(opts.recipientHome);
  if (allowed.length) return allowed.includes(opts.senderId);
  return isCoderBrief(opts.senderId, opts.recipientId);
}

/** True when the recipient has no live busy turn on any lane and no live
 *  session is carrying background work: the drain only wipes at an idle
 *  task boundary, never mid-turn and never through background work the
 *  reset would terminate. */
export function recipientIdle(sessions: Array<{ busy: boolean; backgroundTasks?: string[] }>): boolean {
  return sessions.every((s) => !s.busy && !(s.backgroundTasks?.length));
}

/** Wipe a recipient's home thread so the next task lands in a clean one
 *  (Matt, Oct 22 2026: Christina, Adam and Ivy, and Riley's game devs, start
 *  every new task fresh; Kip and Riley keep their ongoing threads). Driven
 *  from the drain at an idle boundary only: the caller has already confirmed
 *  no live lane is busy, and this re-validates idle under the reset barrier
 *  before anything destructive runs, so a turn that started after the
 *  candidate pick aborts the wipe instead of being killed. The sequence
 *  mirrors the WebSocket Fresh: claim the barrier, settle in-flight
 *  lookups, commit the durable reset epoch, retire every live lane, then
 *  let runner.freshStart do the durable wipe itself (native ids, staged
 *  compact memory, shared log, in that order) and spawn the clean session.
 *  The barrier refuses new session lookups until the reset releases, so a
 *  handoff landing mid-wipe queues behind the fresh spawn instead of
 *  joining the dying thread. If anything after the epoch commit fails, the
 *  durable task records stay queued: the caller holds the batch for retry
 *  instead of delivering into a possibly half-erased thread, and the reset
 *  epoch already committed tells the retry the wipe was attempted, so the
 *  retry re-runs the idempotent freshStart rather than redelivering into
 *  the old conversation. */
export async function freshStartForAgent(agent: Agent, taskId?: string): Promise<{ fresh: boolean; retryable?: boolean; reason?: string }> {
  const runner = await getRunner();
  const home = agentLogKey(agent);
  const chatId = home.chatKey;
  const repoPath = sessionDirectory(chatId, ELROND_WORKSPACE_PATH);
  const logKey = runner.trackedThreadLogKey({ cli: home.cli as CliKind, repoPath, chatId });
  const releaseReset = runner.beginThreadResetForLogKey(logKey);
  if (!releaseReset) return { fresh: false, reason: 'thread already resetting' };
  let destructive = false;
  try {
    await runner.settleThreadSessionLookups({ cli: home.cli as CliKind, repoPath, chatId });
    const latest = findAgent(agent.id) ?? agent;
    const latestHome = agentLogKey(latest);
    if (latestHome.cli !== home.cli) {
      return { fresh: false, reason: 'recipient brain changed during reset' };
    }
    // Idle revalidation under the barrier: a turn that began after the
    // drain's candidate pick must not be killed. Priors are read here (not
    // before the barrier) so this is the same set the wipe would retire.
    const priors = runner.liveSessionsForLogKey(logKey);
    if (!recipientIdle(priors)) return { fresh: false, reason: 'recipient became busy before reset' };
    const resetAt = Date.now();
    // The durable per-task state commits before the epoch and before any
    // destructive work: if the process dies anywhere from here to the end,
    // the task is still owed its wipe (`resetting`), keyed by its own id.
    if (taskId) await persistThreadResetTaskState(logKey, taskId, resetAt, 'resetting');
    const committed = await persistThreadResetEpoch(logKey, resetAt);
    destructive = true;
    noteThreadResetEpoch(logKey, committed);
    freshLifecycleStarted({ logKey, repo: repoPath, chatId, cli: home.cli });
    for (const prior of priors) {
      await runner.interruptSession({ cli: prior.cli as CliKind, repoPath: prior.cwd, chatId: prior.chatId });
      runner.dropSession(prior.cli as CliKind, prior.cwd, prior.chatId);
    }
    await clearThreadSessionIds(repoPath, chatId);
    // runner.freshStart owns the durable wipe (clearThreadMemory staged
    // before clearEventLog, native ids first) on every engine, so the
    // drain never re-implements that order and can never erase the log
    // before the memory staging has succeeded.
    await runner.freshStart({ cli: home.cli as CliKind, repoPath, chatId, model: home.model, effort: home.effort });
    if (taskId) await persistThreadResetTaskState(logKey, taskId, resetAt, 'complete');
    freshLifecycleCompleted({ logKey, repo: repoPath, chatId, cli: home.cli, resetAt: committed });
    return { fresh: true };
  } catch (error) {
    // A failure before the epoch committed changed nothing durable: the
    // batch may deliver into the intact old thread. A failure after it
    // must never deliver into a possibly half-erased thread — the caller
    // holds the durable records for retry.
    return { fresh: false, retryable: destructive, reason: `fresh start failed: ${(error as Error).message}` };
  } finally {
    releaseReset();
  }
}

/** Which of an agent's two live sessions a delivery runs in. `main` is the
 *  home lane the person talks to; `bg` is the background lane. */
export type AgentLane = 'main' | 'bg';

/** Everything that is not the person typing or speaking runs in the
 *  background lane, unless the kill switch is off. Codex and Banana engines
 *  keep their single lane: background lanes live on the persistent-process
 *  registry (claude binary, Pi, or the agy subscription lane), which mirrors
 *  them into the home view. */
function resolveLane(cli: string, requested: AgentLane, runner: { isPersistentProcessCli: (cli: string) => boolean }): AgentLane {
  if (requested === 'main' || !backgroundLaneEnabled()) return 'main';
  return runner.isPersistentProcessCli(cli) ? 'bg' : 'main';
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

export const MAX_TEXT = 8000;
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
const requestRoots = new JsonStore<{ id: string; chainId: string; admittedSeq: number; deliveryId?: string }>('message-request-roots.json', []);

type FreshTaskClaimRecord = StoredRecord & {
  requestId: string;
  senderId: string;
  recipientId: string;
  taskId: string;
};

/** Durable first-handoff claims, keyed by (request, sender, recipient).
 *  The first stamped handoff of a request claims a task id atomically; a
 *  later send on the same request edge (a clarification sent before the
 *  recipient replies) reuses that id instead of stamping a second task. */
const freshTaskClaims = new JsonStore<FreshTaskClaimRecord>('fresh-task-claims.json', []);
const requestRootWrites = new Map<string, Promise<unknown>>();

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
  /** A channel post authored by the person (Matt), not an agent. Person-class
   *  admission: human interrupt boundary plus the person lane preference, so
   *  his channel posts steer members' live turns exactly like a one-on-one
   *  message (card-1327b9). Batch class stays 'channel' — same reply rules. */
  personPosted?: true;
  /** The person chose to queue this channel post for the member's NEXT turn
   *  (card-504beb) instead of steering the live one: person class and lane
   *  preference are kept, but the delivery never interrupts — it waits for
   *  the current turn to end, exactly like a peer message. */
  queue?: true;
  /** Explicit person-sourced wake (Matt's Desk answer, voice continuation,
   *  Matt's channel post including unmentioned members, or an overnight Matt
   *  ask nudge): exempt from the 22:00-05:00 ET quiet-hours hold. */
  personSourced?: true;
  /** card-b3468c: an automation nudge (flag digest, Desk quiet-check,
   *  past-due raise) with its live-turn hold origin in epoch ms. While
   *  Date.now() - nudgeHoldSince is under the liveness ceiling the record's
   *  admission NEVER steers the recipient's live turn — it waits for a real
   *  turn end, exactly the card-504beb queue policy — and it never joins a
   *  batch whose admission would steer. Past the ceiling the flag clears, so
   *  a lane stuck in one long turn still gets its nudge: holding never means
   *  losing. */
  nudgeHoldSince?: number;
  /** card-b3468c (verify P1): 'flag-digest' asks the drain to notify the
   *  flag-digest queue when this record actually admits (the recipient saw
   *  the line), so the digest's entry callbacks run on admission, never on
   *  the durable receipt. */
  admissionAck?: 'flag-digest';
  chainId?: string;
  chainEdges?: string[];
  chainRoute?: string[];
  /** Explicit new-task marker (server-stamped, Oct 22 2026): set only by
   *  deliverTeamMessage when a roster sender on the recipient's task-source
   *  list hands work to a flagged recipient (see isTaskStartHandoff). Client
   *  input can never set it. Only a lead record carrying this marker may
   *  trigger a fresh-thread wipe; follow-ups and worker replies back carry
   *  no marker unless they are themselves a new handoff from a task source. */
  taskStart?: true;
  /** Durable identity of the task this record belongs to: claimed once for
   *  the (request, sender, recipient) edge at stamp time. Batching and the
   *  per-task reset state key on it, so distinct tasks from one sender
   *  never share a wipe decision. */
  taskId?: string;
  /** Batch stamp, persisted before a batch is sent: the lead carries its
   *  own id (self-stamp, freezing the membership across retries) and each
   *  sibling carries the lead's id, so an ack, or its retry after a
   *  restart, can reconstruct exactly which records rode the admitted
   *  turn, never records that queued later and were never seen. */
  batchLeadId?: string;
  /** Set the moment the record's batch was admitted (the recipient saw it).
   *  A queue row that survives a partial ack must be dropped by the next
   *  batch build, never resent. */
  acked?: true;
};


const FRESH_CLAIM_TTL_MS = 30 * 24 * 60 * 60_000;
const FRESH_CLAIM_LIMIT = 5_000;

function freshClaimId(requestId: string, senderId: string, recipientId: string): string {
  return `claim:${createHash('sha256').update(`${requestId}\u0000${senderId}\u0000${recipientId}`).digest('hex')}`;
}

/** Atomically claim (or reuse) the durable task id for one first-handoff
 *  edge. The read-modify-write runs inside the store's mutation chain, so
 *  two concurrent sends on the same request edge can never mint two ids.
 *  Minting is deferred until every cheap exit (rate limit, duplicate,
 *  acknowledgement-only, informational) has already passed, and every mint
 *  prunes expired and excess rows, so the store stays bounded even if a
 *  process dies between the mint and the queue write. */
async function claimFreshTaskId(requestId: string, senderId: string, recipientId: string): Promise<{ taskId: string; minted: boolean }> {
  const claimId = freshClaimId(requestId, senderId, recipientId);
  let taskId = '', minted = false;
  await freshTaskClaims.modify((items) => {
    const cutoff = Date.now() - FRESH_CLAIM_TTL_MS;
    const kept = items.filter((item) => {
      const at = Date.parse(item.updatedAt || item.createdAt || '');
      return Number.isFinite(at) && at >= cutoff;
    });
    const existing = kept.find((item) => item.id === claimId);
    if (existing) {
      taskId = existing.taskId;
      return kept;
    }
    taskId = randomUUID();
    minted = true;
    const stamp = new Date().toISOString();
    return [...kept.slice(-(FRESH_CLAIM_LIMIT - 1)), { id: claimId, createdAt: stamp, updatedAt: stamp, requestId, senderId, recipientId, taskId }];
  });
  return { taskId, minted };
}

/** Release a claim minted by this send when the durable queue write fails:
 *  no record carries the id, so keeping the claim would swallow the retry's
 *  task start. Reused claims (an earlier send already owns them) stay. */
async function releaseFreshTaskClaim(requestId: string, senderId: string, recipientId: string): Promise<void> {
  const claimId = freshClaimId(requestId, senderId, recipientId);
  await freshTaskClaims.modify((items) => items.filter((item) => item.id !== claimId));
}

/** The recipient's real reply closes the chain: every claim on the
 *  (original sender, recipient) edge retires with it, so the next genuine
 *  task on that edge mints a new id and can stamp a new reset. */
async function retireFreshTaskClaimsForReply(replierId: string, originalSenderId: string): Promise<void> {
  await freshTaskClaims.modify((items) => items.filter((item) => !(item.senderId === originalSenderId && item.recipientId === replierId)));
}

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
const queuedRetryTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; due: number }>();
/** A queued lead's admission wait, abortable by a newer non-queued record for
 *  the same recipient (card-504beb, review 3 P0 2): a queued record never
 *  holds the recipient's single delivery line for its whole 30-minute wait
 *  while a person-sourced record waits behind it. The nudge flag marks a
 *  waiting under-ceiling nudge hold (card-b3468c): any ordinary record may
 *  abort that wait — the nudge would have steered before that hold existed,
 *  so no teammate message may sit behind it — while a queued (queue:true)
 *  wait keeps its original person-sourced/priority-only abort rule. */
const queuedLeadAborters = new Map<string, { controller: AbortController; nudge: boolean }>();

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
  const write = requestRoots.modify(items => [...items.filter(item => item.id !== key), { id: key, chainId: chain.id, admittedSeq, deliveryId }]);
  requestRootWrites.set(key, write);
  void write.catch(() => console.warn('[messages] request identity will retry'));
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
  if (session.isBusy?.() === false) return Promise.resolve('idle');
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
        if (event.ev?.type === 'closed') done('closed');
        else if (event.ev?.type === 'turnEnd' || session.isBusy?.() === false) done('idle');
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
    if (session.isBusy?.() === false) done('idle');
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

/** Person-sourced queued deliveries (Desk answers, voice continuations,
 *  the person's own channel posts, and explicit person-sourced wakes). During
 *  quiet hours only these records deliver to non-Max lanes — the boss may
 *  always speak. */
function personSourced(record: { fromRole?: string; personPosted?: boolean; personSourced?: boolean }): boolean {
  return record.fromRole === 'desk'
    || record.fromRole === 'voice'
    || record.fromRole === 'slack'
    || (record.fromRole === 'channel' && record.personPosted === true)
    || record.personSourced === true;
}

/** Records that sort to the front of an admitted batch: person-sourced
 *  (Desk answers, voice continuations, human channel posts), explicitly
 *  priority-flagged teammate messages, and the person's own channel posts.
 *  Sort order only; the interrupt class and lane policy are derived inside
 *  runTeamDelivery. */
function sortsAhead(record: { fromRole?: string; priority?: boolean; personPosted?: boolean; personSourced?: boolean }): boolean {
  return personSourced(record) || record.priority === true
    || (record.fromRole === 'channel' && record.personPosted === true);
}

/** A nudge record's live-turn hold is still under its ceiling (card-b3468c):
 *  its admission must wait for a real turn end and never steer. */
function nudgeHoldActive(record: { nudgeHoldSince?: number }): boolean {
  return record.nudgeHoldSince !== undefined && Date.now() - record.nudgeHoldSince < LIVE_HOLD_CEILING_MS;
}

/** Interrupt class for one delivery: person senders (voice, desk) and the
 *  person's own channel posts get the human boundary (steers a live turn
 *  within a step), automation is never interruptible, everything else is
 *  peer class. Exported for tests. */
export function deliveryInterruptClass(fromRole: string | undefined, personPosted?: boolean, queue?: boolean): false | 'human' | 'peer' {
  if (fromRole === 'automation') return false;
  // A queued delivery (card-504beb) never interrupts: no human or peer
  // boundary request, on the first admission attempt or any drain retry. It
  // waits out the live turn and rides the next-turn admission, exactly like
  // a peer message that cannot steer.
  if (queue === true) return false;
  if (fromRole === 'desk' || fromRole === 'voice') return 'human';
  // Slack: a real person is waiting, so the delivery interrupts like the
  // person's own message — instant when no tool is in flight, and bounded by
  // the runner's hazard override so a background helper cannot hold it.
  if (fromRole === 'slack') return 'human';
  if (fromRole === 'channel' && personPosted === true) return 'human';
  return 'peer';
}

/** Lane policy for one delivery: person senders follow the person lane
 *  preference (an idle main lane first, steering the busy live lane when it
 *  is the only one running), everything else runs in the background lane.
 *  Exported for tests. */
export function deliveryLanePolicy(fromRole: string | undefined, personPosted?: boolean): 'person' | 'bg' {
  return fromRole === 'desk' || fromRole === 'voice' || fromRole === 'slack' || (fromRole === 'channel' && personPosted === true)
    ? 'person'
    : 'bg';
}

async function getRecipientSessionForDelivery(
  agent: Agent,
  deadline: number,
  signal?: AbortSignal,
  deferIfBusy = false,
  interruptAtBoundary: false | 'human' | 'peer' = false,
  requestedLane: AgentLane = 'main',
  /** A queued delivery (card-504beb) must never join the live turn: no
   *  native-steer admission on Claude, no steerable early exit in the wait,
   *  no boundary interrupt on agy. Only a real turn end admits it. */
  neverSteer = false,
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
    if (!neverSteer && steerAdmissible() && session.canAcceptNativeHumanSteer?.() === true) {
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
      neverSteer ? () => false : steerAdmissible,
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

/** Lane log keys for one teammate by name (null when not on the roster): the
 *  (cli, chatKey) pair for the main and background lanes. Read-only use:
 *  the channel working-state check and Stop. An account-pinned session on
 *  the same lane is a rare edge; callers match on the busy session itself. */
export function agentLaneKeys(name: string): Array<{ lane: AgentLane; cli: string; chatKey: string }> | null {
  const agent = findAgent(name);
  if (!agent) return null;
  return (['main', 'bg'] as const).map((lane) => ({ lane, ...agentLogKey(agent, lane) }));
}

/** One channel delivery in flight: an abort handle so channel Stop can
 *  cancel the worker sitting at a turn boundary, plus (once admitted) the
 *  lane and session it sent to, so later person posts from the same channel
 *  steer that exact turn and the channel view can tell channel work from a
 *  member's other work. Exported type for tests. */
export type InFlightChannelDelivery = {
  controller: AbortController;
  lane?: AgentLane;
  cli?: string;
  chatKey?: string;
  admittedAt?: number;
};

const inFlightChannelDeliveries = new Map<string, InFlightChannelDelivery[]>();
const channelDeliveryKey = (toId: string, fromId: string) => `${toId}|${fromId}`;

/** Exported for tests. */
export function registerInFlightChannelDelivery(toId: string, fromId: string): InFlightChannelDelivery {
  const entry: InFlightChannelDelivery = { controller: new AbortController() };
  const key = channelDeliveryKey(toId, fromId);
  const list = inFlightChannelDeliveries.get(key) ?? [];
  list.push(entry);
  inFlightChannelDeliveries.set(key, list);
  return entry;
}

/** Exported for tests. */
export function releaseInFlightChannelDelivery(toId: string, fromId: string, entry: InFlightChannelDelivery): void {
  const key = channelDeliveryKey(toId, fromId);
  const list = inFlightChannelDeliveries.get(key);
  if (!list) return;
  const next = list.filter((item) => item !== entry);
  if (next.length) inFlightChannelDeliveries.set(key, next);
  else inFlightChannelDeliveries.delete(key);
}

/** A channel delivery's own turn, if it is live right now: the lanes whose
 *  busy session an in-flight delivery from this channel sent to. Admitted
 *  entries whose turn has ended (busy gone false for over five seconds —
 *  never inside the spawn-to-send gap) are pruned as a side effect, so a
 *  finished conversation stops claiming follow-ups. Exported for tests. */
export function liveChannelTurnLanes(memberId: string, fromId: string, activeSessions: Array<{ cli: string; chatId: string; busy: boolean }> = []): AgentLane[] {
  const key = channelDeliveryKey(memberId, fromId);
  const list = inFlightChannelDeliveries.get(key);
  if (!list?.length) return [];
  const active = activeSessions;
  const isBusy = (entry: InFlightChannelDelivery) => !!entry.chatKey && !!entry.cli
    && active.some((session) => session.cli === entry.cli && session.chatId === entry.chatKey && session.busy === true);
  const finished = list.filter((entry) =>
    entry.admittedAt !== undefined && entry.admittedAt < Date.now() - 5000 && !isBusy(entry));
  if (finished.length) {
    const next = list.filter((entry) => !finished.includes(entry));
    if (next.length) inFlightChannelDeliveries.set(key, next);
    else inFlightChannelDeliveries.delete(key);
  }
  return [...new Set(list.filter(isBusy).map((entry) => entry.lane as AgentLane))];
}

/** Abort every in-flight delivery worker from one channel to one member.
 *  Used by channel Stop before the interrupt: a worker waiting at a turn
 *  boundary would otherwise send its already-built batch the moment the
 *  Stop's interrupt ends the busy turn. Exported for tests. */
export function abortInFlightChannelDeliveries(memberId: string, fromId: string): number {
  const list = inFlightChannelDeliveries.get(channelDeliveryKey(memberId, fromId));
  if (!list?.length) return 0;
  for (const entry of list) entry.controller.abort();
  return list.length;
}

/** Drop a member's still-queued deliveries from one channel (channel Stop):
 *  the posts stay in the channel history, but they no longer wake the
 *  member. In-flight delivery workers from this channel are aborted first —
 *  removing the store row alone leaves the worker holding its built batch,
 *  and the interrupt that follows would hand it exactly the idle session it
 *  was waiting for, re-delivering the post Stop meant to kill (review
 *  finding 1). The drain also re-checks the outbox right before its send,
 *  so the abort and the row removal close the race from both sides.
 *  Returns how many records were dropped. */
export async function dropQueuedChannelDeliveries(memberName: string, channelId: string): Promise<number> {
  const agent = findAgent(memberName);
  if (!agent) return 0;
  const fromId = `channel:${channelId}`;
  abortInFlightChannelDeliveries(agent.id, fromId);
  let dropped = 0;
  await queueStoreOperation(() => queuedDeliveryStore.modify((items) => {
    const keep = items.filter((item) => !(item.toId === agent.id && item.fromId === fromId));
    dropped = items.length - keep.length;
    return keep;
  }));
  return dropped;
}

/** Fire-and-forget delivery into an agent's home thread (routines path). */
export async function sendToAgentHome(
  agent: Agent,
  text: string,
  /** `lane` defaults to the background lane; a job or watch started from the
   *  home lane reports back there. `neverSteer` (wakes, card-c26bfa): the
   *  delivery must never join a live turn — it waits for a real turn end and
   *  then starts its own, the same admission the queued deliveries use. */
  opts: { peerFrom: string; peerFromRole?: string; peerText?: string; lane?: AgentLane; quietExempt?: boolean; neverSteer?: boolean },
): Promise<{ delivered: boolean; reason?: string }> {
  // Quiet hours (Matt, Oct 15 2026): automation prompts to a non-Max lane
  // hold until 05:00 ET. Every caller parks its record and retries on a
  // refusal, so this is a hold, never a loss. Exempt: Matt's own messages
  // (Desk and voice roles), Max's lanes, and an explicit quietExempt — a
  // manual routine press or Max's emergency routine by id, both of which
  // are an explicit ask for this run now (Opus review, Oct 16).
  const isExemptWake = opts.quietExempt === true || personSourced({ fromRole: opts.peerFromRole });
  const quietHold = !isExemptWake && !isQuietExemptLane(agent.id);
  const heldByQuietHours = (): { delivered: boolean; reason?: string } | null =>
    quietHold && inQuietHours(Date.now())
      ? { delivered: false, reason: 'quiet hours (22:00-05:00 ET): held until 05:00' }
      : null;
  const entryHold = heldByQuietHours();
  if (entryHold) return entryHold;
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
      // A wake never steers (card-c26bfa): only a real turn end admits it,
      // so the result starts its own turn instead of landing as guidance in
      // the live one or racing a Codex steer against the turn end.
      opts.neverSteer === true,
    );
    session = admission.session;
    model = admission.model;
    effort = admission.effort;
    nativeSteer = admission.nativeSteer;
  } catch (e) {
    return { delivered: false, reason: `engine unavailable: ${(e as Error).message}` };
  }
  // Re-check after the admission wait: it can run up to 30 minutes, so a
  // call admitted before 22:00 can land inside the window. A refusal here
  // parks and retries exactly like the entry one (Opus review, Oct 16).
  const admissionHold = heldByQuietHours();
  if (admissionHold) return admissionHold;
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
    await sendWithAdmission(session, deliveryId, () => session.send(text, undefined, {
      peerFrom: opts.peerFrom,
      peerFromRole: opts.peerFromRole,
      peerText: opts.peerText,
      peerDeliveryId: deliveryId,
      allowNativePeerSteer: nativeSteer,
      model,
      effort,
    }));
  } catch (e) {
    return { delivered: false, reason: `delivery failed: ${(e as Error).message}` };
  } finally {
    unsubscribe?.();
  }
  if (echoed && providerAccepted && isExemptWake) {
    recordQuietExemptWake(agent.id, Date.now());
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
  /** The durable record's id, on the fire-and-forget receipt: a producer
   *  that needs to learn the record's actual admission (not its durable
   *  receipt) keys its own state by this id (card-b3468c verify P1: the
   *  flag-digest admission ack). */
  deliveryId?: string;
  /** The durable queue accepted the record but quiet hours (22:00-05:00 ET)
   *  hold its delivery to a non-Max lane until 05:00. Callers that mark or
   *  receipt on landing must not treat this as "it went to them" (Opus
   *  verify, Oct 16). */
  held?: 'quiet-hours';
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
  /** True when a joined batch carries messages from several senders, so the
   *  closing reply instruction must not name only the lead's sender. */
  mixedSenders?: boolean;
  /** Per-record batch members (lead first) for the brief envelope: each
   *  coder brief in the batch gets its own envelope instead of inheriting
   *  the lead's. Absent on a direct (non-batched) delivery. */
  batchRecords?: Array<{ fromId: string; fromName: string; fromRole?: string; hop: number; text: string }>;
  /** The person authored this channel post: person-class admission. */
  personPosted?: boolean;
  /** The person chose to queue this post for the member's NEXT turn
   *  (card-504beb) instead of steering the live one: person class and lane
   *  preference are kept, but the delivery never interrupts — it waits for
   *  the current turn to end, exactly like a peer message. */
  queue?: boolean;
  /** Person-sourced provenance for quiet-hours exemptions and wake tracking. */
  personSourced?: boolean;
  /** Final gate before the prompt is sent: resolves false when the record
   *  was dropped from the outbox while its worker waited at a turn boundary
   *  (channel Stop), so a dropped post can never ride the turn the Stop's
   *  interrupt just made room for. */
  stillWanted?: () => Promise<boolean>;
  /** Quiet hours (Matt, Oct 15 2026): optional predicate marking this
   *  delivery as ordinary automation chatter to a non-Max lane. It is
   *  re-evaluated AFTER admission, which can wait up to 30 minutes, so a
   *  batch built before 22:00 cannot slip past the boundary while it waits
   *  for a busy turn to end (Opus verify, Oct 16). */
  quietHoldCheck?: () => boolean;
  /** card-b3468c: an automation nudge's live-turn hold origin (epoch ms).
   *  Under the liveness ceiling the admission never steers the
   *  recipient's live turn — only a real turn end admits — so a lane that
   *  went busy after the producer's snapshot still never sees the nudge
   *  mid-turn. Past the ceiling normal admission delivers it anyway. */
  nudgeHoldSince?: number;
  onAdmitted?: (session: SessionLike) => Promise<void>;
};


async function runTeamDelivery(delivery: TeamDelivery): Promise<TeamMessageResult> {
  // Channel deliveries register in flight so Stop can abort a worker
  // waiting at a turn boundary and later person posts from the same channel
  // can find the turn they should steer. A fire-and-forget delivery returns
  // at its ack while its turn keeps running, so its entry deliberately
  // outlives this call and is pruned once the turn ends.
  if (delivery.from.role !== 'channel') return runTeamDeliveryInner(delivery, null);
  const entry = registerInFlightChannelDelivery(delivery.to.id, delivery.from.id);
  let result: TeamMessageResult;
  try {
    result = await runTeamDeliveryInner(delivery, entry);
  } catch (error) {
    releaseInFlightChannelDelivery(delivery.to.id, delivery.from.id, entry);
    throw error;
  }
  if (!(result.delivered && !delivery.waitForReply)) {
    releaseInFlightChannelDelivery(delivery.to.id, delivery.from.id, entry);
  }
  return result;
}

async function liveChannelTurnLanesForMember(agent: Agent, fromId: string): Promise<AgentLane[]> {
  const runner = await getRunner();
  return liveChannelTurnLanes(agent.id, fromId, runner.activeChatSessions());
}

/** Lanes with a live turn one channel's delivery started, by member name.
 *  Read-only use: the channel working-state feed and Stop scoping. */
export async function liveChannelTurnLanesByName(memberName: string, channelId: string): Promise<AgentLane[]> {
  const agent = findAgent(memberName);
  if (!agent) return [];
  return liveChannelTurnLanesForMember(agent, `channel:${channelId}`);
}

async function runTeamDeliveryInner(delivery: TeamDelivery, channelInFlight: InFlightChannelDelivery | null): Promise<TeamMessageResult> {
  const { from, to, text, hop, chain, waitForReply, onAdmitted, deferIfBusy = false } = delivery;
  const deliveryId = delivery.deliveryId ?? randomUUID();
  // card-b3468c: an under-ceiling nudge never steers a live turn. The
  // admission below takes the card-504beb never-steer policy (only a real
  // turn end admits) and no boundary interrupt, so a lane that went busy
  // after the producer's liveness snapshot still never sees the nudge
  // mid-turn. Past the ceiling the flag clears and a normal admission (a
  // steer) delivers it anyway: holding never means losing.
  const nudgeHold = nudgeHoldActive(delivery);
  // (Sam check note, Oct 18) A nudge hold's wait never runs past its own
  // ceiling: the deadline is capped at the hold origin + LIVE_HOLD_CEILING_MS,
  // so a hold that starts near the ceiling re-runs at the boundary and
  // force-delivers there instead of up to 30 minutes late.
  const deadline = nudgeHold && typeof delivery.nudgeHoldSince === 'number'
    ? Math.min(Date.now() + RECIPIENT_IDLE_WAIT_MS, delivery.nudgeHoldSince + LIVE_HOLD_CEILING_MS)
    : Date.now() + RECIPIENT_IDLE_WAIT_MS;
  // A channel Stop aborts the in-flight entry; a synchronous caller's own
  // stop signal is honoured alongside it.
  const signals = [delivery.signal, channelInFlight?.controller.signal].filter((s): s is AbortSignal => !!s);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  let waited = false;
  let providerRefusals = 0;
  const replyInstruction = from.role === 'voice'
    ? '(This is the user continuing your own voice conversation. Reply in this thread. Do not team_message Voice. Ending the audio call does not cancel this work. External side effects remain draft/review-first. The call already has a spoken line. Do not write a second, different Hall answer unless the caller needs a result, blocker, or question they cannot hear.)'
    : from.role === 'desk'
    ? `(${from.name} is the human owner, not a teammate, and reads the answer on the Desk card. Reply there with board_card_comment. Do not team_message ${from.name}.)`
    : from.role === 'slack'
    ? '(This is a Slack message from a real person. Reply in that Slack thread with the say command the message names. Do not team_message the Slack relay.)'
    : from.role === 'channel'
    ? '(This ping is a group-channel post. Reply in that channel with the channel_post tool exactly as the ping\'s rules describe, passing the hop number through unchanged. Do not team_message the channel and never move this into a one-on-one thread.)'
    : waitForReply
    ? `(Your final inline answer is returned automatically to ${from.name}; no second team_message call is needed. Anything separately meant for ${DESK_OWNER_NAME} goes in reply_now with audience: "owner", never in this teammate answer.)`
    : delivery.mixedSenders
    ? `(Reply to each teammate who needs a result with team_message(to: "<that sender>", text: ..., wait: false). Inline replies fold under the teammate who started this turn and are not delivered automatically. A teammate arriving during another turn does not change that turn's audience. Anything meant for ${DESK_OWNER_NAME} goes in reply_now with audience: "owner". Finish with NO_UPDATE when there is nothing else for ${DESK_OWNER_NAME}. Busy teammates are queued automatically.)`
    : `(Reply to ${from.name} with team_message(to: "${from.name}", text: ..., wait: false) if they need the result. Inline replies fold under the teammate who started this turn and are not delivered automatically. A teammate arriving during another turn does not change that turn's audience. Anything meant for ${DESK_OWNER_NAME} goes in reply_now with audience: "owner". Finish with NO_UPDATE when there is nothing else for ${DESK_OWNER_NAME}. Busy teammates are queued automatically.)`;
  // Brief envelope (card-e9b846): a lead's handoff to a coder arrives as one
  // goal sentence plus its card link, built here so no sender can skip it.
  // The durable record keeps the lead's raw text; only this turn's prompt
  // carries the envelope, with the raw brief below as detail. Fail-open.
  // A busy recipient lane counts as may-steer here: distillation is skipped
  // there (an already-written goal sentence still rides), so the envelope
  // never stalls an attempt to join a live turn.
  let recipientBusy = false;
  try {
    const runner = await getRunner();
    recipientBusy = runner.activeChatSessions().some((s) => s.busy && bareChatId(s.chatId) === to.home);
  } catch { /* a busy-check hiccup never blocks delivery */ }
  let promptText = text;
  try {
    if (delivery.batchRecords?.length) {
      // Per-record envelopes: every coder brief in the batch gets its own
      // goal + card, and unrelated records stay plain blocks. The outer
      // header below is the lead record's own header, so the lead member is
      // rendered as its envelope text (or raw text) without a second header.
      const blocks: string[] = [];
      for (let i = 0; i < delivery.batchRecords.length; i++) {
        const member = delivery.batchRecords[i];
        const memberEnvelope = await briefEnvelopeForHandoff({
          senderId: member.fromId,
          recipientId: to.id,
          recipientName: to.name,
          text: member.text,
          wait: false,
          maySteer: recipientBusy,
        });
        const memberText = memberEnvelope ?? member.text;
        if (i === 0) blocks.push(memberText);
        else {
          const header = member.fromRole === 'desk'
            ? `[comment from ${member.fromName} on the Desk]`
            : member.fromRole === 'voice'
            ? '[continuation of the user’s voice request in your own thread]'
            : member.fromRole === 'channel'
            ? `[group-channel post in ${member.fromName} — handoff ${member.hop}]`
            : `[message from teammate ${member.fromName}${member.fromRole ? ` (${member.fromRole})` : ''} — handoff ${member.hop}]`;
          blocks.push(`${header}\n${memberText}`);
        }
      }
      promptText = blocks.join('\n\n');
    } else {
      const envelope = await briefEnvelopeForHandoff({
        senderId: from.id,
        recipientId: to.id,
        recipientName: to.name,
        text,
        wait: waitForReply === true,
        maySteer: recipientBusy,
      });
      if (envelope) promptText = envelope;
    }
  } catch (err) {
    console.warn('[brief] envelope failed open:', (err as Error).message);
  }
  const prompt = [
    from.role === 'voice' ? '[continuation of the user’s voice request in your own thread]'
      : from.role === 'desk' ? `[comment from ${from.name} on the Desk]`
      : from.role === 'slack' ? '[Slack message from a real person — reply in that Slack thread]'
      : `[message from teammate ${from.name}${from.role ? ` (${from.role})` : ''} — handoff ${hop}]`,
    promptText,
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
      // The person's own voice continues in their lane; the person's channel
      // posts steer a live turn like a one-on-one message; every other
      // sender (teammates, the Desk, TARDIS notices, robots) runs in the
      // background. A channel delivery whose member has a live turn from
      // this same channel steers that exact turn (its lane), so follow-ups
      // join the conversation instead of spawning a parallel turn — this
      // applies even to a post without an @, because the turn being steered
      // is already this channel's own (review 3, P1 3). Person posts reach
      // the person lane preference only when there is no channel turn to
      // steer, so a room post to an unmentioned member never takes over
      // their main lane or interrupts unrelated work.
      const liveChannelLanes = from.role === 'channel' ? await liveChannelTurnLanesForMember(to, from.id) : [];
      const personClass = delivery.personPosted === true || liveChannelLanes.length > 0;
      const wantsPersonLane = personClass || deliveryLanePolicy(from.role, delivery.personPosted) === 'person';
      // (review 3 P0 2) The queued admission's wait is abortable: a newer
      // non-queued record for this recipient aborts it so the drain re-runs
      // with that record leading. The abort covers the wait only - once the
      // send starts, the original signal governs alone.
      let admissionSignal = signal;
      let queuedWaitKey: string | null = null;
      // card-b3468c: an under-ceiling nudge's never-steer admission is a
      // queued-class wait too — a newer leading record (person-sourced or
      // priority) must be able to abort it, exactly like a queue:true lead.
      // The stored nudge flag additionally lets any ordinary (non-nudge)
      // record abort the wait (Sam check FAIL fix, Oct 18): the nudge would
      // have steered before this hold existed, so no teammate message may
      // sit behind its wait.
      if (delivery.queue === true || nudgeHold) {
        queuedWaitKey = queueKeyOf({ toId: to.id });
        const waitAbort = new AbortController();
        queuedLeadAborters.set(queuedWaitKey, { controller: waitAbort, nudge: nudgeHold });
        if (signal) {
          const combined = new AbortController();
          const forward = () => combined.abort();
          signal.addEventListener('abort', forward, { once: true });
          waitAbort.signal.addEventListener('abort', forward, { once: true });
          admissionSignal = combined.signal;
        } else {
          admissionSignal = waitAbort.signal;
        }
      }
      let admission;
      try {
        admission = await getRecipientSessionForDelivery(
          to, deadline, admissionSignal, deferIfBusy,
          deliveryInterruptClass(from.role, personClass, delivery.queue === true || nudgeHold),
          wantsPersonLane ? (liveChannelLanes[0] ?? await personLanePreference(to)) : 'bg',
          delivery.queue === true || nudgeHold,
        );
      } finally {
        if (queuedWaitKey) queuedLeadAborters.delete(queuedWaitKey);
      }
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
      && (admittedQueuedDeliveries.has(deliveryId) || await hasDurablePeerDeliveryReceipt(session.logKey, deliveryId))
    ) {
      await onAdmitted?.(session);
      admittedQueuedDeliveries.delete(deliveryId);
      // This delivery already rode a previous turn; nothing of this channel
      // is running on the session we just resolved, so the entry must not
      // claim it (review 3, P2 8).
      if (channelInFlight) releaseInFlightChannelDelivery(to.id, from.id, channelInFlight);
      return { delivered: true, to: to.name, hop, queued: true, reason: 'delivery was already accepted before retry' };
    }
    // Quiet hours (Opus verify, Oct 16): the admission wait above can run 30
    // minutes, so a delivery that passed the entry clock can be inside the
    // window by the time it is about to send. Hold it exactly like an entry
    // refusal: the caller parks its record and the 05:00 retry delivers it
    // unchanged.
    if (delivery.quietHoldCheck?.()) {
      return { delivered: false, to: to.name, hop, held: 'quiet-hours', reason: 'quiet hours (22:00-05:00 ET): held until 05:00' };
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
          // THIS channel's turn ended: the in-flight entry must go with it,
          // or a later post from the channel would steer whatever unrelated
          // turn admits next on that lane (review 3, P0 2).
          if (channelInFlight) {
            releaseInFlightChannelDelivery(to.id, from.id, channelInFlight);
            if (!waitForReply) unsubscribe?.();
          }
        } else if (event.ev?.type === 'closed' && admittedSeq !== null) {
          finishWait({ kind: 'closed' });
          if (channelInFlight) {
            releaseInFlightChannelDelivery(to.id, from.id, channelInFlight);
            if (!waitForReply) unsubscribe?.();
          }
        }
      }, session.latestSeq(), false);
    } catch (error) {
      return { delivered: false, to: to.name, hop, queued: waited || undefined, reason: `delivery listener failed: ${(error as Error).message}` };
    }

    try {
      // Channel Stop can land between admission and the send. Re-check the
      // outbox right before the prompt goes out: a record dropped by Stop
      // must not ride the turn its interrupt just made room for (review 1).
      if (delivery.stillWanted && !(await delivery.stillWanted())) {
        unsubscribe?.();
        return { delivered: false, to: to.name, hop, queued: waited || undefined, reason: 'dropped while waiting for a turn boundary' };
      }
      await sendWithAdmission(session, deliveryId, () => session.send(prompt, undefined, {
        peerFrom: from.name,
        peerFromRole: from.role,
        // The control envelope belongs to the model, not the visible feed.
        peerText: text,
        peerDeliveryId: deliveryId,
        allowNativePeerSteer: nativeSteer,
        model,
        effort,
        signal,
      }));
    } catch (error) {
      unsubscribe?.();
      if ((error as Error & { terminalDelivery?: boolean }).terminalDelivery) {
        await retainFailedQueuedDelivery(session, deliveryId, (error as Error).message);
      }
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

    if (personSourced({ fromRole: from.role, personPosted: delivery.personPosted, personSourced: delivery.personSourced })) {
      recordQuietExemptWake(to.id, Date.now());
    }
    // The turn now provably carries this delivery (its peer echo was seen
    // and the provider accepted the prompt), so the in-flight entry may
    // claim exactly this turn: lane, cli and chat id identify it until the
    // turn ends. Recording these earlier would let the entry claim a turn
    // another sender won (review 3, P0 2).
    if (channelInFlight) {
      channelInFlight.lane = lane;
      channelInFlight.cli = agentLogKey(to, lane).cli;
      channelInFlight.chatKey = session.chatId ?? (lane === 'bg' ? backgroundChatId(to.home) : to.home);
      channelInFlight.admittedAt = Date.now();
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
      // The turn keeps running after the ack, so the listener above stays
      // alive purely to release the in-flight entry at this turn's end;
      // non-channel deliveries have no entry and simply unsubscribe.
      if (!channelInFlight) unsubscribe?.();
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

/** Preserve every frozen batch member before closing an ambiguous delivery.
 * A missing receipt is neither success nor permission to repeat a native write. */
async function retainFailedQueuedDelivery(session: SessionLike, deliveryId: string, reason: string): Promise<void> {
  const members = (await queueStoreOperation(() => queuedDeliveryStore.list()))
    .filter(item => item.id === deliveryId || item.batchLeadId === deliveryId);
  for (const member of members) {
    await appendEventLogDurable(session.logKey, {
      seq: reserveEventLogSeq(session.logKey),
      ev: { type: 'event', event: { type: 'peer_delivery_failed', deliveryId: member.id,
        from: member.fromName, text: member.text, message: reason, ts: Date.now() } } as PersistedEvent['ev'],
    });
  }
  await appendEventLogDurable(session.logKey, {
    seq: reserveEventLogSeq(session.logKey), ev: { type: 'error', message: reason },
  });
  recordNativeFailure(session.chatId ?? session.logKey, 'native', `${reason} Delivery: ${deliveryId}`);
  const ids = new Set(members.map(member => member.id));
  await queueStoreOperation(() => queuedDeliveryStore.modify(items => items.filter(item => !ids.has(item.id))));
}

async function acknowledgeQueuedDelivery(record: QueuedTeamDelivery, session: SessionLike): Promise<void> {
  // Persist and verify the provider-accepted receipt before deleting the outbox
  // row. A swallowed event-log write can never lose the message.
  await flushEventLog(session.logKey);
  if (!await hasDurablePeerDeliveryReceipt(session.logKey, record.id)) {
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
    : record.fromRole === 'channel'
    ? `[group-channel post in ${record.fromName} \u2014 handoff ${record.hop}]`
    : `[message from teammate ${record.fromName}${record.fromRole ? ` (${record.fromRole})` : ''} \u2014 handoff ${record.hop}]`;
  return `${header}\n${record.text}`;
}

type BatchMember = { fromId: string; fromName: string; fromRole?: string; hop: number; text: string };

function batchRecordForEnvelope(record: QueuedTeamDelivery): BatchMember {
  return {
    fromId: record.fromId,
    fromName: record.fromName,
    fromRole: record.fromRole,
    hop: record.hop,
    text: record.text,
  };
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
 *  continue the call, automation stays automation, channel posts keep their
 *  channel reply rules, teammates reply inline). */
function batchRoleClass(record: { fromRole?: string }): 'desk' | 'voice' | 'automation' | 'channel' | 'slack' | 'teammate' {
  if (record.fromRole === 'desk') return 'desk';
  if (record.fromRole === 'voice') return 'voice';
  if (record.fromRole === 'automation') return 'automation';
  if (record.fromRole === 'channel') return 'channel';
  // Slack carries its own reply instruction and person-class admission: it
  // must never ride a teammate-led batch, which would deliver it peer-class
  // and lose the idle-lane and human-interrupt behavior (review 2026-10-20).
  if (record.fromRole === 'slack') return 'slack';
  return 'teammate';
}

/** Whether a queued record can ride the lead's admitted turn. Same sender
 *  class (the admitted turn's reply instruction is built from the lead's
 *  role); channel posts additionally need the same channel, because every
 *  channel record carries reply rules tied to its own channel and hop;
 *  tier and batch caps (count, characters) are applied by the caller.
 *  Collaboration chains no longer gate the join: the lead's chain is the
 *  only one the turn activates (one active chain slot per lane), so a
 *  sibling's chain is not activated. Queued records never carry blocking
 *  waiters (the drain always delivers with waitForReply false; a wait:true
 *  caller to a busy FIFO gets back a delivered+queued result and its reply
 *  edge is released), so a sibling loses only continuity metadata its sender
 *  can read from the thread. Chain-identity joins left every differently
 *  chained handoff a singleton batch: Tim's queue held 11 records, one
 *  admitted per idle break. */
/** Exported for tests. */
export function batchJoinable(lead: QueuedTeamDelivery, record: QueuedTeamDelivery): boolean {
  // A task start is a batch boundary (see batchJoinableFresh): marked and
  // unmarked records never share a turn, and marked records share one only
  // with the same sender.
  if (!batchJoinableFresh(lead, record)) return false;
  if (batchRoleClass(lead) !== batchRoleClass(record)) return false;
  // card-b3468c: an under-ceiling nudge batches only with other
  // under-ceiling nudges. Its admission waits for a real turn end, so a
  // record that could steer a live turn (or be steered by one) must never
  // ride that batch — nor may a nudge ride a steering lead. Past the
  // ceiling the flag clears and the record batches normally again.
  if (nudgeHoldActive(lead) !== nudgeHoldActive(record)) return false;
  if (batchRoleClass(lead) === 'channel') {
    // Same channel, and the same person-hood: a person post (human interrupt
    // class, steering lane policy, or person-sourced quiet-hours wake) must
    // never share a batch with an agent reply from the same channel, or the
    // lead's class would decide for both (review finding 5).
    return lead.fromId === record.fromId
      && (lead.personPosted === true) === (record.personPosted === true)
      && (lead.queue === true) === (record.queue === true)
      && (lead.personSourced === true) === (record.personSourced === true);
  }
  // A coder brief (card-e9b846) is a delivery contract, not just text: its
  // goal sentence must be the first thing the coder reads, and one named
  // sender is waiting on the result. A mixed-sender batch decides the
  // framing and the reply instruction from the lead, so a brief never rides
  // with — or leads over — another sender's record; briefs from the same
  // sender still batch (review P1, Oct 20).
  if (isCoderBrief(lead.fromId, lead.toId) || isCoderBrief(record.fromId, record.toId)) {
    return lead.fromId === record.fromId;
  }
  return true;
}

/** (review P1, Oct 20) Split a frozen batch's stamped members against the
 *  current join rules. A stamp written by an earlier build predates later
 *  guards (the coder-brief same-sender rule), so reusing it verbatim would
 *  let a mixed-sender batch ride and defeat the guard. Members that no
 *  longer join are returned for un-stamping so they stay queued and take
 *  their own admission. Exported for tests. */
export function frozenBatchMembers(
  lead: QueuedTeamDelivery,
  stamped: QueuedTeamDelivery[],
): { ride: QueuedTeamDelivery[]; drop: QueuedTeamDelivery[] } {
  const ride: QueuedTeamDelivery[] = [];
  const drop: QueuedTeamDelivery[] = [];
  for (const member of stamped) (batchJoinable(lead, member) ? ride : drop).push(member);
  return { ride, drop };
}

/** Ack a joined batch: the lead record's durable receipt proves the whole
 *  joined prompt was accepted (one send, one peer echo), so persist a
 *  per-record receipt for every stamped member before deleting them; a
 *  restart mid-ack must never redeliver the tail of a batch. Membership
 *  comes from the persisted batch stamps, not the caller's in-memory list:
 *  an ack retried after a restart must cover exactly the records that rode
 *  the admitted turn, never a batch rebuilt around records that queued
 *  later and were never seen. Members are marked acked before their
 *  receipts and rows go (and the lead's row goes last), so every partial
 *  failure leaves the queue in a state the next pass resolves by dropping
 *  rows, never by resending a message the recipient already saw. */
async function acknowledgeQueuedBatch(lead: QueuedTeamDelivery, session: SessionLike): Promise<void> {
  await flushEventLog(session.logKey);
  if (!await hasDurablePeerDeliveryReceipt(session.logKey, lead.id)) {
    throw new Error('accepted delivery receipt did not reach the event log');
  }
  const members = [lead, ...(await queueStoreOperation(() => queuedDeliveryStore.list()))
    .filter((item) => item.batchLeadId === lead.id && queueKeyOf(item) === queueKeyOf(lead))];
  const memberIds = new Set(members.map((member) => member.id));
  await queueStoreOperation(() => queuedDeliveryStore.modify((items) => items.map((item) =>
    (memberIds.has(item.id) && item.id !== lead.id && item.acked !== true
      ? { ...item, acked: true }
      : item))));
  for (const member of members) {
    if (member.id === lead.id) continue;
    if (await hasDurablePeerDeliveryReceipt(session.logKey, member.id)) continue;
    await appendEventLogDurable(session.logKey, {
      seq: reserveEventLogSeq(session.logKey),
      ev: { type: 'event', event: { type: 'peer_delivery_accepted', deliveryId: member.id } } as PersistedEvent['ev'],
    });
  }
  for (const member of [...members.slice(1), lead]) {
    await queueStoreOperation(() => queuedDeliveryStore.delete(member.id));
  }
}

/** (card-b3468c verify P1) A queued flag-digest record asks its source to
 *  learn the ADMISSION, not the durable receipt: run the flag-digest
 *  admission ack for every batch member that carries the marker, so the
 *  digest's per-entry callbacks (the commitment marks) fire only when the
 *  recipient actually saw the line. Lazy import: teamBus and flagDigest
 *  share the delivery graph. */
async function fireDigestAdmissionAcks(toId: string, members: QueuedTeamDelivery[]): Promise<void> {
  const acks = members.filter((member) => member.admissionAck === 'flag-digest');
  if (!acks.length) return;
  try {
    const { admittedDeliveryAck } = await import('../lib/flagDigest.ts');
    for (const member of acks) {
      try {
        admittedDeliveryAck(toId, member.id);
      } catch (error) {
        console.warn(`[flag-digest] admission ack for record ${member.id} of ${toId} failed: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    console.warn(`[flag-digest] admission ack import failed: ${(error as Error).message}`);
  }
}

function retryDelay(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ASYNC_RETRY_MS);
    timer.unref?.();
  });
}

async function drainQueuedRecipient(queueKey: string): Promise<void> {
  // Quiet hours (Matt, Oct 15 2026): teammate chatter to a non-Max lane
  // holds through 22:00-05:00 ET. Person-sourced records (Desk answers,
  // voice continuations, human channel posts) still deliver — the boss may
  // always speak. Held records stay queued untouched and the retry timer
  // targets the next 05:00 ET, so the first drain after the window delivers
  // them unchanged. Read the clock once per pass so a drain that starts
  // before 22:00 and keeps admitting (the admission wait can run 30 minutes)
  // re-checks the boundary on each pass without calling Intl.DateTimeFormat
  // per queued record (Opus review 3, Oct 16).
  const isNonMax = !isQuietExemptLane(queueKey);
  const holdInitial = isNonMax && inQuietHours(Date.now());
  // Snapshot this worker's batch. Handoffs accepted while it runs are scheduled
  // as the next batch, behind any synchronous delivery already waiting on the
  // same recipient tail.
  const batch = (await queueStoreOperation(() => queuedDeliveryStore.list()))
    .filter((item) => queueKeyOf(item) === queueKey && (!holdInitial || personSourced(item)))
    // Person-sourced records (Desk answers, voice continuations) and
    // priority-flagged messages jump teammate chatter; within each group
    // oldest first, so a joined delivery reads newest-last.
    .sort((a, b) => (Number(sortsAhead(b)) - Number(sortsAhead(a)))
      || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

  // A quiet-hours park (runTeamDelivery held result) stops the whole drain:
  // person-sourced records sorted ahead of the parked batch, so everything
  // left is same-tier chatter, and the finally in scheduleQueuedRecipient
  // reschedules the queue at the 05:00 ET window end.
  let quietParked = false;
  for (const record of batch) {
    if (quietParked) break;
    while (true) {
      const stillQueued = await queueStoreOperation(async () =>
        (await queuedDeliveryStore.list()).some((item) => item.id === record.id));
      if (!stillQueued) break;

      const to = findAgent(record.toId);
      if (!to) {
        console.warn(`[team] queued delivery ${record.id} is waiting for missing teammate ${record.toId}`);
        // (card-b3468c review P1, Oct 18) A flag-digest record for a
        // teammate no longer on the roster can never admit, and its source
        // entry would wait on the record forever. Drop it: the digest's
        // next flush sees the record gone from the queue and re-queues the
        // line, which fails cleanly at recipient resolution while the
        // teammate stays missing (no record is created) and delivers fresh
        // if they return. Teammate chatter keeps waiting: a person may
        // re-add the teammate and those messages still matter.
        if (record.admissionAck === 'flag-digest') {
          await queueStoreOperation(() => queuedDeliveryStore.delete(record.id));
          break;
        }
        await retryDelay();
        continue;
      }
      // One admission for the whole still-queued batch, bounded and
      // routing-compatible. A boundary per message is what backed deliveries
      // up for an hour on busy lanes (34 queued for one Kimi K3 recipient,
      // one message per 10-25 s step), so every still-queued message for this
      // recipient rides the same admitted turn: person messages first
      // (Matt's Desk answers never sit behind teammate chatter), oldest first
      // within each group. Same sender class joins (see batchJoinable —
      // chains no longer gate it), and the join is capped by count and
      // characters so an admitted turn never grows past admission limits.
      // Whatever does not fit stays queued and the next admission takes it.
      const holdNow = isNonMax && inQuietHours(Date.now());
      let candidates = (await queueStoreOperation(() => queuedDeliveryStore.list()))
        .filter((item) => queueKeyOf(item) === queueKey && (!holdNow || personSourced(item)))
        .sort((a, b) => (Number(sortsAhead(b)) - Number(sortsAhead(a)))
          || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
      // Rows marked acked rode a batch the recipient already saw, but their
      // delete did not survive the ack. Drop them here rather than letting
      // them ride, or lead, a fresh batch: resending one would duplicate a
      // delivered message.
      const seenRows = candidates.filter((item) => item.acked === true);
      for (const row of seenRows) {
        await queueStoreOperation(() => queuedDeliveryStore.delete(row.id));
      }
      if (seenRows.length > 0) candidates = candidates.filter((item) => item.acked !== true);
      if (candidates.length === 0) break;
      // (card-504beb, verify P1 3 + review 3 P1 7) A queued record never
      // leads over a non-queued one in its OWN tier: it would wait out the
      // live turn for up to 30 minutes with no interrupt, blocking the
      // recipient's records behind it. Ordinary teammate chatter never
      // jumps ahead of the person's queued post either: the pick stays
      // inside the first record's tier, so person-first delivery holds.
      const firstTier = sortsAhead(candidates[0]);
      // An under-ceiling nudge (card-b3468c) never leads over a non-nudge in
      // its own tier either: its never-steer admission waits out a live turn
      // with no interrupt, which would block the recipient's records behind it.
      const lead = candidates.find((item) => item.queue !== true && !nudgeHoldActive(item) && sortsAhead(item) === firstTier) ?? candidates[0];
      let siblings: QueuedTeamDelivery[];
      if (lead.batchLeadId === lead.id) {
        // Frozen batch from a send attempt that already ran (the lead's
        // self-stamp persists). Reuse the stamped members instead of
        // rebuilding: if that attempt actually admitted, this pass is only
        // retrying the ack, and a rebuilt batch would fold in records that
        // queued later and were never seen. The lead is self-stamped, so it
        // also matches the filter and is excluded to keep it out twice.
        //
        // (review P1, Oct 20) A stamp written by an earlier build predates
        // the coder-brief join rule, so a mixed-sender frozen batch would
        // otherwise ride verbatim and defeat the guard. Every stamped member
        // is re-checked against batchJoinable; one that no longer joins is
        // un-stamped so it stays queued and takes its own admission.
        // Un-stamping is safe in both retry cases: an admitted batch already
        // delivered that member's text (this retry re-sends the rest anyway),
        // and a batch that never went simply delivers it separately. Left
        // stamped, the ack would delete a record that never rode the resend.
        const { ride, drop } = frozenBatchMembers(lead, candidates.filter((item) => item.id !== lead.id && item.batchLeadId === lead.id));
        if (drop.length > 0) {
          const droppedIds = new Set(drop.map((item) => item.id));
          await queueStoreOperation(() => queuedDeliveryStore.modify((items) => items.map((item) => {
            if (!droppedIds.has(item.id)) return item;
            const { batchLeadId: _stamp, ...rest } = item;
            return rest;
          })));
        }
        siblings = [lead, ...ride];
      } else {
        siblings = [lead];
        let batchChars = lead.text.length;
        for (const candidate of candidates.filter((item) => item.id !== lead.id)) {
          if (siblings.length >= MAX_BATCH_DELIVERIES) break;
          // Siblings must share the lead's sortsAhead tier. A priority-flagged
          // teammate lead that joined ordinary chatter would strand a queued
          // Desk answer or voice continuation behind that whole admitted batch,
          // breaking person-first delivery; same tier plus batchJoinable's
          // same-class rule keeps every person-sourced and priority record
          // ahead of ordinary chatter.
          if (sortsAhead(candidate) !== sortsAhead(lead)) continue;
          if (!batchJoinable(lead, candidate)) continue;
          const block = batchDeliveryBlock(candidate);
          if (batchChars + block.length > MAX_BATCH_TEXT_CHARS) continue;
          siblings.push(candidate);
          batchChars += block.length;
        }
        // Stamp the whole batch in one store write before it is sent: the
        // lead self-stamps (freezing the membership across retries) and
        // each sibling carries the lead's id, so an ack, or its retry
        // after a restart, can always reconstruct exactly which records
        // rode the admitted turn.
        await queueStoreOperation(() => queuedDeliveryStore.modify((items) => items.map((item) =>
          (siblings.some((sibling) => sibling.id === item.id) && item.batchLeadId !== lead.id
            ? { ...item, batchLeadId: lead.id }
            : item))));
      }
      // (card-b3468c verify P0) The batch's live-turn hold is the LATEST
      // origin across the lead AND its siblings, recomputed at every drain
      // attempt: a frozen batch whose lead aged past its ceiling while a
      // newer sibling is still under-ceiling must keep waiting for a real
      // turn end — an admission governed by the lead's origin alone would
      // steer that sibling's live turn on the retry.
      let batchHoldSince = lead.nudgeHoldSince;
      for (const sibling of siblings) {
        if (typeof sibling.nudgeHoldSince === 'number' && sibling.nudgeHoldSince > (batchHoldSince ?? 0)) {
          batchHoldSince = sibling.nudgeHoldSince;
        }
      }
      const from = findAgent(lead.fromId) ?? {
        id: lead.fromId,
        name: lead.fromName,
        role: lead.fromRole ?? '',
        engine: '',
        home: '',
        createdAt: 0,
      };
      // Fresh thread on task (Matt, Oct 22 2026): a flagged recipient's next
      // new task lands in a clean thread. The trigger is deliberately narrow:
      // the recipient is flagged, the lead record is a direct non-person
      // handoff (no Desk/voice/Slack/channel fan-out, no nudge hold), and the
      // batch's durable task id is still owed its reset (per-task state, so
      // an interrupted wipe resumes after restart and one task's completion
      // never suppresses another's). The wipe itself waits for an idle
      // boundary and re-checks idle under the barrier, so a busy recipient
      // is never killed for a queued task: admission below simply joins the
      // live turn as today. Person-sourced records never trigger it: they
      // steer the thread the person is talking in. A wipe that fails before
      // anything destructive ran delivers into the intact old thread; one
      // that fails after the reset began holds the durable records for
      // retry instead.
      const batchIsPersonSourced = siblings.some((sibling) => personSourced(sibling));
      const leadIsChannelFanout = lead.fromRole === 'channel';
      let freshRetryReason: string | undefined;
      if (freshThreadOnTask(to.home)
        && !batchIsPersonSourced
        && !leadIsChannelFanout
        && !nudgeHoldActive(lead)
        // Defense in depth: the drain re-derives the sender gate instead of
        // trusting a stored marker alone, so an operator list change (or a
        // stale stamp from an earlier build) can never wipe for a sender
        // that is no longer a task source for this recipient.
        && isTaskStartHandoff({ senderId: lead.fromId, recipientId: to.id, recipientHome: to.home })) {
        const toHome = agentLogKey(to);
        const toLogKey = logKeyFor(toHome.cli, sessionDirectory(toHome.chatKey, ELROND_WORKSPACE_PATH), toHome.chatKey);
        // The batch is owed a wipe until its own task id's durable reset
        // state says complete: an interrupted wipe (`resetting`) resumes
        // after restart, and a different task is never suppressed by an
        // earlier task's completion (Codex verify, Oct 23 2026). Legacy
        // marked rows carry no task id; they keep the old behavior of
        // delivering without a wipe until they drain.
        if (freshResetOwed(lead.taskId, threadResetTaskState(toLogKey))) {
          const wiped = await freshStartForAgent(to, lead.taskId);
          const hold = freshHoldReason(wiped);
          if (hold) {
            freshRetryReason = hold;
          } else if (!wiped.fresh) {
            console.warn(`[team] fresh thread for ${to.name} skipped: ${wiped.reason ?? 'unknown'}`);
          }
        }
      }
      if (freshRetryReason) {
        // Keep the durable records queued and let the drain retry: the
        // reset epoch is already committed, so the retry re-runs the
        // idempotent wipe rather than delivering into a half-erased thread.
        console.warn(`[team] fresh thread for ${to.name} will retry: ${freshRetryReason}`);
        await retryDelay();
        continue;
      }
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
        personPosted: lead.personPosted === true,
        queue: lead.queue === true,
        nudgeHoldSince: batchHoldSince,
        personSourced: batchIsPersonSourced,
        mixedSenders: siblings.some((sibling) => sibling.fromId !== lead.fromId),
        batchRecords: siblings.map(batchRecordForEnvelope),
        stillWanted: async () => {
          // Every record that rides this batch must still be queued when the
          // prompt finally goes out: a Stop that dropped any of them must
          // not see the dropped text delivered anyway (review finding 1).
          const rows = await queueStoreOperation(() => queuedDeliveryStore.list());
          return siblings.every((sibling) => rows.some((row) => row.id === sibling.id));
        },
        // Quiet hours (Opus verify, Oct 16): this batch was built before the
        // admission wait above, which can run 30 minutes, so re-check the
        // window after admission. A batch with person-sourced siblings never
        // holds — they sort ahead, so they lead their own batch — and an
        // all-chatter batch to a non-Max lane parks whole.
        quietHoldCheck: batchIsPersonSourced
          ? undefined
          : () => isNonMax && inQuietHours(Date.now()),
        // (card-b3468c verify P1) The digest admission ack fires in the
        // finally: the batch ack's own failure (a receipt that did not reach
        // the event log) must not strand the digest's in-flight entries —
        // the turn still carried the line, so the source's callbacks still
        // owe their marks.
        onAdmitted: async (session) => {
          try {
            await acknowledgeQueuedBatch(lead, session);
          } finally {
            await fireDigestAdmissionAcks(to.id, siblings);
          }
        },
      });
      if (result.held === 'quiet-hours') {
        // Park the whole drain, not just this record: person-sourced records
        // sorted ahead of this batch, so everything left is same-tier
        // chatter. The scheduleQueuedRecipient finally re-schedules with
        // queuedRetryDelay, which targets the next 05:00 ET for a queue with
        // no person-sourced records left.
        console.log(`[team] queued delivery ${lead.fromName} -> ${to.name} held for quiet hours (22:00-05:00 ET); resumes after 05:00`);
        quietParked = true;
        break;
      }
      const remains = await queueStoreOperation(async () =>
        (await queuedDeliveryStore.list()).some((item) => item.id === record.id));
      // A dropped or gone lead needs neither the warning nor the retry wait:
      // sleeping here would stall the member's other queued deliveries for a
      // full retry interval after every channel Stop (review 3, P2 7).
      if (!result.delivered && !remains) continue;
      if (!result.delivered || remains) {
        // (review 3 P0 2 / P1 7; card-b3468c) A queued or nudge-hold lead
        // aborted by a newer leading record re-runs immediately: that record
        // must not wait a retry interval behind the abort that let it lead.
        const abortedQueuedWait = (lead.queue === true || nudgeHoldActive(lead)) && result.reason === 'sender stopped before delivery';
        if (!abortedQueuedWait) {
          console.warn(`[team] queued delivery ${lead.fromName} -> ${to.name} will retry: ${result.reason ?? 'durable acknowledgement pending'}`);
          await retryDelay();
        }
        continue;
      }
      break;
    }
  }
}

/** Retry delay for a paused queue with records still pending. Fast retry
 *  normally; during quiet hours a non-Max recipient's held teammate records
 *  wait for the 05:00 ET window end instead of churning the drain every 15
 *  seconds all night. Person-sourced records keep the fast retry whatever
 *  the hour — the boss's messages never wait out the window. */
function queuedRetryDelay(queueKey: string, remains: QueuedTeamDelivery[]): number {
  const now = Date.now();
  if (!inQuietHours(now) || isQuietExemptLane(queueKey)) return ASYNC_RETRY_MS;
  return remains.some((item) => personSourced(item)) ? ASYNC_RETRY_MS : msUntilQuietEnd(now);
}

function scheduleQueuedRecipient(queueKey: string, delayMs = 0): void {
  if (activeQueuedRecipients.has(queueKey)) return;
  const due = Date.now() + Math.max(0, delayMs);
  // A pending long timer must never gate out a sooner delivery: a quiet-hours
  // hold parks the retry at the 05:00 ET window end, and a NEW message for
  // this recipient schedules an immediate drain — without preemption a
  // person-sourced record arriving at 23:00 would wait behind the held
  // chatter's timer until morning (Opus review, Oct 16). A sooner request
  // replaces the pending timer; a later one keeps the earlier due.
  const pending = queuedRetryTimers.get(queueKey);
  if (pending) {
    if (due >= pending.due) return;
    clearTimeout(pending.timer);
    queuedRetryTimers.delete(queueKey);
  }
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
          (await queuedDeliveryStore.list()).filter((item) => queueKeyOf(item) === queueKey));
        if (remains.length > 0) scheduleQueuedRecipient(queueKey, queuedRetryDelay(queueKey, remains));
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
  queuedRetryTimers.set(queueKey, { timer, due });
}

/** Resume accepted fire-and-forget handoffs after a TARDIS restart. */
export async function resumeQueuedTeamDeliveries(): Promise<number> {
  // The first quiet-delivery build incorrectly parked actionable digests.
  // Restore their original IDs before scheduling, so source admission acks
  // settle once. Unknown legacy urgency fails open instead of waiting forever.
  for (const item of await legacyActionableInformation()) {
    const to = agentForChatId(item.chatId);
    if (!to) continue;
    const from = findAgent(item.from);
    const stamp = new Date().toISOString();
    await queueStoreOperation(() => queuedDeliveryStore.modify(items => items.some(row => row.id === item.id) ? items : [...items, {
      id: item.id, createdAt: stamp, updatedAt: stamp, fromId: from?.id ?? 'unknown', fromName: item.from,
      toId: to.id, text: item.text, hop: 1, priority: true, admissionAck: item.admissionAck,
      chainId: randomUUID(), chainEdges: [], chainRoute: [],
    }]));
    await removeSavedInformation(item.id);
  }
  const records = await queueStoreOperation(() => queuedDeliveryStore.list());
  new Set(records.map(queueKeyOf)).forEach((queueKey) => scheduleQueuedRecipient(queueKey));
  return records.length;
}

/** (card-b3468c review P1, Oct 18) Ground truth for whether a
 *  fire-and-forget record is still alive: true while it sits in the durable
 *  delivery queue (its admission can still happen — the wait can legally
 *  span repeated 30-minute admission windows and then quiet hours, so
 *  elapsed time proves nothing), false once it is gone from the queue
 *  (admitted — the admission ack should have fired — or dropped), null when
 *  the queue cannot be read (the caller re-checks rather than guess). */
export async function teamDeliveryRecordPending(deliveryId: string): Promise<boolean | null> {
  if (await informationalPending(deliveryId)) return true;
  const id = deliveryId.trim().slice(0, 120);
  if (!id) return false;
  try {
    const items = await queueStoreOperation(() => queuedDeliveryStore.list());
    return items.some((item) => item.id === id);
  } catch {
    return null;
  }
}

export function teamMessageWaitRequested(wait: boolean | undefined): boolean {
  // Preserve the original raw HTTP contract. team-mcp.mjs explicitly sends
  // false when its caller omits wait, giving agents async-by-default behavior
  // without silently changing other API clients.
  return wait !== false;
}

export async function deliverTeamMessage(input: {
  /** Status/FYI only: save for the next real turn, never start or steer one. */
  informational?: boolean;
  from: string;
  to: string;
  text: string;
  /** voice: the user's own call continuing in the thread. desk: the human
   *  owner commenting on a Desk card (`from` is their display name). channel:
   *  a group-channel post fanned out to a member (the channel identity rides
   *  in `channel`; the poster's name rides inside the text). slack: the Slack
   *  bridge relaying a real person's message — person-class so it jumps the
   *  queue, takes an idle lane, and interrupts a busy turn. */
  source?: 'voice' | 'desk' | 'channel' | 'slack';
  /** Group-channel identity for source 'channel' records (id + display name). */
  channel?: { id: string; name: string };
  /** Internal admission notification; fires only after the outbox is durable. */
  onQueued?: () => void;
  hop?: number;
  wait?: boolean;
  /** Priority flag: this record sorts with person-sourced records, ahead of
   *  older teammate chatter. Sort order only; nothing else changes. */
  priority?: boolean;
  /** True when source:'channel' and the post was authored by the person
   *  (Matt) rather than an agent: the record gets person-class admission
   *  (human interrupt boundary, person lane preference) so his channel
   *  posts steer members' live turns like his one-on-one messages do. */
  personPosted?: boolean;
  /** True when the person chose to queue this channel post for the
   *  recipient's NEXT turn instead of steering the live one (card-504beb):
   *  person class and lane preference stay, but the delivery never
   *  interrupts — it waits out the current turn like a peer message. */
  queue?: boolean;
  /** Person-sourced provenance the role cannot carry (an unmentioned member's
   *  human channel post or an overnight Matt ask nudge). Person-sourced
   *  records deliver to non-Max lanes even during quiet hours. */
  personSourced?: boolean;
  /** card-b3468c: present on automation nudges (flag digests, Desk
   *  quiet-checks, past-due raises): the epoch ms the nudge's live-turn hold
   *  started. Under the liveness ceiling the delivery never steers the
   *  recipient's live turn and never joins a batch that would; past it,
   *  normal admission delivers anyway. */
  nudgeHoldSince?: number;
  /** card-b3468c (verify P1): 'flag-digest' marks a flag-digest record so
   *  its source queue learns the record's actual ADMISSION (the recipient
   *  saw the line), not just its durable receipt. */
  admissionAck?: 'flag-digest';
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
    : input.source === 'channel'
    // Same colon trick: the pseudo-sender is the channel itself, never an
    // agent, and the poster's own name rides inside the delivered text.
    ? { id: `channel:${input.channel?.id ?? 'unknown'}`, name: input.channel?.name?.trim() ? input.channel.name : '#channel', role: 'channel', engine: '', home: '', createdAt: 0 }
    : input.source === 'slack'
    // A real person is waiting on the other end of the Slack thread: the
    // record is person-class (queue priority, human interrupt class, idle
    // lane preference) so it can never sit behind teammate chatter or a
    // busy turn (card-c26bfa follow-up, Oct 20).
    ? { id: 'slack:inbound', name: input.from.trim() || 'Slack', role: 'slack', engine: '', home: '', createdAt: 0 }
    : findAgent(input.from) ?? { id: `external:${createHash('sha256').update(input.from.trim().toLowerCase()).digest('hex').slice(0, 16)}`, name: input.from || 'Unknown', role: '', engine: '', home: '', createdAt: 0 };
  if (to.id === from.id && input.from.trim().toLowerCase() === to.name.trim().toLowerCase()) {
    return { delivered: false, reason: 'that is you — no need to message yourself' };
  }

  const fromLane = input.fromLane === 'bg' ? 'bg' : 'main';
  const rosterSender = findAgent(from.id);
  const request = input.source || !rosterSender ? randomUUID() : await outboundRequest(from, fromLane);
  let parentChain: TeamChain | undefined;
  const parentActive = activeInboundChains.get(chainKey(from.id, fromLane));
  if (parentActive && Date.now() - parentActive.at <= 2 * 60 * 60_000) parentChain = parentActive;
  // A send that continues the conversation the sender is already having
  // with this recipient (its active inbound chain already carries this
  // edge) is follow-up inside work in flight, never a new task (Codex
  // review, Oct 23 2026). Only a first handoff leg can stamp a fresh thread.
  const continuesChain = chainContinues(parentChain, from.id, to.id);
  let { chain } = inheritedTeamChain(from.id, to.id, fromLane);
  if (chain.id !== request) chain = { id: request, edges: [replyEdge(from.id, to.id)], route: [from.id, to.id] };
  const requestedWaitForReply = teamMessageWaitRequested(input.wait);
  // Historical route repetition is never a reason to discard a message. Only
  // a CURRENT synchronous wait path can deadlock; that exact case is degraded
  // to durable fire-and-forget below so the text still reaches its recipient.
  // If adding from -> to closes any active wait path (A -> B -> C -> A), the
  // closing leg becomes durable fire-and-forget. Its text is preserved and all
  // blocked turns can finish; direct and longer cycles behave identically.
  const closesReplyCycle = requestedWaitForReply && hasReplyPath(to.id, from.id);
  // Quiet hours (Matt, Oct 15 2026): a synchronous wait would wake a
  // non-Max lane inside 22:00-05:00 ET. The record is already durable, so a
  // held handoff degrades to fire-and-forget exactly like a reply cycle:
  // the drain holds it until 05:00 and delivers unchanged. Person-sourced
  // records (Desk, voice, human channel posts, explicit personSourced wakes)
  // and Max's lanes never hold (Opus review, Oct 16).
  const isPersonSourced = personSourced({
    fromRole: from.role || undefined,
    personPosted: input.source === 'channel' && input.personPosted === true,
    personSourced: input.personSourced === true,
  });
  const quietHoldRecipient = !isPersonSourced && !isQuietExemptLane(to.id) && inQuietHours(Date.now());
  // Fresh thread on task: a stamped handoff must reach the drain, which owns
  // the idle-boundary wipe. The synchronous path admits straight into the
  // standing thread, so a task start rides the durable queue like every
  // other drain delivery; the sender simply stops waiting on a reply.
  const taskStartCandidate = rosterSender !== undefined && isTaskStartHandoff({
    senderId: from.id,
    recipientId: to.id,
    recipientHome: to.home,
    source: input.source,
    personSourced: input.personSourced === true,
    nudgeHoldSince: input.nudgeHoldSince,
    continuesChain,
  });
  // Every cheap exit runs BEFORE any claim is minted: a send that dies at
  // the rate limit, the duplicate guard, the acknowledgement path or the
  // informational path never owns a task id, so its retry still stamps the
  // fresh thread (Codex verify round 6, Oct 23 2026).
  const rl = rateOk(replyEdge(from.id, to.id));
  if (!rl.ok) return { delivered: false, reason: rl.reason };

  const quietAcknowledgement = acknowledgementOnly(text, [to.name, DESK_OWNER_NAME]);
  const claim = !input.source && rosterSender ? await claimOutbound(from.id, to.id, text, request, quietAcknowledgement) : undefined;
  if (claim === null) return { delivered: false, to: to.name, reason: 'You already sent this exact message. Do not send it again; continue only when there is new information.' };
  if (quietAcknowledgement && input.priority !== true && !input.source) {
    return { delivered: true, to: to.name, queued: true, reason: 'Acknowledgement noted. No wake-up or message card was needed.' };
  }
  if (input.informational === true && input.priority !== true && !input.source) {
    let deliveryId: string;
    try { deliveryId = await saveInformational(to.home || `bot-${to.id}`, from.name, text, input.admissionAck); }
    catch (error) { if (claim) await releaseOutbound(claim); throw error; }
    return { delivered: true, to: to.name, deliveryId, queued: true, reason: 'Saved for their next real turn. This update did not wake or interrupt them.' };
  }

  // The first handoff of a request claims its task id durably; a second
  // send on the same (request, sender, recipient) edge before the
  // recipient replies is a clarification of that same task, so it reuses
  // the claimed id and never stamps a new task start (Codex verify,
  // Oct 23 2026). Detection reads the sender's live inbound chain above,
  // which a first outbound send does not update — the claim is the durable
  // identity that closes that gap. A claim retires when the recipient's
  // reply closes the chain (below), so the next genuine task mints anew.
  let taskStart = false, taskId: string | undefined, mintedFreshClaim = false;
  if (taskStartCandidate) {
    const priorTaskId = (await freshTaskClaims.list()).find((item) => item.requestId === request && item.senderId === from.id && item.recipientId === to.id)?.taskId;
    taskStart = priorTaskId === undefined;
    if (priorTaskId !== undefined) taskId = priorTaskId;
    else { const mintedClaim = await claimFreshTaskId(request, from.id, to.id); taskId = mintedClaim.taskId; mintedFreshClaim = mintedClaim.minted; }
  }
  const waitForReply = requestedWaitForReply && !closesReplyCycle && !quietHoldRecipient && !taskStart;
  // card-b3468c: an under-ceiling nudge reports its idle-boundary delivery in
  // the receipt (the drain-side admission never steers a live turn).
  const nudgeHoldEntry = typeof input.nudgeHoldSince === 'number' && Number.isFinite(input.nudgeHoldSince) && input.nudgeHoldSince > 0
    && Date.now() - input.nudgeHoldSince < LIVE_HOLD_CEILING_MS;

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
      personPosted: input.source === 'channel' && input.personPosted === true ? true : undefined,
      queue: input.source === 'channel' && input.queue === true ? true : undefined,
      personSourced: input.personSourced === true ? true : undefined,
      nudgeHoldSince: typeof input.nudgeHoldSince === 'number' && Number.isFinite(input.nudgeHoldSince) && input.nudgeHoldSince > 0 ? input.nudgeHoldSince : undefined,
      admissionAck: input.admissionAck === 'flag-digest' ? 'flag-digest' : undefined,
      taskStart: taskStart ? true : undefined,
      taskId,
      chainId: chain.id,
      chainEdges: chain.edges,
      chainRoute: chain.route,
    }));
  } catch (error) {
    if (claim) await releaseOutbound(claim);
    if (mintedFreshClaim) await releaseFreshTaskClaim(request, from.id, to.id).catch(() => undefined);
    return { delivered: false, to: to.name, hop, reason: `could not persist queued delivery: ${(error as Error).message}` };
  }

  // This send is a real reply back to the original sender, so the chain is
  // closed: retire any fresh-task claim on that edge. The reply itself is
  // already durable, so a retirement failure must never fail the delivery.
  if (rosterSender) {
    try { await retireFreshTaskClaimsForReply(from.id, to.id); } catch (error) { console.warn('[team] fresh-task claim retirement failed:', (error as Error).message); }
  }

  try { input.onQueued?.(); } catch (error) {
    console.warn('[team] admission observer failed:', (error as Error).message);
  }

  // A time the sender promises in this message becomes a commitment
  // automatically when nothing matches it, so a promise can never silently
  // vanish (card-baadaf gap 1). Fire-and-forget: a scan hiccup must never
  // delay or fail the delivery itself. Only a roster agent's own words
  // count: pseudo-senders (desk, voice, channel, unknown) are skipped, so a
  // flag or nudge can never be re-processed as a promise.
  if (!input.source) {
    const sender = findAgent(input.from);
    if (sender) {
      void Promise.resolve().then(() => {
        // The scan itself must never vanish an exception: a store failure
        // would silently drop the promise with no commitment and no nudge.
        let scan: ReturnType<typeof scanOutgoingPromise>;
        try {
          scan = scanOutgoingPromise(sender.id, text, record.id);
        } catch (error) {
          console.warn('[team] outgoing-promise scan failed:', (error as Error).message);
          scan = { added: [], addError: (error as Error).message };
        }
        if (scan.addError) {
          const promised = scan.promise
            ? `You promised "${scan.promise.clause.replace(/\s+/g, ' ').slice(0, 120)}" (due ${scan.promise.due}) with no matching commitment, and the auto-add failed: ${scan.addError}. Add it with the commitments tool now.`
            : `The outgoing-promise scan failed (${scan.addError}). Check your open commitments and add anything you promised with the commitments tool now.`;
          void deliverTeamMessage({
            from: 'TARDIS',
            to: sender.id,
            text: promised,
            wait: false,
            priority: true,
          }).catch(() => undefined);
        }
      }).catch(() => undefined);
    }
  }

  if (!waitForReply) {
    // (review 3 P0 2) A newer non-queued record that can lead (person-sourced
    // or priority) never waits behind a queued lead's admission wait: abort
    // it so the drain re-runs with this record leading; the queued record
    // stays durable and delivers after it. A waiting under-ceiling nudge hold
    // is abortable by any ordinary record too (card-b3468c Sam check FAIL
    // fix, Oct 18): the nudge would have steered before this PR, so no
    // teammate message may sit behind its 30-minute wait — another
    // under-ceiling nudge still joins the wait instead of aborting it.
    if (record.queue !== true) {
      const waitingLead = queuedLeadAborters.get(queueKeyOf(record));
      if (waitingLead && (sortsAhead(record) || (waitingLead.nudge && !nudgeHoldActive(record)))) waitingLead.controller.abort();
    }
    scheduleQueuedRecipient(queueKeyOf(record));
    return {
      delivered: true,
      to: to.name,
      hop,
      queued: true,
      deliveryId: record.id,
      // Quiet hours (Opus verify, Oct 16): a held handoff is accepted and
      // durable but will not land until after 05:00, so callers that mark or
      // receipt on landing can see the hold instead of "it went to them".
      held: quietHoldRecipient ? 'quiet-hours' : undefined,
      reason: quietHoldRecipient
        ? 'stored durably for quiet hours (22:00-05:00 ET); delivery is automatic after 05:00'
        : nudgeHoldEntry
        ? 'stored durably; the live-turn hold (card-b3468c) delivers it at the recipient\'s next idle boundary'
        : taskStart
        ? 'stored durably; it opens a fresh thread for the recipient at their next idle boundary'
        : closesReplyCycle
        ? 'stored durably to avoid a cross-agent reply cycle; delivery is automatic'
        : queuedBehindAnotherTurn
          ? 'stored durably behind an earlier handoff; delivery is automatic'
          : 'stored durably; it will steer a compatible active turn immediately or use the next idle boundary',
    };
  }

  if (queuedBehindAnotherTurn) {
    // Same rule as the wait:false path above (card-b3468c Sam check FAIL
    // fix, Oct 18): an ordinary record aborts a waiting under-ceiling
    // nudge-hold lead so it leads instead of sitting behind the nudge's
    // 30-minute never-steer wait; another under-ceiling nudge joins it.
    if (record.queue !== true) {
      const waitingLead = queuedLeadAborters.get(queueKeyOf(record));
      if (waitingLead && (sortsAhead(record) || (waitingLead.nudge && !nudgeHoldActive(record)))) waitingLead.controller.abort();
    }
    scheduleQueuedRecipient(queueKeyOf(record));
    return {
      delivered: true,
      to: to.name,
      hop,
      queued: true,
      held: quietHoldRecipient ? 'quiet-hours' : undefined,
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
    personPosted: input.source === 'channel' && input.personPosted === true,
    queue: input.source === 'channel' && input.queue === true,
    personSourced: isPersonSourced,
    deferIfBusy: true,
    stillWanted: async () => queueStoreOperation(async () =>
      (await queuedDeliveryStore.list()).some((row) => row.id === record.id)),
    // Quiet hours (Opus verify, Oct 16): a synchronous handoff that entered
    // before 22:00 can admit after it — hold it after admission like the
    // queue drain does. Person-sourced senders never hold; the record is
    // already durable, so the caller's queued handling parks it for 05:00.
    quietHoldCheck: isPersonSourced
      ? undefined
      : () => inQuietHours(Date.now()) && !isQuietExemptLane(to.id),
    // (card-b3468c verify P1) The digest admission ack fires in the finally
    // for the same reason as the batch path: an ack failure must not strand
    // the digest's in-flight entries when the turn still carried the line.
    onAdmitted: async (session) => {
      try {
        await acknowledgeQueuedDelivery(record, session);
      } finally {
        await fireDigestAdmissionAcks(to.id, [record]);
      }
    },
  }));
  if (!job) {
    scheduleQueuedRecipient(queueKeyOf(record));
    return {
      delivered: true,
      to: to.name,
      hop,
      queued: true,
      held: quietHoldRecipient ? 'quiet-hours' : undefined,
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
      if (claim) await releaseOutbound(claim);
      return result;
    }
    if (remains) scheduleQueuedRecipient(queueKeyOf(record));
    if (!result.delivered && remains) {
      const heldForQuietHours = result.held === 'quiet-hours'
        || (!isPersonSourced && !isQuietExemptLane(to.id) && inQuietHours(Date.now()));
      return {
        delivered: true,
        to: to.name,
        hop,
        queued: true,
        held: heldForQuietHours ? 'quiet-hours' : undefined,
        reason: heldForQuietHours
          ? 'stored durably for quiet hours (22:00-05:00 ET); delivery is automatic after 05:00'
          : 'reply wait ended, but the handoff remains durably queued and will deliver automatically',
      };
    }
    if (!result.delivered && !remains && claim) await releaseOutbound(claim);
    return result;
  } catch (error) {
    if (input.signal?.aborted) {
      await queueStoreOperation(() => queuedDeliveryStore.delete(record.id));
      if (claim) await releaseOutbound(claim);
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

import { appendEventLogDurable, appendEventLogSync, flushEventLog, hasDurablePeerDeliveryReceipt, loadEventLogSync, loadEventLogTail, reserveEventLogSeq, type PersistedEvent } from './event-log-store.ts';
import { redactEventSecrets } from './secretRedaction.ts';

/** Durable input identity, shared by every engine. Assistant output and tool
 * results cannot turn a retry into a new request. */
async function outboundRequest(agent: Pick<Agent, 'id'>, lane: AgentLane): Promise<string> {
  const owner = findAgent(agent.id);
  if (!owner) return 'automation';
  const { cli, chatKey } = agentLogKey(owner, lane);
  const key = logKeyFor(cli, ELROND_WORKSPACE_PATH, chatKey);
  await flushEventLog(key);
  const rootKey = chainKey(agent.id, lane);
  await requestRootWrites.get(rootKey);
  const root = (await requestRoots.list()).find(item => item.id === rootKey);
  const identity = (text: string) => createHash('sha256').update(text).digest('hex');
  const events = (await loadEventLogTail(key)).events.filter(event => !foreignLaneEvent(event, lane));
  for (const event of events.reverse()) {
    const inner = event.ev?.type === 'event' ? event.ev.event : undefined;
    if (inner?.type === 'peer_delivery_accepted' && inner.deliveryId) return root && root.deliveryId === inner.deliveryId ? root.chainId : identity(`${key}|peer:${inner.deliveryId}`);
    if (inner?.type === '_user_echo') return identity(`${key}|user:${inner.clientMsgId ?? `${event.at ?? 0}:${event.seq}`}`);
  }
  return identity(`${key}|no-input`);
}

/** Explicit owner publication uses the same durable thread and live fanout on
 * every engine. Posting is a tool result, never an inference from reply prose. */
export async function publishOwnerReply(from: string, text: string, lane: AgentLane = 'main'): Promise<number> {
  const agent = findAgent(from);
  if (!agent) throw new Error('Choose your own teammate identity before publishing an owner reply.');
  const { cli, chatKey } = agentLogKey(agent, lane);
  const logKey = logKeyFor(cli, ELROND_WORKSPACE_PATH, chatKey);
  const { publishExternalThreadEvent } = await import('./runner.ts');
  await flushEventLog(logKey);
  const claim = await claimOutbound(agent.id, 'owner', text, await outboundRequest(agent, lane));
  if (!claim) throw new Error('You already posted this exact reply. Do not repeat it; continue only with new information.');
  // Reserve, save and broadcast in one synchronous slice after older writes
  // finish. A later native frame must not overtake this published message.
  const event = { seq: reserveEventLogSeq(logKey), at: Date.now(), ...(lane === 'bg' ? { lane: 'bg' as const } : {}),
    ev: { type: 'event' as const, event: redactEventSecrets({ type: 'assistant', _replyNow: true, _replyNowForOwner: true,
      message: { id: `reply_now_${randomUUID()}`, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'tool_use' } }) } };
  if (!appendEventLogSync(logKey, event)) { await releaseOutbound(claim); throw new Error('The owner reply could not be saved. It was not published.'); }
  publishExternalThreadEvent(logKey, event);
  return event.seq;
}

/** Read the recipient's authoritative shared-thread tail for this exact turn. */
async function readLastReply(logKey: string, minSeq = 0, maxSeq = Number.POSITIVE_INFINITY, lane: AgentLane = 'main'): Promise<string | undefined> {
  try { await flushEventLog(logKey); } catch { /* best-effort */ }
  const { events } = loadEventLogSync(logKey);
  // The other lane may have spoken in the same seq range; the reply is this lane's.
  const bounded = events.filter((event) => {
    const inner = event.ev?.type === 'event' ? event.ev.event : event.ev;
    return event.seq >= minSeq && event.seq <= maxSeq && !foreignLaneEvent(event, lane)
      && inner?._replyNowForOwner !== true;
  });
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
  // Agent home IDs are canonical across engines and working directories.
  // A directory edit must not hide the turn still running in the old one.
  const busyLanes = sessions.filter((session) => (
    bareChatId(session.chatId) === bareChatId(agent.home)
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
