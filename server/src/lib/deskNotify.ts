// Needs-you alerts for the owner's phone (Pushover), plus the retry loop for
// answers the owning agent has not heard yet. Started from index.ts.
//
// Policy, all in America/New_York:
//  - A high item pushes at once between 08:00 and 17:59, any day. Outside that
//    it is held and goes out on the first tick at or after 08:00.
//  - A high item still open 3h after its push gets one "Still waiting" push,
//    on weekdays inside the same hours. After that it rides the digests.
//  - Weekday digests at 09:30, 13:30 and 16:30 when anything is open. A slot
//    is caught up within 20 minutes (a restart) and never repeats. Its top
//    three lines skip items older than 24h (they count in "+N more" only).
//  - A high item whose linked card sits in Pipeline is parked: it never pushes,
//    never re-nudges and ranks as normal in digests. It alerts again if the
//    card leaves Pipeline while the item is still open.
//  - Normal and low items never push on their own.
// Every send is at most once: the attempt is on disk before the network call,
// and one left mid-flight by a crash counts as sent.
// State: ~/.rivendell/desk-notify.json (RIVENDELL_DESK_NOTIFY_FILE overrides).
// RIVENDELL_DESK_NOTIFY=off starts nothing at all (answer retries included).
// The Pushover keys are read from the environment and never logged or stored.

import { readFile } from 'node:fs/promises';
import { DESK_NOTIFY_FILE } from '../config.ts';
import { readDesk, writeJsonAtomic, type DeskCard, type DeskData, type DeskTodo } from './deskStore.ts';

const TICK_MS = 60_000;
const DAY_START_MIN = 8 * 60;
const DAY_END_MIN = 18 * 60;
const RENUDGE_AFTER_MS = 3 * 60 * 60_000;
const RETRY_SPACING_MS = 5 * 60_000;
const MAX_TRIES = 6;
const DIGEST_SLOTS_MIN = [9 * 60 + 30, 13 * 60 + 30, 16 * 60 + 30];
const DIGEST_GRACE_MIN = 20;
const ANSWER_RETRY_MS = 60_000;
/** After half an hour of failures, keep trying but less often. */
const ANSWER_SLOW_AFTER_MS = 30 * 60_000;
const ANSWER_SLOW_RETRY_MS = 10 * 60_000;
/** Past a day of failures the answer is still not dropped: hourly until it lands
 *  (or the item is reopened or deleted, which clears the answer). */
const ANSWER_DAY_MS = 24 * 60 * 60_000;
const ANSWER_HOURLY_RETRY_MS = 60 * 60_000;
/** A delivery claim this old with no outcome means the server stopped mid-send
 *  (or the send hung): reclaim it. A repeated message to an agent is harmless;
 *  a lost answer is not. */
export const ANSWER_CLAIM_STALE_MS = 5 * 60_000;
/** Records for items that left the Desk are dropped after this long. Never
 *  sooner: a desk.json moved aside for repair must not re-arm every push. */
const FORGET_AFTER_MS = 14 * 24 * 60 * 60_000;
const DIGEST_KEEP_DAYS = 8;
/** Items older than this stay out of a digest's top lines (still counted). */
const DIGEST_LINE_MAX_AGE_MS = 24 * 60 * 60_000;
export const PUSHOVER_ENDPOINT = 'https://api.pushover.net/1/messages.json';

// ---- Eastern time -----------------------------------------------------------

const easternFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export type EasternClock = { day: string; weekday: string; minutes: number; label: string };

export function easternClock(at: Date): EasternClock {
  const p: Record<string, string> = {};
  for (const part of easternFormat.formatToParts(at)) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    minutes: hour * 60 + Number(p.minute),
    label: `${String(hour).padStart(2, '0')}:${p.minute} ET`,
  };
}

function inPushHours(clock: EasternClock): boolean {
  return clock.minutes >= DAY_START_MIN && clock.minutes < DAY_END_MIN;
}

function isWeekend(clock: EasternClock): boolean {
  return clock.weekday === 'Sat' || clock.weekday === 'Sun';
}

/** True when a high item must not raise an alert right now (18:00 to 07:59
 *  ET). The Desk summary hands this to clients so every surface agrees. */
