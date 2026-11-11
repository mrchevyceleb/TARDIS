// T3 Code sessions that belong to a TARDIS agent.
//
// The launcher records who started a session (POST /api/t3-sessions). From
// then on TARDIS reads each host's thread list, one call per host per tick and
// only while that host has a session to watch, and keeps one record per owned
// session. Everything else is derived from those records:
//   - a session that is holding for its owner (its latest run ended, or it
//     stopped mid-run to ask a question) and whose owner has not been told is
//     owed a wake: the owner gets one teammate message (holds that land close
//     together share it);
//   - a session whose latest run is still going shows under its owner in team
//     status and the roster.
// A session nobody registered (a person's own) has no record, so it never wakes
// anyone.

import { listAgents, type Agent } from '../chat/agents.ts';
import { MAX_TEXT, deliverTeamMessage } from '../chat/teamBus.ts';
import { JsonStore } from './jsonStore.ts';
import { T3ToolError, t3Call, t3Host, t3Hosts, type T3Host } from './t3Hosts.ts';

export type T3Session = {
  /** `${host}:${threadId}` */
  id: string;
  host: string;
  threadId: string;
  ownerId: string;
  title: string;
  link?: string;
  /** T3's own thread status, as last seen. */
  status: string;
  /** The latest run, as last seen. */
  runId?: string;
  /** When TARDIS first saw that run. */
  runStartedAt: number;
  /** When TARDIS first saw that run finished. */
  runEndedAt?: number;
  /** The open question a running session is blocked on, and when TARDIS saw it. */
  askId?: string;
  askedAt?: number;
  /** What the owner was last told about: a run id or a question id. */
  toldFor?: string;
  createdAt?: string;
  updatedAt?: string;
};

type T3Thread = { threadId: string; title: string; link?: string; status: string; latestRunId: string | null; itemCount?: number; updatedAt?: string };
type T3ThreadList = { threads: T3Thread[]; nextCursor: number | null };
type T3ThreadRead = {
  thread: T3Thread;
  recentRuns: Array<{ runId: string; status: string; startedAt?: string; completedAt?: string }>;
  items: Array<{ type: string; runId: string; text?: string; textTruncated?: boolean }>;
};
type T3Question = { questions?: Array<{ question?: string; options?: Array<{ label?: string }> }> };

const TICK_MS = 5_000;
/** Holds that begin inside this window reach the owner as one message. */
const BUNDLE_MS = 10_000;
/** A resting session stays watched this long after its last run ended, so a
 *  follow-up turn on it still wakes its owner. Past that it is forgotten. */
const WATCH_REST_MS = 7 * 24 * 60 * 60_000;
/** Sessions in one wake message; any more ride the next one. */
const MAX_PER_WAKE = 8;
const LIVE_STATUSES = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const MAX_LIST_PAGES = 20;
const REPLY_TAIL_ITEMS = 40;
const MAX_REPLY_CHARS = 2_500;

const store = new JsonStore<T3Session>('t3-sessions.json', []);
const sessions = new Map<string, T3Session>();
/** Per session: T3's last-activity stamp as last seen, and whether open
 *  questions were looked for since it stopped moving. Rebuilt after a restart. */
const activity = new Map<string, { at?: string; asked: boolean }>();
/** Hosts whose last look failed. Their sessions wait: nothing is read from them
 *  until they answer again, and the outage is logged once, not every tick. */
const unreachable = new Set<string>();
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const cleanTitle = (title: string | undefined): string => (title ?? '').trim().slice(0, 200);
let loaded: Promise<void> | null = null;

function load(): Promise<void> {
  loaded ??= store.list().then((items) => { for (const item of items) sessions.set(item.id, item); });
  return loaded;
}

async function persist(): Promise<void> {
  await store.replace([...sessions.values()]);
}

const isLive = (session: T3Session): boolean => LIVE_STATUSES.has(session.status);
/** What the session is holding for its owner: a question it stopped to ask, or its ended turn. */
const heldFor = (session: T3Session): string | undefined => (isLive(session) ? session.askId : session.runId);
const heldSince = (session: T3Session): number => (isLive(session) ? session.askedAt : session.runEndedAt) ?? 0;
/** It is holding and the owner has not been told. */
const owedWake = (session: T3Session): boolean => Boolean(heldFor(session)) && heldFor(session) !== session.toldFor;
const watched = (session: T3Session, now: number): boolean =>
  isLive(session) || owedWake(session) || now - (session.runEndedAt ?? session.runStartedAt) < WATCH_REST_MS;

