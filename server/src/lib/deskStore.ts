// The Desk: "Needs you" todos for the owner plus a board of agent work.
// Store: ~/.rivendell/desk.json (RIVENDELL_DESK_FILE overrides the path).
//
// Every mutation runs read -> change -> atomic write inside one in-process
// lock, so two agents writing at the same moment cannot clobber each other.
// Only this server writes the file; the team MCP reaches it over HTTP.

import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DESK_FILE } from '../config.ts';
import { closeMattAsksForAgent } from './mattAsks.ts';
import { queueMirror } from './deskMirror.ts';
import { inQuietHours, isQuietExemptLane, lastQuietEndMs } from './quietHours.ts';
import { LIVE_HOLD_CEILING_MS, agentsWithLiveTurns } from './laneLiveness.ts';

// Matt's five stages (2026-10-09; order staging-first per the locked rally
// release process, 2026-10-10). Old ids (pipeline, up_next, waiting, done)
// are accepted as aliases for one release via COLUMN_ALIASES; stored cards
// migrate lazily through parseColumn's read-repair on load.
export const DESK_COLUMNS = ['not_started', 'in_progress', 'on_staging', 'in_qa', 'in_production'] as const;
export type DeskColumn = (typeof DESK_COLUMNS)[number];
export const DESK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type DeskPriority = (typeof DESK_PRIORITIES)[number];

export type DeskActor = { kind: 'owner' | 'agent'; id: string; name: string };

/** The owner's one-tap (or typed) answer to a Needs-you item. */
export type DeskAnswer = {
  choice?: string;
  text?: string;
  at: string;
  /** sent: the owning agent was told. failed: not yet (retried for a while,
   *  and a crash between saving and telling lands here too). none: the
   *  owner's own item, nobody to tell. */
  delivery: 'sent' | 'failed' | 'none';
  /** Set while the owning agent is being told. One left behind by a crash
   *  means the outcome is unknown, so it is never sent again (at most once). */
  sendingAt?: string;
};

export type DeskTodo = {
  id: string;
  title: string;
  detail?: string;
  from: DeskActor;
  createdAt: string;
  updatedAt: string;
  /** YYYY-MM-DD */
  due?: string;
  priority: DeskPriority;
  /** http(s) URL or `thread:<agentId>` */
  link?: string;
  status: 'open' | 'done';
  completedAt?: string;
  cardId?: string;
  /** Pick-one options for a one-tap answer (the Desk offers Yes / No when absent). */
  choices?: string[];
  answer?: DeskAnswer;
};

export type DeskComment = { id: string; author: DeskActor; text: string; at: string };

export type DeskCard = {
  id: string;
  title: string;
  description?: string;
  owner: DeskActor;
  column: DeskColumn;
  priority: DeskPriority;
  project?: string;
  links: string[];
  comments: DeskComment[];
  createdAt: string;
  updatedAt: string;
  /** When the card entered its current column (for "parked 4d" ages). */
  columnSince: string;
  /** Silence is an event (card-baadaf A): every In progress / In QA card
   *  carries a check-in deadline set by the owner's last touch (create,
   *  move, or comment: 30 minutes out by default, or a written check-in
   *  time in the comment honored up to 12 hours out). The hygiene tick
   *  nudges the owner when it passes; 15 quiet minutes later it nudges the
   *  Chief. Only a new touch (a fresh nextCheckAt) clears the nudges. */
  nextCheckAt?: string;
  /** True when nextCheckAt came from a written check-in time in a comment
   *  (not the computed touch window): the read-repair caps it at
   *  CARD_NEXT_CHECK_WRITTEN_MAX_MS instead of CARD_NEXT_CHECK_MS, so a
   *  legitimate park (an overnight quiet-hours park) survives reloads while
   *  no deadline can suppress checks indefinitely. */
  nextCheckWritten?: boolean;
  nudgeAt?: string;
  escalatedAt?: string;
  createdBy?: DeskActor;
  archived?: boolean;
};

/** The check-in window: every owner touch without a written time sets a
 *  deadline this far out, and no such touch can push it further. */
export const CARD_NEXT_CHECK_MS = 30 * 60_000;
/** A written next check-in time in a comment is honored up to this far out:
 *  long enough for an overnight quiet-hours park, never long enough to
 *  suppress checks on a live card indefinitely. */
export const CARD_NEXT_CHECK_WRITTEN_MAX_MS = 12 * 60 * 60_000;
/** Quiet time after the owner nudge before the Chief copy. */
export const CARD_CHECK_ESCALATE_MS = 15 * 60_000;

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

const WRITTEN_CHECK_PHRASE = /\bcheck[\s-]?in\b/gi;
// A time may state its zone: ET/Eastern is the team convention and honored;
// any other recognized zone is rejected rather than silently rescheduled as
// Eastern (a PT time would otherwise fire three hours early). The list is
// deliberately conservative: an unrecognized zone still assumes Eastern.
const WRITTEN_CHECK_TIME = /(?:\b(\d{1,2}):(\d{2})\s*(am|pm)?|\b(\d{1,2})\s*(am|pm))(?:\s*(et|eastern|pt|pacific|pst|pdt|ct|central|cst|cdt|mt|mountain|mst|mdt|utc|gmt|cet))?\b/i;
const WRITTEN_CHECK_ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const WRITTEN_CHECK_MONTH_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i;
const WRITTEN_CHECK_MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** A month abbreviation's period ("Oct. 15") is part of the date, not a
 *  sentence break. */
const WRITTEN_CHECK_MONTH_ABBR_PERIOD = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.(?=\s)/gi;

/** ET wall clock -> UTC instant. Every written Desk time is Eastern (the
 *  team's convention), so a check-in time is read in America/New_York. Two
 *  passes because the DST offset depends on the instant being found. A wall
 *  time that does not exist on the ET calendar returns NaN so it can never
 *  become a deadline: a spring-forward gap like 2:30 AM on the jump day, or
 *  an impossible date like February 31, which Date.UTC silently rolls over.
 *  A duplicated fall-back time resolves to its first occurrence. */
function etWallToInstant(year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const etWall = (at: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(at));
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    return { year: n('year'), month: n('month'), day: n('day'), hour: n('hour') % 24, minute: n('minute') };
  };
  const etOffsetMs = (at: number): number => {
    const w = etWall(at);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - at;
  };
  const guess = wall - etOffsetMs(wall);
  const instant = wall - etOffsetMs(guess);
  // Round-trip the result through America/New_York: only a real ET wall
  // time maps back onto itself.
  const got = etWall(instant);
  if (got.year !== year || got.month !== month || got.day !== day || got.hour !== hour || got.minute !== minute) return Number.NaN;
  return instant;
}

/** The Eastern calendar year of an instant: a year-less month date uses it,
 *  never the host's year, which has already rolled over during the
 *  late-evening ET hours of December 31. */
function etCalendarYear(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).formatToParts(new Date(nowMs));
  return Number(parts.find((p) => p.type === 'year')?.value ?? '0');
}

