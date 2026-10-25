/** Quiet hours (Matt, Oct 15 2026): nobody on the team works 22:00-05:00 ET.
 *  Weekend nights run longer (Matt, Oct 24 2026): Friday and Saturday nights
 *  are quiet 20:00-08:00 ET.
 *
 *  Every overnight automation delivery to a non-exempt lane holds until the
 *  window ends: teammate messages, routine fires, job results, watch wakes, and Desk
 *  check-in nudges. Exempt: Matt's own messages (Desk answers, voice
 *  continuations, and human channel posts — the boss may always speak),
 *  Max's lanes (the Chief of Staff is on overnight outage duty), Samwise's
 *  lane (Matt, Oct 19 2026: he and his comms routines keep working through
 *  the window, and only him), and Max's overnight emergency check by routine
 *  id. Held never means lost: every gated path parks its record durably and
 *  the next tick after the window ends delivers it unchanged.
 *
 *  This module owns the shared clock and lane facts so the call sites can
 *  never drift apart on the window, the roster ids, or the exemptions. The
 *  person-sourced record test itself lives with the queue in teamBus.ts
 *  (personSourced), next to the batch class logic it must stay consistent
 *  with. */

const etHourFmt = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  hourCycle: 'h23',
  timeZone: 'America/New_York',
});

const etMinuteFmt = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  hourCycle: 'h23',
  minute: 'numeric',
  timeZone: 'America/New_York',
});

const etWeekdayFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  timeZone: 'America/New_York',
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weeknight quiet window, Eastern hour of day, half-open: [22:00, 05:00). */
export const QUIET_START_ET = 22;
export const QUIET_END_ET = 5;

/** Friday and Saturday nights: [20:00, 08:00) ET (Matt, Oct 24 2026). */
export const WEEKEND_QUIET_START_ET = 20;
export const WEEKEND_QUIET_END_ET = 8;

/** Eastern weekday (0 = Sunday) and minute of day for an epoch-ms timestamp. */
function etClock(ms: number): { weekday: number; minuteOfDay: number } {
  const d = new Date(ms);
  const [h, m] = etMinuteFmt.format(d).split(':').map(Number);
  return { weekday: WEEKDAYS.indexOf(etWeekdayFmt.format(d)), minuteOfDay: h * 60 + m };
}

/** Minute of day the quiet window starts on the evening of `weekday`. */
function quietStartMinute(weekday: number): number {
  return (weekday === 5 || weekday === 6 ? WEEKEND_QUIET_START_ET : QUIET_START_ET) * 60;
}

/** Minute of day the quiet window ends on the morning of `weekday`
 *  (Saturday and Sunday mornings close Friday and Saturday nights). */
function quietEndMinute(weekday: number): number {
  return (weekday === 6 || weekday === 0 ? WEEKEND_QUIET_END_ET : QUIET_END_ET) * 60;
}

/** Max's lanes: overnight holds never apply (outage duty + the boss's voice). */
export const MAX_LANE_AGENT_IDS: ReadonlySet<string> = new Set(['chief-of-staff', 'max-voice']);

/** Samwise's lane: the one teammate exception (Matt, Oct 19 2026). He and his
 *  comms routines keep working through 22:00-05:00 ET, so deliveries to him,
 *  his jobs, and his routines never hold — and only him. */
export const SAMWISE_LANE_AGENT_IDS: ReadonlySet<string> = new Set(['samwise']);

/** Max's overnight emergency check: exempt by id even if its owner moves. */
export const MAX_EMERGENCY_ROUTINE_ID = 'rt-mv09wwrd-s5u8';

/** Per-agent timestamp (epoch ms) of the most recent exempt wake inside a
 *  quiet window (a person-sourced message or an explicit quietExempt routine
 *  fire). Jobs and watches started in the SAME quiet window at or after this
 *  wake may deliver their results overnight; a turn that started before
 *  22:00 ET has no exempt wake in the current window, so jobs it spawns
 *  after 22:00 ET hold until 05:00 ET (Opus review 3, Oct 16). */
const exemptWakeAtByAgent = new Map<string, number>();

/** Eastern hour of day for an epoch-ms timestamp, 0-23. */
export function etHour(ms: number): number {
  return Number(etHourFmt.format(new Date(ms)));
}

/** True inside the quiet window (weeknights 22:00-05:00 ET, Friday and
 *  Saturday nights 20:00-08:00 ET, half-open). */
export function inQuietHours(ms: number): boolean {
  const { weekday, minuteOfDay } = etClock(ms);
  return minuteOfDay < quietEndMinute(weekday) || minuteOfDay >= quietStartMinute(weekday);
}

