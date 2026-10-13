// Outgoing-promise scanning (card-baadaf gap 1): a time an agent promises in
// its own team_message gets a matching commitment automatically, so a promise
// can never silently vanish. Pure on purpose: the message path calls it
// fire-and-forget, and the past-due sweep reuses the same clock parser.

import { addCommitment, listCommitments } from './commitmentStore.ts';

/** The clock forms the team actually writes: "6:40pm", "10pm", "10:00am ET".
 *  Bare times without an am/pm marker stay unparsed: an ambiguous "8:35"
 *  never becomes anyone's promise or flag. */
const TIME = /(\d{1,2}):(\d{2})\s*(am|pm)|(\d{1,2})\s*(am|pm)/i;
const DAY = /\b(today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** A promise marker and a clock time in the same sentence. Plain "at 8:35" is
 *  deliberately not a marker: relayed third-party deadlines ("Max's freeze at
 *  8:35") must not become the sender's own promise. */
const MARKER = /\b(by|before|due|no later than|new time)\b/i;

export type PromisedTime = { due: string; dueAt: number; clause: string };

/** Place one matched clock time (with any nearby day word) on the calendar.
 *  Assumes the server runs in the team's timezone, which it does. Returns
 *  null when the pieces cannot resolve to a real moment. */
function resolveClock(sentence: string, match: RegExpMatchArray, now: Date): number | null {
  let hour: number;
  let minute: number;
  let meridiem: string;
  if (match[1] !== undefined) {
    hour = parseInt(match[1], 10);
    minute = parseInt(match[2], 10);
    meridiem = match[3].toLowerCase();
  } else {
    hour = parseInt(match[4], 10);
    minute = 0;
    meridiem = match[5].toLowerCase();
  }
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hour, minute);
  const day = sentence.match(DAY);
  if (day) {
    const word = day[1].toLowerCase();
    if (word === 'tomorrow') {
      d.setDate(d.getDate() + 1);
    } else if (word !== 'today' && word !== 'tonight') {
      const weekday = WEEKDAYS.indexOf(word.slice(0, 3));
      if (weekday >= 0) {
        let add = (weekday - d.getDay() + 7) % 7;
        if (add === 0 && d.getTime() <= now.getTime()) add = 7;
        d.setDate(d.getDate() + add);
      } else {
        const month = MONTHS.indexOf(word.slice(0, 3));
        if (month < 0) return null;
        const dayNum = parseInt((sentence.match(new RegExp(`${day[1]}\\s+(\\d{1,2})`, 'i')) ?? [])[1] ?? '0', 10);
        if (dayNum < 1 || dayNum > 31) return null;
        d.setMonth(month, dayNum);
        if (d.getTime() <= now.getTime()) d.setFullYear(d.getFullYear() + 1);
      }
    }
  }
  return d.getTime();
}

/** The display form for a matched time: the time text, a trailing ET marker
 *  when the sentence carries one, and the day word when there is one. */
function dueDisplay(sentence: string, match: RegExpMatchArray): string {
  const end = (match.index ?? 0) + match[0].length;
  const tz = sentence.slice(end).match(/^\s*(ET|EDT|EST)/i);
  const day = sentence.match(DAY);
  return `${match[0].replace(/\s+/g, '').toLowerCase()}${tz ? ` ${tz[1].toUpperCase()}` : ''}${day ? ` ${day[1].toLowerCase()}` : ''}`;
}

/** Every promise clause in `text`: a marker word plus a clock time in one
 *  sentence, resolved to a moment. */
export function findPromisedTimes(text: string, now: Date = new Date()): PromisedTime[] {
  const out: PromisedTime[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (sentence.length < 8 || !MARKER.test(sentence)) continue;
    const time = sentence.match(TIME);
    if (!time || time.index === undefined) continue;
    const dueAt = resolveClock(sentence, time, now);
    if (dueAt === null) continue;
    out.push({ due: dueDisplay(sentence, time), dueAt, clause: sentence });
  }
  return out;
}

/** Parse a stored due string to its moment, or null when it does not parse.
 *  Unparsable dues are never flagged: the sweep only raises what it can read. */
export function parseDue(due: string, now: Date = new Date()): number | null {
  const time = due.match(TIME);
  if (!time || time.index === undefined) return null;
  return resolveClock(due, time, now);
}

/** One outgoing agent message: the first promise clause with no matching open
 *  commitment (same owner, parsed due within ten minutes) is auto-added, so
 *  restating a time with a new value still lands while the stale entry waits
 *  for its owner to clear it. Returns what happened so the caller can nudge
 *  when the add itself failed. One add per message: a promise message almost
 *  always carries one time, and the seed list stays small. */
export function scanOutgoingPromise(
  agentId: string,
  text: string,
  now: Date = new Date(),
): { added?: { id: string }; addError?: string; promise?: PromisedTime } {
  const promises = findPromisedTimes(text, now);
  if (!promises.length) return {};
  const mine = listCommitments(agentId);
  for (const promise of promises) {
    const matched = mine.some((c) => {
      if (!c.due) return false;
      const at = parseDue(c.due, now);
      return at !== null && Math.abs(at - promise.dueAt) <= 10 * 60_000;
    });
    if (matched) continue;
    const clause = promise.clause.replace(/\s+/g, ' ').trim().slice(0, 160);
    const result = addCommitment(agentId, clause, promise.due.slice(0, 40));
    if (result.error) return { promise, addError: result.error };
    return { added: { id: result.commitment!.id }, promise };
  }
  return {};
}