/** Parse a written next check-in time out of a comment: "Next check-in: 5:00
 *  AM ET October 15", "Next check-in is 2026-10-15 07:30 ET, when ...",
 *  "next check-in 7:30pm". Anchored on the phrase "check-in" (a lone date or
 *  time elsewhere in a comment never moves a deadline), a "last check-in"
 *  retrospective is skipped, the time is required (a meridiem-bearing hour
 *  is 1-12; a stated ET/Eastern zone is honored, a recognized non-Eastern
 *  zone rejects the statement, Eastern is otherwise assumed), the date is
 *  optional (a time-only statement already past means tomorrow),
 *  and a dated statement already past is stale and ignored; a wall time that
 *  does not exist on the ET calendar (a DST gap or an impossible date) is
 *  ignored, and a duplicated fall-back time resolves to its first
 *  occurrence. The LAST usable
 *  statement in the comment wins. Returns the instant, or null when the
 *  comment sets no usable check-in time. */
export function parseWrittenNextCheck(text: string, nowMs: number): number | null {
  let found: number | null = null;
  for (const phrase of text.matchAll(WRITTEN_CHECK_PHRASE)) {
    const start = phrase.index ?? 0;
    if (/\blast\s*$/i.test(text.slice(0, start))) continue;
    // The statement lives between the phrase and the next sentence break; a
    // month abbreviation's period is part of the date, not a break.
    const rest = text
      .slice(start + phrase[0].length)
      .replace(WRITTEN_CHECK_MONTH_ABBR_PERIOD, '$1');
    const cut = rest.search(/[.;\n]/);
    const window = (cut === -1 ? rest : rest.slice(0, cut)).slice(0, 80);
    const time = WRITTEN_CHECK_TIME.exec(window);
    if (!time) continue;
    const zone = (time[6] ?? '').toLowerCase();
    if (zone && zone !== 'et' && zone !== 'eastern') continue; // never silently reschedule a stated non-ET zone
    let hour = time[1] !== undefined ? Number(time[1]) : Number(time[4]);
    const minute = time[2] !== undefined ? Number(time[2]) : 0;
    const meridiem = (time[3] ?? time[5] ?? '').toLowerCase();
    if (meridiem) {
      // A 12-hour time is 1-12: "13 PM" and "0 AM" are not clock times.
      if (hour < 1 || hour > 12) continue;
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
    } else if (hour > 23) {
      continue;
    }
    if (minute > 59) continue;
    const isoDate = WRITTEN_CHECK_ISO_DATE.exec(window);
    const monthDate = WRITTEN_CHECK_MONTH_DATE.exec(window);
    let instant: number;
    if (isoDate) {
      const month = Number(isoDate[2]);
      const day = Number(isoDate[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      instant = etWallToInstant(Number(isoDate[1]), month, day, hour, minute);
    } else if (monthDate) {
      const day = Number(monthDate[2]);
      if (day < 1 || day > 31) continue;
      const year = monthDate[3] ? Number(monthDate[3]) : etCalendarYear(nowMs);
      instant = etWallToInstant(year, WRITTEN_CHECK_MONTHS[monthDate[1].toLowerCase()], day, hour, minute);
    } else {
      // No date: today in ET, or tomorrow when that time has already passed.
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(nowMs));
      const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
      instant = etWallToInstant(n('year'), n('month'), n('day'), hour, minute);
      if (instant <= nowMs) {
        // Tomorrow is a real calendar increment: a raw "day + 1" would hand
        // etWallToInstant an impossible January 32 at a month boundary.
        const tomorrow = new Date(Date.UTC(n('year'), n('month') - 1, n('day') + 1));
        instant = etWallToInstant(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute);
      }
    }
    if (!Number.isFinite(instant)) continue; // nonexistent ET wall time or impossible date
    // A stated time already passed is a stale statement, not a park.
    if (instant > nowMs) found = instant;
  }
  return found;
}

function touchCardNextCheck(card: DeskCard, nowIso: string, writtenNextCheckMs?: number | null): void {
  // Archived cards carry no check state even in a live column: a PATCH or
  // comment on an archived card must not re-create a deadline.
  if (!card.archived && (card.column === 'in_progress' || card.column === 'in_qa')) {
    const nowMs = Date.parse(nowIso);
    if (typeof writtenNextCheckMs === 'number' && Number.isFinite(writtenNextCheckMs) && writtenNextCheckMs > nowMs) {
      // A written check-in time in the comment is honored, capped at the
      // written maximum so no comment can park a live card indefinitely:
      // parking until a stated time actually silences the card until then.
      card.nextCheckAt = new Date(Math.min(writtenNextCheckMs, nowMs + CARD_NEXT_CHECK_WRITTEN_MAX_MS)).toISOString();
      card.nextCheckWritten = true;
    } else {
      card.nextCheckAt = new Date(nowMs + CARD_NEXT_CHECK_MS).toISOString();
      delete card.nextCheckWritten;
    }
    delete card.nudgeAt;
    delete card.escalatedAt;
  } else {
    delete card.nextCheckAt;
    delete card.nextCheckWritten;
    delete card.nudgeAt;
    delete card.escalatedAt;
  }
}

export type DeskData = { version: 1; rev: number; todos: DeskTodo[]; cards: DeskCard[] };

export const DESK_LIMITS = {
  title: 200,
  detail: 4000,
  description: 8000,
  comment: 4000,
  project: 60,
  link: 2000,
  links: 20,
  commentsPerCard: 400,
  todos: 2000,
  cards: 2000,
  choices: 4,
  choice: 40,
  answerText: 1000,
} as const;

/** Thrown for bad input or a missing record; routes map `status` to HTTP. */
export class DeskError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---- normalisers (shared by input validation and on-disk repair) -----------

const COLUMN_ALIASES: Record<string, DeskColumn> = {
  not_started: 'not_started', notstarted: 'not_started', pipeline: 'not_started', parked: 'not_started', backlog: 'not_started', later: 'not_started',
  up_next: 'not_started', upnext: 'not_started', next: 'not_started', todo: 'not_started',
  in_progress: 'in_progress', inprogress: 'in_progress', doing: 'in_progress', active: 'in_progress', working: 'in_progress',
  waiting: 'in_progress', waiting_on_matt: 'in_progress', waiting_on_owner: 'in_progress', blocked: 'in_progress', needs_you: 'in_progress',
  in_qa: 'in_qa', inqa: 'in_qa', qa: 'in_qa', sud: 'in_qa',
  on_staging: 'on_staging', onstaging: 'on_staging', staging: 'on_staging', merged: 'on_staging', merged_to_staging: 'on_staging',
  in_production: 'in_production', inproduction: 'in_production', production: 'in_production', live: 'in_production', done: 'in_production', complete: 'in_production', completed: 'in_production', shipped: 'in_production',
};

export function parseColumn(value: unknown): DeskColumn | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return COLUMN_ALIASES[key] ?? null;
}

export function parsePriority(value: unknown): DeskPriority | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key === 'low' || key === 'p3') return 'low';
  if (key === 'normal' || key === 'medium' || key === 'med' || key === 'default' || key === 'p2') return 'normal';
  if (key === 'high' || key === 'urgent' || key === 'critical' || key === 'p0' || key === 'p1') return 'high';
  return null;
}

function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD, '' (clear), or null when unparseable. */
export function parseDue(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'today') return localDay(0);
  if (raw === 'tomorrow') return localDay(1);
  // A bare date, or the date part of a full ISO timestamp (agents often send one).
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|t)/);
  if (!match) return null;
  if (raw.length > 10 && !Number.isFinite(Date.parse(value.trim()))) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