/** True when agentId is one of Max's lanes. */
export function isMaxLane(agentId: string | undefined | null): boolean {
  return typeof agentId === 'string' && MAX_LANE_AGENT_IDS.has(agentId);
}

/** True when agentId is Samwise's lane. */
export function isSamwiseLane(agentId: string | undefined | null): boolean {
  return typeof agentId === 'string' && SAMWISE_LANE_AGENT_IDS.has(agentId);
}

/** True when the overnight holds never apply to agentId: Max's lanes and
 *  Samwise's lane. Every quiet-hours gate reads this, so the exemption set
 *  can never drift between call sites. */
export function isQuietExemptLane(agentId: string | undefined | null): boolean {
  return isMaxLane(agentId) || isSamwiseLane(agentId);
}

/** Every quiet edge is a whole Eastern hour, and Eastern offsets are whole
 *  hours, so quiet state is constant within each real UTC hour. The edge
 *  helpers below step through real instants an hour at a time, which keeps
 *  them exact across DST changes with no wall-clock arithmetic. */
const HOUR_MS = 3_600_000;
const EDGE_SCAN_HOURS = 72;

/** Start of the real hour containing `ms`. */
function hourFloor(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Latest hour start at or before `hourMs` whose quiet state is `quiet`. */
function prevHourWithState(hourMs: number, quiet: boolean): number {
  let t = hourMs;
  for (let i = 0; i < EDGE_SCAN_HOURS && inQuietHours(t) !== quiet; i++) t -= HOUR_MS;
  return t;
}

/** Earliest hour start at or after `hourMs` whose quiet state is `quiet`. */
function nextHourWithState(hourMs: number, quiet: boolean): number {
  let t = hourMs;
  for (let i = 0; i < EDGE_SCAN_HOURS && inQuietHours(t) !== quiet; i++) t += HOUR_MS;
  return t;
}

/** Epoch ms of the most recent quiet start at or before `ms`. Inside the
 *  window this is the current window's start; outside it, the previous
 *  night's start. */
export function lastQuietStartMs(ms: number): number {
  let t = hourFloor(ms);
  if (!inQuietHours(t)) t = prevHourWithState(t, true);
  return prevHourWithState(t, false) + HOUR_MS;
}

/** Epoch ms of the most recent quiet end at or before `ms`. Inside the
 *  window this is the previous morning's end; outside it, this morning's. */
export function lastQuietEndMs(ms: number): number {
  let t = hourFloor(ms);
  if (inQuietHours(t)) t = prevHourWithState(t, false);
  return prevHourWithState(t, true) + HOUR_MS;
}

/** Record that `agentId` received an exempt wake (person-sourced message or
 *  explicit quietExempt routine) at `atMs`. Only wakes inside quiet hours
 *  arm the current window's job/watch carve-out. */
export function recordQuietExemptWake(agentId: string, atMs: number = Date.now()): void {
  if (!agentId || !Number.isFinite(atMs) || !inQuietHours(atMs)) return;
  const prev = exemptWakeAtByAgent.get(agentId) ?? 0;
  if (atMs > prev) exemptWakeAtByAgent.set(agentId, atMs);
}

/** True when a job or watch started at `startedAtMs` for `agentId` may
 *  deliver its result inside quiet hours at `nowMs`: `nowMs` is in quiet
 *  hours, `startedAtMs` is inside the CURRENT quiet window (on or after
 *  `lastQuietStartMs(nowMs)`), and the agent received an exempt wake in
 *  this window at or before `startedAtMs`. Max lanes and Samwise's lane are
 *  always exempt. */
export function isQuietExemptWork(agentId: string, startedAtMs: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(startedAtMs) || !inQuietHours(nowMs)) return false;
  if (isQuietExemptLane(agentId)) return true;
  const windowStart = lastQuietStartMs(nowMs);
  if (startedAtMs < windowStart || startedAtMs > nowMs) return false;
  const wakeAt = exemptWakeAtByAgent.get(agentId);
  return typeof wakeAt === 'number' && wakeAt >= windowStart && startedAtMs >= wakeAt;
}

/** Clear recorded exempt wakes (for tests). */
export function resetQuietExemptWakes(): void {
  exemptWakeAtByAgent.clear();
}

/** Milliseconds until the quiet window ends, for scheduling a held retry.
 *  Outside quiet hours this is the time until the next window's end. */
export function msUntilQuietEnd(ms: number): number {
  let t = hourFloor(ms);
  if (!inQuietHours(t)) t = nextHourWithState(t, true);
  return Math.max(nextHourWithState(t, false) - ms, 0);
}