export function isQuietHours(at: Date = new Date()): boolean {
  return !inPushHours(easternClock(at));
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// ---- payloads and senders -------------------------------------------------------

export type PushPayload = { title: string; message: string; priority: 0 | 1; url?: string; url_title?: string };
export type PushResult = { ok: true; dryRun?: boolean } | { ok: false; error: string };
export type PushSender = (payload: PushPayload) => Promise<PushResult>;

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Where the phone link points. No default: an install that has not said where
 *  it is served sends alerts without a link rather than a wrong one. */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.RIVENDELL_PUBLIC_URL?.trim() ?? '').replace(/\/+$/, '');
}

function deskLink(baseUrl: string, target: string): Pick<PushPayload, 'url' | 'url_title'> {
  return baseUrl ? { url: `${baseUrl}/?desk=${encodeURIComponent(target)}`, url_title: 'Open in TARDIS' } : {};
}

/** The body never carries the item's detail: it lands on a lock screen through
 *  a third-party push service, and detail is where amounts and numbers live.
 *  The title is the only content; the detail waits behind the tap. */
export function itemPayload(todo: DeskTodo, kind: 'push' | 'renudge', baseUrl: string): PushPayload {
  return {
    title: clipText(kind === 'renudge' ? `Still waiting: ${todo.title}` : todo.title, 250),
    message: todo.from.kind === 'agent' ? `${todo.from.name} needs you` : 'Open the Desk.',
    priority: 1,
    ...deskLink(baseUrl, todo.id),
  };
}

/** A high item whose card is parked in Pipeline is not asking for the owner
 *  right now: no push, no re-nudge, no high rank in a digest. */
export function isParkedHigh(todo: DeskTodo, cards: DeskCard[]): boolean {
  if (todo.priority !== 'high' || !todo.cardId) return false;
  return cards.find((c) => c.id === todo.cardId)?.column === 'pipeline';
}

/** Count, then the top three (high first, then oldest), then "+N more". Parked
 *  highs rank as normal, and items older than 24h only count in "+N more". */