/** http(s) URL or `thread:<agentId>`; '' clears; null when invalid. */
export function parseLink(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return '';
  if (raw.length > DESK_LIMITS.link) return null;
  const thread = raw.match(/^thread:([a-z0-9][a-z0-9_-]{0,80})$/i);
  if (thread) return `thread:${thread[1]}`;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
}

/** Write-path clip: silently truncating on save loses data (Kip's Oct 7 backlog loss), so over-limit text is rejected with a 400 instead. */
function requireClip(value: unknown, max: number, field: string): string {
  if (typeof value === 'string' && value.replace(/\r\n?/g, '\n').trim().length > max) {
    throw new DeskError(400, `${field} must be ${max} characters or fewer`);
  }
  return clip(value, max);
}

/** Write-path one-line fields: same rejection rule with one-line normalisation. */
function requireOneLine(value: unknown, max: number, field: string): string {
  if (typeof value === 'string' && value.replace(/\s+/g, ' ').trim().length > max) {
    throw new DeskError(400, `${field} must be ${max} characters or fewer`);
  }
  return oneLine(value, max);
}

function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function isoOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function normalizeActor(value: unknown): DeskActor | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = oneLine(raw.name, 80);
  if (!name) return null;
  return { kind: raw.kind === 'owner' ? 'owner' : 'agent', id: oneLine(raw.id, 80) || name.toLowerCase(), name };
}

/** Case-insensitive dedupe that keeps the first spelling seen. */
function pushUnique(list: string[], item: string): void {
  const key = item.toLowerCase();
  if (!list.some((c) => c.toLowerCase() === key)) list.push(item);
}

/** On-disk repair: keep what fits, never throw. */
function cleanChoices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const choice = oneLine(item, DESK_LIMITS.choice);
    if (choice) pushUnique(out, choice);
  }
  return out.slice(0, DESK_LIMITS.choices);
}

function normalizeAnswer(value: unknown, fallback: string): DeskAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const choice = oneLine(raw.choice, DESK_LIMITS.choice);
  const text = clip(raw.text, DESK_LIMITS.answerText);
  if (!choice && !text) return null;
  // Unknown delivery reads as failed so the answer is retried, not lost.
  const delivery = raw.delivery === 'sent' || raw.delivery === 'none' ? raw.delivery : 'failed';
  const answer: DeskAnswer = { at: isoOr(raw.at, fallback), delivery };
  if (choice) answer.choice = choice;
  if (text) answer.text = text;
  if (typeof raw.sendingAt === 'string' && Number.isFinite(Date.parse(raw.sendingAt))) answer.sendingAt = raw.sendingAt;
  return answer;
}

function normalizeTodo(value: unknown, now: string): DeskTodo | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = oneLine(raw.id, 80);
  const title = oneLine(raw.title, DESK_LIMITS.title);
  const from = normalizeActor(raw.from);
  if (!id || !title || !from) return null;
  const todo: DeskTodo = {
    id,
    title,
    from,
    createdAt: isoOr(raw.createdAt, now),
    updatedAt: isoOr(raw.updatedAt, now),
    priority: parsePriority(raw.priority) ?? 'normal',
    status: raw.status === 'done' ? 'done' : 'open',
  };
  const detail = clip(raw.detail, DESK_LIMITS.detail);
  if (detail) todo.detail = detail;
  const due = parseDue(raw.due);
  if (due) todo.due = due;
  const link = parseLink(raw.link);
  if (link) todo.link = link;
  if (todo.status === 'done') todo.completedAt = isoOr(raw.completedAt, todo.updatedAt);
  const cardId = oneLine(raw.cardId, 80);
  if (cardId) todo.cardId = cardId;
  const choices = cleanChoices(raw.choices);
  if (choices.length) todo.choices = choices;
  const answer = normalizeAnswer(raw.answer, todo.updatedAt);
  if (answer) todo.answer = answer;
  return todo;
}

function normalizeComment(value: unknown, now: string): DeskComment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = oneLine(raw.id, 80);
  const text = clip(raw.text, DESK_LIMITS.comment);
  const author = normalizeActor(raw.author);
  if (!id || !text || !author) return null;
  return { id, author, text, at: isoOr(raw.at, now) };
}

function normalizeCard(value: unknown, now: string): DeskCard | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = oneLine(raw.id, 80);
  const title = oneLine(raw.title, DESK_LIMITS.title);
  const owner = normalizeActor(raw.owner);
  if (!id || !title || !owner) return null;
  const updatedAt = isoOr(raw.updatedAt, now);
  const card: DeskCard = {
    id,
    title,
    owner,
    column: parseColumn(raw.column) ?? 'not_started',
    priority: parsePriority(raw.priority) ?? 'normal',
    links: Array.isArray(raw.links)
      ? raw.links.map(parseLink).filter((l): l is string => Boolean(l)).slice(0, DESK_LIMITS.links)
      : [],
    comments: Array.isArray(raw.comments)
      ? raw.comments.map((c) => normalizeComment(c, now)).filter((c): c is DeskComment => Boolean(c))
      : [],
    createdAt: isoOr(raw.createdAt, now),
    updatedAt,
    columnSince: isoOr(raw.columnSince, updatedAt),
    ...(validIso(raw.nextCheckAt) ? { nextCheckAt: raw.nextCheckAt as string } : {}),
    ...(raw.nextCheckWritten === true ? { nextCheckWritten: true } : {}),
    ...(validIso(raw.nudgeAt) ? { nudgeAt: raw.nudgeAt as string } : {}),
    ...(validIso(raw.escalatedAt) ? { escalatedAt: raw.escalatedAt as string } : {}),
  };
  // P0 read-repair: an existing live card that never carried a check-in
  // deadline (it predates this feature) gets one seeded from its last update,
  // bounded to 30 minutes out from the moment it was read, so the sweep covers
  // every live card from deployment day, not only new ones.
  if (raw.archived === true || (card.column !== 'in_progress' && card.column !== 'in_qa')) {
    // Archived and parked cards carry no check state: the sweep skips them,
    // and a stale deadline or mark must not survive a read round-trip (an
    // archive clears the fields; the next read must not re-create them).
    // raw.archived, not card.archived: the copy onto card happens below.
    delete card.nextCheckAt;
    delete card.nextCheckWritten;
    delete card.nudgeAt;
    delete card.escalatedAt;
  } else {
    // Every computed deadline is clamped to at most now + 30 minutes (not
    // only newly seeded ones): a parseable persisted nextCheckAt months ahead
    // would suppress checks indefinitely. A written check-in deadline carries
    // its own larger cap, so a legitimate park (an overnight quiet-hours park)
    // survives reloads while still never suppressing checks indefinitely; a
    // marker without a deadline is incoherent and drops. A missing deadline is
    // seeded; an existing one is capped.
    if (card.nextCheckWritten && !card.nextCheckAt) delete card.nextCheckWritten;
    const cap = Date.parse(now) + (card.nextCheckWritten ? CARD_NEXT_CHECK_WRITTEN_MAX_MS : CARD_NEXT_CHECK_MS);
    if (!card.nextCheckAt) {
      const base = Math.min(Date.parse(updatedAt || now), Date.parse(now));
      card.nextCheckAt = new Date(base + CARD_NEXT_CHECK_MS).toISOString();
    } else if (Date.parse(card.nextCheckAt) > cap) {
      card.nextCheckAt = new Date(cap).toISOString();
    }
    // Mark invariants: escalation without a prior nudge is incoherent (it
    // would suppress escalation forever while re-nudging the owner), a
    // future nudgeAt would postpone escalation indefinitely, and an
    // escalation older than its own nudge is inconsistent.
    if (card.escalatedAt && !card.nudgeAt) delete card.escalatedAt;
    if (card.nudgeAt && Date.parse(card.nudgeAt) > Date.parse(now)) delete card.nudgeAt;
    if (card.escalatedAt && card.nudgeAt && Date.parse(card.escalatedAt) < Date.parse(card.nudgeAt)) delete card.escalatedAt;
  }
  const description = clip(raw.description, DESK_LIMITS.description);
  if (description) card.description = description;
  const project = oneLine(raw.project, DESK_LIMITS.project);
  if (project) card.project = project;
  const createdBy = normalizeActor(raw.createdBy);
  if (createdBy) card.createdBy = createdBy;
  if (raw.archived === true) card.archived = true;
  return card;
}

