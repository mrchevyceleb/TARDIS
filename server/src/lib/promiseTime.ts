// Pure Eastern-time parsing shared by promised work, the Desk and commitments.


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

/** A negated time is not a promise ("I can't finish by 5pm", "we won't ship
 *  before 6pm"): the negation kills the whole sentence's promises. */
const NEGATED = /\b(?:can'?t|cannot|won'?t|will not|wouldn'?t|not going to|didn'?t|doesn'?t|don'?t|never|no longer)\b[^.!?]{0,80}\b(?:by|before|due|no later than|new time)\b/i;

/** Someone else's plan, not the sender's promise ("Sam will deliver by
 *  6pm", "Max's report is due by 6pm", "the deploy must finish before 5pm"
 *  when it is not the sender doing it). Deliberately high-precision: a
 *  missed promise is a safe miss, a wrong one is a false escalation. */
const THIRD_PERSON = /\b(?:he|she|they|it)\s+will\b[^.!?]{0,60}\b(?:by|before|due)\b|\b[A-Z][a-z]{2,}(?:'s)?\s+(?:will|is going to|plans to|needs to|has to|must)\b[^.!?]{0,60}\b(?:by|before|due)\b|\b[A-Z][a-z]+'s\b[^.!?]{0,60}\b(?:due|by|before)\b/i;

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
 *  a DST boundary lands on the right side: the second pass recomputes the
 *  offset AT the estimate and re-derives from the original guess). */
function instantInZone(year: number, month0: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month0, day, hour, minute);
  let at = guess - zoneOffsetMs(new Date(guess));
  at = guess - zoneOffsetMs(new Date(at));
  return at;
}

/** `now` as a wall-clock in the team's zone: the instant shifted BY the
 *  zone offset (the offset already carries its sign; adding it moves the
 *  wall-clock fields into Eastern). */
function wallInZone(date: Date): { y: number; m0: number; d: number; h: number; min: number; weekday: number } {
  const shifted = new Date(date.getTime() + zoneOffsetMs(date));
  return {
    y: shifted.getUTCFullYear(),
    m0: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    h: shifted.getUTCHours(),
    min: shifted.getUTCMinutes(),
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
      // Near year-end, an ordinary future promise ("by Jan 2 at 5pm" said
      // in December) means the coming year: a month-day that resolved more
      // than half a year into the past rolls forward, while a recently past
      // month-day stays an already-late promise.
      let probe = instantInZone(y, m0, d, hour, minute);
      if (probe <= now.getTime() && now.getTime() - probe > 183 * 24 * 60 * 60_000) {
        y += 1;
        probe = instantInZone(y, m0, d, hour, minute);
      }
    }
  } else {
    rollsWhenPast = true;
  }
  let at = instantInZone(y, m0, d, hour, minute);
  if (rollsWhenPast && at <= now.getTime()) {
    d += 1;
    at = instantInZone(y, m0, d, hour, minute);
  }
  // A date that does not survive the round trip (Feb 31 normalizes into
  // March, and a nonexistent spring-forward wall clock normalizes into the
  // hour after) is not the requested time: refuse instead of silently
  // storing a different one. Ambiguous fall-back hours are inherently so;
  // the first occurrence wins and passes this check as itself.
  const resolved = wallInZone(new Date(at));
  if (resolved.y !== y || resolved.m0 !== m0 || resolved.d !== d) return null;
  if (resolved.h !== hour || resolved.min !== minute) return null;
  return at;
}

/** The display form: the clock, a trailing ET marker when the text carries
 *  one, and the day phrase in full ("10:00am ET Wed Oct 14", never a month
 *  word with its day number dropped). */