export function digestPayload(open: DeskTodo[], baseUrl: string, cards: DeskCard[] = [], nowMs: number = Date.now()): PushPayload {
  const rank = (t: DeskTodo) => Number(t.priority === 'high' && !isParkedHigh(t, cards));
  const ranked = [...open].sort((a, b) => rank(b) - rank(a) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const shown = ranked.filter((t) => nowMs - Date.parse(t.createdAt) <= DIGEST_LINE_MAX_AGE_MS).slice(0, 3);
  const lines = [`${ranked.length} open:`, ...shown.map((t) => `- ${clipText(t.title, 120)}`)];
  if (ranked.length > shown.length) lines.push(`+${ranked.length - shown.length} more`);
  return { title: 'Needs you', message: lines.join('\n'), priority: 0, ...deskLink(baseUrl, 'open') };
}

export function pushoverSender(opts: { token: string; user: string; endpoint?: string; timeoutMs?: number }): PushSender {
  const endpoint = opts.endpoint ?? PUSHOVER_ENDPOINT;
  // Whatever comes back (an error list, a fetch failure) is scrubbed of the
  // keys before it can reach a log line.
  const scrub = (text: string) =>
    [opts.token, opts.user].reduce((out, secret) => (secret ? out.split(secret).join('[key]') : out), text);
  return async (payload) => {
    const form = new URLSearchParams({
      token: opts.token,
      user: opts.user,
      title: payload.title,
      message: payload.message,
      priority: String(payload.priority),
    });
    if (payload.url) {
      form.set('url', payload.url);
      if (payload.url_title) form.set('url_title', payload.url_title);
    }
    try {
      const res = await fetch(endpoint, { method: 'POST', body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
      const json = (await res.json().catch(() => null)) as { status?: unknown; errors?: unknown } | null;
      if (res.ok && json?.status === 1) return { ok: true };
      const errors = Array.isArray(json?.errors) ? json.errors.slice(0, 3).map(String).join('; ') : '';
      return { ok: false, error: scrub(`HTTP ${res.status}${errors ? `: ${errors}` : ''}`) };
    } catch (error) {
      return { ok: false, error: scrub((error as Error).message || 'request failed') };
    }
  };
}

/** Logs the exact payload that would go out (it never holds the keys). */
export function dryRunSender(log: (line: string) => void = console.log): PushSender {
  return async (payload) => {
    log(`[desk-notify] dry run, would send ${JSON.stringify(payload)}`);
    return { ok: true, dryRun: true };
  };
}

export type NotifyMode = 'off' | 'dry-run' | 'live';

export function notifyModeFromEnv(env: NodeJS.ProcessEnv = process.env): NotifyMode {
  if (['off', '0', 'false', 'no'].includes((env.RIVENDELL_DESK_NOTIFY ?? '').trim().toLowerCase())) return 'off';
  if (['1', 'true', 'yes', 'on'].includes((env.RIVENDELL_DESK_NOTIFY_DRY_RUN ?? '').trim().toLowerCase())) return 'dry-run';
  return 'live';
}

/** The sender this environment allows, or null when nothing may go out. */
export function senderFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { endpoint?: string; log?: (line: string) => void } = {}): PushSender | null {
  const mode = notifyModeFromEnv(env);
  if (mode === 'off') return null;
  if (mode === 'dry-run') return dryRunSender(opts.log);
  const token = env.PUSHOVER_API_KEY?.trim();
  const user = env.PUSHOVER_USER_KEY?.trim();
  if (!token || !user) return null;
  return pushoverSender({ token, user, endpoint: opts.endpoint });
}

// ---- state ------------------------------------------------------------------------

/** One alert's progress. Finished once sent, seeded on first run, skipped, or
 *  given up on. `sendingAt` is the claim written just before the network call. */
type Send = { tries: number; lastTryAt?: string; sendingAt?: string; sentAt?: string; seededAt?: string; failedAt?: string; skipped?: 'empty' };
type ItemState = { push?: Send; renudge?: Send; doneSeen?: boolean };
type NotifyState = { version: 1; createdAt: string; items: Record<string, ItemState>; digests: Record<string, Send> };

function finished(send: Send | undefined): boolean {
  return Boolean(send && (send.sentAt || send.seededAt || send.failedAt || send.skipped));
}

function readyToTry(send: Send | undefined, nowMs: number): boolean {
  if (!send) return true;
  if (finished(send) || send.tries >= MAX_TRIES) return false;
  return !send.lastTryAt || nowMs - Date.parse(send.lastTryAt) >= RETRY_SPACING_MS;
}

function lastTouched(item: ItemState): number {
  const stamps = [item.push, item.renudge].flatMap((s) => (s ? [s.lastTryAt, s.sentAt, s.seededAt, s.failedAt] : []));
  return Math.max(0, ...stamps.map((s) => (s ? Date.parse(s) : 0)).filter(Number.isFinite));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function loadState(file: string, log: (line: string) => void): Promise<NotifyState | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && (parsed.version === undefined || parsed.version === 1) && isRecord(parsed.items) && isRecord(parsed.digests)) {
      const items: Record<string, ItemState> = {};
      for (const [id, value] of Object.entries(parsed.items)) {
        if (!isRecord(value)) continue;
        const item: ItemState = {};
        const push = cleanSend(value.push);
        const renudge = cleanSend(value.renudge);
        if (push) item.push = push;
        if (renudge) item.renudge = renudge;
        items[id] = item;
      }
      const digests: Record<string, Send> = {};
      for (const [key, value] of Object.entries(parsed.digests)) {
        const send = cleanSend(value);
        if (send && /^\d{4}-\d{2}-\d{2} /.test(key)) digests[key] = send;
      }
      return {
        version: 1,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
        items,
        digests,
      };
    }
  } catch {
    // fall through: treated like a first run, which seeds and never blasts
  }
  log(`[desk-notify] ${file} was unreadable or from a newer version; starting over as a first run`);
  return null;
}