// ---- persistence ------------------------------------------------------------

/** `repaired` marks a file that loaded with records it could not keep; the
 *  first write after that snapshots the original beside it before replacing. */
let cache: { data: DeskData; mtimeMs: number; size: number; repaired: boolean } | null = null;
let chain: Promise<unknown> = Promise.resolve();

function emptyDesk(): DeskData {
  return { version: 1, rev: 0, todos: [], cards: [] };
}

async function load(): Promise<DeskData> {
  let info;
  try {
    info = await stat(DESK_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = null;
      return emptyDesk();
    }
    throw error;
  }
  if (cache && cache.mtimeMs === info.mtimeMs && cache.size === info.size) return cache.data;
  const raw = await readFile(DESK_FILE, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never paper over a damaged file with an empty desk: that would erase it
    // on the next write. Fail loudly until someone repairs or moves it.
    throw new DeskError(500, `desk.json is not valid JSON; refusing to overwrite it (${DESK_FILE})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeskError(500, `desk.json is not a desk object; refusing to overwrite it (${DESK_FILE})`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== undefined && obj.version !== 1) {
    throw new DeskError(500, `desk.json is version ${JSON.stringify(obj.version)}, newer than this server understands; refusing to overwrite it (${DESK_FILE})`);
  }
  for (const key of ['todos', 'cards'] as const) {
    if (obj[key] !== undefined && !Array.isArray(obj[key])) {
      throw new DeskError(500, `desk.json "${key}" is not a list; refusing to overwrite it (${DESK_FILE})`);
    }
  }
  const now = new Date().toISOString();
  const rawTodos = (obj.todos as unknown[] | undefined) ?? [];
  const rawCards = (obj.cards as unknown[] | undefined) ?? [];
  const data: DeskData = {
    version: 1,
    rev: typeof obj.rev === 'number' && Number.isFinite(obj.rev) ? obj.rev : 0,
    todos: rawTodos.map((t) => normalizeTodo(t, now)).filter((t): t is DeskTodo => Boolean(t)),
    cards: rawCards.map((c) => normalizeCard(c, now)).filter((c): c is DeskCard => Boolean(c)),
  };
  // Anything normalisation changed (a dropped record, a coerced field, a
  // missing timestamp) means the next write would lose the original, so keep
  // a copy of it first. Files this server wrote itself compare equal.
  const repaired = canonicalJson({ todos: rawTodos, cards: rawCards }) !== canonicalJson({ todos: data.todos, cards: data.cards });
  if (repaired) console.warn(`[desk] ${DESK_FILE} had entries it had to repair; the original is kept as a .bak on the next write`);
  cache = { data, mtimeMs: info.mtimeMs, size: info.size, repaired };
  return data;
}

/** JSON with object keys sorted, so key order never counts as a change. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Atomic replace. Windows can briefly refuse to replace a file another
 *  process has open; retry the rename rather than ever writing in place. */
async function replaceFile(tmp: string, target = DESK_FILE): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !RENAME_RETRY_CODES.has(code) || attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

async function save(data: DeskData): Promise<void> {
  const dir = dirname(DESK_FILE);
  await mkdir(dir, { recursive: true });
  if (cache?.repaired) {
    await copyFile(DESK_FILE, `${DESK_FILE}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    cache.repaired = false;
  }
  const tmp = `${DESK_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  let handleOpen = true;
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handleOpen = false;
    await replaceFile(tmp);
  } catch (error) {
    if (handleOpen) await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  const info = await stat(DESK_FILE);
  cache = { data, mtimeMs: info.mtimeMs, size: info.size, repaired: false };
}

/** The same temp-file, fsync and rename write, for Desk side files
 *  (the notifier's state) that must never be left half written. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  let handleOpen = true;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handleOpen = false;
    await replaceFile(tmp, path);
  } catch (error) {
    if (handleOpen) await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Returned from a `mutate` callback that changed nothing: skip the write. */
class Unchanged<T> {
  constructor(readonly value: T) {}
}

/** Read-modify-write under the lock. `fn` edits a private copy; the file is
 *  only written (and rev bumped) when `fn` returns without throwing. */
function mutate<T>(fn: (data: DeskData, now: string) => T | Unchanged<T>): Promise<T> {
  return withLock(async () => {
    const data = structuredClone(await load());
    const result = fn(data, new Date().toISOString());
    if (result instanceof Unchanged) return result.value;
    data.rev += 1;
    await save(data);
    return result;
  });
}

export async function readDesk(): Promise<DeskData> {
  return load();
}

function newId(prefix: string, taken: (id: string) => boolean): string {
  for (;;) {
    const id = `${prefix}-${randomBytes(4).toString('hex').slice(0, 6)}`;
    if (!taken(id)) return id;
  }
}

function findTodo(data: DeskData, id: string): DeskTodo {
  const todo = data.todos.find((t) => t.id === id);
  if (!todo) throw new DeskError(404, `No Needs-you item with id ${id}.`);
  return todo;
}

function findCard(data: DeskData, id: string): DeskCard {
  const card = data.cards.find((c) => c.id === id);
  if (!card) throw new DeskError(404, `No board card with id ${id}.`);
  return card;
}

function requireTitle(value: unknown): string {
  const title = requireOneLine(value, DESK_LIMITS.title, 'title');
  if (!title) throw new DeskError(400, 'title is required');
  return title;
}

function requirePriority(value: unknown): DeskPriority {
  const priority = parsePriority(value);
  if (!priority) throw new DeskError(400, 'priority must be low, normal, or high');
  return priority;
}

function requireColumn(value: unknown): DeskColumn {
  const column = parseColumn(value);
  if (!column) throw new DeskError(400, `column must be one of ${DESK_COLUMNS.join(', ')}`);
  return column;
}

function requireDue(value: unknown): string {
  const due = parseDue(value);
  if (due === null) throw new DeskError(400, 'due must be a date like 2026-10-01 (or today / tomorrow)');
  return due;
}

function requireLink(value: unknown): string {
  const link = parseLink(value);
  if (link === null) throw new DeskError(400, 'link must be an http(s) URL or thread:<agentId>');
  return link;
}

function requireLinks(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    const link = requireLink(item);
    if (link && !out.includes(link)) out.push(link);
  }
  if (out.length > DESK_LIMITS.links) throw new DeskError(400, `at most ${DESK_LIMITS.links} links per card`);
  return out;
}

/** Agent input: strict, so a too-long option comes back as an error the
 *  agent can fix instead of a clipped button. Empty clears. */
function requireChoices(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) throw new DeskError(400, 'choices must be a list of short strings');
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new DeskError(400, 'choices must be a list of short strings');
    const choice = item.replace(/\s+/g, ' ').trim();
    if (!choice) continue;
    if (choice.length > DESK_LIMITS.choice) {
      throw new DeskError(400, `each choice must be ${DESK_LIMITS.choice} characters or fewer ("${choice.slice(0, 20)}..." is ${choice.length})`);
    }
    pushUnique(out, choice);
  }
  if (out.length > DESK_LIMITS.choices) throw new DeskError(400, `at most ${DESK_LIMITS.choices} choices`);
  return out;
}

function requireCardRef(data: DeskData, value: unknown): string {
  const cardId = requireOneLine(value, 80, 'cardId');
  if (cardId && !data.cards.some((c) => c.id === cardId)) throw new DeskError(400, `No board card with id ${cardId}.`);
  return cardId;
}

/** Make room under a cap by dropping the oldest finished records first. */
function pruneTodos(data: DeskData): void {
  if (data.todos.length < DESK_LIMITS.todos) return;
  const done = data.todos
    .filter((t) => t.status === 'done')
    .sort((a, b) => (a.completedAt ?? a.updatedAt).localeCompare(b.completedAt ?? b.updatedAt));
  const drop = new Set(done.slice(0, data.todos.length - DESK_LIMITS.todos + 1).map((t) => t.id));
  data.todos = data.todos.filter((t) => !drop.has(t.id));
  if (data.todos.length >= DESK_LIMITS.todos) throw new DeskError(409, 'The Needs-you list is full; complete or delete some items first.');
}

/** Only finished cards (Done, archived or not) that no Needs-you item points
 *  at are ever dropped; archived work that never finished stays. */
function pruneCards(data: DeskData): void {
  if (data.cards.length < DESK_LIMITS.cards) return;
  const referenced = new Set(data.todos.filter((t) => t.cardId).map((t) => t.cardId));
  const finished = data.cards
    .filter((c) => c.column === 'in_production' && !referenced.has(c.id))
    .sort((a, b) => Number(Boolean(b.archived)) - Number(Boolean(a.archived)) || a.updatedAt.localeCompare(b.updatedAt));
  const drop = new Set(finished.slice(0, data.cards.length - DESK_LIMITS.cards + 1).map((c) => c.id));
  data.cards = data.cards.filter((c) => !drop.has(c.id));
  if (data.cards.length >= DESK_LIMITS.cards) throw new DeskError(409, 'The board is full; move finished cards to Live in production or archive them first.');
}

/** Case- and spacing-insensitive title key; punctuation still counts, so
 *  "C++ port" and "C# port" stay distinct. Unicode letters are kept. */
export function normalizeTitleKey(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').replace(/[\s.!?,;:]+$/u, '').trim();
}

/** Insert `card` into `column` at `index` among that column's live cards. */
function placeCard(data: DeskData, card: DeskCard, index: number | undefined): void {
  const others = data.cards.filter((c) => c.id !== card.id);
  const peers = others.filter((c) => c.column === card.column && !c.archived);
  const at = index === undefined ? 0 : Math.max(0, Math.min(Math.floor(index), peers.length));
  let position: number;
  if (!peers.length) position = others.length;
  else if (at >= peers.length) position = others.indexOf(peers[peers.length - 1]) + 1;
  else position = others.indexOf(peers[at]);
  others.splice(position, 0, card);
  data.cards = others;
}

// ---- todos --------------------------------------------------------------------

export type TodoInput = {
  title?: unknown; detail?: unknown; due?: unknown; priority?: unknown; link?: unknown; cardId?: unknown; status?: unknown; choices?: unknown;
};

export function createTodo(input: TodoInput, from: DeskActor): Promise<DeskTodo> {
  return mutate((data, now) => {
    const todo: DeskTodo = {
      id: newId('todo', (id) => data.todos.some((t) => t.id === id)),
      title: requireTitle(input.title),
      from,
      createdAt: now,
      updatedAt: now,
      priority: input.priority === undefined || input.priority === '' ? 'normal' : requirePriority(input.priority),
      status: 'open',
    };
    const detail = requireClip(input.detail, DESK_LIMITS.detail, 'detail');
    if (detail) todo.detail = detail;
    const due = requireDue(input.due);
    if (due) todo.due = due;
    const link = requireLink(input.link);
    if (link) todo.link = link;
    const cardId = requireCardRef(data, input.cardId);
    if (cardId) todo.cardId = cardId;
    const choices = requireChoices(input.choices);
    if (choices.length) todo.choices = choices;
    pruneTodos(data);
    data.todos.unshift(todo);
    return todo;
  });
}

export function updateTodo(id: string, input: TodoInput): Promise<DeskTodo> {
  return mutate((data, now) => {
    const todo = findTodo(data, id);
    if (input.title !== undefined) todo.title = requireTitle(input.title);
    if (input.detail !== undefined) {
      const detail = requireClip(input.detail, DESK_LIMITS.detail, 'detail');
      if (detail) todo.detail = detail; else delete todo.detail;
    }
    if (input.due !== undefined) {
      const due = requireDue(input.due);
      if (due) todo.due = due; else delete todo.due;
    }
    if (input.priority !== undefined) todo.priority = requirePriority(input.priority);
    if (input.link !== undefined) {
      const link = requireLink(input.link);
      if (link) todo.link = link; else delete todo.link;
    }
    if (input.cardId !== undefined) {
      const cardId = requireCardRef(data, input.cardId);
      if (cardId) todo.cardId = cardId; else delete todo.cardId;
    }
    if (input.choices !== undefined) {
      const choices = requireChoices(input.choices);
      if (choices.length) todo.choices = choices; else delete todo.choices;
    }
    if (input.status !== undefined) {
      if (input.status !== 'open' && input.status !== 'done') throw new DeskError(400, 'status must be open or done');
      applyTodoStatus(todo, input.status, now);
    }
    todo.updatedAt = now;
    return todo;
  });
}

function applyTodoStatus(todo: DeskTodo, status: 'open' | 'done', now: string): void {
  if (status === todo.status) return;
  todo.status = status;
  if (status === 'done') todo.completedAt = now;
  else {
    delete todo.completedAt;
    // Reopened means "ask me again": a stale answer would block the next one.
    delete todo.answer;
  }
}

export type AnswerInput = { choice?: unknown; text?: unknown };

/** Save the owner's answer and close the item in one locked write, so a
 *  double tap lands once (the second call gets `duplicate`). Delivery starts
 *  as failed whenever an agent should hear it; the caller flips it to sent. */
export type AnswerResult = { todo: DeskTodo; card?: DeskCard; duplicate: boolean };

export function answerTodo(id: string, input: AnswerInput): Promise<AnswerResult> {
  return mutate<AnswerResult>((data, now) => {
    const todo = findTodo(data, id);
    const card = todo.cardId ? data.cards.find((c) => c.id === todo.cardId) : undefined;
    if (todo.answer) return new Unchanged({ todo, card, duplicate: true });
    // Resolved some other way (the agent completed it) while this screen was stale.
    if (todo.status !== 'open') throw new DeskError(409, 'This item was already resolved, so there is nothing to answer.');
    for (const key of ['choice', 'text'] as const) {
      const value = input[key];
      if (value !== undefined && value !== null && typeof value !== 'string') throw new DeskError(400, `${key} must be a string`);
    }
    const wanted = typeof input.choice === 'string' ? input.choice.replace(/\s+/g, ' ').trim() : '';
    const text = typeof input.text === 'string' ? input.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!wanted && !text) throw new DeskError(400, 'choice or text is required');
    if (text.length > DESK_LIMITS.answerText) throw new DeskError(400, `text must be ${DESK_LIMITS.answerText} characters or fewer`);
    let choice = '';
    if (wanted) {
      const options = todo.choices?.length ? todo.choices : ['Yes', 'No'];
      choice = options.find((o) => o.toLowerCase() === wanted.toLowerCase()) ?? '';
      if (!choice) throw new DeskError(400, `choice must be one of ${options.map((o) => JSON.stringify(o)).join(', ')}`);
    }
    const tellSomeone = todo.from.kind === 'agent' || card?.owner.kind === 'agent';
    const answer: DeskAnswer = { at: now, delivery: tellSomeone ? 'failed' : 'none' };
    if (choice) answer.choice = choice;
    if (text) answer.text = text;
    todo.answer = answer;
    applyTodoStatus(todo, 'done', now);
    todo.updatedAt = now;
    return { todo, card, duplicate: false };
  });
}

/** Claim an answer for delivery. Only a failed answer can be claimed, and the
 *  claim is on disk before anyone is told, so two callers at once cannot both
 *  send. A claim older than `staleMs` with no outcome means the server stopped
 *  mid-send; it can be taken over, because telling the agent twice is harmless
 *  and never telling them is not. */
export function claimAnswerDelivery(id: string, staleMs = 5 * 60_000): Promise<DeskTodo | null> {
  return mutate<DeskTodo | null>((data, now) => {
    const todo = data.todos.find((t) => t.id === id);
    if (todo?.answer?.delivery !== 'failed') return new Unchanged(null);
    const claimedAt = todo.answer.sendingAt ? Date.parse(todo.answer.sendingAt) : NaN;
    if (Number.isFinite(claimedAt) && Date.parse(now) - claimedAt < staleMs) return new Unchanged(null);
    todo.answer.sendingAt = now;
    return todo;
  });
}

/** Settle a claimed delivery: sent, or failed (released for a retry). `claim`
 *  is the `sendingAt` the caller was handed; settling only counts while that
 *  claim is still the one on disk, so a delivery that hung past a takeover, or
 *  outlived a reopen and a fresh answer, cannot overwrite what replaced it. */
export function setAnswerDelivery(id: string, delivery: 'sent' | 'failed', claim?: string): Promise<DeskTodo | null> {
  return mutate<DeskTodo | null>((data) => {
    const todo = data.todos.find((t) => t.id === id);
    if (!todo?.answer || todo.answer.delivery === 'none') return new Unchanged(todo ?? null);
    if (claim !== undefined && todo.answer.sendingAt !== claim) return new Unchanged(todo);
    if (todo.answer.delivery === delivery && !todo.answer.sendingAt) return new Unchanged(todo);
    todo.answer.delivery = delivery;
    delete todo.answer.sendingAt;
    return todo;
  });
}

export function setTodoStatus(id: string, status: 'open' | 'done'): Promise<DeskTodo> {
  return mutate((data, now) => {
    const todo = findTodo(data, id);
    applyTodoStatus(todo, status, now);
    todo.updatedAt = now;
    return todo;
  });
}

export function deleteTodo(id: string): Promise<void> {
  return mutate((data) => {
    findTodo(data, id);
    data.todos = data.todos.filter((t) => t.id !== id);
  });
}

// ---- cards --------------------------------------------------------------------

export type CardInput = {
  title?: unknown; description?: unknown; column?: unknown; priority?: unknown; project?: unknown; links?: unknown; index?: unknown;
};

export const DUPLICATE_CARD_PREFIX = 'An open card already has this title';

/** `dedupe` refuses a second open card with the same title, checked inside the
 *  lock so two agents starting the same work at once cannot both create one. */
/** Card mutations mirror to the Dev PR Tracker after the disk write lands
 *  (fire-and-forget; the push can never fail or block the Desk write). */
function mirrorAfter(p: Promise<DeskCard>): Promise<DeskCard> {
  void p.then((card) => queueMirror(card), () => {});
  return p;
}

export function createCard(input: CardInput, owner: DeskActor, by: DeskActor, opts: { dedupe?: boolean } = {}): Promise<DeskCard> {
  return mirrorAfter(mutate((data, now) => {
    if (opts.dedupe) {
      const wanted = normalizeTitleKey(requireTitle(input.title));
      const dupe = wanted ? data.cards.find((c) => !c.archived && c.column !== 'in_production' && normalizeTitleKey(c.title) === wanted) : undefined;
      if (dupe) throw new DeskError(409, `${DUPLICATE_CARD_PREFIX}: [${dupe.id}] ${dupe.title} (owner ${dupe.owner.name}, ${dupe.column}).`);
    }
    const card: DeskCard = {
      id: newId('card', (id) => data.cards.some((c) => c.id === id)),
      title: requireTitle(input.title),
      owner,
      column: input.column === undefined || input.column === '' ? 'not_started' : requireColumn(input.column),
      priority: input.priority === undefined || input.priority === '' ? 'normal' : requirePriority(input.priority),
      links: requireLinks(input.links),
      comments: [],
      createdAt: now,
      updatedAt: now,
      columnSince: now,
      createdBy: by,
    };
    const description = requireClip(input.description, DESK_LIMITS.description, 'description');
    if (description) card.description = description;
    const project = requireOneLine(input.project, DESK_LIMITS.project, 'project');
    if (project) card.project = project;
    touchCardNextCheck(card, now);
    pruneCards(data);
    placeCard(data, card, typeof input.index === 'number' ? input.index : undefined);
    return card;
  }));
}

export function updateCard(id: string, input: CardInput, owner?: DeskActor): Promise<DeskCard> {
  return mirrorAfter(mutate((data, now) => {
    const card = findCard(data, id);
    if (input.title !== undefined) card.title = requireTitle(input.title);
    if (input.description !== undefined) {
      const description = requireClip(input.description, DESK_LIMITS.description, 'description');
      if (description) card.description = description; else delete card.description;
    }
    if (input.project !== undefined) {
      const project = requireOneLine(input.project, DESK_LIMITS.project, 'project');
      if (project) card.project = project; else delete card.project;
    }
    if (input.priority !== undefined) card.priority = requirePriority(input.priority);
    if (input.links !== undefined) card.links = requireLinks(input.links);
    if (owner) card.owner = owner;
    if (input.column !== undefined) {
      const column = requireColumn(input.column);
      if (column !== card.column) {
        card.column = column;
        card.columnSince = now;
        delete card.archived;
        placeCard(data, card, 0);
      }
    }
    card.updatedAt = now;
    // Every PATCH is an owner touch too: a column change into or out of the
    // live columns sets or clears the deadline, and a reassignment refreshes
    // it so the new owner gets their own 30-minute window, not the old one's.
    touchCardNextCheck(card, now);
    return card;
  }));
}

export function moveCard(id: string, column: unknown, index?: unknown): Promise<DeskCard> {
  return mirrorAfter(mutate((data, now) => {
    const card = findCard(data, id);
    const target = requireColumn(column);
    if (target !== card.column) {
      card.column = target;
      card.columnSince = now;
    }
    delete card.archived;
    card.updatedAt = now;
    touchCardNextCheck(card, now);
    const at = typeof index === 'number' && Number.isFinite(index) ? index : undefined;
    placeCard(data, card, at);
    return card;
  }));
}

export async function commentCard(id: string, text: unknown, author: DeskActor): Promise<{ card: DeskCard; comment: DeskComment }> {
  // Resolve the author against the live roster BEFORE the mutation (so the
  // close is decided with real data), then close AFTER the save (so a failed
  // save never deletes asks).
  let isLiveAgent = false;
  if (author.kind === 'agent' && typeof author.id === 'string' && author.id) {
    try {
      const { listAgents } = await import('../chat/agents.ts');
      const agents = await listAgents();
      isLiveAgent = agents.some((a) => a.id === author.id);
    } catch { /* a roster hiccup must never block the comment */ }
  }
  const result = await mutate((data, now) => {
    const card = findCard(data, id);
    const body = requireClip(text, DESK_LIMITS.comment, 'text');
    if (!body) throw new DeskError(400, 'text is required');
    if (card.comments.length >= DESK_LIMITS.commentsPerCard) {
      throw new DeskError(409, 'This card has too many comments; start a fresh card for the next phase.');
    }
    const comment: DeskComment = {
      id: newId('cm', (cid) => card.comments.some((c) => c.id === cid)),
      author,
      text: body,
      at: now,
    };
    card.comments.push(comment);
    card.updatedAt = now;
    // A comment is an owner touch: it refreshes the check-in deadline and
    // clears any pending nudges, exactly like a create or a move. A written
    // next check-in time in the comment body is honored (capped), so a
    // quiet-hours park with a stated time stays silent until that time. It
    // also closes the commenter's open Matt asks (card-baadaf B: the card
    // touch is the close), best effort.
    touchCardNextCheck(card, now, parseWrittenNextCheck(body, Date.parse(now)));
    return { card, comment };
  });
  // Only a live roster agent's card comment closes their asks, and only after
  // the mutate successfully committed (a failed save never deletes asks).
  if (isLiveAgent && typeof author.id === 'string' && author.id) {
    try { closeMattAsksForAgent(author.id); } catch { /* never block the comment */ }
  }
  return result;
}

/** One hygiene sweep over the check-in deadlines (card-baadaf A): returns the
 *  nudges that are due now (the owner nudge when a live card's nextCheckAt
 *  passed with no touch since, the Chief copy 15 quiet minutes after the
 *  owner nudge), having already marked them on the cards, so a crash can
 *  drop a nudge but never repeat one. An explicit delivery failure also
 *  keeps the mark (the same at-most-once trade as every existing hygiene
 *  piece: a nudge can be dropped but never repeated, and the log records
 *  the failure). The one exception is a rate-limited delivery, a transient
 *  condition: the caller restores that mark (restoreCardCheckMark) so it
 *  retries on the next tick. A touch that sets a fresh nextCheckAt clears
 *  both marks.
 *  A dry-run sweep ({ dryRun: true }) returns the due nudges read-only:
 *  nothing is marked or written, so previewing never consumes a
 *  notification that would then never be delivered. */
/** Delivery bound per sweep tick: deliverTeamMessage admits at most 8 per
 *  sender/recipient pair per minute (PAIR_MAX) — every Chief escalation shares
 *  the one Desk->Chief pair — plus a global 20/min shared with every other
 *  sender. A mass-silence burst marks and returns at most this many per tick;
 *  the rest stay unmarked for the next tick, and a rate-limited delivery
 *  restores its mark (restoreCardCheckMark) so it retries too. */
const MAX_SWEEP_DELIVERIES = 8;

export async function sweepCardChecks(options: { dryRun?: boolean; liveLanes?: ReadonlySet<string> } = {}): Promise<Array<{ kind: 'owner' | 'chief'; card: DeskCard; to: string; text: string; since: number }>> {
  const dryRun = options.dryRun === true;
  // Lane-liveness (Max, Oct 18 2026, card-b3468c): a nudge must never derail
  // a live turn. Resolved once per sweep from the ground-truth roster (fail
  // open when unreadable — a broken gate must never swallow a nudge);
  // injectable for tests.
  const liveLanes = options.liveLanes ?? await agentsWithLiveTurns();
  const due: Array<{ kind: 'owner' | 'chief'; card: DeskCard; to: string; text: string; since: number }> = [];
  // Resolve the live roster once before the sweep: a stale agent id routes to
  // the Chief (a delivery to a dead id is a silent failure), and a human or
  // Desk actor owner routes to the Chief immediately.
  const { listAgents } = await import('../chat/agents.ts');
  const agents = await listAgents();
  // listAgents converts every roster read/parse failure into an empty list;
  // an empty roster here would read as "every owner is stale" and reroute
  // the whole due batch to the Chief while consuming its marks. Treat an
  // empty roster as a sweep failure: the caller logs it, nothing is marked
  // or delivered.
  if (agents.length === 0) throw new Error('live roster unavailable (empty list) — sweep skipped, nothing marked');
  // The Chief is the fallback recipient for every stale, human, and
  // escalated card: validate it exists in the roster BEFORE marking, so an
  // unavailable Chief aborts the sweep with nothing consumed instead of
  // marking every nudge for a delivery that cannot land.
  if (!agents.some((a) => a.id === 'chief-of-staff')) throw new Error('chief-of-staff is not in the live roster — sweep skipped, nothing marked');
  // Case-insensitive like the rest of Desk routing: a legacy or externally
  // repaired actor id/name with different casing is not a stale owner. The
  // canonical roster id is returned, never the lowercased candidate.
  const byLowerId = new Map(agents.map((a) => [a.id.toLowerCase(), a] as const));
  const byLowerName = new Map(agents.map((a) => [a.name.toLowerCase(), a] as const));
  const resolveOwner = (card: DeskCard): string => {
    if (card.owner.kind !== 'agent') return 'chief-of-staff';
    // Id first, then the name independently: a legacy or repaired card can
    // carry a stale id with a valid canonical name, and the id is present on
    // every normalized card, so a same-value name lookup would never fire.
    const idHit = typeof card.owner.id === 'string' && card.owner.id ? byLowerId.get(card.owner.id.toLowerCase()) : undefined;
    const nameHit = typeof card.owner.name === 'string' && card.owner.name ? byLowerName.get(card.owner.name.toLowerCase()) : undefined;
    const hit = idHit ?? nameHit;
    return hit ? hit.id : 'chief-of-staff';
  };
  await mutate((data, now) => {
    const nowMs = Date.parse(now);
    // Candidates are collected UNMARKED first: delivery is globally rate
    // limited (deliverTeamMessage, shared with every other sender), so
    // marking the whole batch up front would permanently consume nudges the
    // limiter rejects — exactly the mass-silence burst this feature exists
    // for. Only the deliverable head of the batch is marked; the rest stay
    // unmarked and eligible for the next tick.
    const candidates: Array<{ setMark: () => void; nudge: { kind: 'owner' | 'chief'; card: DeskCard; to: string; text: string; since: number } }> = [];
    for (const card of data.cards) {
      if (card.archived) continue;
      if (card.column !== 'in_progress' && card.column !== 'in_qa') continue;
      const next = card.nextCheckAt ? Date.parse(card.nextCheckAt) : NaN;
      if (!Number.isFinite(next) || next > nowMs) continue;
      // Resolve the owner against the roster, not just the stored id: a
      // human-owned card (owner.kind 'human', id 'owner') or a stale agent id
      // is not a deliverable teammate, so those route to the Chief.
      const ownerAgent = resolveOwner(card);
      if (!card.nudgeAt) {
        // Quiet hours (Matt, Oct 15 2026): the owner nudge to a non-Max lane
        // holds through 22:00-05:00 ET. The card stays unmarked, so the
        // first sweep after 05:00 nudges it unchanged — held never means
        // lost. Chief escalation below targets Max's lane and always goes.
        if (inQuietHours(nowMs) && !isQuietExemptLane(ownerAgent)) {
          // held: unmarked, retried by the next post-05:00 sweep
        } else if (liveLanes.has(ownerAgent) && nowMs - next < LIVE_HOLD_CEILING_MS) {
          // Lane-liveness hold (Max, Oct 18 2026, card-b3468c): the owner's
          // lane is mid-turn; a quiet-check nudge must not derail it. Held
          // unmarked exactly like the quiet-hours hold above — the next sweep
          // after the turn ends nudges it — and bounded by the same ceiling
          // measured from the check-in's own due instant: a lane stuck in
          // one long turn still gets its nudge once the check-in has been
          // due past the ceiling. Holding never means losing.
        } else {
          candidates.push({
            setMark: () => { card.nudgeAt = now; },
            nudge: {
              kind: 'owner',
              card,
              to: ownerAgent,
              // The hold origin the sweep's liveness gate measured from
              // (the check-in's own due instant): the delivery carries it so
              // the drain-side admission holds by the same clock (review
              // P0, Oct 18) instead of a snapshot that can go stale before
              // the record admits.
              since: next,
              text: ownerAgent === 'chief-of-staff'
                ? `Quiet check: [${card.id}] "${card.title}" (${card.column}) passed its check-in time with no touch since (you own this one). Comment on the card to set a new one.`
                : `Quiet check: [${card.id}] "${card.title}" (${card.column}) passed its check-in time with no touch since. Comment on the card to set a new one, or tell the Chief of Staff what is blocking it.`,
            },
          });
        }
      } else if (!card.escalatedAt && ownerAgent !== 'chief-of-staff') {
        // The Chief's own cards never get the separate Chief copy: the owner
        // nudge already reached the Chief, so a second one is noise.
        // Quiet hours (Oct 15 2026): the escalation asserts the nudge WENT
        // OUT, but during the window a non-Max owner's nudge can still be
        // held in the delivery queue, so escalating would tell the Chief a
        // falsehood. Never escalate a held owner inside the window, and
        // after 05:00 count the 15 minutes from the later of the nudge and
        // the last quiet end — the held nudge only just landed then (Opus
        // verify, Oct 16). Max-lane nudges deliver immediately, so their
        // timing is unchanged.
        const escalateFrom = isQuietExemptLane(ownerAgent)
          ? Date.parse(card.nudgeAt)
          : Math.max(Date.parse(card.nudgeAt), lastQuietEndMs(nowMs));
        if (
          nowMs - escalateFrom >= CARD_CHECK_ESCALATE_MS
          && !(inQuietHours(nowMs) && !isQuietExemptLane(ownerAgent))
          // Lane-liveness (card-b3468c): the escalation's recipient is the
          // Chief; hold it unmarked while that lane is mid-turn, bounded by
          // the same ceiling from the escalation's own due instant, so a
          // stuck Chief lane still gets it. Holding never means losing.
          && !(liveLanes.has('chief-of-staff') && nowMs - escalateFrom < CARD_CHECK_ESCALATE_MS + LIVE_HOLD_CEILING_MS)
        ) {
          candidates.push({
            setMark: () => { card.escalatedAt = now; },
            nudge: {
              kind: 'chief',
              card,
              to: 'chief-of-staff',
              since: escalateFrom,
              text: `Silence flag: ${ownerAgent}'s card [${card.id}] "${card.title}" (${card.column}) went quiet past its check-in time and stayed quiet 15 minutes after the nudge. It went to them; make sure they act on it.`,
            },
          });
        }
      }
    }
    // Dry run: nothing is marked or written — every candidate comes back
    // read-only for logging. Real run: at most MAX_SWEEP_DELIVERIES are
    // marked and returned; the rest reappear on the next tick.
    const batch = dryRun ? candidates : candidates.slice(0, MAX_SWEEP_DELIVERIES);
    for (const c of batch) {
      if (!dryRun) c.setMark();
      due.push(c.nudge);
    }
    return dryRun || batch.length === 0
      ? (new Unchanged(due) as unknown as Array<{ kind: 'owner' | 'chief'; card: DeskCard; to: string; text: string }>)
      : due;
  });
  return due;
}