function findAgent(ref: string): Agent | undefined {
  const needle = ref.trim().toLowerCase();
  return listAgents().find((agent) => agent.id === needle || agent.name.trim().toLowerCase() === needle);
}

/** Fold what T3 says about a thread into its record. True when it changed. */
function observe(session: T3Session, thread: T3Thread, quiet: boolean, now: number): boolean {
  const before = JSON.stringify(session);
  session.title = cleanTitle(thread.title) || session.title;
  if (thread.link) session.link = thread.link;
  const runId = thread.latestRunId ?? undefined;
  if (runId !== session.runId) {
    session.runId = runId;
    session.runStartedAt = now;
    delete session.runEndedAt;
  }
  session.status = thread.status;
  if (isLive(session)) delete session.runEndedAt;
  else session.runEndedAt ??= now;
  // A question stands only while the session stays quiet behind it.
  if (!isLive(session) || !quiet) { delete session.askId; delete session.askedAt; }
  return JSON.stringify(session) !== before;
}

/** A running session that went quiet may have stopped to ask its owner a
 *  question; T3 keeps calling it running. Looked up once per quiet spell. */
async function observeQuestion(host: T3Host, session: T3Session, now: number): Promise<boolean> {
  try {
    const { requestIds } = await t3Call<{ requestIds?: string[] }>(host, 't3_pending_request', { action: 'list', threadId: session.threadId });
    const askId = requestIds?.[0];
    if (askId === session.askId) return false;
    if (askId) Object.assign(session, { askId, askedAt: now });
    else { delete session.askId; delete session.askedAt; }
    return true;
  } catch (error) {
    if (error instanceof T3ToolError) return false;
    throw error;
  }
}

/** One pass over a host's thread list, stopping once every watched session has
 *  been seen. A watched session the whole list no longer carries was archived
 *  or deleted, so its record goes too. */