/** Keep only well-formed fields, so a hand-edited file cannot crash every tick. */
function cleanSend(value: unknown): Send | undefined {
  if (!isRecord(value)) return undefined;
  const send: Send = { tries: typeof value.tries === 'number' && Number.isFinite(value.tries) ? Math.max(0, Math.floor(value.tries)) : 0 };
  for (const key of ['lastTryAt', 'sendingAt', 'sentAt', 'seededAt', 'failedAt'] as const) {
    const stamp = value[key];
    if (typeof stamp === 'string' && Number.isFinite(Date.parse(stamp))) send[key] = stamp;
  }
  if (value.skipped === 'empty') send.skipped = 'empty';
  return send;
}

/** A send the server stopped in the middle of may already have reached the
 *  phone, so it counts as sent rather than going out twice. */
function settleInterrupted(st: NotifyState, log: (line: string) => void): boolean {
  let settled = false;
  const settle = (send: Send | undefined, what: string) => {
    if (!send?.sendingAt) return;
    send.sentAt = send.sendingAt;
    delete send.sendingAt;
    settled = true;
    log(`[desk-notify] ${what} was mid-send when the server stopped; counted as sent so it never repeats`);
  };
  for (const [id, item] of Object.entries(st.items)) {
    settle(item.push, `push ${id}`);
    settle(item.renudge, `re-nudge ${id}`);
  }
  for (const [key, digest] of Object.entries(st.digests)) settle(digest, `digest ${key}`);
  return settled;
}

// ---- the notifier -------------------------------------------------------------------

export type AnswerRetry = (todoId: string) => Promise<{ delivered: boolean; to?: string; reason?: string }>;

export type DeskNotifierOptions = {
  /** null when nothing may go out (off, or no keys). Answer retries still run. */
  send: PushSender | null;
  /** Re-tells the owning agent about an answer that was saved but not heard. */
  retryAnswer?: AnswerRetry;
  stateFile?: string;
  baseUrl?: string;
  now?: () => Date;
  readDesk?: () => Promise<DeskData>;
  log?: (line: string) => void;
};

export type DeskNotifier = {
  /** One pass of the policy at `at` (the clock's now by default). */
  tick: (at?: Date) => Promise<void>;
  /** A tick now, coalesced: one in flight at a time, never throws. */
  run: () => Promise<void>;
};

/** `build` runs against a fresh read right before the send, so an item
 *  answered or lowered since the tick started never goes out; null skips. */
type Job = {
  send: Send;
  what: string;
  heldKey?: string;
  /** Re-nudges and digests never go out on a weekend. */
  weekdayOnly?: boolean;
  build: (data: DeskData) => PushPayload | null;
  onGone?: () => void;
};

