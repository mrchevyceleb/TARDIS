// Outgoing-promise scanning (card-baadaf gap 1): a time an agent promises in
// its own team_message gets a matching commitment automatically, so a promise
// can never silently vanish. Pure on purpose: the message path calls it
// fire-and-forget, the add route parses dues with the same clock parser, and
// the past-due sweep matches on the stored absolute instants.

import { addCommitment, listCommitments } from './commitmentStore.ts';

/** Every clock the team writes is Eastern, on any host. */
const ZONE = 'America/New_York';

/** A marker word. Plain "at" is deliberately not one: relayed third-party
 *  deadlines ("Max's freeze at 8:35") must not become the sender's promise. */
const MARKER = /by|before|due|no later than|new time/i;

/** A marker-clock pair: the marker, optional connectors ("due by 6", "new
 *  time: 6:25", "by about 8pm"), then a clock. The clock belongs to the
 *  marker that governs it, not to the first clock anywhere in the sentence
 *  ("Before I meet Max at 5pm, I'll finish by 8pm" pairs 8pm, and "before I
 *  meet" pairs nothing because no clock directly follows it). An am/pm marker
 *  is required (an ambiguous bare "8:35" is never anyone's promise), the
 *  hour must be a real 12-hour hour, and digit boundaries keep a larger
 *  number from hiding one. */
const PAIR = /\b(?:by|before|due|no later than|new time)\b(?:\s*(?:by|about|around)|:)?\s*((?<!\d)(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)(?!\d))(?:\s*(?:et|edt|est))?\b/gi;

const DAY = /\b(today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
const DAY_ALL = new RegExp(DAY.source, 'gi');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export type PromisedTime = { due: string; dueAt: number; clause: string };

/** The zone offset (ms) of an instant, so wall-clock times resolve in the
 *  team's timezone on any host and across DST changes. */
function zoneOffsetMs(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce<Record<string, string>>((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - date.getTime();
}

/** Resolve a wall-clock in the team's zone to an epoch instant (two-pass, so
 *  a DST boundary lands on the right side). */
function instantInZone(year: number, month0: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month0, day, hour, minute);
  let at = guess - zoneOffsetMs(new Date(guess));
  at = at - zoneOffsetMs(new Date(at));
  return at;
}

/** `now` as a wall-clock in the team's zone. */
function wallInZone(date: Date): { y: number; m0: number; d: number; weekday: number } {
  const shifted = new Date(date.getTime() - zoneOffsetMs(date));
  return {
    y: shifted.getUTCFullYear(),
    m0: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/** The day word that governs one marker-clock pair: the day word nearest the
 *  marker inside the pair's local window. A day word may lead the marker
 *  ("Tomorrow, Wed Oct 14, by 10:00am") or trail the clock ("by 10pm ET
 *  today"), and with two promises in one sentence the nearest word keeps
 *  each pair on its own day instead of the sentence's first. */
function dayWordNear(window: string, markerStart: number): { word: string; index: number } | undefined {
  let best: { word: string; index: number } | undefined;
  let bestDist = Infinity;
  DAY_ALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DAY_ALL.exec(window)) !== null) {
    const dist = Math.abs(m.index - markerStart);
    if (dist < bestDist) {
      bestDist = dist;
      best = { word: m[1], index: m.index };
    }
  }
  return best;
}

/** Place one clock on the calendar, governed by its day word. "today" in the
 *  past stays in the past (a late promise must flag, not roll); a bare clock
 *  or "tonight" that already passed rolls to the next day (an 11pm "by 1am"
 *  is tomorrow's 1am, not three hours overdue); tomorrow is tomorrow; a
 *  weekday is its next occurrence; a month-day stays this year (a past
 *  month-day is an already-late promise). Null when the pieces cannot
 *  resolve. */
function resolveClock(text: string, dayWord: string | undefined, clockText: string, now: Date): number | null {
  const m = clockText.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2] ?? '0', 10);
  const mer = m[3].toLowerCase();
  if (mer === 'pm' && hour < 12) hour += 12;
  if (mer === 'am' && hour === 12) hour = 0;
  const word = dayWord?.toLowerCase();
  const wall = wallInZone(now);
  let y = wall.y;
  let m0 = wall.m0;
  let d = wall.d;
  let rollsWhenPast = false;
  if (word === 'tomorrow') {
    d += 1;
  } else if (word === 'today') {
    // explicit today: a past time is late, never rolled
  } else if (word === 'tonight') {
    rollsWhenPast = true;
  } else if (word) {
    const weekday = WEEKDAYS.indexOf(word.slice(0, 3));
    if (weekday >= 0) {
      d += ((weekday - wall.weekday + 7) % 7) || 7;
    } else {
      const month = MONTHS.indexOf(word.slice(0, 3));
      if (month < 0) return null;
      const dayNum = parseInt((text.match(new RegExp(`${dayWord}\\s+(\\d{1,2})`, 'i')) ?? [])[1] ?? '0', 10);
      if (dayNum < 1 || dayNum > 31) return null;
      m0 = month;
      d = dayNum;
    }
  } else {
    rollsWhenPast = true;
  }
  let at = instantInZone(y, m0, d, hour, minute);
  if (rollsWhenPast && at <= now.getTime()) {
    at = instantInZone(y, m0, d + 1, hour, minute);
  }
  return at;
}