async function observeHost(host: T3Host, now: number): Promise<boolean> {
  const missing = new Set([...sessions.values()].filter((s) => s.host === host.name && watched(s, now)).map((s) => s.id));
  if (!missing.size) return false;
  let changed = false;
  const wentQuiet: T3Session[] = [];
  let cursor: number | null = null;
  for (let page = 0; page < MAX_LIST_PAGES && missing.size; page++) {
    const list: T3ThreadList = await t3Call(host, 't3_thread_list', { allProjects: true, limit: 100, ...(cursor === null ? {} : { cursor }) });
    if (unreachable.delete(host.name)) console.log(`[t3] ${host.name} is readable again`);
    for (const thread of list.threads) {
      const session = sessions.get(`${host.name}:${thread.threadId}`);
      if (!session) continue;
      missing.delete(session.id);
      let seen = activity.get(session.id);
      const quiet = seen?.at === thread.updatedAt;
      if (!seen || !quiet) activity.set(session.id, seen = { at: thread.updatedAt, asked: false });
      changed = observe(session, thread, quiet, now) || changed;
      if (isLive(session) && quiet && !seen.asked) wentQuiet.push(session);
    }
    cursor = list.nextCursor ?? null;
    if (cursor === null) {
      for (const id of missing) sessions.delete(id);
      changed = changed || missing.size > 0;
      break;
    }
  }
  for (const session of wentQuiet) {
    // Marked looked-for only once the look succeeded, so a failed one runs again next tick.
    try {
      changed = await observeQuestion(host, session, now) || changed;
      const seen = activity.get(session.id);
      if (seen) seen.asked = true;
    } catch (error) {
      console.warn(`[t3] could not check "${session.title}" on ${host.name} for a question, will retry: ${errorText(error)}`);
    }
  }
  return changed;
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `text`, cut short with an ellipsis if it is longer than `budget`. */
const fit = (text: string, budget: number): string => (text.length > budget ? `${text.slice(0, budget - 2)} …` : text);

/** What the session is holding for, in at most `budget` characters: the
 *  question it asked (`held` is its id), or how the run `held` ended and the
 *  last thing the session said in it. */
async function report(session: T3Session, held: string, budget: number): Promise<string> {
  const host = t3Host(session.host)!;
  const name = `"${session.title}" on ${session.host}`;
  if (isLive(session)) {
    const ask: T3Question = await t3Call(host, 't3_pending_request', { action: 'read', threadId: session.threadId, requestId: held });
    const asks = (ask.questions ?? []).map((q) => {
      const options = (q.options ?? []).map((option) => option.label).filter(Boolean).join(' / ');
      return `${q.question ?? ''}${options ? ` (${options})` : ''}`;
    }).join('\n');
    return fit(`${name}: stopped to ask you a question and is blocked until you answer. Thread ${session.threadId}\nIt asks:\n${asks || '(open it to see the question)'}`, budget);
  }
  const head: T3ThreadRead = await t3Call(host, 't3_thread_read', { threadId: session.threadId, limit: 1, maxCharsPerItem: 1, runLimit: 1 });
  const afterPosition = Math.max(0, (head.thread.itemCount ?? 0) - REPLY_TAIL_ITEMS);
  const tail: T3ThreadRead = await t3Call(host, 't3_thread_read', { threadId: session.threadId, afterPosition, limit: 100, maxCharsPerItem: Math.min(MAX_REPLY_CHARS, budget), runLimit: 5 });
  // Only ever the run the owner is being told about. If T3 has moved past it,
  // this throws, the wake stays owed, and the next look picks up the newer run.
  const run = tail.recentRuns.find((candidate) => candidate.runId === held);
  if (!run) throw new Error('the turn it ended is no longer among its recent runs');
  const message = tail.items.filter((item) => item.type === 'assistant_message' && item.runId === run.runId && item.text?.trim()).at(-1);
  const text = message?.text?.trim() ?? '';
  const ranMs = Date.parse(run.completedAt ?? '') - Date.parse(run.startedAt ?? '');
  const outcome = `${run.status}${Number.isFinite(ranMs) ? ` after ${ago(ranMs)}` : ''}`;
  const reply = text ? `${text}${message?.textTruncated ? ' …' : ''}` : '(it ended without a written reply)';
  return fit(`${name}: ${outcome}. Thread ${session.threadId}\nIts last reply:\n${reply}`, budget);
}

/** One message for everything an owner is owed. Marks them told only once the
 *  team bus has the message durably. */
async function wakeOwner(ownerId: string, allOwed: T3Session[]): Promise<boolean> {
  const owner = listAgents().find((agent) => agent.id === ownerId);
  if (!owner) {
    for (const session of allOwed) sessions.delete(session.id);
    return true;
  }
  // Every block gets an equal share, so the whole message always fits the team bus.
  const budget = Math.floor((MAX_TEXT - 400) / Math.min(allOwed.length, MAX_PER_WAKE));
  const told: Array<{ session: T3Session; held: string }> = [];
  const blocks: string[] = [];
  for (const session of allOwed.sort((a, b) => heldSince(a) - heldSince(b))) {
    if (told.length === MAX_PER_WAKE) break;
    const held = heldFor(session)!;
    // One session that cannot be read never holds back the others, and never
    // takes a place in the message; it stays owed.
    try {
      blocks.push(await report(session, held, budget));
      told.push({ session, held });
    } catch (error) {
      console.warn(`[t3] could not read "${session.title}" on ${session.host} for ${owner.name}, will retry: ${errorText(error)}`);
    }
  }
  if (!told.length) return false;
  const lead = blocks.length === 1 ? 'Your T3 session is waiting on you.' : `${blocks.length} of your T3 sessions are waiting on you.`;
  const text = [lead, ...blocks, 'Act on it now: answer it, follow up, review the work, or tell it /bloom.'].join('\n\n');
  const result = await deliverTeamMessage({ from: 'T3 Code', to: owner.id, text, wait: false });
  if (!result.delivered) {
    console.warn(`[t3] wake for ${owner.name} not accepted (${result.reason ?? 'no reason'}); will retry`);
    return false;
  }
  // A session handed to someone else while this was in flight still owes its new owner.
  for (const { session, held } of told) if (session.ownerId === owner.id) session.toldFor = held;
  console.log(`[t3] woke ${owner.name}: ${told.map(({ session }) => `"${session.title}" on ${session.host}`).join(', ')}`);
  return true;
}

async function wakeOwners(now: number): Promise<boolean> {
  const byOwner = new Map<string, T3Session[]>();
  for (const session of sessions.values()) {
    if (!owedWake(session) || unreachable.has(session.host)) continue;
    byOwner.set(session.ownerId, [...(byOwner.get(session.ownerId) ?? []), session]);
  }
  let changed = false;
  for (const [ownerId, owed] of byOwner) {
    // The bundle window opens at the first hold and closes BUNDLE_MS later.
    if (now - Math.min(...owed.map(heldSince)) < BUNDLE_MS) continue;
    try {
      changed = await wakeOwner(ownerId, owed) || changed;
    } catch (error) {
      console.warn(`[t3] wake for ${ownerId} failed, will retry: ${errorText(error)}`);
    }
  }
  return changed;
}

let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await load();
    const now = Date.now();
    let changed = false;
    await Promise.all(t3Hosts().map(async (host) => {
      try {
        changed = await observeHost(host, now) || changed;
      } catch (error) {
        if (!unreachable.has(host.name)) console.warn(`[t3] ${host.name} not readable, will keep trying: ${errorText(error)}`);
        unreachable.add(host.name);
      }
    }));
    // Forget sessions that rested past the watch window or whose host is gone.
    for (const session of [...sessions.values()]) {
      if (!watched(session, now) || !t3Host(session.host)) { sessions.delete(session.id); changed = true; }
    }
    for (const id of activity.keys()) if (!sessions.has(id)) activity.delete(id);
    changed = await wakeOwners(now) || changed;
    if (changed) await persist();
  } catch (error) {
    console.warn('[t3] session watch tick failed:', errorText(error));
  } finally {
    ticking = false;
  }
}