function dueDisplay(local: string, pairText: string, dayWord: string | undefined, clockText: string): string {
  // The ET marker rides inside the pair match itself (the pair regex
  // consumes it), so it is searched there, never after the clock.
  const tz = pairText.match(/\b(et|edt|est)\b/i);
  let dayPhrase = '';
  if (dayWord) {
    const monthIdx = MONTHS.indexOf(dayWord.toLowerCase().slice(0, 3));
    if (monthIdx >= 0) {
      const dayNum = (local.match(new RegExp(`${dayWord}\\s+(\\d{1,2})`, 'i')) ?? [])[1];
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
    if (NEGATED.test(sentence) || THIRD_PERSON.test(sentence)) continue;
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
      const due = dueDisplay(local, match[0], day?.word, clockText);
      out.push({ due, dueAt, clause: sentence });
    }
  }
  return out;
}

/** Parse a stored due string to its moment, or null when it does not parse.
 *  Unparsable dues are never flagged: the sweep only raises what it can read. */
export function parseDue(due: string, now: Date = new Date()): number | null {
  const absolute = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(due.trim()) ? Date.parse(due) : NaN;
  if (Number.isFinite(absolute)) return absolute;
  const relative = new RegExp(`^(?:${RELATIVE_WORK.source})$`, 'i').exec(due.trim());
  if (relative) return now.getTime() + relativeMs(relative[1], relative[2]);
  const match = due.match(/(?<!\d)(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)(?!\d)/i);
  if (!match || match.index === undefined) return null;
  const word = due.match(DAY)?.[1];
  return resolveClock(due, word, match[0], now);
}


/** Work gets a near checkpoint, even when the whole job takes longer. */
export const WORK_CHECKPOINT_MS = 30 * 60_000;
const FUTURE_WORK = /\b(?:will|shall|should|expect|ETA|next|new|plan|promise|aim|ready)\b|\b(?:I|we)'ll\b/i;
const PAST_WORK = /\b(?:took|finished|completed|shipped|delivered|resolved|deployed|merged|fixed|landed|pushed|started|passed|ran|went|asked|noticed|saw|got|used to|last check-in|previous checkpoint|was due|were due)\b/i;
const CALENDAR_DURATION = /\b(?:meeting|webinar|maintenance|event|appointment|flight|cache|token|timeout|retention|CI)\b/i;
const RELATIVE_WORK = /\b(?:in|within|ETA|checkpoint|takes?)\s+(?:(?:about|the next)\s+|~\s*)?(\d+(?:\.\d+)?|an?|one|two|three|four|five|ten|fifteen|thirty|forty-five)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/gi;
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, thirty: 30, 'forty-five': 45 };
function relativeMs(value: string, unit: string): number {
  return (NUMBERS[value.toLowerCase()] ?? Number(value)) * (/^h/i.test(unit) ? 3_600_000 : 60_000);
}