/** Undo a sweep mark so a rate-limited nudge retries on the next tick: the
 *  one explicit delivery failure whose mark is restored (a transient,
 *  retryable condition — every other failure or crash keeps the mark, the
 *  documented at-most-once trade). No-op if the mark is already gone (a
 *  concurrent touch cleared it). Fail-open. */
export async function restoreCardCheckMark(cardId: string, kind: 'owner' | 'chief'): Promise<void> {
  try {
    await mutate((data) => {
      const card = findCard(data, cardId);
      if (kind === 'owner') delete card.nudgeAt;
      else delete card.escalatedAt;
      return card;
    });
  } catch {
    // Fail-open: a missed restore leaves the at-most-once trade as-is.
  }
}

export function deleteComment(cardId: string, commentId: string): Promise<DeskCard> {
  return mutate((data, now) => {
    const card = findCard(data, cardId);
    const next = card.comments.filter((c) => c.id !== commentId);
    if (next.length === card.comments.length) throw new DeskError(404, `No comment ${commentId} on ${cardId}.`);
    card.comments = next;
    card.updatedAt = now;
    return card;
  });
}

export function archiveCard(id: string, archived: boolean): Promise<DeskCard> {
  return mirrorAfter(mutate((data, now) => {
    const card = findCard(data, id);
    if (archived) {
      card.archived = true;
      // Archiving clears the check state: a stale deadline or an old
      // nudge/escalation mark must not survive into an unarchive.
      delete card.nextCheckAt;
      delete card.nextCheckWritten;
      delete card.nudgeAt;
      delete card.escalatedAt;
    } else {
      delete card.archived;
      // Unarchiving into a live column seeds a fresh 30-minute window and
      // clears stale marks; into a parked column this just clears the fields.
      touchCardNextCheck(card, now);
    }
    card.updatedAt = now;
    return card;
  }));
}