export function createDeskNotifier(opts: DeskNotifierOptions): DeskNotifier {
  const now = opts.now ?? (() => new Date());
  // Items created after this process started are new work, not backlog, even
  // when the very first tick (and its one-time seeding) runs a moment later.
  const bootMs = now().getTime();
  const read = opts.readDesk ?? readDesk;
  const log = opts.log ?? ((line: string) => console.log(line));
  const stateFile = opts.stateFile ?? DESK_NOTIFY_FILE;
  const baseUrl = (opts.baseUrl ?? publicBaseUrl()).replace(/\/+$/, '');
  let state: NotifyState | null | undefined;
  const heldLogged = new Set<string>();
  const answerTriedAt = new Map<string, number>();
  const answerNoted = new Set<string>();
  let running: Promise<void> | null = null;
  let again = false;

  const save = (st: NotifyState) => writeJsonAtomic(stateFile, st);

  async function ensureState(data: DeskData, at: Date): Promise<NotifyState> {
    if (state === undefined) {
      state = await loadState(stateFile, log);
      if (state && settleInterrupted(state, log)) await save(state);
    }
    if (state) return state;
    // First run: every item already open rides the digests instead of
    // arriving as a burst, including one created a moment before this tick.
    const stamp = at.toISOString();
    const fresh: NotifyState = { version: 1, createdAt: stamp, items: {}, digests: {} };
    let seeded = 0;
    for (const todo of data.todos) {
      if (todo.status !== 'open') continue;
      if (Date.parse(todo.createdAt) >= bootMs) continue;
      fresh.items[todo.id] = { push: { tries: 0, seededAt: stamp }, renudge: { tries: 0, seededAt: stamp } };
      seeded += 1;
    }
    // Same for digest slots that have already started today: a first boot at
    // 13:38 must not send the 13:30 digest late (Matt would get it twice when
    // something else already covered that slot). Later slots still go out.
    const clock = easternClock(at);
    let slotsSeeded = 0;
    for (const slot of DIGEST_SLOTS_MIN) {
      if (clock.minutes < slot) continue;
      fresh.digests[`${clock.day} ${hhmm(slot)}`] = { tries: 0, seededAt: stamp };
      slotsSeeded += 1;
    }
    await save(fresh);
    state = fresh;
    log(`[desk-notify] first run: ${seeded} open item${seeded === 1 ? '' : 's'} marked as already pushed; they ride the digests${slotsSeeded ? `; ${slotsSeeded} earlier digest slot${slotsSeeded === 1 ? '' : 's'} today marked handled` : ''}`);
    return fresh;
  }

  function prune(st: NotifyState, data: DeskData, clock: EasternClock, nowMs: number): boolean {
    let dirty = false;
    const ids = new Set(data.todos.map((t) => t.id));
    for (const [id, item] of Object.entries(st.items)) {
      if (!ids.has(id) && nowMs - lastTouched(item) > FORGET_AFTER_MS) {
        delete st.items[id];
        dirty = true;
      }
    }
    const [y, m, d] = clock.day.split('-').map(Number);
    const oldest = new Date(Date.UTC(y, m - 1, d - DIGEST_KEEP_DAYS)).toISOString().slice(0, 10);
    for (const key of Object.keys(st.digests)) {
      if (key.slice(0, 10) < oldest) {
        delete st.digests[key];
        dirty = true;
      }
    }
    return dirty;
  }

  function hold(key: string, line: string): void {
    if (heldLogged.has(key)) return;
    heldLogged.add(key);
    log(line);
  }

  async function retryAnswers(data: DeskData, nowMs: number): Promise<void> {
    if (!opts.retryAnswer) return;
    for (const todo of data.todos) {
      const answer = todo.answer;
      if (answer?.delivery !== 'failed') continue;
      // A fresh claim is a delivery in flight right now. One older than the
      // stale limit means the server stopped mid-send: fall through and retry.
      if (answer.sendingAt && nowMs - Date.parse(answer.sendingAt) <= ANSWER_CLAIM_STALE_MS) continue;
      const answeredAt = Date.parse(answer.at);
      const age = nowMs - answeredAt;
      if (age > ANSWER_DAY_MS && !answerNoted.has(todo.id)) {
        answerNoted.add(todo.id);
        log(`[desk-notify] the answer to ${todo.id} "${todo.title}" is still undelivered after 24 hours; trying hourly until it lands`);
      }
      // The answer route itself tried at answer time, so space from that too.
      const spacing = age > ANSWER_DAY_MS ? ANSWER_HOURLY_RETRY_MS : age > ANSWER_SLOW_AFTER_MS ? ANSWER_SLOW_RETRY_MS : ANSWER_RETRY_MS;
      if (nowMs - Math.max(answeredAt, answerTriedAt.get(todo.id) ?? 0) < spacing) continue;
      answerTriedAt.set(todo.id, nowMs);
      try {
        const result = await opts.retryAnswer(todo.id);
        log(result.delivered
          ? `[desk-notify] answer to ${todo.id} delivered to ${result.to ?? 'the owning agent'} on retry`
          : `[desk-notify] answer to ${todo.id} still not delivered: ${result.reason ?? 'unknown reason'}`);
      } catch (error) {
        log(`[desk-notify] answer to ${todo.id} retry failed: ${(error as Error).message}`);
      }
    }
  }

  async function tick(at: Date = now()): Promise<void> {
    const data = await read();
    const nowMs = at.getTime();
    await retryAnswers(data, nowMs);
    if (!opts.send) return;
    const st = await ensureState(data, at);
    const clock = easternClock(at);
    let dirty = prune(st, data, clock, nowMs);
    // A pushed item that was completed and then reopened is asking for the owner
    // again: forget that it was pushed so it alerts like a new one.
    for (const todo of data.todos) {
      const item = st.items[todo.id];
      if (!item) continue;
      if (todo.status === 'done' && !item.doneSeen) {
        item.doneSeen = true;
        dirty = true;
      } else if (todo.status === 'open' && item.doneSeen) {
        delete item.push;
        delete item.renudge;
        delete item.doneSeen;
        dirty = true;
        log(`[desk-notify] ${todo.id} "${todo.title}" was reopened: alerting again if it is high priority`);
      }
    }
    const open = data.todos.filter((t) => t.status === 'open');
    const dayHours = inPushHours(clock);
    const weekday = !isWeekend(clock);
    const stamp = at.toISOString();
    const jobs: Job[] = [];

    const itemJob = (todo: DeskTodo, kind: 'push' | 'renudge', send: Send): Job => ({
      send,
      what: `${kind === 'push' ? 'push' : 're-nudge'} ${todo.id} "${todo.title}"`,
      heldKey: `${kind}:${todo.id}`,
      weekdayOnly: kind === 'renudge',
      build: (fresh) => {
        const current = fresh.todos.find((t) => t.id === todo.id);
        return current?.status === 'open' && current.priority === 'high' && !isParkedHigh(current, fresh.cards)
          ? itemPayload(current, kind, baseUrl)
          : null;
      },
    });
    const digestJob = (key: string, send: Send): Job => ({
      send,
      what: `digest ${key}`,
      weekdayOnly: true,
      build: (fresh) => {
        const stillOpen = fresh.todos.filter((t) => t.status === 'open');
        return stillOpen.length ? digestPayload(stillOpen, baseUrl, fresh.cards, now().getTime()) : null;
      },
      onGone: () => { send.skipped = 'empty'; },
    });

    for (const todo of open) {
      if (todo.priority !== 'high') continue;
      if (isParkedHigh(todo, data.cards)) {
        hold(`parked:${todo.id}`, `[desk-notify] ${todo.id} "${todo.title}" is parked (its card is in Pipeline): no push or re-nudge until the card moves`);
        continue;
      }
      heldLogged.delete(`parked:${todo.id}`);
      const item = (st.items[todo.id] ??= {});
      const name = `${todo.id} "${todo.title}"`;
      if (!finished(item.push)) {
        if (!dayHours) {
          hold(`push:${todo.id}`, `[desk-notify] held push ${name}: quiet hours (${clock.label}), goes out at 08:00 ET`);
        } else if (readyToTry(item.push, nowMs)) {
          jobs.push(itemJob(todo, 'push', (item.push ??= { tries: 0 })));
        }
        continue;
      }
      if (!item.push?.sentAt || finished(item.renudge) || nowMs - Date.parse(item.push.sentAt) < RENUDGE_AFTER_MS) continue;
      if (!dayHours || !weekday) {
        const why = weekday ? `quiet hours (${clock.label})` : 'weekend';
        hold(`renudge:${todo.id}`, `[desk-notify] held re-nudge ${name}: ${why}, goes out at the next weekday 08:00 ET`);
      } else if (readyToTry(item.renudge, nowMs)) {
        jobs.push(itemJob(todo, 'renudge', (item.renudge ??= { tries: 0 })));
      }
    }

    if (weekday) {
      for (const slot of DIGEST_SLOTS_MIN) {
        if (clock.minutes < slot || clock.minutes >= slot + DIGEST_GRACE_MIN) continue;
        const key = `${clock.day} ${hhmm(slot)}`;
        const record = st.digests[key];
        if (finished(record)) continue;
        if (!open.length) {
          // Recorded anyway, so an item added at 09:40 does not trigger a late 09:30 digest.
          st.digests[key] = { ...(record ?? { tries: 0 }), skipped: 'empty' };
          dirty = true;
          log(`[desk-notify] digest ${key} skipped: nothing open`);
        } else if (readyToTry(record, nowMs)) {
          jobs.push(digestJob(key, (st.digests[key] ??= { tries: 0 })));
        }
      }
    }
    // A digest that already failed keeps its retry schedule past the 20
    // minute window, but only that weekday's daytime; after a restart at
    // night or the next day it is given up rather than sent late.
    for (const [key, record] of Object.entries(st.digests)) {
      if (finished(record) || !record.tries || jobs.some((j) => j.send === record)) continue;
      if (key.slice(0, 10) !== clock.day || !weekday || !dayHours) {
        record.failedAt = stamp;
        dirty = true;
        log(`[desk-notify] gave up on digest ${key}: too late to send it now (${clock.label})`);
      } else if (readyToTry(record, nowMs)) {
        jobs.push(digestJob(key, record));
      }
    }

    for (const job of jobs) {
      // The clock may have moved on since the tick started (a tick begun at
      // 17:59, a slow send before this one); the next tick picks it up.
      const clockNow = easternClock(now());
      if (!inPushHours(clockNow) || (job.weekdayOnly && isWeekend(clockNow))) {
        log(`[desk-notify] held ${job.what}: outside the allowed hours now (${clockNow.label})`);
        continue;
      }
      const payload = job.build(await read());
      if (!payload) {
        job.onGone?.();
        dirty = true;
        log(`[desk-notify] skipped ${job.what}: nothing needs it any more`);
        continue;
      }
      job.send.tries += 1;
      job.send.lastTryAt = stamp;
      job.send.sendingAt = stamp;
      // The claim is on disk before the network call: a crash mid-send is
      // counted as sent on restart, never repeated.
      await save(st);
      const result = await opts.send(payload);
      delete job.send.sendingAt;
      if (result.ok) {
        job.send.sentAt = stamp;
        if (job.heldKey) heldLogged.delete(job.heldKey);
        log(`[desk-notify] ${result.dryRun ? 'dry run, counted as sent' : 'sent'} ${job.what}`);
      } else if (job.send.tries >= MAX_TRIES) {
        job.send.failedAt = stamp;
        log(`[desk-notify] gave up on ${job.what} after ${job.send.tries} tries: ${result.error}`);
      } else {
        log(`[desk-notify] ${job.what} failed (try ${job.send.tries} of ${MAX_TRIES}), retrying in 5 minutes: ${result.error}`);
      }
      dirty = true;
    }
    if (dirty) await save(st);
  }

  function run(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await tick();
          } catch (error) {
            console.warn(`[desk-notify] tick failed: ${(error as Error).message}`);
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return { tick, run };
}

// ---- the running instance ---------------------------------------------------------

let active: { notifier: DeskNotifier; timers: NodeJS.Timeout[] } | null = null;

/** Start the 60s tick. Options override the environment (scratch runs).
 *  null when RIVENDELL_DESK_NOTIFY=off: nothing starts, not even answer
 *  retries (the answer route still tells the agent once, as it always does). */
export function startDeskNotifier(opts: Partial<DeskNotifierOptions> & { retryAnswer: AnswerRetry }): DeskNotifier | null {
  if (active) return active.notifier;
  const mode = notifyModeFromEnv();
  if (mode === 'off' && opts.send === undefined) {
    console.log('[desk-notify] off (RIVENDELL_DESK_NOTIFY=off): no phone alerts, digests or answer retries');
    return null;
  }
  const send = opts.send !== undefined ? opts.send : senderFromEnv();
  if (mode === 'dry-run') console.log('[desk-notify] dry run: payloads are logged, nothing is sent');
  else if (!send) console.warn('[desk-notify] PUSHOVER_API_KEY or PUSHOVER_USER_KEY is not set; phone alerts stay off until both are');
  const notifier = createDeskNotifier({ ...opts, send });
  const every = setInterval(() => { void notifier.run(); }, TICK_MS);
  // First pass soon after boot, so a first run seeds before new items arrive.
  const first = setTimeout(() => { void notifier.run(); }, 3_000);
  every.unref?.();
  first.unref?.();
  active = { notifier, timers: [every, first] };
  return notifier;
}

export function stopDeskNotifier(): void {
  if (!active) return;
  for (const timer of active.timers) clearTimeout(timer);
  active = null;
}

/** A todo was created or its priority changed: tick now so a new high item
 *  goes out within a second instead of a minute. Fire and forget. */
export function notifyTodoTouched(): void {
  if (active) void active.notifier.run();
}
