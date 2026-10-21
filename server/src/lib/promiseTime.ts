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
  const relative = relativeDue(due, now.getTime());
  if (relative !== null) return relative;
  const clean = due.replace(/\bnoon\b/gi, '12pm').replace(/\bmidnight\b/gi, '12am');
  const match = clean.match(/(?<!\d)((?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)|(?:[01]?\d|2[0-3]):[0-5]\d)(?![\d:])/i);
  if (!match) return null;
  let clock = match[1];
  if (!/(?:am|pm)/i.test(clock)) {
    const [hour, minute] = clock.split(':').map(Number);
    clock = `${hour % 12 || 12}:${String(minute).padStart(2, '0')}${hour >= 12 ? 'pm' : 'am'}`;
  }
  // A stored due is explicit. A clock earlier today stays overdue rather
  // than silently becoming tomorrow's promise.
  return resolveClock(clean, clean.match(DAY)?.[1] ?? 'today', clock, now);
}


/** Work gets a near checkpoint, even when the whole job takes longer. */
export const WORK_CHECKPOINT_MS = 30 * 60_000;
const FUTURE_INTENT = /\b(?:I|we)(?:'ll| will| shall| plan to| aim to| expect to)\b|\b(?:will|shall|should|going to|gonna|aim(?:ing)? to|hop(?:e|ing) to|target(?:ing)?|on track(?: for| to)?|landing|following up|need (?:until|till)|give me (?:until|till)|ETA|next (?:update|check[ -]?in|checkpoint)|first look|first proof|new time|back to you)\b/i;
const WORK_LEAD = /^\s*(?:(?:please|then)\s+)?(?:(?:full|first|next|final)\s+)?(?:send|ship|finish|fix|deliver|complete|update|report|results?|proof|rewrite|checkpoint|check[ -]?in|delivering|finishing|sending|shipping|expect|back|give me)\b|^\s*(?:ready|done)\s+(?:by|at|in|within)\b|^\s*(?:by|before|due)\s+(?:\d|noon|midnight|tomorrow|tonight|[a-z]+day)\b|^\s*first thing in the morning\b/i;
const PAST_CONTEXT = /\b(?:was|were|had|already|since|yesterday|previous|last check[ -]?in|last checkpoint|sent|posted|completed|finished|shipped|delivered|taken|confirmed|green|healthy|verified|timed out|restarted|started|accepted|deployed|resolved|landed)\b|^\s*done\s+(?:today|tonight|yesterday)\s*:|^\s*before today\b/i;
const CALENDAR_DURATION = /\b(?:meeting|webinar|maintenance|event|appointment|flight|cache|token|timeout|retention|CI|cron|schedule)\b/i;
const NUMBER_WORDS = '(?:a couple of|couple(?: of)?|a few|few|several|half(?: an?)?|quarter(?: of an?)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|hundred)';
const RELATIVE_WORK = new RegExp(`\\b(?:in|within|ETA\\s*:?|checkpoint|takes?|give me)\\s+(?:(?:about|the next)\\s+|~\\s*)?(\\d+(?:\\.\\d+)?|${NUMBER_WORDS})\\s*(minutes?|mins?|m|hours?|hrs?|h|days?|weeks?)\\b`, 'gi');
const NUMBER_VALUES: Record<string, number> = {a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100};
function relativeMs(value: string, unit: string): number {
  const word=value.toLowerCase();
  const n=/couple/.test(word)?2:/few|several/.test(word)?3:/half/.test(word)?.5:/quarter/.test(word)?.25:NUMBER_VALUES[word] ?? (/^\d/.test(word)?Number(word):word.split(/[- ]/).reduce((sum,w)=>sum+(NUMBER_VALUES[w]??0),0));
  return n * (/^w/i.test(unit)?604_800_000:/^d/i.test(unit)?86_400_000:/^h/i.test(unit)?3_600_000:60_000);
}
function relativeDue(due:string, nowMs:number):number|null {
  const clean=due.trim();
  const compound=/^(?:in\s+)?(\d+)\s*h(?:ours?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?$/i.exec(clean);
  if(compound) return nowMs+Number(compound[1])*3_600_000+Number(compound[2])*60_000;
  const re=new RegExp(`^(?:${RELATIVE_WORK.source})$`,'i');
  const m=re.exec(clean) ?? re.exec('in '+clean);
  return m?nowMs+relativeMs(m[1],m[2]):null;
}
export function relativeCheckpointTime(text: string, nowMs: number): number | null {
  const clean = text.trim().replace(/^(?:is\b|:)\s*/i, '');
  const compound=/^(?:in|within)\s+(\d+\s*h\s*\d+\s*m)\b/i.exec(clean);
  if(compound) return relativeDue(compound[1],nowMs);
  const match = new RegExp(RELATIVE_WORK.source, 'i').exec(clean);
  return match?.index === 0 ? nowMs + relativeMs(match[1], match[2]) : null;
}

/** A real overnight park resumes at the next 5am. Only the end-of-day
 * park window qualifies; saying "quiet hours" at midday cannot extend work. */
export function quietParkResume(text: string, nowMs: number): number | null {
  const wall=wallInZone(new Date(nowMs));
  if ((wall.h >= 5 && wall.h < 21) || !/\bquiet[ -]hours\b/i.test(text) || !/\b(?:park(?:ed|ing)?|stop(?:ped|ping)?|resum(?:e|ing))\b/i.test(text)) return null;
  const nextDay=new Date(Date.UTC(wall.y,wall.m0,wall.d+(wall.h>=21?1:0)));
  return instantInZone(nextDay.getUTCFullYear(),nextDay.getUTCMonth(),nextDay.getUTCDate(),5,0);
}

const CLAUSE_BREAK = /[.!?;]\s+|\n+|,\s+(?=(?:I\b|we\b|next\b|rest\b|done\b|then\b))/i;
function workClauses(text:string):string[] { return text.replace(/[’‘]/g,"'").split(CLAUSE_BREAK).map(s=>s.trim()).filter(Boolean); }

/** Validate only newly written clauses on an edit. Unchanged owner deadlines
 * and historical notes must survive an agent appending its own checkpoint. */
export function addedWorkText(before:string|undefined, after:unknown):string {
  if(typeof after!=='string' || after===before) return '';
  const old=workClauses(before??'');
  const norm=(s:string)=>s.replace(/\s+/g,' ').trim().replace(/[.!?;]+$/,'');
  return workClauses(after).flatMap(clause=>{
    const previous=old.find(s=>norm(s)===norm(clause));
    if(previous!==undefined) return [];
    // Appending a note on the same line leaves the existing text intact too.
    const prefix=old.find(s=>clause.startsWith(s) && /^\s|^[,;:]/.test(clause.slice(s.length)));
    if (!prefix) return [clause];
    const added=clause.slice(prefix.length).trim();
    // A qualifier such as 'tomorrow' changes the existing promise. Keep its
    // subject and verb instead of treating the new date as an isolated fact.
    const changesTime=/\b(?:tomorrow|tonight|morning|afternoon|evening|week|month|by|before|at|in|within|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.test(added);
    return [changesTime && !FUTURE_INTENT.test(added) && !WORK_LEAD.test(added) ? clause : added];
  }).join('\n');
}

function promisesWork(clause:string, now:Date):boolean {
  const ownFuture=/\b(?:I|we)(?:'ll| will| shall| plan to| aim to| expect to)\b/i.test(clause);
  const explicitFuture=FUTURE_INTENT.test(clause);
  if (/^\s*(?:I|we)\s+(?:will not|won't|cannot|can't)\b/i.test(clause)) return false;
  if (!ownFuture && (/^\s*(?:Matt|Kim)(?:'s)?\b|\b(?:Matt|Kim)'s deadline\b/i.test(clause) || /^\s*waiting on\b|^\s*(?!This\b|It\b)[A-Z][a-z]+(?:'s)?\s+(?:will|plans to|needs to)\b/i.test(clause))) return false;
  if (!explicitFuture && (PAST_CONTEXT.test(clause) || /^\s*(?:ship|release|deploy)\s+note\s*:/i.test(clause) || /\b(?:passed|merged|went fine|went well)\b/i.test(clause))) return false;
  if (!explicitFuture && /^\s*(?:done|ready)\s+at\s+/i.test(clause)) {
    const clock=clause.match(/\b(?:at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i)?.[1];
    if(clock) {
      const forms=/(am|pm)/i.test(clock)?[clock]:[clock+'am',clock+'pm'];
      const past=forms.some(c=>{const t=resolveClock('', 'today', c, now);return t!==null && t<=now.getTime();});
      if(past) return false;
    }
  }
  if (CALENDAR_DURATION.test(clause) && !/\b(?:finish|ship|fix|deliver|complete|results?|update|proof|checkpoint)\b/i.test(clause)) return false;
  const workPlan = /\b(?:send|ship|finish|fix|deliver|complete|report|results?|proof|rewrite|checkpoint|check[ -]?in)\b[^.!?]{0,100}\b(?:by|before|at|in|within|tomorrow|tonight|next week)\b|\b(?:PR|fix|proof|report|result|update|delivery|deck|release|build)\b[^.!?]{0,60}\b(?:up|due|ready|on track)\b/i.test(clause);
  return explicitFuture || WORK_LEAD.test(clause) || workPlan;
}

function workInstants(clause:string, now:Date):number[] {
  const nowMs=now.getTime(), instants:number[]=[];
  for(const match of clause.matchAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/gi)) { const at=Date.parse(match[0]);if(Number.isFinite(at))instants.push(at); }
  for(const match of clause.matchAll(RELATIVE_WORK)) instants.push(nowMs+relativeMs(match[1],match[2]));
  for(const match of clause.matchAll(/\b(?:within|in)\s+(?:(?:the next|the coming|the)\s+)?(hour|day|week)\b/gi)) instants.push(nowMs+relativeMs('one',match[1]));
  for(const match of clause.matchAll(/\b(?:in|within|ETA\s*:?)\s+(\d+)\s*h(?:ours?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?\b/gi)) instants.push(nowMs+Number(match[1])*3_600_000+Number(match[2])*60_000);
  const bare=/^\s*(?:back|back to you)\s+in\s+(\d+)\s*$/i.exec(clause.replace(/[.!]$/,''));
  if(bare) instants.push(nowMs+Number(bare[1])*60_000);
  if(/\bat the top of the hour\b/i.test(clause)) { const w=wallInZone(now);instants.push(nowMs+((60-w.min)*60_000)-(nowMs%60_000)); }
  const pairs=/\b(?:by|before|due|at|around|until|till|on track for|ETA|checkpoint|first look|next update|check[ -]?in|ready|finish|deliver|ship)\b\s*(?:(?:by|at|about|around)\s*|:\s*)?(noon|midnight|(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:am|pm)?)(?![\d:]|\.\d)\b/gi;
  for(const match of clause.matchAll(pairs)) {
    if(!/(?:am|pm)|:|noon|midnight/i.test(match[1]) && /^(?:finish|deliver|ship|ready)\b/i.test(match[0]))continue;
    if(!/(?:am|pm)|:|noon|midnight/i.test(match[1]) && !/^(?:(?:ET|EDT|EST)\b|today\b|tomorrow\b|tonight\b|[.,!?]|$)/i.test(clause.slice((match.index??0)+match[0].length).trim())) continue;
    let clock=match[1].trim().toLowerCase().replace(/\s+/g,'');
    if(clock==='noon')clock='12pm';if(clock==='midnight')clock='12am';
    if(!/(?:am|pm)$/.test(clock)) {
      const [h,m=0]=clock.split(':').map(Number);
      if(h>12||h===0)clock=`${h%12||12}:${String(m).padStart(2,'0')}${h>=12?'pm':'am'}`;
      else clock=['am','pm'].map(mer=>`${h}:${String(m).padStart(2,'0')}${mer}`).sort((a,b)=>(resolveClock('',undefined,a,now)??Infinity)-(resolveClock('',undefined,b,now)??Infinity))[0];
    }
    const days=[...clause.matchAll(DAY_ALL)].filter(d=>!/^'s\b/.test(clause.slice((d.index??0)+d[0].length)) && (!MONTHS.includes(d[1].toLowerCase().slice(0,3)) || /^\s+\d{1,2}\b/.test(clause.slice((d.index??0)+d[0].length))));
    days.sort((a,b)=>Math.abs((a.index??0)-(match.index??0))-Math.abs((b.index??0)-(match.index??0)));
    const at=resolveClock(clause,days[0]?.[1],clock,now);if(at!==null)instants.push(at);
  }
  return instants;
}

export function workTimingError(text:string,due?:string,dueAt?:number,nowMs=Date.now()):string|undefined {
  const now=new Date(nowMs),instants:number[]=[];
  if(due?.trim()) {
    const parsed=parseDue(due,now);
    if(parsed===null)return 'Nothing saved. Give a clear checkpoint within 30 minutes, such as "in 15 minutes" or an Eastern clock time.';
    instants.push(parsed);
  }
  if(typeof dueAt==='number'&&Number.isFinite(dueAt))instants.push(dueAt);
  // A date naming the event inside an object is not the delivery time:
  // 'Deliver the Oct 30 launch checklist' may still be worked on now.
  const namedEventDate = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\s+(?=(?:launch|webinar|meeting|event|conference|workshop|release|appointment)\b)/gi;
  const clauses=workClauses(text).map(c=>c.replace(namedEventDate, 'scheduled '));
  const nearCheckpoint=clauses.some(c=>/\b(?:next update|first (?:look|proof)|check[ -]?in|checkpoint)\b/i.test(c) && workInstants(c,now).some(t=>t>=nowMs&&t<=nowMs+WORK_CHECKPOINT_MS));
  for(const clause of clauses) {
    if(!promisesWork(clause,now))continue;
    if(nearCheckpoint && /\b(?:will|should) take\b|\b(?:build|render|job|migration) (?:takes|needs)\b/i.test(clause) && !/\b(?:finish|deliver|ship|complete)\b/i.test(clause))continue;
    const times=workInstants(clause,now);instants.push(...times);
    if(!times.length && /\b(?:tomorrow|tonight|EOD|COB|this (?:afternoon|evening|week)|later today|after lunch|(?:the |this )?weekend|(?:first thing )?in the morning|end of (?:the )?(?:day|week|month)|next (?:week|month)|on the \d{1,2}(?:st|nd|rd|th)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2})\b/i.test(clause)) return 'Nothing saved. Give the next concrete result a clear time within 30 minutes, rather than a later day or an open-ended deadline.';
  }
  const resume=quietParkResume(text,nowMs);
  if(resume!==null && instants.length) {
    if(instants.some(at=>at<resume||at>resume+WORK_CHECKPOINT_MS)) return 'Nothing saved. For a quiet-hours park, set the first checkpoint between 5:00 and 5:30am ET, after work resumes.';
    return undefined;
  }
  if(instants.some(at=>at-nowMs>WORK_CHECKPOINT_MS)) {
    const wall=wallInZone(now);
    const stop=instantInZone(wall.y,wall.m0,wall.d,22,0);
    const limit=wall.h<22&&wall.h>=5?Math.min(nowMs+WORK_CHECKPOINT_MS,stop):nowMs+WORK_CHECKPOINT_MS;
    const latest=new Intl.DateTimeFormat('en-US',{timeZone:ZONE,hour:'numeric',minute:'2-digit'}).format(new Date(limit));
    return `Nothing saved. That time is more than 30 minutes away. Give the next concrete result by ${latest} ET or sooner, then continue the larger job.`;
  }
  return undefined;
}