/** The display form: the clock, a trailing ET marker when the text carries
 *  one, and the day phrase in full ("10:00am ET Wed Oct 14", never a month
 *  word with its day number dropped). */
function dueDisplay(text: string, dayWord: string | undefined, clockText: string, matchEnd: number): string {
  const tz = text.slice(matchEnd).match(/^\s*(et|edt|est)\b/i);
  let dayPhrase = '';
  if (dayWord) {
    const monthIdx = MONTHS.indexOf(dayWord.toLowerCase().slice(0, 3));
    if (monthIdx >= 0) {
      const dayNum = (text.match(new RegExp(`${dayWord}\\s+(\\d{1,2})`, 'i')) ?? [])[1];
      dayPhrase = dayNum ? `${dayWord} ${dayNum}` : dayWord;
    } else {
      dayPhrase = dayWord;
    }
  }
  const clock = clockText.replace(/\s+/g, '').toLowerCase();
  return `${clock}${tz ? ' ET' : ''}${dayPhrase ? ` ${dayPhrase}` : ''}`;
}

/** Every promise clause in `text`: a marker governing a clock in one
 *  sentence, resolved to an absolute instant. */
export function findPromisedTimes(text: string, now: Date = new Date()): PromisedTime[] {
  const out: PromisedTime[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (sentence.length < 8 || !MARKER.test(sentence)) continue;
    PAIR.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PAIR.exec(sentence)) !== null) {
      const clockText = match[1];
      // The pair's local window, not the whole sentence, so two promises in
      // one sentence each keep their own day word (nearest the marker).
      const at = match.index ?? 0;
      const windowFrom = Math.max(0, at - 60);
      const local = sentence.slice(windowFrom, Math.min(sentence.length, at + match[0].length + 30));
      const day = dayWordNear(local, at - windowFrom);
      const dueAt = resolveClock(local, day?.word, clockText, now);
      if (dueAt === null) continue;
      const due = dueDisplay(local, day?.word, clockText, at + match[0].length - windowFrom);
      out.push({ due, dueAt, clause: sentence });
    }
  }
  return out;
}

/** Parse a stored due string to its moment, or null when it does not parse.
 *  Unparsable dues are never flagged: the sweep only raises what it can read. */
export function parseDue(due: string, now: Date = new Date()): number | null {
  const match = due.match(/(?<!\d)(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)(?!\d)/i);
  if (!match || match.index === undefined) return null;
  const word = due.match(DAY)?.[1];
  return resolveClock(due, word, match[0], now);
}

/** One outgoing agent message: every promise clause that has no matching
 *  open commitment is auto-added (each with its resolved absolute instant),
 *  so no promise in the message can silently vanish. `sourceId` (the
 *  outgoing message's own id) makes the scan idempotent: a message that was
 *  already scanned is never processed twice, while distinct promises —
 *  restatements included — each land their own entry for the owner to clear.
 *  Returns every add, and the first add failure so the caller can nudge. */
export function scanOutgoingPromise(
  agentId: string,
  text: string,
  sourceId?: string,
  now: Date = new Date(),
): { added: Array<{ id: string; due: string }>; addError?: string; promise?: PromisedTime } {
  if (sourceId && listCommitments(agentId).some((c) => c.sourceId === sourceId)) {
    return { added: [] };
  }
  const promises = findPromisedTimes(text, now);
  if (!promises.length) return { added: [] };
  const added: Array<{ id: string; due: string }> = [];
  for (const promise of promises) {
    const clause = promise.clause.replace(/\s+/g, ' ').trim().slice(0, 160);
    const result = addCommitment(agentId, clause, promise.due, { dueAt: promise.dueAt, sourceId });
    if (result.error) return { added, addError: result.error, promise };
    added.push({ id: result.commitment!.id, due: promise.due });
  }
  return { added };
}