/** Watch owned T3 sessions. A no-op until RIVENDELL_T3_HOSTS names a host. */
export function startT3SessionWatch(): void {
  if (!t3Hosts().length) return;
  console.log(`[t3] watching agent-owned sessions on ${t3Hosts().map((host) => host.name).join(', ')}`);
  setInterval(() => void tick(), TICK_MS).unref();
  void tick();
}

export type T3SessionRegistration = { ok: true; session: T3Session } | { ok: false; status: number; error: string };

/** Record that an agent started (or took over) a session. */
export async function registerT3Session(input: { owner: string; host: string; threadId: string; title?: string; link?: string }): Promise<T3SessionRegistration> {
  if (!t3Hosts().length) return { ok: false, status: 503, error: 'T3 session watching is not configured on this server (RIVENDELL_T3_HOSTS).' };
  const host = t3Host(input.host);
  if (!host) return { ok: false, status: 400, error: `Unknown T3 host "${input.host}". Known hosts: ${t3Hosts().map((h) => h.name).join(', ')}.` };
  const owner = findAgent(input.owner);
  if (!owner) return { ok: false, status: 404, error: `No teammate named "${input.owner}".` };
  const threadId = input.threadId.trim();
  if (!threadId) return { ok: false, status: 400, error: 'threadId is required.' };
  await load();
  const id = `${host.name}:${threadId}`;
  // An existing record is updated in place: a wake in flight holds it.
  const session: T3Session = sessions.get(id) ?? { id, host: host.name, threadId, ownerId: owner.id, title: threadId, status: 'starting', runStartedAt: Date.now() };
  // A new owner has not been told anything yet.
  if (session.ownerId !== owner.id) { session.ownerId = owner.id; delete session.toldFor; }
  session.title = cleanTitle(input.title) || session.title;
  if (input.link) session.link = input.link;
  sessions.set(id, session);
  await persist();
  void tick();
  return { ok: true, session };
}

export type LiveT3Session = { id: string; host: string; threadId: string; ownerId: string; title: string; link?: string; state: string; runningSince: number };

/** Sessions with a run going right now, oldest first. `state` is T3's status,
 *  or `asking` while the run is blocked on a question for its owner. */
export function liveT3Sessions(ownerId?: string): LiveT3Session[] {
  return [...sessions.values()]
    .filter((session) => isLive(session) && (!ownerId || session.ownerId === ownerId))
    .sort((a, b) => a.runStartedAt - b.runStartedAt)
    .map((session) => ({
      id: session.id, host: session.host, threadId: session.threadId, ownerId: session.ownerId, title: session.title,
      ...(session.link ? { link: session.link } : {}),
      state: session.askId ? 'asking' : session.status, runningSince: session.runStartedAt,
    }));
}
