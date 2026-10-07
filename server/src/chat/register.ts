import { assertSubscriptionLane } from './subscription-policy.ts';
import type express from 'express';
import type { Server } from 'node:http';
import { basename } from 'node:path';
import { WebSocketServer } from 'ws';
import { discoverRepos } from './repos.ts';
import { readChronicle } from './chronicle.ts';
import { readCommands } from './commands.ts';
import { clearThreadSessionIds, ensureStateDir } from './sessions.ts';
import { trustedWebSocketOrigin } from '../lib/origin.ts';
import { stopComputersForOwner } from '../devices/bridge.ts';
import { codexCatalogPayload, startCodexCatalog } from './codex-models.ts';
import { fireworksCatalogPayload, startFireworksCatalog } from './fireworks-models.ts';
import { openRouterCatalogPayload, startOpenRouterCatalog } from './openrouter-models.ts';
import {
  clampReplayWindow,
  REPLAY_CATCHUP_MAX_BYTES,
  isUnreadHistoryFrame,
  replayLeavesHole,
  collapseHistoricalToolArgs,
  historicalDelivery,
  subscriptionReplayCursor,
} from './replayDelivery.ts';
import {
  activeClaudeSessions,
  subscribeExternalThreadEvents,
  subscribeSessionCreated,
  publishExternalThreadEvent,
  beginThreadReset,
  dropSession,
  freshStart,
  getOrCreateSession,
  interruptSession,
  isClaudeFamilyCli,
  isClaudeUnrecognizedModelWarning,
  laneLogKey,
  MemoryPressureSpawnError,
  peekClaudeSession,
  pruneIdleClaudeSessions,
  settleThreadSessionLookups,
  shutdownAllSessions,
  type AnySession,
  type CliKind,
} from './runner.ts';
import { durableUserEchoClientMsgId, flushEventLog, loadEventLogCatchUp, loadEventLogSync, recentUserEchoClientMsgIds, repairEventLogSequenceSync } from './event-log-store.ts';
import { isReactionEmoji, recordReaction } from './reactions.ts';
import {
  activeCodexSessions,
  pruneIdleCodexSessions,
  shutdownAllCodexSessions,
} from './codex-runner.ts';
import {
  activeBananaSessions,
  pruneIdleBananaSessions,
  shutdownAllBananaSessions,
} from './banana-runner.ts';
import { emitScribe } from '../worker/scribe.ts';
import { listChatHistory } from './history.ts';
import { watchThread, unwatchThread, setWatchVisible } from './threadWatch.ts';
import { agentForChatId, brainForAgent, cliForAgentEngine } from './agents.ts';
import { loadThreadResetEpochs, persistThreadResetEpoch } from './threadResetStore.ts';
import { setQueuedHumanProbe } from './providerSwitch.ts';
import { bareChatId, isBackgroundChatId } from './threadKey.ts';

type ClientSelection = {
  model?: string;
  effort?: string;
  /** Process-local picker revision plus explicit dirty bit. Device defaults
   * report reconfigure=false, so they can never recycle a warm process. */
  selectionRevision?: number;
  reconfigure?: boolean;
};
type ClientHello = { type: 'hello'; cli: CliKind; repo: string; chatId?: string; sinceSeq?: number; resetAt?: number; visible?: boolean } & ClientSelection;
type ClientWatch = { type: 'watch'; visible?: boolean };
// `model` / `effort` ride on send/steer. Banana and Codex apply them per turn.
// Claude-family lanes (claude/assistant/zai/xai) apply them at spawn; a live
// steer must reuse that spawn, not the Counsel picker's current id.
type ClientSend = { type: 'send'; cli?: CliKind; repo?: string; chatId?: string; sinceSeq?: number; text: string; images?: Array<{ mediaType: string; base64: string }>; clientMsgId?: string; voice?: boolean } & ClientSelection;
type ClientFresh = { type: 'freshStart'; cli: CliKind; repo: string; chatId?: string } & ClientSelection;
type ClientStop = { type: 'stop'; cli: CliKind; repo: string; chatId?: string };
type ClientSteer = { type: 'steer'; cli: CliKind; repo: string; chatId?: string; text: string; images?: Array<{ mediaType: string; base64: string }>; clientMsgId?: string; voice?: boolean } & ClientSelection;
type ClientReact = { type: 'react'; cli?: CliKind; repo?: string; chatId?: string; targetSeq: number; emoji: string; removed?: boolean };
type ClientMsg = ClientHello | ClientWatch | ClientSend | ClientFresh | ClientStop | ClientSteer | ClientReact;
type ResumeWatchableSession = AnySession & {
  startedWithResume?: () => boolean;
  waitForInitOrExit?: (timeoutMs: number) => Promise<'initialized' | 'closed' | 'timeout'>;
};

type SteerBoundary = 'steerable' | 'turn-complete' | 'closed' | 'timeout' | 'aborted';

function sessionHasActiveBoundary(session: AnySession): boolean {
  return (session as { isBusy?: () => boolean }).isBusy?.() === true;
}

function supportsNativeTurnSteer(cli: CliKind): boolean {
  return isClaudeFamilyCli(cli) || cli === 'codex';
}

function sessionCanAcceptNativeSteer(session: AnySession): boolean {
  return (session as { canAcceptNativeHumanSteer?: () => boolean })
    .canAcceptNativeHumanSteer?.() === true;
}

/** Wait without interrupting until guidance can join the active turn or the
 * natural boundary arrives. This closes the readiness race for a Codex adapter
 * still starting and for Claude entering a tool window after guidance queued. */
function waitForSteerOrTurnEnd(
  session: AnySession,
  signal: AbortSignal,
  timeoutMs = 30 * 60_000,
  allowNativeSteer = false,
): Promise<SteerBoundary> {
  if (signal.aborted) return Promise.resolve('aborted');
  if (!sessionHasActiveBoundary(session)) return Promise.resolve('turn-complete');
  if (allowNativeSteer && sessionCanAcceptNativeSteer(session)) return Promise.resolve('steerable');
  // The message is waiting on a busy Claude-family session: have its turn end
  // at the next tool boundary so the message starts a real turn (see
  // ClaudeSession.canAcceptNativeHumanSteer). Codex takes turn/steer natively.
  const releaseBoundary = (session as { requestBoundaryInterrupt?: (opts?: { human?: boolean }) => (() => void) | null }).requestBoundaryInterrupt?.({ human: true }) ?? null;
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const onAbort = () => done('aborted');
    const done = (result: SteerBoundary) => {
      if (settled) return;
      settled = true;
      releaseBoundary?.();
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
      resolve(result);
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { done('aborted'); return; }
    try {
      unsubscribe = (session as unknown as {
        subscribe: (fn: (se: { ev?: { type?: string } }) => void, since?: number, count?: boolean) => () => void;
        latestSeq?: () => number;
      }).subscribe((se) => {
        if (se.ev?.type === 'turnEnd') done('turn-complete');
        else if (se.ev?.type === 'closed') done('closed');
        else if (allowNativeSteer && sessionCanAcceptNativeSteer(session)) done('steerable');
      }, session.latestSeq?.() ?? -1, false);
      // Close both check/subscribe races: the turn can end or the native steer
      // channel can become ready before the listener is attached.
      if (!sessionHasActiveBoundary(session)) done('turn-complete');
      else if (allowNativeSteer && sessionCanAcceptNativeSteer(session)) done('steerable');
    } catch {
      done('timeout');
    }
  });
}

// Personas stay warm all day: measured cost is ~0.5GB per warm session
// (claude CLI + MCP stack) on a 128GB box, so the 30-minute prune was pure
// cold-start tax. 24h still self-heals stale processes overnight (old CLI
// builds, dead OAuth) — and sessions with an open tab are never pruned.
const IDLE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const IDLE_REAPER_INTERVAL_MS = 60 * 1000;
const RESUME_STARTUP_WATCH_MS = 8000;
const DEFAULT_CHAT_ID = 'main';
// Mobile networks (especially Android backgrounded tabs) silently drop WS
// connections without firing onclose on either side. Server-side ping every
// 25s, terminate after one missed pong, so the client's reconcile path can
// reopen instead of leaving the user staring at a dead socket.
const WS_PING_INTERVAL_MS = 25 * 1000;
// Application-level keepalive while a turn is busy. Tool calls, MCP, and
// model thinking produce no stream frames for tens of seconds; without this
// the client's 90s silence watchdog treats a healthy pause as a dead socket.
const TURN_KEEPALIVE_MS = 15 * 1000;
// Restoring a window fires visibilitychange AND focus (plus pageshow/online on
// some paths), so a client emits several identical hellos in the same tick.
// Collapse them: re-binding and re-replaying for each one is wasted work.
const HELLO_DEDUPE_MS = 1500;

function previewText(text: unknown): string {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 77) + '...' : flat;
}

/** Mirror every chat turn into the Scribe rail so a "frozen" UI is verifiable
 *  from the timeline — if the entry shows up there, the server received it
 *  and the gap is downstream of register. */
function logChatTurn(
  wsId: number,
  kind: 'send' | 'steer',
  cli: CliKind | null,
  repo: string | null,
  chatId: string,
  text: string,
): void {
  const repoLabel = repo ? basename(repo) : 'unknown';
  console.log(`[chat ws#${wsId}] ${kind} ${cli ?? '?'}/${chatId}: ${previewText(text)}`);
  void emitScribe({
    level: 'system',
    text: `chat ${kind} ws#${wsId} ${cli ?? '?'}/${repoLabel}/${chatId}: ${previewText(text)}`,
  }).catch((err) => {
    console.warn(`[chat ws#${wsId}] scribe log failed:`, (err as Error).message);
  });
}

function normalizeChatId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CHAT_ID;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_CHAT_ID;
  // Account-suffixed lanes were a private deployment detail. Collapse legacy
  // clients onto the same public/default-profile thread instead of forking it.
  const withoutLegacyAccount = trimmed.replace(/__acct__[a-z0-9-]+$/i, '');
  const safe = withoutLegacyAccount.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  // A viewer always attaches to the home lane; the background lane is server-owned.
  return (isBackgroundChatId(safe) ? bareChatId(safe) : safe) || DEFAULT_CHAT_ID;
}