export function workTimingError(text: string, due?: string, dueAt?: number, nowMs = Date.now()): string | undefined {
  const now = new Date(nowMs);
  const instants: number[] = [];
  const explicit = due?.trim();
  if (explicit) {
    const relative = new RegExp(`^(?:${RELATIVE_WORK.source})$`, 'i').exec(explicit);
    const parsed = relative ? nowMs + relativeMs(relative[1], relative[2]) : parseDue(explicit, now);
    if (parsed === null) return 'Nothing saved. Give a clear checkpoint within 30 minutes, such as "in 15 minutes" or an Eastern clock time.';
    instants.push(parsed);
  }
  if (typeof dueAt === 'number' && Number.isFinite(dueAt)) instants.push(dueAt);
  // Promise detection for enforcement intentionally does not use the scanner's
  // high-precision third-person/negation filters: "This will..." and "Don't
  // worry, I'll..." are still commitments. Each clause has its own tense.
  for (const clause of text.replace(/[’‘]/g, "'").split(/[.!?;]\s+|\n+|,\s+(?=(?:I\b|we\b|next\b|rest\b|done\b|then\b))/i)) {
    const historical = PAST_WORK.test(clause) && !FUTURE_WORK.test(clause);
    const calendar = CALENDAR_DURATION.test(clause) && !/\b(?:finish|ship|fix|deliver|complete|result|update|proof|checkpoint)\b/i.test(clause);
    const reportedOwnerFact = /^\s*(?:Matt|Kim)(?:'s)?\b/i.test(clause) && !/\b(?:I(?:'ll| will)|we(?:'ll| will))\b/i.test(clause);
    if (calendar || historical || reportedOwnerFact) continue;
    for (const match of clause.matchAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/gi)) {
      const at = Date.parse(match[0]);
      if (Number.isFinite(at)) instants.push(at);
    }
    if (!historical && !calendar) {
      for (const match of clause.matchAll(RELATIVE_WORK)) instants.push(nowMs + relativeMs(match[1], match[2]));
    }
    const clockPairs = /\b(?:by|before|due|at|ETA|checkpoint|first look|next update|check[ -]?in|ready|finish|deliver|ship)\b\s*(?:(?:by|at|about|around)\s*|:\s*)?(noon|midnight|(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)?)(?![\d:])\b/gi;
    for (const match of clause.matchAll(clockPairs)) {
      if (!/(?:am|pm)|:|noon|midnight/i.test(match[1]) && /^(?:finish|deliver|ship|ready)\b/i.test(match[0])) continue;
      if (!/(?:am|pm)|:|noon|midnight/i.test(match[1]) && !/^(?:(?:ET|EDT|EST)\b|today\b|tomorrow\b|tonight\b|[.,!?]|$)/i.test(clause.slice((match.index ?? 0) + match[0].length).trim())) continue;
      let clock = match[1].trim().toLowerCase().replace(/\s+/g, '');
      if (clock === 'noon') clock = '12pm';
      if (clock === 'midnight') clock = '12am';
      if (!/(?:am|pm)$/.test(clock)) {
        const [h, m = '0'] = clock.split(':').map(Number);
        if (h > 12 || h === 0) clock = `${h % 12 || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
        else {
          const forms = ['am','pm'].map(mer => `${h}:${String(m).padStart(2, '0')}${mer}`);
          clock = forms.sort((a,b)=>(resolveClock('',undefined,a,now) ?? Infinity)-(resolveClock('',undefined,b,now) ?? Infinity))[0];
        }
      }
      const days = [...clause.matchAll(DAY_ALL)].filter(d => {
        const after = clause.slice((d.index ?? 0) + d[0].length);
        if (/^'s\b/.test(after)) return false;
        return !MONTHS.includes(d[1].toLowerCase().slice(0, 3)) || /^\s+\d{1,2}\b/.test(after);
      });
      days.sort((a,b)=>Math.abs((a.index ?? 0)-(match.index ?? 0))-Math.abs((b.index ?? 0)-(match.index ?? 0)));
      const day = days[0]?.[1];
      // Past-tense facts use today's clock, rather than rolling into tomorrow.
      const at = resolveClock(clause, day ?? (historical ? 'today' : undefined), clock, now);
      if (at !== null) instants.push(at);
    }
    if (!historical && !calendar && /\b(?:tomorrow|tonight|EOD|later today|end of (?:the )?day|next (?:week|month)|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(clause)
        && /\b(?:send|ship|finish|fix|deliver|result|update|checkpoint|check[ -]?in|ready|done|complete|proof)\b/i.test(clause)
        && !clockPairs.test(clause)) {
      return 'Nothing saved. Give the next concrete result a clear time within 30 minutes, rather than a later day or an open-ended deadline.';
    }
  }
  if (instants.some(at => at - nowMs > WORK_CHECKPOINT_MS)) {
    const latest = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', hour:'numeric', minute:'2-digit'}).format(new Date(nowMs + WORK_CHECKPOINT_MS));
    return `Nothing saved. That time is more than 30 minutes away. Give the next concrete result by ${latest} ET or sooner, then continue the larger job.`;
  }
  return undefined;
}