function selectionRevisionOf(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

type ResolvedBrain = { cli: CliKind; model?: string; effort?: string; revision?: number };

function resolvedBrain(
  chatId: string,
  fallback: { cli: CliKind; model?: string; effort?: string },
): ResolvedBrain {
  const agent = agentForChatId(chatId);
  if (!agent) return fallback;
  const brain = brainForAgent(agent);
  return {
    cli: cliForAgentEngine(brain.engine) as CliKind,
    model: brain.model,
    effort: brain.effort,
    revision: brain.revision,
  };
}

function sessionCli(session: AnySession | null | undefined): CliKind | null {
  if (!session || typeof session.cli !== 'string') return null;
  return session.cli;
}

/** Spawn model/effort on a live Claude-family process. Missing on Codex/Banana
 *  (those take model per turn). */
function claudeSpawnOf(session: AnySession | null | undefined): { model: string; effort: string } | null {
  if (!session || !('spawnModel' in session)) return null;
  const spawned = session as { spawnModel?: unknown; spawnEffort?: unknown };
  if (typeof spawned.spawnModel !== 'string' || typeof spawned.spawnEffort !== 'string') return null;
  return { model: spawned.spawnModel, effort: spawned.spawnEffort };
}

function activeSelectionOf(session: AnySession | null | undefined): { model?: string; effort?: string } {
  const claude = claudeSpawnOf(session);
  if (claude) return claude;
  const selected = (session as { activeSelection?: () => { model?: string; effort?: string } } | null | undefined)
    ?.activeSelection?.();
  return selected ?? {};
}

type DispatchSeqEvent = { seq: number; ev: any; at?: number; lane?: 'bg' };

function isBananaTaggedError(se: DispatchSeqEvent): boolean {
  if (se.ev?.type !== 'error') return false;
  return typeof se.ev.code === 'string' && se.ev.code.startsWith('BANANA_');
}

function isSuccessfulResult(se: DispatchSeqEvent): boolean {
  const event = se.ev?.type === 'event' ? se.ev.event : null;
  return event?.type === 'result' && event.is_error === false;
}

function filterReplayEvents(events: DispatchSeqEvent[]): DispatchSeqEvent[] {
  let lastSuccessSeq = -1;
  for (const se of events) {
    if (isSuccessfulResult(se)) lastSuccessSeq = se.seq;
  }

  let latestUnresolvedBananaErrorSeq = -1;
  for (const se of events) {
    if (se.seq > lastSuccessSeq && isBananaTaggedError(se)) {
      latestUnresolvedBananaErrorSeq = se.seq;
    }
  }

  return events.filter((se) => {
    if (!isBananaTaggedError(se)) return true;
    return se.seq === latestUnresolvedBananaErrorSeq;
  });
}

/** Set on service shutdown: new turns are rejected (existing sockets get a
 *  clean error) so no work starts after the busy lanes were tombstoned. */
let chatQuiesced = false;
export function quiesceChat(): void {
  chatQuiesced = true;
}

export async function registerChat(app: express.Express, server: Server): Promise<() => void> {
  await ensureStateDir();
  // The Codex model picker follows the CLI's own catalog. Give the first read a
  // moment (it is local and quick) so early turns are checked against it.
  await startCodexCatalog();
  // The Fireworks picker follows the live control-plane catalog. The hand list
  // is complete for today's models, so boot never waits on the network: warm in
  // the background and let the endpoint/lazy spawns use the hand list first.
  void startFireworksCatalog();
  // Same for OpenRouter's public model list (no key needed to read it).
  void startOpenRouterCatalog();

  app.get('/api/codex/models', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(codexCatalogPayload());
  });

  app.get('/api/fireworks/models', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(fireworksCatalogPayload());
  });

  app.get('/api/openrouter/models', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(openRouterCatalogPayload());
  });

  app.get('/api/repos', async (_req, res) => {
    try {
      res.json({ repos: await discoverRepos() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/live', (_req, res) => {
    const sessions = [...activeClaudeSessions(), ...activeCodexSessions(), ...activeBananaSessions()];
    res.json({
      sessions: sessions.map((session) => ({
        cli: session.cli,
        cwd: session.cwd,
        repoName: basename(session.cwd),
        busy: session.busy,
        chatId: session.chatId,
        sessionId: session.sessionId,
        lastActivityAt: session.lastActivityAt,
      })),
    });
  });

  app.post('/api/chat/interrupt', async (req, res) => {
    const body = req.body as Partial<{ cli: CliKind; repo: string; chatId: string }>;
    const cli = body.cli;
    if (
      cli !== 'assistant' &&
      cli !== 'claude' &&
      cli !== 'codex' &&
      cli !== 'banana' &&
      cli !== 'codex-personal' &&
      cli !== 'banana-local' &&
      cli !== 'banana-fireworks' &&
      cli !== 'zai' &&
      cli !== 'xai' &&
      cli !== 'fireworks' &&
      cli !== 'openrouter'
    ) {
      res.status(400).json({ error: 'invalid cli' });
      return;
    }
    if (typeof body.repo !== 'string' || !body.repo.trim()) {
      res.status(400).json({ error: 'invalid repo' });
      return;
    }
    const chatId = normalizeChatId(body.chatId);
    const peer = (req.headers['x-forwarded-for'] as string | undefined)
      ?? req.socket?.remoteAddress ?? '?';
    console.warn(`[chat http] interrupt from ${peer} cli=${cli} repo=${body.repo} chatId=${chatId}`);
    await Promise.all([interruptSession({ cli, repoPath: body.repo, chatId }), stopComputersForOwner(chatId)]);
    res.json({ ok: true, chatId });
  });

  app.get('/api/chronicle', async (_req, res) => {
    try {
      res.json(await readChronicle());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/chat/history', async (_req, res) => {
    try {
      res.json({ items: await listChatHistory() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.get('/api/commands', async (_req, res) => {
    try {
      res.json(await readCommands());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Lane-scoped operation generations: Stop/Fresh/send from ANY socket bumps
  // the generation so a stale waiter cannot write after cancel. A newer steer
  // does not bump or abort. Stacked guidance waits in FIFO and delivers in order.
  const laneGenerations = new Map<string, number>();
  const laneWaiters = new Map<string, Set<AbortController>>();
  const laneSteerTails = new Map<string, Promise<void>>();
  // Authoritative server ownership for human guidance waiting behind a turn.
  // Reconnects receive these ids in ready/working so a cached "queued" bubble
  // can never remain optimistic forever after a timeout or process restart.
  const pendingSteers = new Map<string, Set<string>>();
  const laneGenKey = (cli: CliKind, repo: string, chatId: string) => `${cli}|${repo}|${chatId}`;
  type SendAdmission = {
    state: 'pending' | 'accepted';
    at: number;
    cli: CliKind;
    repo: string;
    chatId: string;
    logKey: string;
    clientMsgId: string;
  };
  const sendAdmissions = new Map<string, SendAdmission>();
  const sendAdmissionKey = (cli: CliKind, repo: string, chatId: string, clientMsgId: string) => (
    `${laneLogKey(cli, repo, chatId)}\u0000${clientMsgId}`
  );
  const userEchoClientMsgId = (raw: unknown): string | null => {
    let event: any = raw;
    while (
      event
      && typeof event === 'object'
      && (event.type === 'event' || event.type === 'stream_event')
      && event.event
    ) event = event.event;
    return event?.type === '_user_echo' && typeof event.clientMsgId === 'string'
      ? event.clientMsgId
      : null;
  };
  // Delivery receipts must come from the FULL durable log files, not
  // loadEventLogSync's trimmed replay window: a busy lane pushes a natively
  // delivered steer's _user_echo out of MAX_EVENTS_PER_LOG within minutes,
  // and a reconnect then honestly reported the receipt as missing, raising
  // the false "Queued guidance was not retained" banner (verified live on
  // the Chief chat: 39 durable receipts, one handed back on reconnect).
  const durableSendAccepted = (cli: CliKind, repo: string, chatId: string, clientMsgId: string): boolean => (
    durableUserEchoClientMsgId(laneLogKey(cli, repo, chatId), clientMsgId)
  );
  const recentDeliveredClientMsgIds = (cli: CliKind, repo: string, chatId: string, limit = 128): string[] => (
    recentUserEchoClientMsgIds(laneLogKey(cli, repo, chatId), limit)
  );
  const rememberSendAdmission = (
    key: string,
    state: SendAdmission['state'],
    owner: Pick<SendAdmission, 'cli' | 'repo' | 'chatId' | 'logKey' | 'clientMsgId'>,
  ) => {
    sendAdmissions.set(key, { ...owner, state, at: Date.now() });
    if (sendAdmissions.size <= 5_000) return;
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const [entryKey, admission] of sendAdmissions) {
      if (admission.state === 'accepted' && admission.at < cutoff) sendAdmissions.delete(entryKey);
    }
    // Accepted ids are also durable in `_user_echo`; cap their hot cache by
    // insertion order while preserving every in-flight pending reservation.
    for (const [entryKey, admission] of sendAdmissions) {
      if (sendAdmissions.size <= 5_000) break;
      if (admission.state === 'accepted') sendAdmissions.delete(entryKey);
    }
  };
  // The person's own lane only: a busy background lane never owns the thread,
  // so it can never reject, delay or capture a human send.
  const sessionsForLogKey = (logKey: string) => (
    [...activeClaudeSessions(), ...activeCodexSessions(), ...activeBananaSessions()]
      .filter((session) => !isBackgroundChatId(session.chatId)
        && laneLogKey(session.cli, session.cwd, session.chatId) === logKey)
  );
  const activeSessionForLogKey = (logKey: string) => (
    sessionsForLogKey(logKey).find((session) => session.busy) ?? null
  );
  const pendingAdmissionForLogKey = (logKey: string): SendAdmission | null => (
    [...sendAdmissions.values()].find((admission) => (
      admission.logKey === logKey
      && admission.state === 'pending'
      && Date.now() - admission.at <= 2 * 60_000
    )) ?? null
  );
  const addPendingSteer = (key: string, clientMsgId: string | undefined) => {
    if (!clientMsgId) return;
    const ids = pendingSteers.get(key) ?? new Set<string>();
    ids.add(clientMsgId);
    pendingSteers.set(key, ids);
  };
  const deletePendingSteer = (key: string | null, clientMsgId: string | undefined) => {
    if (!key || !clientMsgId) return;
    const ids = pendingSteers.get(key);
    if (!ids) return;
    ids.delete(clientMsgId);
    if (ids.size === 0) pendingSteers.delete(key);
  };
  const pendingSteerIds = (cli: CliKind | null, repo: string | null, id: string): string[] => {
    if (!cli || !repo) return [];
    return [...(pendingSteers.get(laneGenKey(cli, repo, id)) ?? [])];
  };
  // Stop means "silence the agent now", never "delete what I said". A steer
  // still queued when Stop lands is captured here instead of being rejected,
  // keeps its "Queued · will run next" state on every client, and rides the
  // next admitted send in order. Fresh (a thread wipe) is the only path that
  // may discard held steers outright.
  type HeldSteer = {
    text: string;
    images?: ClientSteer['images'];
    clientMsgId?: string;
    laneKey: string;
    model?: string;
    effort?: string;
    voice?: boolean;
    selectionRevision?: number;
    /** Monotonic enqueue order across every lane, so a replay after Stop keeps
     *  the order the user typed even when steers sat on different engine lanes. */
    seq: number;
  };
  let steerEnqueueSeq = 0;
  const heldSteers = new Map<string, HeldSteer[]>();
  const inFlightSteers = new Map<string, Map<string, HeldSteer>>();
  const heldClientIds = new Set<string>();
  // Threads with a Stop still ending their turn. Steers typed meanwhile wait here.
  const stopBarriers = new Map<string, Promise<void>>();
  // An interrupt that never settles must not hold the barrier up forever. Stop gives
  // up on it after this long (reported as a stop failure), still replays the held
  // steers and releases the gate, so waiting steers always go in the order typed and
  // two Stops never overlap. Waiters themselves never time out.
  const STOP_INTERRUPT_MAX_WAIT_MS = 20_000;
  const capStopWork = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stop did not finish within ${STOP_INTERRUPT_MAX_WAIT_MS / 1000}s`)), STOP_INTERRUPT_MAX_WAIT_MS);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
  // Payloads Stop handed back to the steer path as fresh steers. The aborted
  // original must not reject or untrack the id its replacement now owns.
  const requeuedSteers = new WeakSet<HeldSteer>();
  const heldScopeKey = (repo: string | null | undefined, chatId: string): string => `${repo ?? ''}\0${chatId}`;
  const holdLaneSteers = (laneKey: string, repo: string, chatId: string): void => {
    const live = inFlightSteers.get(laneKey);
    if (!live?.size) return;
    const scope = heldScopeKey(repo, chatId);
    const bucket = heldSteers.get(scope) ?? [];
    for (const steer of live.values()) {
      bucket.push(steer);
      if (steer.clientMsgId) heldClientIds.add(steer.clientMsgId);
    }
    inFlightSteers.delete(laneKey);
    heldSteers.set(scope, bucket);
  };
  const takeHeldSteers = (repo: string, chatId: string): HeldSteer[] => {
    const scope = heldScopeKey(repo, chatId);
    const bucket = heldSteers.get(scope) ?? [];
    if (bucket.length === 0) return [];
    heldSteers.delete(scope);
    for (const steer of bucket) {
      if (!steer.clientMsgId) continue;
      heldClientIds.delete(steer.clientMsgId);
      deletePendingSteer(steer.laneKey, steer.clientMsgId);
    }
    return bucket.sort((a, b) => a.seq - b.seq);
  };
  const purgeHeldSteers = (repo: string, chatId: string): void => {
    const scope = heldScopeKey(repo, chatId);
    const bucket = heldSteers.get(scope) ?? [];
    heldSteers.delete(scope);
    for (const steer of bucket) {
      if (!steer.clientMsgId) continue;
      heldClientIds.delete(steer.clientMsgId);
      deletePendingSteer(steer.laneKey, steer.clientMsgId);
    }
  };
  // The automatic continue after a GLM provider cut must never jump ahead of
  // a person: a steer waiting for this thread, or a send being admitted,
  // takes the turn instead (it carries the cut guidance). Stop-held steers
  // wait for the next send and do not count; they would strand the thread.
  setQueuedHumanProbe((logKey) => {
    for (const [key, ids] of pendingSteers) {
      const first = key.indexOf('|');
      const last = key.lastIndexOf('|');
      if (first <= 0 || last <= first) continue;
      if (laneLogKey(key.slice(0, first) as CliKind, key.slice(first + 1, last), key.slice(last + 1)) !== logKey) continue;
      for (const id of ids) if (!heldClientIds.has(id)) return true;
    }
    return Boolean(pendingAdmissionForLogKey(logKey));
  });
  const addLaneWaiter = (key: string | null, ac: AbortController) => {
    if (!key) return;
    const set = laneWaiters.get(key) ?? new Set<AbortController>();
    set.add(ac);
    laneWaiters.set(key, set);
  };
  const removeLaneWaiter = (key: string | null, ac: AbortController) => {
    if (!key) return;
    const set = laneWaiters.get(key);
    if (!set) return;
    set.delete(ac);
    if (set.size === 0) laneWaiters.delete(key);
  };
  const abortLaneWaiters = (key: string) => {
    const set = laneWaiters.get(key);
    if (!set) return;
    for (const ac of set) ac.abort();
    laneWaiters.delete(key);
  };
  const bumpLaneGen = (cli: CliKind, repo: string, chatId: string): number => {
    const k = laneGenKey(cli, repo, chatId);
    abortLaneWaiters(k);
    const n = (laneGenerations.get(k) ?? 0) + 1;
    laneGenerations.set(k, n);
    return n;
  };
  const peekLaneGen = (cli: CliKind, repo: string, chatId: string): number => (
    laneGenerations.get(laneGenKey(cli, repo, chatId)) ?? 0
  );
  const threadSteerKey = (repo: string, chatId: string) => `${repo}|${chatId}`;
  const enqueueThreadSteer = (repo: string, chatId: string, run: () => Promise<void>): void => {
    const key = threadSteerKey(repo, chatId);
    const prev = laneSteerTails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    laneSteerTails.set(key, next);
    void next.finally(() => {
      if (laneSteerTails.get(key) === next) laneSteerTails.delete(key);
    });
  };

  // A repaired durable log can coexist with an older warm session buffer.
  // Remember exactly how far that buffer is stale so every later socket skips
  // only the renumbered prefix while still replaying newer memory-only events.
  const repairedSessionThrough = new WeakMap<AnySession, number>();
  const wss = new WebSocketServer({ noServer: true });
  type SocketThread = { cli: CliKind; repo: string; chatId: string };
  const socketThreads = new Map<import('ws').WebSocket, SocketThread>();
  const threadResetAt = await loadThreadResetEpochs();
  const broadcastThreadReset = (
    logKey: string,
    source: import('ws').WebSocket,
    payload: Record<string, unknown>,
  ) => {
    let sourceSent = false;
    for (const [client, lane] of socketThreads) {
      if (client.readyState !== client.OPEN) continue;
      if (laneLogKey(lane.cli, lane.repo, lane.chatId) !== logKey) continue;
      client.send(JSON.stringify({ ...payload, remote: client !== source }));
      if (client === source) sourceSent = true;
    }
    if (!sourceSent && source.readyState === source.OPEN) {
      source.send(JSON.stringify({ ...payload, remote: false }));
    }
  };
  let wsCounter = 0;
  // Backstop for a client that leaks sockets: a long-lived tab whose orphaned
  // WebSockets keep their handlers attached and keep re-helloing. One browser
  // reached 35 live sockets on a single lane. A healthy client holds one per
  // open conversation, so anything past this cap is a leak - drop the oldest.
  // Pure backstop against a runaway client. Deliberately well above the ~35
  // sockets an old cached bundle can leak: closing sockets a live client still
  // wants just feeds its reconnect loop, which is worse than idle sockets now
  // that hello is attach-only and cheap.
  const MAX_SOCKETS_PER_PEER = 64;
  const peerSockets = new Map<string, Set<import('ws').WebSocket>>();

  const onUpgrade = (req: import('node:http').IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (path !== '/api/ws') return;
    if (!trustedWebSocketOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws, req) => {
    const wsId = ++wsCounter;
    const peer = (req.headers['x-forwarded-for'] as string | undefined) ?? req.socket.remoteAddress ?? '?';
    console.log(`[chat ws#${wsId}] open from ${peer}`);

    const peerKey = String(peer);
    let peerSet = peerSockets.get(peerKey);
    if (!peerSet) {
      peerSet = new Set();
      peerSockets.set(peerKey, peerSet);
    }
    peerSet.add(ws);
    while (peerSet.size > MAX_SOCKETS_PER_PEER) {
      const oldest = peerSet.values().next().value;
      if (!oldest || oldest === ws) break;
      peerSet.delete(oldest);
      console.warn(`[chat ws#${wsId}] ${peerKey} exceeded ${MAX_SOCKETS_PER_PEER} sockets - closing its oldest`);
      try { oldest.close(4002, 'too many concurrent connections'); } catch { /* already gone */ }
    }

    let sessionPromise: Promise<AnySession> | null = null;
    let unsubscribe: (() => void) | null = null;
    // Bumped by every replaying bind, every cold replay and every detach. A
    // catch-up scan is asynchronous, so a replay that finds the epoch moved (a
    // newer replay, or Stop / Fresh Start detaching the lane) or the socket gone
    // must not subscribe or dispatch: that history would land after newer frames,
    // or on a retired session, and its subscription would leak.
    let bindEpoch = 0;
    // Replaying binds currently between their first await and their subscribe.
    // The socket holds no subscription then, so external thread events must not
    // be dispatched directly: the bind replays them from the session's tail.
    let bindScansInFlight = 0;
    let busy = false;
    let cliKind: CliKind | null = null;
    let repoPath: string | null = null;
    let chatId = DEFAULT_CHAT_ID;
    // The lane this socket is currently counted as watching (threadWatch registry).
    let watchedLane: { repo: string; chatId: string } | null = null;
    let turnGeneration = 0;
    // True only while Stop replays held steers through this socket's own steer path.
    let replayingStopSteers = false;
    const ownedSteerWaiters = new Set<AbortController>();
    // Last model/effort actually used on this socket (hello/send/steer).
    // Steer must reuse these for Codex/Banana so a drifted Counsel picker
    // cannot feed grok-4.6 into a live Codex turn (Claude-family uses spawnModel).
    let lastTurnModel: string | undefined;
    let lastTurnEffort: string | undefined;
    /** Last authoritative queue set sent to this socket. Keepalive sends one
     * empty transition after cancellation even when the lane just became idle. */
    let lastQueuedSignature = '';
    // Durable admission receipts repair optimistic bubbles after a device/tab
    // leaves between the server's synchronous _user_echo and React committing
    // that acknowledgement to its local snapshot.
    let deliveredClientMsgIds: string[] = [];
    const refreshDeliveredClientMsgIds = (cli: CliKind, repo: string, id: string) => {
      deliveredClientMsgIds = recentDeliveredClientMsgIds(cli, repo, id);
    };
    const rememberDeliveredClientMsgId = (clientMsgId: string) => {
      deliveredClientMsgIds = [
        clientMsgId,
        ...deliveredClientMsgIds.filter((value) => value !== clientMsgId),
      ].slice(0, 128);
    };
    // Duplicate-hello suppression (see HELLO_DEDUPE_MS).
    let lastHelloSig = '';
    let lastHelloAt = 0;
    // WebSocket OPEN is not the protocol boundary. A send can arrive while an
    // asynchronous hello is still replaying/binding; hold it until `ready` has
    // been emitted so it cannot observe an empty or stale lane.
    let helloSeen = false;
    let settleHelloBarrier: () => void = () => {};
    let helloBarrier: Promise<void>;
    const resetHelloBarrier = () => {
      helloBarrier = new Promise<void>((resolve) => { settleHelloBarrier = resolve; });
    };
    resetHelloBarrier();
    const waitForHelloBarrier = async (timeoutMs = 15_000): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      });
      const ready = await Promise.race([helloBarrier.then(() => true as const), timedOut]);
      if (timer) clearTimeout(timer);
      return ready;
    };
    // Idle CLI chatter is logged, not surfaced. A wedged lane can emit hundreds
    // of identical lines, so keep the first few and then sample.
    let swallowedIdle = 0;

    // Heartbeat: any pong (or any inbound frame) marks the socket alive. The
    // interval ticks the ping; if a tick finds the socket already not-alive,
    // the prior ping went unanswered and we tear it down so the client's
    // visibility/online listeners can reopen a fresh connection.
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (!alive) {
        console.log(`[chat ws#${wsId}] heartbeat lost, terminating`);
        try { ws.terminate(); } catch {}
        return;
      }
      alive = false;
      try { ws.ping(); } catch {}
    }, WS_PING_INTERVAL_MS);
    heartbeat.unref();

    const safeSend = (msg: object) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const sendHandshakePending = (clientMsgId?: string) => {
      safeSend({
        type: 'error',
        code: 'HANDSHAKE_PENDING',
        retryable: true,
        clientMsgId,
        message: 'Connecting to this agent. Your message will retry when the line is ready.',
      });
    };

    // Held while an idle send waits out a rotation's maintenance and the
    // replacement spawn. A rotation's own `closed` event clears `busy`, and the
    // client's 90s silence watchdog must still hear the keepalive meanwhile.
    let holdKeepalive = 0;
    const keepalive = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      const queuedClientMsgIds = pendingSteerIds(cliKind, repoPath, chatId);
      const signature = queuedClientMsgIds.join('\u0000');
      const queueChanged = signature !== lastQueuedSignature;
      if (!busy && holdKeepalive === 0 && !queueChanged) return;
      safeSend({ type: 'working', busy: busy || holdKeepalive > 0, activeCli: cliKind, queuedClientMsgIds, deliveredClientMsgIds });
      lastQueuedSignature = signature;
    }, TURN_KEEPALIVE_MS);
    keepalive.unref();

    const detachCurrentSession = () => {
      bindEpoch += 1;
      sessionPromise = null;
      busy = false;
      unsubscribe?.();
      unsubscribe = null;
    };

    /** Highest seq this socket has been sent. A rebind resumes from here so
     *  the replacement process replays exactly what was missed, no more. */
    let lastDeliveredSeq = -1;
    /** This socket was unsubscribed by an intentional retire and is waiting for
     *  the lane's replacement process to exist. */
    let rebindPending = false;

    const dispatch = (se: DispatchSeqEvent) => {
      const sev = se.ev;
      if (se.seq > lastDeliveredSeq) lastDeliveredSeq = se.seq;
      // The agent's background lane shares this thread's transcript, never its
      // busy state: only its transcript frames reach the viewer, tagged so the
      // client keeps a separate reply cursor for them.
      if (se.lane === 'bg') {
        if (sev.type === 'event') safeSend({ type: 'stream', event: sev.event, seq: se.seq, at: se.at, lane: 'bg' });
        return;
      }
      if (sev.type === 'event') {
        const admittedClientMsgId = userEchoClientMsgId(sev.event);
        if (admittedClientMsgId && cliKind && repoPath) {
          rememberDeliveredClientMsgId(admittedClientMsgId);
          const logKey = laneLogKey(cliKind, repoPath, chatId);
          rememberSendAdmission(
            sendAdmissionKey(cliKind, repoPath, chatId, admittedClientMsgId),
            'accepted',
            { cli: cliKind, repo: repoPath, chatId, logKey, clientMsgId: admittedClientMsgId },
          );
        }
        safeSend({ type: 'stream', event: sev.event, seq: se.seq, at: se.at });
      } else if (sev.type === 'turnStart') {
        busy = true;
        safeSend({ type: 'turnStart', seq: se.seq });
      } else if (sev.type === 'turnEnd') {
        busy = false;
        safeSend({ type: 'turnEnd', sessionId: sev.sessionId, seq: se.seq });
      } else if (sev.type === 'compacted') {
        // Auto-compaction marker — the model's context rotated with a juicy
        // durable summary (saved to the RAG vault); the visible thread lives on.
        safeSend({ type: 'compacted', chatId: sev.chatId, words: sev.words, turns: sev.turns, count: sev.count, savedToRag: sev.savedToRag, at: sev.at, seq: se.seq });
      } else if (sev.type === 'error') {
        if (typeof sev.message === 'string' && isClaudeUnrecognizedModelWarning(sev.message)) {
          console.log(`[chat ws#${wsId}] swallowed unrecognized_model warning`);
          return;
        }
        // Only surface stderr/spawn errors during an active turn. Banana turn
        // failures are tagged so a reconnect can replay them even after the
        // backend already marked the turn ended; plain idle chatter stays
        // suppressed.
        const code = typeof sev.code === 'string' ? sev.code : '';
        // Fatal errors (e.g. a 401 auth failure) must ALWAYS reach the client,
        // even with no turn in flight, or the chat dies silently. Only harmless
        // idle stderr chatter is suppressed.
        if (busy || sev.fatal || code.startsWith('BANANA_')) {
          // NB: do NOT clear `busy` on fatal. failAuth()'s deferred shutdown
          // fires `closed` next, and the closed branch only sends `sessionClosed`
          // (which clears the client spinner) while `busy` is true. Zeroing it
          // here would swallow that and strand the spinner until the watchdog.
          safeSend({
            type: 'error',
            message: sev.message,
            code: sev.code,
            retryable: sev.retryable,
            seq: se.seq,
          });
        } else {
          swallowedIdle += 1;
          if (swallowedIdle <= 3 || swallowedIdle % 50 === 0) {
            console.log(`[chat ws#${wsId}] swallowed idle stderr (x${swallowedIdle}): ${String(sev.message).slice(0, 200)}`);
          }
        }
      } else if (sev.type === 'closed') {
        // The CLI process is dead. Drop the stale promise + subscription so
        // the next send can rebind via getOrCreateSession, which resumes from
        // the saved session id when possible.
        if (busy && !sev.intentional) {
          // Mid-turn death is a real failure — tell the client.
          safeSend({ type: 'sessionClosed', code: sev.code, seq: se.seq });
        } else {
          // Idle/intentional replacement: swallow it. The sending socket
          // resolves the lane owner again before writing, but a passive tab
          // has nothing to trigger that — it would look connected while
          // receiving nothing from the replacement. Arm a rebind so it
          // re-attaches as soon as a replacement exists, without spawning one.
          rebindPending = true;
          console.log(`[chat ws#${wsId}] swallowed ${sev.intentional ? 'intentional' : 'idle'} session close (code=${sev.code})`);
        }
        sessionPromise = null;
        busy = false;
        unsubscribe?.();
        unsubscribe = null;
      }
    };

    // A retired lane's replacement has arrived. Re-attach any socket that was
    // unsubscribed by that retire, resuming from its own delivery cursor.
    // bindSession is declared below but only called later, at event time.
    const stopSessionCreated = subscribeSessionCreated((logKey, session) => {
      if (!rebindPending || !cliKind || !repoPath) return;
      if (laneLogKey(cliKind, repoPath, chatId) !== logKey) return;
      if (!session.isAlive()) return;
      rebindPending = false;
      console.log(`[chat ws#${wsId}] rebinding to replacement session for ${logKey}`);
      void bindSession(Promise.resolve(session), lastDeliveredSeq).catch((err) => {
        // A failed rebind must not strand the socket: re-arm so the next
        // replacement (or the socket's own next send) picks it up.
        rebindPending = true;
        console.warn(`[chat ws#${wsId}] rebind failed for ${logKey}: ${(err as Error).message}`);
      });
    });

    const stopExternalEvents = subscribeExternalThreadEvents((logKey, se) => {
      // Warm views receive this through their runner. A cold attach has no
      // process subscription, but must still show the call without a reload.
      if (unsubscribe || bindScansInFlight > 0 || !cliKind || !repoPath || laneLogKey(cliKind, repoPath, chatId) !== logKey) return;
      void helloBarrier.then(() => {
        if (!unsubscribe && bindScansInFlight === 0 && cliKind && repoPath && laneLogKey(cliKind, repoPath, chatId) === logKey) dispatch(se);
      });
    });

    const bindSession = async (
      promise: Promise<AnySession>,
      sinceSeq = -1,
      resetAt = 0,
      forceReset = false,
    ) => {
      if (sinceSeq < 0 && !forceReset) return runBind(promise, sinceSeq, resetAt, forceReset);
      bindScansInFlight += 1;
      try {
        return await runBind(promise, sinceSeq, resetAt, forceReset);
      } finally {
        bindScansInFlight -= 1;
      }
    };

    const runBind = async (
      promise: Promise<AnySession>,
      sinceSeq: number,
      resetAt: number,
      forceReset: boolean,
    ) => {
      // Only replaying binds take part in the epoch. The epoch is reserved before
      // any await, so call order decides which bind is newest, not whichever
      // session promise happens to settle last.
      const replays = sinceSeq >= 0 || forceReset;
      const epoch = replays ? ++bindEpoch : bindEpoch;
      sessionPromise = promise;
      const session = await promise;
      if (replays && epoch !== bindEpoch) return session;
      unsubscribe?.();

      // The durable thread, not an engine's potentially stale in-memory tail,
      // owns replay. Older builds let a resumed Codex session allocate below a
      // Banana/GLM tail; repair those regressions in file chronology before
      // comparing the browser cursor or subscribing to new live events.
      await flushEventLog(session.logKey);
      const repair = repairEventLogSequenceSync(session.logKey);
      if (repair.repaired) {
        repairedSessionThrough.set(
          session,
          Math.max(repairedSessionThrough.get(session) ?? 0, repair.latestSeq),
        );
        console.warn(`[chat ws#${wsId}] repaired non-monotonic event sequence for ${session.logKey}`);
      }
      const { events } = loadEventLogSync(session.logKey);
      const durableLatest = events.reduce((max, event) => Math.max(max, event.seq), 0);
      const latest = Math.max(durableLatest, session.latestSeq());
      const resetReplay = forceReset || (sinceSeq >= 0 && sinceSeq > latest);
      const replaySince = resetReplay ? 0 : sinceSeq;
      // Read what the window no longer holds BEFORE subscribing: the scan is
      // asynchronous, and everything from subscribe to the last dispatch below
      // must stay one synchronous stretch (live events buffer while it runs).
      // Anything appended during the scan is above `latest` and also reaches
      // this socket through the session's in-memory tail.
      const catchUp = replays
        ? await loadEventLogCatchUp(session.logKey, events, replaySince, REPLAY_CATCHUP_MAX_BYTES, {
            keep: (ev) => !isUnreadHistoryFrame(ev),
            aborted: () => epoch !== bindEpoch || ws.readyState !== ws.OPEN,
          })
        : { extra: [], reachedSince: true };
      if (replays && (epoch !== bindEpoch || ws.readyState !== ws.OPEN)) return session;
      if (resetReplay) safeSend({ type: 'replayReset', latestSeq: latest, resetAt });

      const liveReplay: DispatchSeqEvent[] = [];
      let replaying = replaySince >= 0;
      const listener = (se: DispatchSeqEvent) => {
        if (replaying) {
          liveReplay.push(se);
          return;
        }
        dispatch(se);
      };
      // Replay the session's in-memory tail too. Durable appends deliberately
      // fail soft; subscribing only above the disk high-water would discard a
      // valid buffered reply whose mirror write failed. The one exception is a
      // sequence repair: that session buffer still carries the pre-repair seqs,
      // so disk is authoritative through `latest` and only newer live events
      // may join the replay.
      const staleSessionThrough = repairedSessionThrough.get(session) ?? 0;
      // A send that bound without a replay while the scan ran has subscribed
      // already; drop it so this socket never holds two.
      unsubscribe?.();
      unsubscribe = session.subscribe(listener, subscriptionReplayCursor(replaySince, staleSessionThrough));
      if (replaying) {
        const durableReplay: DispatchSeqEvent[] = [...catchUp.extra, ...events]
          .filter((event) => event.seq > replaySince)
          .map((event) => ({ seq: event.seq, ev: event.ev as any, at: event.at, ...(event.lane ? { lane: event.lane } : {}) }));
        const seenSeq = new Set<number>();
        const merged = [...durableReplay, ...liveReplay]
          .sort((a, b) => a.seq - b.seq)
          .filter((event) => {
            if (seenSeq.has(event.seq)) return false;
            seenSeq.add(event.seq);
            return true;
          });
        replaying = false;
        // Bound the history half only. Live events buffered during the bind
        // are new to this socket and must all arrive.
        // Collapse streamed tool-argument noise and trim old tool output first,
        // so the replay window is spent on conversation rather than on
        // redrawing old tool cards, and the byte budget measures what actually
        // goes out. Live frames above `latest` are new to this socket and are
        // neither rewritten nor dropped.
        const full = collapseHistoricalToolArgs(filterReplayEvents(merged), latest)
          .map((se) => (se.seq <= latest ? historicalDelivery(se) : se))
          .filter((se): se is DispatchSeqEvent => se !== null);
        const history = clampReplayWindow(full, latest);
        // A browser that already holds history (sinceSeq > 0) and fell further
        // behind than the replay window would keep its old blocks, skip the
        // clamped middle, and show a silent hole. Tell it to drop the stale
        // copy and rebuild from the window instead.
        if (replayLeavesHole(replaySince, catchUp.reachedSince, full.length, history.length)) {
          safeSend({ type: 'replayGap' });
        }
        for (const se of history) dispatch(se);
      }
      return session;
    };

    /** Replay a lane's durable event log straight to this socket, with no
     *  engine process involved. Same shape and same replay filtering as
     *  bindSession, so a cold attach renders identically to a warm one. */
    const replayFromEventLog = async (
      cli: CliKind,
      repo: string,
      id: string,
      sinceSeq: number,
      resetAt = 0,
      forceReset = false,
    ): Promise<number> => {
      const epoch = ++bindEpoch;
      const logKey = laneLogKey(cli, repo, id);
      await flushEventLog(logKey);
      const repair = repairEventLogSequenceSync(logKey);
      if (repair.repaired) {
        console.warn(`[chat ws#${wsId}] repaired non-monotonic cold event sequence for ${logKey}`);
      }
      const { events } = loadEventLogSync(logKey);
      let latest = 0;
      for (const event of events) if (event.seq > latest) latest = event.seq;
      const resetReplay = forceReset || (sinceSeq >= 0 && sinceSeq > latest);
      const replaySince = resetReplay ? 0 : sinceSeq;
      const catchUp = replaySince >= 0
        ? await loadEventLogCatchUp(logKey, events, replaySince, REPLAY_CATCHUP_MAX_BYTES, {
            keep: (ev) => !isUnreadHistoryFrame(ev),
            aborted: () => epoch !== bindEpoch || ws.readyState !== ws.OPEN,
          })
        : { extra: [], reachedSince: true };
      if (replaySince >= 0 && (epoch !== bindEpoch || ws.readyState !== ws.OPEN)) return latest;
      if (resetReplay) safeSend({ type: 'replayReset', latestSeq: latest, resetAt });
      if (replaySince >= 0) {
        const pending: DispatchSeqEvent[] = [...catchUp.extra, ...events]
          .filter((event) => event.seq > replaySince)
          .sort((a, b) => a.seq - b.seq)
          .filter((event, index, all) => index === 0 || event.seq !== all[index - 1].seq)
          .map((event) => ({ seq: event.seq, ev: event.ev as any, at: event.at, ...(event.lane ? { lane: event.lane } : {}) }));
        const full = collapseHistoricalToolArgs(filterReplayEvents(pending), latest)
          .map((se) => historicalDelivery(se))
          .filter((se): se is DispatchSeqEvent => se !== null);
        const history = clampReplayWindow(full, latest);
        if (replayLeavesHole(replaySince, catchUp.reachedSince, full.length, history.length)) {
          safeSend({ type: 'replayGap' });
        }
        for (const se of history) dispatch(se);
      }
      return latest;
    };

    const retryOnceAfterStaleResume = async (
      session: AnySession,
      text: string,
      generation: number,
      images?: Array<{ mediaType: string; base64: string }>,
      model?: string,
      effort?: string,
      clientMsgId?: string,
      voiceMode?: boolean,
    ): Promise<boolean> => {
      if (!cliKind || !repoPath || cliKind === 'codex') return false;
      const watchable = session as ResumeWatchableSession;
      if (watchable.startedWithResume?.() !== true || !watchable.waitForInitOrExit) return false;

      const state = await watchable.waitForInitOrExit(RESUME_STARTUP_WATCH_MS);
      if (state !== 'closed') return false;
      if (generation !== turnGeneration) return false;

      console.log(`[chat ws#${wsId}] stale resume closed before init, retrying fresh`);
      try {
        const retrySession = await bindSession(getOrCreateSession({ cli: cliKind, repoPath, chatId, model, effort }));
        busy = true;
        safeSend({ type: 'sessionRebound' });
        safeSend({ type: 'turnStart' });
        // send() is async (ClaudeSession runs the vision adapter); this retry is
        // fire-and-forget, so guard the promise or a rejection escapes the outer
        // try/catch as an unhandled rejection.
        if ('send' in retrySession) {
          void Promise.resolve((retrySession as any).send(text, images, { model, clientMsgId, voiceMode, skipAttachments: true })).catch((e: Error) => {
            // Don't just log: a rejected retry-send would otherwise strand the
            // client with busy=true and no turnEnd. Clean up the turn like the
            // synchronous catch below.
            console.warn(`[chat ws#${wsId}] retry send failed:`, e?.message ?? e);
            busy = false;
            safeSend({ type: 'error', message: String(e?.message ?? e) });
            safeSend({ type: 'turnEnd' });
          });
        }
        return true;
      } catch (error) {
        console.warn(`[chat ws#${wsId}] stale resume retry failed:`, (error as Error).message);
        busy = false;
        safeSend({ type: 'error', message: String((error as Error).message) });
        safeSend({ type: 'turnEnd' });
        return false;
      }
    };

    ws.on('message', async (raw) => {
      // Inbound traffic counts as proof-of-life for the heartbeat — no need to
      // wait for the next pong if the client just sent us a real message.
      alive = true;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        safeSend({ type: 'error', message: 'invalid JSON' });
        return;
      }

      let finishHello: (() => void) | null = null;
      let reservedSendAdmission: { key: string; clientMsgId: string } | null = null;
      let unsubscribeSendAdmission: (() => void) | null = null;
      try {
        if ('cli' in msg && msg.cli !== undefined && msg.type !== 'stop' && msg.type !== 'react') assertSubscriptionLane(msg.cli);
        if (msg.type === 'hello') {
          // Serialize only hello/replay operations. A second focus/pageshow
          // hello must not race the first subscription bind, but Stop/steer
          // remain independent and can still interrupt long work immediately.
          const previousHello = helloBarrier;
          if (helloSeen) {
            resetHelloBarrier();
            finishHello = settleHelloBarrier;
            await previousHello;
          } else {
            helloSeen = true;
            finishHello = settleHelloBarrier;
          }
          repoPath = msg.repo;
          chatId = normalizeChatId(msg.chatId);
          const desiredBrain = resolvedBrain(chatId, { cli: msg.cli, model: msg.model, effort: msg.effort });
          cliKind = desiredBrain.cli;
          const sinceSeq = typeof msg.sinceSeq === 'number' ? msg.sinceSeq : -1;
          const requestedLogKey = laneLogKey(desiredBrain.cli, msg.repo, chatId);
          const resetAt = threadResetAt.get(requestedLogKey) ?? 0;
          const clientResetAt = typeof msg.resetAt === 'number' && Number.isFinite(msg.resetAt)
            ? Math.max(0, msg.resetAt)
            : 0;
          const forceResetReplay = clientResetAt < resetAt;
          socketThreads.set(ws, { cli: desiredBrain.cli, repo: msg.repo, chatId });
          // Same-lane re-hellos (focus/online/pageshow reconcile) refresh
          // visibility even when the replay dedupe below swallows the rest —
          // a lost or racing watch message must self-heal on the next hello.
          if (watchedLane && watchedLane.repo === msg.repo && watchedLane.chatId === chatId) {
            setWatchVisible(watchedLane.repo, watchedLane.chatId, wsId, msg.visible !== false);
          }
          const helloSig = `${desiredBrain.cli}|${desiredBrain.model ?? ''}|${desiredBrain.effort ?? ''}|${desiredBrain.revision ?? 0}|${msg.repo}|${chatId}|${sinceSeq}|${clientResetAt}`;
          const helloAt = Date.now();
          if (!forceResetReplay && helloSig === lastHelloSig && helloAt - lastHelloAt < HELLO_DEDUPE_MS) {
            lastHelloAt = helloAt;
            const current = sessionPromise ? await sessionPromise.catch(() => null) : null;
            const sessionBusy = current
              ? (current as { isBusy?: () => boolean }).isBusy?.() === true
              : busy;
            const latestSeq = current
              ? current.latestSeq()
              : loadEventLogSync(laneLogKey(desiredBrain.cli, msg.repo, chatId)).events.reduce(
                  (max, event) => Math.max(max, event.seq),
                  0,
                );
            const activeCli = sessionCli(current) ?? desiredBrain.cli;
            const activeSelection = activeSelectionOf(current);
            cliKind = activeCli;
            repoPath = msg.repo;
            busy = sessionBusy;
            const queuedClientMsgIds = pendingSteerIds(activeCli, msg.repo, chatId);
            refreshDeliveredClientMsgIds(activeCli, msg.repo, chatId);
            lastQueuedSignature = queuedClientMsgIds.join('\u0000');
            safeSend({
              type: 'ready',
              cli: desiredBrain.cli,
              model: desiredBrain.model,
              effort: desiredBrain.effort,
              brainRevision: desiredBrain.revision,
              activeCli,
              activeModel: activeSelection.model ?? desiredBrain.model,
              activeEffort: activeSelection.effort ?? desiredBrain.effort,
              brainPending: activeCli !== desiredBrain.cli
                || (activeSelection.model !== undefined && activeSelection.model !== desiredBrain.model)
                || (activeSelection.effort !== undefined && activeSelection.effort !== desiredBrain.effort),
              repo: msg.repo,
              chatId,
              latestSeq,
              busy: sessionBusy,
              queuedClientMsgIds,
              deliveredClientMsgIds,
              resetAt,
            });
            return;
          }
          lastHelloSig = helloSig;
          lastHelloAt = helloAt;
          console.log(`[chat ws#${wsId}] hello cli=${desiredBrain.cli} repo=${msg.repo} chatId=${chatId} sinceSeq=${sinceSeq}`);
          if (watchedLane && (watchedLane.repo !== msg.repo || watchedLane.chatId !== chatId)) {
            unwatchThread(watchedLane.repo, watchedLane.chatId, wsId);
            watchedLane = null;
          }
          if (!watchedLane) {
            // Client reports tab visibility in hello; a backgrounded tab must
            // not suppress the badge on other devices.
            watchThread(msg.repo, chatId, wsId, msg.visible !== false);
            watchedLane = { repo: msg.repo, chatId };
          }
          // A hello is a passive attach and must never start an engine process.
          // Warm lane -> attach to it. Cold lane -> serve the durable log and
          // wait; the first real turn spawns lazily in the `send` handler.
          const activeThreadOwner = activeSessionForLogKey(requestedLogKey);
          const pendingThreadOwner = pendingAdmissionForLogKey(requestedLogKey);
          const threadOwner = activeThreadOwner ?? pendingThreadOwner;
          const warm = threadOwner
            ? await getOrCreateSession({
                cli: threadOwner.cli,
                repoPath: 'repo' in threadOwner ? threadOwner.repo : threadOwner.cwd,
                chatId,
              })
            : peekClaudeSession({ cli: desiredBrain.cli, repoPath: msg.repo, chatId });
          if (!warm && isClaudeFamilyCli(desiredBrain.cli)) {
            // Drop any session this socket was already bound to. Without it a
            // socket that re-helloes onto a different, cold lane keeps the old
            // lane's subscription - those events would stream into the new
            // lane's transcript - and `send` would reuse the stale
            // sessionPromise instead of starting the lane that was asked for.
            detachCurrentSession();
            const coldLatestSeq = await replayFromEventLog(
              desiredBrain.cli,
              msg.repo,
              chatId,
              sinceSeq,
              resetAt,
              forceResetReplay,
            );
            lastTurnModel = desiredBrain.model;
            lastTurnEffort = desiredBrain.effort;
            busy = false;
            console.log(`[chat ws#${wsId}] attached cold ${laneLogKey(desiredBrain.cli, msg.repo, chatId)} latestSeq=${coldLatestSeq} (no spawn)`);
            const queuedClientMsgIds = pendingSteerIds(desiredBrain.cli, msg.repo, chatId);
            refreshDeliveredClientMsgIds(desiredBrain.cli, msg.repo, chatId);
            lastQueuedSignature = queuedClientMsgIds.join('\u0000');
            safeSend({
              type: 'ready',
              cli: desiredBrain.cli,
              model: desiredBrain.model,
              effort: desiredBrain.effort,
              brainRevision: desiredBrain.revision,
              activeCli: desiredBrain.cli,
              activeModel: desiredBrain.model,
              activeEffort: desiredBrain.effort,
              brainPending: false,
              repo: msg.repo,
              chatId,
              latestSeq: coldLatestSeq,
              busy: false,
              queuedClientMsgIds,
              deliveredClientMsgIds,
              resetAt,
            });
            return;
          }
          const session = await bindSession(
            warm
              ? Promise.resolve(warm)
              : getOrCreateSession({ cli: desiredBrain.cli, repoPath: msg.repo, chatId, model: desiredBrain.model, effort: desiredBrain.effort }),
            sinceSeq,
            resetAt,
            forceResetReplay,
          );
          lastTurnModel = desiredBrain.model;
          lastTurnEffort = desiredBrain.effort;
          const activeCli = sessionCli(session) ?? desiredBrain.cli;
          const activeSelection = activeSelectionOf(session);
          cliKind = activeCli;
          repoPath = msg.repo;
          const sessionBusy = (session as any).isBusy?.() === true
            || Boolean(pendingAdmissionForLogKey(requestedLogKey));
          busy = sessionBusy;
          console.log(`[chat ws#${wsId}] session ready key=${session.key} latestSeq=${session.latestSeq()} busy=${sessionBusy}`);
          const queuedClientMsgIds = pendingSteerIds(activeCli, msg.repo, chatId);
          refreshDeliveredClientMsgIds(activeCli, msg.repo, chatId);
          lastQueuedSignature = queuedClientMsgIds.join('\u0000');
          safeSend({
            type: 'ready',
            cli: desiredBrain.cli,
            model: desiredBrain.model,
            effort: desiredBrain.effort,
            brainRevision: desiredBrain.revision,
            activeCli,
            activeModel: activeSelection.model ?? desiredBrain.model,
            activeEffort: activeSelection.effort ?? desiredBrain.effort,
            brainPending: activeCli !== desiredBrain.cli
              || (activeSelection.model !== undefined && activeSelection.model !== desiredBrain.model)
              || (activeSelection.effort !== undefined && activeSelection.effort !== desiredBrain.effort),
            repo: msg.repo,
            chatId,
            latestSeq: session.latestSeq(),
            busy: sessionBusy,
            queuedClientMsgIds,
            deliveredClientMsgIds,
            resetAt,
          });
          return;
        }

        if (msg.type === 'freshStart') {
          turnGeneration += 1;
          chatId = normalizeChatId(msg.chatId);
          let brain = resolvedBrain(chatId, { cli: msg.cli, model: msg.model, effort: msg.effort });
          const releaseReset = beginThreadReset({ cli: brain.cli, repoPath: msg.repo, chatId });
          if (!releaseReset) {
            safeSend({ type: 'error', message: 'This thread is already being reset.' });
            return;
          }
          try {
            // A delivery/prewarm can be between native-id lookup and claiming
            // its runner map. Settle it under the reset barrier so the sweep
            // sees Claude, Codex, and Banana lanes alike.
            await settleThreadSessionLookups({ cli: brain.cli, repoPath: msg.repo, chatId });
            brain = resolvedBrain(chatId, brain);
            const targetLogKey = laneLogKey(brain.cli, msg.repo, chatId);
            const resetAt = Math.max(Date.now(), (threadResetAt.get(targetLogKey) ?? 0) + 1);
            // Commit the generation before clearing anything. If a later RAG
            // or process teardown fails, clients still perform a full replay
            // of the coherent old log instead of trusting a stale high cursor.
            await persistThreadResetEpoch(targetLogKey, resetAt);
            threadResetAt.set(targetLogKey, resetAt);
            const priorSessions = sessionsForLogKey(targetLogKey);
            for (const prior of priorSessions) bumpLaneGen(prior.cli, msg.repo, chatId);
            bumpLaneGen(brain.cli, msg.repo, chatId);
            // Fresh wipes the thread: held steers die with it.
            purgeHeldSteers(msg.repo, chatId);
            console.warn(`[chat ws#${wsId}] freshStart from ${peer} cli=${brain.cli} repo=${msg.repo} chatId=${chatId}`);
            detachCurrentSession();
            // Fresh is a visible-thread reset, not a provider-lane reset. Retire
            // every live engine (busy or idle) and erase every native resume id
            // before clearing the shared log, otherwise switching back to an old
            // engine could resurrect the conversation that was just discarded.
            for (const prior of priorSessions) {
              await interruptSession({ cli: prior.cli, repoPath: prior.cwd, chatId });
              dropSession(prior.cli, prior.cwd, chatId);
            }
            await clearThreadSessionIds(msg.repo, chatId, brain.cli);
            deliveredClientMsgIds = [];
            const session = await bindSession(
              freshStart({ cli: brain.cli, repoPath: msg.repo, chatId, model: brain.model, effort: brain.effort }),
            );
            lastTurnModel = brain.model;
            lastTurnEffort = brain.effort;
            cliKind = brain.cli;
            repoPath = msg.repo;
            busy = false;
            safeSend({ type: 'selectionApplied', selectionRevision: selectionRevisionOf(msg.selectionRevision), cli: brain.cli, model: brain.model ?? null, effort: brain.effort ?? null, brainRevision: brain.revision });
            broadcastThreadReset(targetLogKey, ws, {
              type: 'freshStarted',
              cli: brain.cli,
              model: brain.model,
              effort: brain.effort,
              brainRevision: brain.revision,
              repo: msg.repo,
              chatId,
              latestSeq: session.latestSeq(),
              resetAt,
            });
            return;
          } finally {
            releaseReset();
          }
        }

        if (msg.type === 'stop') {
          turnGeneration += 1;
          const stopChatId = normalizeChatId(msg.chatId);
          const stopRepo = msg.repo;
          const stopBrain = resolvedBrain(stopChatId, { cli: msg.cli });
          const activeOwner = activeSessionForLogKey(laneLogKey(stopBrain.cli, stopRepo, stopChatId));
          const stopCli = (activeOwner?.cli ?? msg.cli) as CliKind;
          console.warn(`[chat ws#${wsId}] stop from ${peer} cli=${stopCli} repo=${stopRepo} chatId=${stopChatId}`);
          // A steer typed while Stop is still ending the turn is newer than every
          // held steer. This gate makes it wait until Stop has replayed them, so the
          // next turns run in the order the user typed.
          const stopScope = heldScopeKey(stopRepo, stopChatId);
          let releaseStopGate: () => void = () => {};
          const stopGate = new Promise<void>((resolve) => { releaseStopGate = resolve; });
          // A second Stop on the same thread queues behind the first, so the barrier
          // never drops while an earlier Stop is still replaying.
          const priorStopGate = stopBarriers.get(stopScope);
          stopBarriers.set(stopScope, stopGate);
          try {
            if (priorStopGate) await priorStopGate;
            // Capture steers still queued on this lane BEFORE the generation
            // bump aborts their waiters. Stop silences the turn; held steers
            // survive it and ride the next send.
            const stopLaneClis = new Set<CliKind>([stopCli, stopBrain.cli]);
            for (const live of sessionsForLogKey(laneLogKey(stopBrain.cli, stopRepo, stopChatId))) {
              stopLaneClis.add(live.cli);
            }
            for (const laneCli of stopLaneClis) holdLaneSteers(laneGenKey(laneCli, stopRepo, stopChatId), stopRepo, stopChatId);
            // Every lane whose steers were captured must abort its originals, or a
            // captured steer would also be delivered by the handler that still owns it.
            for (const laneCli of stopLaneClis) bumpLaneGen(laneCli, stopRepo, stopChatId);
            detachCurrentSession();
            let stopFailure: unknown = null;
            try {
              await capStopWork(Promise.all([interruptSession({ cli: stopCli, repoPath: stopRepo, chatId: stopChatId }), stopComputersForOwner(stopChatId)]));
            } catch (error) {
              stopFailure = error;
            }
            safeSend({ type: 'turnEnd' });
            // Stop ends the turn, never what the user already queued. Hand each
            // held steer back to the steer path, oldest first, so it runs as the
            // next turn with its images, keeps its clientMsgId (the echo clears
            // its bubble), and either delivers or is rejected back to the sender
            // like any other steer. Runs even when the interrupt itself failed.
            const heldForRequeue = takeHeldSteers(stopRepo, stopChatId);
            if (heldForRequeue.length > 0) {
              console.warn(`[chat ws#${wsId}] stop: re-queueing ${heldForRequeue.length} held steer(s) as the next turn`);
              // emit() runs each steer handler synchronously up to enqueueThreadSteer
              // (no await before it), so the replay keeps the held order. It also
              // does not depend on this socket staying open: accepted guidance
              // survives a close by design and its echo reaches whichever socket binds.
              // A steer the provider already accepted (its echo is in the durable log)
              // raced Stop; replaying it would deliver the guidance twice.
              const alreadyDelivered = new Set(recentDeliveredClientMsgIds(stopCli, stopRepo, stopChatId));
              let receiptsOwed = false;
              replayingStopSteers = true;
              try {
                for (const held of heldForRequeue) {
                  requeuedSteers.add(held);
                  if (held.clientMsgId && alreadyDelivered.has(held.clientMsgId)) {
                    // The provider accepted it between detach and interrupt, so this
                    // socket never saw the echo: hand it the receipt or the bubble
                    // stays "Queued" forever.
                    rememberDeliveredClientMsgId(held.clientMsgId);
                    receiptsOwed = true;
                    continue;
                  }
                  ws.emit('message', JSON.stringify({
                    type: 'steer',
                    cli: stopCli,
                    repo: stopRepo,
                    chatId: stopChatId,
                    text: held.text,
                    images: held.images,
                    clientMsgId: held.clientMsgId,
                    model: held.model,
                    effort: held.effort,
                    voice: held.voice,
                    selectionRevision: held.selectionRevision,
                  }));
                }
              } finally {
                replayingStopSteers = false;
              }
              if (receiptsOwed) {
                safeSend({ type: 'working', busy: busy || holdKeepalive > 0, activeCli: cliKind, queuedClientMsgIds: pendingSteerIds(cliKind, repoPath, chatId), deliveredClientMsgIds });
              }
            }
            if (stopFailure) throw stopFailure;
          } finally {
            if (stopBarriers.get(stopScope) === stopGate) stopBarriers.delete(stopScope);
            releaseStopGate();
          }
          return;
        }

        if (msg.type === 'watch') {
          if (watchedLane) setWatchVisible(watchedLane.repo, watchedLane.chatId, wsId, msg.visible !== false);
          return;
        }

        if (msg.type === 'react') {
          const reactChatId = normalizeChatId(msg.chatId ?? chatId);
          const reactCli = (msg.cli ?? cliKind) as CliKind | null;
          const reactRepo = msg.repo ?? repoPath;
          if (!reactCli || !reactRepo) {
            safeSend({ type: 'error', message: 'no session - send hello first', retryable: true });
            return;
          }
          const emoji = typeof msg.emoji === 'string' ? msg.emoji.trim() : '';
          const targetSeq = typeof msg.targetSeq === 'number' ? msg.targetSeq : 0;
          if (!isReactionEmoji(emoji) || !Number.isFinite(targetSeq) || targetSeq <= 0) {
            safeSend({ type: 'error', message: 'invalid reaction' });
            return;
          }
          const logKey = laneLogKey(reactCli, reactRepo, reactChatId);
          await recordReaction(
            logKey,
            targetSeq,
            emoji,
            { from: 'Matt', removed: msg.removed === true },
            (event) => publishExternalThreadEvent(logKey, { seq: event.seq, ev: event.ev as any }),
          );
          return;
        }

        if (msg.type === 'steer') {
          // Wait out a Stop still ending this thread's turn (its own replay skips this).
          if (!replayingStopSteers) {
            const gateScope = heldScopeKey(msg.repo, normalizeChatId(msg.chatId));
            for (let gate = stopBarriers.get(gateScope); gate; gate = stopBarriers.get(gateScope)) await gate;
          }
          if (chatQuiesced) {
            safeSend({ type: 'error', code: 'STEER_REJECTED', clientMsgId: msg.clientMsgId, message: 'TARDIS is regenerating — try again in a few seconds.' });
            safeSend({ type: 'turnEnd' });
            return;
          }
          turnGeneration += 1;
          chatId = normalizeChatId(msg.chatId);
          const authoritativeAgent = agentForChatId(chatId);
          let desiredSteerBrain = resolvedBrain(chatId, { cli: msg.cli, model: msg.model, effort: msg.effort });
          // Own cancellation from the first await through the final stdin
          // write. Stop or Fresh aborts this path. A newer steer waits in
          // line instead of superseding. A socket close does NOT: accepted
          // guidance must survive tab switches and reconnects, and its
          // durable echo will reach whichever socket binds.
          const steerAborter = new AbortController();
          ownedSteerWaiters.add(steerAborter);
          let waitKey: string | null = null;
          const releaseSteer = () => {
            ownedSteerWaiters.delete(steerAborter);
            removeLaneWaiter(waitKey, steerAborter);
          };
          const steerPayload: HeldSteer = {
            text: msg.text,
            images: msg.images,
            clientMsgId: msg.clientMsgId,
            laneKey: '',
            seq: ++steerEnqueueSeq,
            model: msg.model,
            effort: msg.effort,
            voice: msg.voice,
            selectionRevision: msg.selectionRevision,
          };
          const steerToken = `${msg.clientMsgId ?? 'anon'}\0${Date.now()}\0${Math.random()}`;
          const trackSteerPayload = (key: string | null) => {
            if (!key) return;
            steerPayload.laneKey = key;
            const live = inFlightSteers.get(key) ?? new Map<string, HeldSteer>();
            live.set(steerToken, steerPayload);
            inFlightSteers.set(key, live);
          };
          const untrackSteerPayload = (key: string | null) => {
            for (const [laneKey, live] of inFlightSteers) {
              live.delete(steerToken);
              if (live.size === 0) inFlightSteers.delete(laneKey);
            }
            void key;
          };
          const rejectSteer = (message = 'Queued guidance was superseded or canceled before delivery.') => {
            untrackSteerPayload(waitKey);
            if (requeuedSteers.has(steerPayload) || (msg.clientMsgId && heldClientIds.has(msg.clientMsgId))) {
              // Stop captured this steer for the next turn. Keep the queued
              // bubble intact on every client; do not send a rejection.
              return;
            }
            deletePendingSteer(waitKey, msg.clientMsgId);
            // Surface the reason server-side too: a rejected steer used to
            // vanish with no log line at all, which is how a register bug hid
            // for hours looking like "queued".
            console.warn(
              `[chat ws#${wsId}] steer rejected from ${peer} cli=${steerCli} repo=${steerRepo} chatId=${chatId} clientMsgId=${msg.clientMsgId ?? 'none'}: ${message}`,
            );
            safeSend({ type: 'steerRejected', clientMsgId: msg.clientMsgId, message, busy });
          };
          // Pin to the engine already bound on this socket. Counsel picker
          // drift (Grok 4.6 while a Claude turn is live, or vice versa) must
          // not respawn the wrong runner with a model it cannot accept.
          let steerCli: CliKind = cliKind ?? desiredSteerBrain.cli;
          let steerRepo = repoPath ?? msg.repo;
          let steerModel = authoritativeAgent ? desiredSteerBrain.model : msg.model;
          let steerEffort = authoritativeAgent ? desiredSteerBrain.effort : msg.effort;
          const bound = sessionPromise;
          // Register ownership before the FIFO wait so reconnects still see
          // this id as queued. Stop/Fresh can abort it even while it waits.
          waitKey = laneGenKey(steerCli, steerRepo, chatId);
          addLaneWaiter(waitKey, steerAborter);
          addPendingSteer(waitKey, msg.clientMsgId);
          trackSteerPayload(waitKey);
          // Ack immediately so a reconnect/hello cannot paint this bubble as
          // failed while we wait for the next tool window.
          safeSend({
            type: 'sendAdmission',
            state: 'pending',
            clientMsgId: msg.clientMsgId,
            busy: true,
            activeCli: steerCli,
          });
          enqueueThreadSteer(steerRepo, chatId, async () => {
          try {
          if (steerAborter.signal.aborted) { rejectSteer(); releaseSteer(); return; }
          let laneGen = peekLaneGen(steerCli, steerRepo, chatId);
          if (bound) {
            try {
              const current = await bound;
              if (steerAborter.signal.aborted) { rejectSteer(); releaseSteer(); return; }
              const live = sessionCli(current);
              if (live) steerCli = live;
              if (!authoritativeAgent) {
                const spawned = isClaudeFamilyCli(steerCli) ? claudeSpawnOf(current) : null;
                if (spawned) {
                  steerModel = spawned.model;
                  steerEffort = spawned.effort;
                } else {
                  if (lastTurnModel !== undefined) steerModel = lastTurnModel;
                  if (lastTurnEffort !== undefined) steerEffort = lastTurnEffort;
                }
              }
            } catch {
              // Dead bind — fall through with hello/picker values.
            }
          }
          if (steerAborter.signal.aborted) { rejectSteer(); releaseSteer(); return; }
          const resolvedKey = laneGenKey(steerCli, steerRepo, chatId);
          if (resolvedKey !== waitKey) {
            removeLaneWaiter(waitKey, steerAborter);
            deletePendingSteer(waitKey, msg.clientMsgId);
            untrackSteerPayload(waitKey);
            waitKey = resolvedKey;
            laneGen = peekLaneGen(steerCli, steerRepo, chatId);
            addLaneWaiter(waitKey, steerAborter);
            addPendingSteer(waitKey, msg.clientMsgId);
            trackSteerPayload(waitKey);
          }
          console.warn(`[chat ws#${wsId}] steer from ${peer} cli=${steerCli} repo=${steerRepo} chatId=${chatId}`);
          // Lane-scoped supersession: recheck after every await so a stopped,
          // reset, disconnected, or superseded steer never writes later.
          // An unbumped lane has no map entry while peekLaneGen reports 0, so
          // comparing the raw entry made every steer to a lane that never saw
          // a browser send/Stop/Fresh since startup look superseded and get
          // silently rejected in under a millisecond.
          const laneGenStale = () => !waitKey || (laneGenerations.get(waitKey) ?? 0) !== laneGen;
          // STRICTLY NON-DESTRUCTIVE steer: every engine finishes its current
          // turn naturally. No control interrupt and no process signal occurs.
          let session: AnySession | null = bound ? await bound.catch(() => null) : null;
          if (steerAborter.signal.aborted || laneGenStale()) { rejectSteer(); releaseSteer(); return; }
          if (
            session
            && (session as { isPrewarming?: () => boolean }).isPrewarming?.() === true
            && 'prewarm' in session
            && typeof session.prewarm === 'function'
          ) {
            await session.prewarm().catch(() => {});
            if (steerAborter.signal.aborted || laneGenStale()) { rejectSteer(); releaseSteer(); return; }
          }
          if (authoritativeAgent) desiredSteerBrain = resolvedBrain(chatId, desiredSteerBrain);
          // Only an engine swap has to wait for the natural turn end. A live
          // Grok/Claude process with a drifted picker model/effort string used
          // to look like a brain change, so steers sat until the whole turn
          // finished (20+ minutes) and the phone marked them undelivered.
          const needsAuthoritativeBoundary = Boolean(
            authoritativeAgent
            && session
            && sessionCli(session) !== desiredSteerBrain.cli
          );
          // Claude stream-json accepts same-turn input in a verified tool
          // window. Codex app-server accepts it through turn/steer throughout
          // an active turn. Images cannot ride that channel (Codex drops them
          // and Claude's tool-window stdin is text). Wait for a natural turn
          // end, then send as a new turn so the picture actually arrives.
          // A pending authoritative brain change must still wait for the
          // natural boundary so guidance cannot land on the old model after a
          // central reconfiguration.
          // Claude-family engines and Codex take steered screenshots as saved
          // files (see runner/codex-runner imagesAsFiles), so only other engines
          // wait for a turn end. Without this a Codex image steer held every
          // later steer on the thread behind it for the whole turn.
          const steerImagesAsFiles = Boolean(msg.images && msg.images.length > 0)
            && (isClaudeFamilyCli(steerCli) || steerCli === 'codex');
          const hasSteerImages = Boolean(msg.images && msg.images.length > 0) && !steerImagesAsFiles;
          let nativeActiveSteer = Boolean(
            session
            && !needsAuthoritativeBoundary
            && !hasSteerImages
            && supportsNativeTurnSteer(steerCli)
            && (session as { canAcceptNativeHumanSteer?: () => boolean })
              .canAcceptNativeHumanSteer?.() === true,
          );
          while (!nativeActiveSteer && session && sessionHasActiveBoundary(session)) {
            const boundary = await waitForSteerOrTurnEnd(
              session,
              steerAborter.signal,
              30 * 60_000,
              !hasSteerImages && !needsAuthoritativeBoundary && supportsNativeTurnSteer(steerCli),
            );
            if (steerAborter.signal.aborted || laneGenStale() || boundary === 'aborted') { rejectSteer(); releaseSteer(); return; }
            if (boundary === 'steerable') {
              if (hasSteerImages) continue;
              nativeActiveSteer = true;
              break;
            }
            if (boundary === 'closed') { session = null; break; }
            if (boundary === 'timeout') {
              // Long tool stretch. Keep waiting for a tool window or turn end.
              // Never drop the first steer.
              continue;
            }
            // Some engines immediately start an internal continuation after
            // turnEnd. Loop until the session is genuinely idle.
          }
          if (session) {
            console.warn(`[chat ws#${wsId}] guidance ${nativeActiveSteer ? `accepted in active ${steerCli} turn` : 'queued after natural turn completion'}`);
          }
          if (session && (session as { isAlive?: () => boolean }).isAlive?.() === false) session = null;
          if (authoritativeAgent && !nativeActiveSteer) {
            // Another device may have changed the global brain while this
            // guidance waited. Resolve again at the actual admission boundary.
            desiredSteerBrain = resolvedBrain(chatId, desiredSteerBrain);
            steerCli = desiredSteerBrain.cli;
            steerModel = desiredSteerBrain.model;
            steerEffort = desiredSteerBrain.effort;
            const mustReplace = Boolean(
              session
              && sessionCli(session) !== steerCli
            );
            if (mustReplace) {
              detachCurrentSession();
              session = await bindSession(getOrCreateSession({
                cli: steerCli,
                repoPath: steerRepo,
                chatId,
                model: steerModel,
                effort: steerEffort,
                recycleOnMismatch: true,
              }));
              if (steerAborter.signal.aborted) { rejectSteer(); releaseSteer(); return; }
            }
            const desiredKey = laneGenKey(steerCli, steerRepo, chatId);
            if (desiredKey !== waitKey) {
              removeLaneWaiter(waitKey, steerAborter);
              deletePendingSteer(waitKey, msg.clientMsgId);
              untrackSteerPayload(waitKey);
              waitKey = desiredKey;
              laneGen = peekLaneGen(steerCli, steerRepo, chatId);
              addLaneWaiter(waitKey, steerAborter);
              addPendingSteer(waitKey, msg.clientMsgId);
              trackSteerPayload(waitKey);
            }
          }
          if (!session) {
            // The old process is already gone; starting its normal replacement
            // is recovery, not an interrupt. Never call interruptSession here.
            detachCurrentSession();
            try {
              const replacement = await getOrCreateSession({
                cli: steerCli,
                repoPath: steerRepo,
                chatId,
                model: steerModel,
                effort: steerEffort,
              });
              if (steerAborter.signal.aborted || laneGenStale()) {
                rejectSteer();
                releaseSteer();
                return;
              }
              session = await bindSession(Promise.resolve(replacement));
              if (steerAborter.signal.aborted || laneGenStale()) {
                detachCurrentSession(); // unsubscribe the bind created after close/cancel
                rejectSteer();
                releaseSteer();
                return;
              }
            } catch (error) {
              rejectSteer(`Guidance could not bind safely: ${(error as Error).message}`);
              releaseSteer();
              safeSend({ type: 'turnEnd' });
              return;
            }
          }
          if (steerAborter.signal.aborted || laneGenStale()) { rejectSteer(); releaseSteer(); return; }
          if (authoritativeAgent && !nativeActiveSteer) {
            while (true) {
              const latestBrain = resolvedBrain(chatId, desiredSteerBrain);
              const unchanged = latestBrain.revision === desiredSteerBrain.revision
                && latestBrain.cli === desiredSteerBrain.cli
                && latestBrain.model === desiredSteerBrain.model
                && latestBrain.effort === desiredSteerBrain.effort;
              if (unchanged) break;
              desiredSteerBrain = latestBrain;
              steerCli = latestBrain.cli;
              steerModel = latestBrain.model;
              steerEffort = latestBrain.effort;
              const desiredKey = laneGenKey(steerCli, steerRepo, chatId);
              if (desiredKey !== waitKey) {
                removeLaneWaiter(waitKey, steerAborter);
                deletePendingSteer(waitKey, msg.clientMsgId);
                untrackSteerPayload(waitKey);
                waitKey = desiredKey;
                laneGen = peekLaneGen(steerCli, steerRepo, chatId);
                addLaneWaiter(waitKey, steerAborter);
                addPendingSteer(waitKey, msg.clientMsgId);
                trackSteerPayload(waitKey);
              }
              session = await bindSession(getOrCreateSession({
                cli: steerCli,
                repoPath: steerRepo,
                chatId,
                model: steerModel,
                effort: steerEffort,
                recycleOnMismatch: true,
              }));
              if (steerAborter.signal.aborted || laneGenStale()) { rejectSteer(); releaseSteer(); return; }
            }
          }
          // The native channel can close between the earlier snapshot and the
          // actual write. Wait for the next steerable event or natural end,
          // then rebind the authoritative brain before turning this into a new
          // turn. CodexSession/ClaudeSession still revalidate at send() as the
          // final no-await race guard.
          while (nativeActiveSteer && !sessionCanAcceptNativeSteer(session)) {
            if (!sessionHasActiveBoundary(session)) {
              nativeActiveSteer = false;
              break;
            }
            const boundary = await waitForSteerOrTurnEnd(
              session,
              steerAborter.signal,
              30 * 60_000,
              true,
            );
            if (steerAborter.signal.aborted || laneGenStale() || boundary === 'aborted') { rejectSteer(); releaseSteer(); return; }
            if (boundary === 'steerable') continue;
            if (boundary === 'closed') { session = null; break; }
            if (boundary === 'timeout') continue;
            nativeActiveSteer = false;
          }
          if (!session) {
            rejectSteer('Guidance target closed before delivery — try again.');
            releaseSteer();
            safeSend({ type: 'turnEnd' });
            return;
          }
          if (authoritativeAgent && !nativeActiveSteer) {
            desiredSteerBrain = resolvedBrain(chatId, desiredSteerBrain);
            steerCli = desiredSteerBrain.cli;
            steerModel = desiredSteerBrain.model;
            steerEffort = desiredSteerBrain.effort;
            const desiredKey = laneGenKey(steerCli, steerRepo, chatId);
            if (desiredKey !== waitKey) {
              removeLaneWaiter(waitKey, steerAborter);
              deletePendingSteer(waitKey, msg.clientMsgId);
              untrackSteerPayload(waitKey);
              waitKey = desiredKey;
              laneGen = peekLaneGen(steerCli, steerRepo, chatId);
              addLaneWaiter(waitKey, steerAborter);
              addPendingSteer(waitKey, msg.clientMsgId);
              trackSteerPayload(waitKey);
            }
            session = await bindSession(getOrCreateSession({
              cli: steerCli,
              repoPath: steerRepo,
              chatId,
              model: steerModel,
              effort: steerEffort,
              recycleOnMismatch: true,
            }));
            if (steerAborter.signal.aborted || laneGenStale()) { rejectSteer(); releaseSteer(); return; }
          }
          if ((session as { isAlive?: () => boolean }).isAlive?.() === false) {
            rejectSteer('Guidance target closed before delivery — try again.');
            releaseSteer();
            safeSend({ type: 'turnEnd' });
            return;
          }
          if (chatQuiesced) {
            rejectSteer('TARDIS is regenerating — try again in a few seconds.');
            releaseSteer();
            safeSend({ type: 'turnEnd' });
            return;
          }
          cliKind = steerCli;
          repoPath = steerRepo;
          busy = true;
          // This is the commit point: all cancellation/generation checks passed.
          // An idle/after-turn delivery starts a new turn. Native Claude steer
          // remains inside the already-running turn; its _user_echo carries the
          // clientMsgId that clears the client's queued state.
          logChatTurn(wsId, 'steer', steerCli, steerRepo, chatId, msg.text);
          ++turnGeneration;
          // A person's message is never dropped for a boundary race: if the lane
          // started another turn (a job wake, a handoff) between our boundary
          // and the write, wait for the next boundary and send again.
          const nativeWindowClosed = (error: unknown) =>
            /native steering window closed|must reach a safe boundary|waiting for the automation turn|still answering|steer channel closed/i.test((error as Error).message || '');
          let boundaryRetries = 0;
          try {
            for (;;) {
              if (steerAborter.signal.aborted || laneGenStale()) { rejectSteer(); releaseSteer(); return; }
              if (!nativeActiveSteer) safeSend({ type: 'turnStart', clientMsgId: msg.clientMsgId });
              try {
                await (session as any).send(msg.text, msg.images, {
                  model: steerModel,
                  effort: steerEffort,
                  clientMsgId: msg.clientMsgId,
                  allowNativeHumanSteer: nativeActiveSteer,
                  voiceMode: msg.voice === true,
                  imagesAsFiles: nativeActiveSteer && steerImagesAsFiles,
                  signal: steerAborter.signal,
                });
                break;
              } catch (error) {
                if (!nativeWindowClosed(error) || ++boundaryRetries > 1000) throw error;
                // The tool window closed (or another turn started) between
                // admission and stdin. Do not drop the message. Wait for the
                // next window or turn end, then send again.
                nativeActiveSteer = false;
                let waited = false;
                while (session && sessionHasActiveBoundary(session)) {
                  waited = true;
                  const boundary = await waitForSteerOrTurnEnd(
                    session,
                    steerAborter.signal,
                    30 * 60_000,
                    !hasSteerImages && !needsAuthoritativeBoundary && supportsNativeTurnSteer(steerCli),
                  );
                  if (steerAborter.signal.aborted || laneGenStale() || boundary === 'aborted') {
                    rejectSteer();
                    releaseSteer();
                    return;
                  }
                  if (boundary === 'steerable') {
                    nativeActiveSteer = true;
                    break;
                  }
                  if (boundary === 'closed') { session = null; break; }
                  if (boundary === 'timeout') continue;
                  break;
                }
                if (!session) {
                  rejectSteer('Guidance target closed before delivery — try again.');
                  releaseSteer();
                  safeSend({ type: 'turnEnd' });
                  return;
                }
                // Not busy yet the send still refused: give the lane a beat
                // instead of spinning.
                if (!waited) await new Promise((resolve) => setTimeout(resolve, 250));
              }
            }
          } catch (error) {
            rejectSteer(`Guidance could not be delivered: ${(error as Error).message}`);
            releaseSteer();
            safeSend({ type: 'turnEnd' });
            return;
          }
          // A send that saw the abort mid-flight (for instance while saving
          // images) returns quietly. That is not delivery: let Stop's replay or
          // the rejection path own the id instead of clearing its pending flag.
          if (steerAborter.signal.aborted) { rejectSteer(); releaseSteer(); return; }
          deletePendingSteer(waitKey, msg.clientMsgId);
          untrackSteerPayload(waitKey);
          releaseSteer();
          lastTurnModel = steerModel;
          lastTurnEffort = steerEffort;
          if (authoritativeAgent) {
            safeSend({
              type: 'selectionApplied',
              selectionRevision: selectionRevisionOf(msg.selectionRevision),
              cli: desiredSteerBrain.cli,
              model: desiredSteerBrain.model ?? null,
              effort: desiredSteerBrain.effort ?? null,
              brainRevision: desiredSteerBrain.revision,
            });
          }
          } catch (error) {
            // Guidance is never auto-resubmitted after acceptance: a cross-device
            // Stop/Fresh must not be undone by the stale-resume retry helper.
            // The inner send loop already reported and returned on delivery
            // failure, so reaching here means bind/boundary work threw.
            const stillPending = Boolean(
              waitKey && msg.clientMsgId && pendingSteers.get(waitKey)?.has(msg.clientMsgId),
            );
            if (stillPending) {
              rejectSteer(`Guidance could not be delivered: ${(error as Error).message}`);
              safeSend({ type: 'turnEnd' });
            }
            releaseSteer();
          }
          });
          return;
        }

        if (msg.type === 'send') {
          if (!await waitForHelloBarrier()) {
            sendHandshakePending(msg.clientMsgId);
            return;
          }
          if (chatQuiesced) {
            safeSend({ type: 'error', message: 'TARDIS is regenerating — try again in a few seconds.' });
            safeSend({ type: 'turnEnd' });
            return;
          }
          const requestedChatId = normalizeChatId(msg.chatId ?? chatId);
          const authoritativeAgent = agentForChatId(requestedChatId);
          let sendBrain = resolvedBrain(requestedChatId, {
            cli: msg.cli ?? cliKind ?? 'xai',
            model: msg.model,
            effort: msg.effort,
          });
          const hintedLaneMismatch = !authoritativeAgent && (
            (msg.cli !== undefined && msg.cli !== cliKind)
            || (msg.repo !== undefined && msg.repo !== repoPath)
          );
          if (requestedChatId !== chatId || hintedLaneMismatch || !repoPath) {
            sendHandshakePending(msg.clientMsgId);
            return;
          }
          let sendCli = authoritativeAgent ? sendBrain.cli : cliKind!;
          const sendRepo = repoPath;
          const logKey = laneLogKey(sendCli, sendRepo, chatId);
          const owner = msg.clientMsgId
            ? { cli: sendCli, repo: sendRepo, chatId, logKey, clientMsgId: msg.clientMsgId }
            : null;
          const admissionKey = owner
            ? sendAdmissionKey(sendCli, sendRepo, chatId, owner.clientMsgId)
            : null;
          let admission = admissionKey ? sendAdmissions.get(admissionKey) : undefined;
          if (owner && admissionKey && !admission && durableSendAccepted(sendCli, sendRepo, chatId, owner.clientMsgId)) {
            rememberSendAdmission(admissionKey, 'accepted', owner);
            admission = sendAdmissions.get(admissionKey);
          }
          let admissionOwner = admission ? activeSessionForLogKey(admission.logKey) : null;
          if (
            admission?.state === 'pending'
            && !admissionOwner
            && Date.now() - admission.at > 2 * 60_000
          ) {
            // The original owner vanished before durable admission. A short
            // grace protects the normal reserve→spawn/preparation window;
            // only a genuinely stale reservation may be retried.
            if (admissionKey) sendAdmissions.delete(admissionKey);
            admission = undefined;
          }
          if (admission) {
            safeSend({
              type: 'sendAdmission',
              state: admission.state,
              clientMsgId: admission.clientMsgId,
              busy: admission.state === 'pending' || Boolean(admissionOwner) || busy,
              // A completed historical admission must not replace ownership of
              // the currently selected/bound engine.
              activeCli: admissionOwner?.cli ?? sendCli,
            });
            return;
          }
          const competingAdmission = [...sendAdmissions.values()].find((entry) => (
            entry.logKey === logKey
            && entry.state === 'pending'
            && Date.now() - entry.at <= 2 * 60_000
          ));
          const activeThreadOwner = activeSessionForLogKey(logKey);
          if (competingAdmission || activeThreadOwner) {
            safeSend({
              type: 'sendRejected',
              clientMsgId: msg.clientMsgId,
              message: 'This agent is already working. The message was not delivered; send it again when the current turn completes.',
              busy: true,
              activeCli: activeThreadOwner?.cli ?? competingAdmission?.cli ?? sendCli,
            });
            return;
          }
          if (owner && admissionKey) {
            rememberSendAdmission(admissionKey, 'pending', owner);
            reservedSendAdmission = { key: admissionKey, clientMsgId: owner.clientMsgId };
          }
          const sendAborter = new AbortController();
          const claimedSendLanes = new Map<string, number>();
          const claimSendLane = (laneCli: CliKind) => {
            const key = laneGenKey(laneCli, sendRepo, chatId);
            if (claimedSendLanes.has(key)) return;
            const generation = bumpLaneGen(laneCli, sendRepo, chatId);
            claimedSendLanes.set(key, generation);
            addLaneWaiter(key, sendAborter);
          };
          claimSendLane(sendCli);
          // Held steers (captured by Stop instead of being destroyed) ride
          // this send, oldest first, so nothing the user said is ever lost.
          let outgoingText = msg.text;
          let outgoingImages = msg.images;
          const heldRide = takeHeldSteers(sendRepo, chatId);
          if (heldRide.length > 0) {
            const heldPrefix = heldRide.map((held) => held.text).join('\n\n');
            const heldImages = heldRide.flatMap((held) => held.images ?? []);
            outgoingText = `${heldPrefix}\n\n${outgoingText}`;
            if (heldImages.length > 0) outgoingImages = [...heldImages, ...(outgoingImages ?? [])];
            for (const held of heldRide) {
              if (held.clientMsgId) rememberDeliveredClientMsgId(held.clientMsgId);
            }
            console.warn(`[chat ws#${wsId}] merged ${heldRide.length} held steer(s) into the next send`);
          }
          ownedSteerWaiters.add(sendAborter);
          const sendCanceled = () => sendAborter.signal.aborted
            || [...claimedSendLanes].some(([key, generation]) => laneGenerations.get(key) !== generation);
          const releaseSend = () => {
            ownedSteerWaiters.delete(sendAborter);
            for (const key of claimedSendLanes.keys()) removeLaneWaiter(key, sendAborter);
          };
          try {
          if (!sessionPromise && cliKind && repoPath) {
            // Claim the turn BEFORE the spawn. The client arms its 90s silence
            // watchdog the moment it sends, and the `working` keepalive below is
            // gated on `busy`, so with busy=false a 30-70s MCP startup looked
            // like a dead socket and the client force-reconnected mid-spawn.
            // Now hello never spawns, this is the only place that cost lands.
            // Restored immediately after so the turn bookkeeping below (and
            // `wasBusy`) still sees a fresh, idle turn.
            busy = true;
            try {
              // Spawn with the picked model/effort. Omitting them started the
              // lane on defaults, and the model/effort reconcile further down
              // then SIGTERMed that brand-new process to respawn on the right
              // model - two full spawns, each paying 30-70s of MCP startup, for
              // every cold lane's first turn. That is the cost this outage fix
              // exists to kill.
              await bindSession(getOrCreateSession({
                cli: sendCli,
                repoPath,
                chatId,
                model: authoritativeAgent ? sendBrain.model : msg.model,
                effort: authoritativeAgent ? sendBrain.effort : msg.effort,
              }));
              if (sendCanceled()) return;
            } finally {
              busy = false;
            }
          }
          if (!sessionPromise) {
            sendHandshakePending(msg.clientMsgId);
            return;
          }
          if (busy && cliKind === 'codex') {
            safeSend({ type: 'error', message: 'codex is on a turn - wait for the result' });
            return;
          }
          // Studio model/effort values remain device-local and recycle only on
          // an explicit picker revision. Named teammate turns always opt in to
          // reconciling against their server-authoritative brain.
          const selectionChangeRequested = Boolean(authoritativeAgent) || msg.reconfigure === true;
          const requestedSelectionRevision = selectionRevisionOf(msg.selectionRevision);
          let selectionApplied = false;
          const generation = ++turnGeneration;
          let session: AnySession | null = await sessionPromise;
          if (sendCanceled()) return;

          if (!session && sendCli && repoPath) {
            // sessionPromise resolved to a dead/null session — rebind a fresh
            // one rather than crashing on `null.send`.
            session = await bindSession(getOrCreateSession({ cli: sendCli, repoPath, chatId, model: sendBrain.model, effort: sendBrain.effort }));
            if (sendCanceled()) return;
          }
          let initiallyBusy = Boolean(session && (session as { isBusy?: () => boolean }).isBusy?.() === true);
          if (authoritativeAgent && session && !initiallyBusy && sessionCli(session) !== sendCli) {
            session = await bindSession(getOrCreateSession({
              cli: sendCli,
              repoPath,
              chatId,
              model: sendBrain.model,
              effort: sendBrain.effort,
              recycleOnMismatch: true,
            }));
            cliKind = sendCli;
            initiallyBusy = (session as { isBusy?: () => boolean }).isBusy?.() === true;
            if (sendCanceled()) return;
          }

          // Persistent CLIs (claude/assistant): reconcile the spawned model/effort
          // with the current pick before an idle turn. An attach-only lookup on
          // every idle send also resolves a replacement made by another socket;
          // recycleOnMismatch remains explicit, so stale device defaults cannot
          // cause replacement themselves.
          if (!initiallyBusy && isClaudeFamilyCli(sendCli) && repoPath) {
            // This can wait out a boundary rotation's compaction; keep the
            // keepalive going so the client's silence watchdog does not fire.
            holdKeepalive++;
            let reconciled: Awaited<ReturnType<typeof getOrCreateSession>>;
            try {
              reconciled = await getOrCreateSession({
                cli: sendCli,
                repoPath,
                chatId,
                model: authoritativeAgent ? sendBrain.model : msg.model,
                effort: authoritativeAgent ? sendBrain.effort : msg.effort,
                recycleOnMismatch: selectionChangeRequested,
              });
            } finally {
              holdKeepalive--;
            }
            if (reconciled !== session) session = await bindSession(Promise.resolve(reconciled));
            if (sendCanceled()) return;
            if (selectionChangeRequested) {
              selectionApplied = true;
            } else {
              const spawned = claudeSpawnOf(session);
              if (spawned && (spawned.model !== msg.model || spawned.effort !== msg.effort)) {
                console.log(
                  `[chat ws#${wsId}] preserving warm ${cliKind} session across device-local model/effort mismatch`,
                );
              }
            }
          }
          if (session && (session as { isAlive?: () => boolean }).isAlive?.() === false) {
            session = repoPath && sendCli
              ? await bindSession(getOrCreateSession({ cli: sendCli, repoPath, chatId, model: authoritativeAgent ? sendBrain.model : msg.model, effort: authoritativeAgent ? sendBrain.effort : msg.effort }))
              : null;
            if (sendCanceled()) return;
          }
          if (!session) throw new Error('session unavailable, please retry');
          if (sendCanceled()) return;

          // Brain PATCHes and send admission share the Node event loop but not
          // one request. Re-resolve after every awaited spawn/reconcile and keep
          // rebinding until the revision is stable. Once stable, there are no
          // more awaits before session.send() captures this exact selection, so
          // a later PATCH is correctly a pending change for the next boundary.
          if (authoritativeAgent) {
            while (true) {
              const latestBrain = resolvedBrain(requestedChatId, sendBrain);
              const unchanged = latestBrain.revision === sendBrain.revision
                && latestBrain.cli === sendBrain.cli
                && latestBrain.model === sendBrain.model
                && latestBrain.effort === sendBrain.effort;
              if (unchanged) break;
              if ((session as { isBusy?: () => boolean }).isBusy?.() === true) {
                throw new Error('This agent started another turn before admission. Please send again when it finishes.');
              }

              const previousCli = sendCli;
              sendBrain = latestBrain;
              sendCli = latestBrain.cli;
              claimSendLane(sendCli);
              if (reservedSendAdmission && previousCli !== sendCli) {
                const priorKey = reservedSendAdmission.key;
                const current = sendAdmissions.get(priorKey);
                if (current) {
                  sendAdmissions.delete(priorKey);
                  const nextOwner = {
                    cli: sendCli,
                    repo: sendRepo,
                    chatId,
                    logKey: laneLogKey(sendCli, sendRepo, chatId),
                    clientMsgId: current.clientMsgId,
                  };
                  const nextKey = sendAdmissionKey(sendCli, sendRepo, chatId, current.clientMsgId);
                  rememberSendAdmission(nextKey, current.state, nextOwner);
                  reservedSendAdmission.key = nextKey;
                }
              }
              session = await bindSession(getOrCreateSession({
                cli: sendCli,
                repoPath: sendRepo,
                chatId,
                model: sendBrain.model,
                effort: sendBrain.effort,
                recycleOnMismatch: true,
              }));
              cliKind = sendCli;
              if (sendCanceled()) return;
            }
          }

          // Recompute after every awaited owner/rebind operation. Another send
          // may have started this session while we yielded.
          const wasBusy = (session as { isBusy?: () => boolean }).isBusy?.() === true;
          busy = wasBusy;
          if (!wasBusy) {
            busy = true;
            safeSend({ type: 'turnStart' });
          } else if (cliKind === 'codex') {
            safeSend({ type: 'error', message: 'codex is on a turn - wait for the result' });
            return;
          }
          if (chatQuiesced) {
            safeSend({ type: 'error', message: 'TARDIS is regenerating — try again in a few seconds.' });
            safeSend({ type: 'turnEnd' });
            return;
          }
          if (authoritativeAgent) selectionApplied = true;
          logChatTurn(wsId, 'send', cliKind, repoPath, chatId, outgoingText);
          if (reservedSendAdmission) {
            const admission = reservedSendAdmission;
            unsubscribeSendAdmission = session.subscribe((event) => {
              if (userEchoClientMsgId(event.ev) !== admission.clientMsgId) return;
              const current = sendAdmissions.get(admission.key);
              if (!current) return;
              rememberSendAdmission(admission.key, 'accepted', current);
            }, session.latestSeq(), false);
          }
          await (session as any).send(outgoingText, outgoingImages, {
            model: authoritativeAgent ? sendBrain.model : msg.model,
            effort: authoritativeAgent ? sendBrain.effort : msg.effort,
            clientMsgId: msg.clientMsgId,
            voiceMode: msg.voice === true,
            signal: sendAborter.signal,
          });
          if (sendCanceled()) return;
          if (selectionApplied) {
            safeSend({
              type: 'selectionApplied',
              selectionRevision: requestedSelectionRevision,
              cli: authoritativeAgent ? sendBrain.cli : undefined,
              model: authoritativeAgent ? sendBrain.model ?? null : undefined,
              effort: authoritativeAgent ? sendBrain.effort ?? null : undefined,
              brainRevision: authoritativeAgent ? sendBrain.revision : undefined,
            });
          }
          lastTurnModel = authoritativeAgent ? sendBrain.model : msg.model;
          lastTurnEffort = authoritativeAgent ? sendBrain.effort : msg.effort;
          void retryOnceAfterStaleResume(
            session,
            outgoingText,
            generation,
            outgoingImages,
            authoritativeAgent ? sendBrain.model : msg.model,
            authoritativeAgent ? sendBrain.effort : msg.effort,
            msg.clientMsgId,
            msg.voice === true,
          );
          } finally {
            releaseSend();
          }
        }
      } catch (error) {
        busy = false;
        if (error instanceof MemoryPressureSpawnError) {
          console.warn(`[chat ws#${wsId}] memory-pressure spawn refused: ${error.message}`);
          safeSend({
            type: 'error',
            code: error.code,
            retryable: true,
            clientMsgId: msg.type === 'send' ? msg.clientMsgId : undefined,
            message: error.message,
          });
        } else {
          safeSend({
            type: 'error',
            clientMsgId: msg.type === 'send' ? msg.clientMsgId : undefined,
            message: (error as Error).message,
          });
        }
        safeSend({ type: 'turnEnd' });
      } finally {
        finishHello?.();
        unsubscribeSendAdmission?.();
        if (
          reservedSendAdmission
          && sendAdmissions.get(reservedSendAdmission.key)?.state === 'pending'
        ) {
          sendAdmissions.delete(reservedSendAdmission.key);
          safeSend({
            type: 'sendRejected',
            clientMsgId: reservedSendAdmission.clientMsgId,
            message: 'The message was not admitted by the agent. Please send it again.',
            busy,
          });
        }
      }
    });

    ws.on('close', () => {
      stopExternalEvents();
      stopSessionCreated();
      socketThreads.delete(ws);
      clearInterval(heartbeat);
      clearInterval(keepalive);
      // Do not abort ownedSteerWaiters here. The server already accepted those
      // messages; they must cross the natural turn boundary even if a mobile
      // tab sleeps, navigates to another agent, or reconnects. releaseSteer()
      // removes each waiter after delivery/rejection. Lane Stop/Fresh still
      // aborts them through bumpLaneGen(). Stacked steers wait in FIFO.
      unsubscribe?.();
      unsubscribe = null;
      const set = peerSockets.get(peerKey);
      if (set) {
        set.delete(ws);
        if (set.size === 0) peerSockets.delete(peerKey);
      }
      if (watchedLane) {
        unwatchThread(watchedLane.repo, watchedLane.chatId, wsId);
        watchedLane = null;
      }
      console.log(`[chat ws#${wsId}] close`);
    });
  });

  const idleReaper = setInterval(() => {
    const now = Date.now();
    const pruned = pruneIdleClaudeSessions(IDLE_SESSION_TTL_MS, now)
      + pruneIdleCodexSessions(IDLE_SESSION_TTL_MS, now)
      + pruneIdleBananaSessions(IDLE_SESSION_TTL_MS, now);
    if (pruned > 0) console.log(`[chat idle-reaper] pruned ${pruned} idle session(s)`);
  }, IDLE_REAPER_INTERVAL_MS);
  idleReaper.unref();

  return () => {
    clearInterval(idleReaper);
    server.off('upgrade', onUpgrade);
    shutdownAllSessions();
    shutdownAllCodexSessions();
    shutdownAllBananaSessions();
    wss.close();
  };
}
