/** Quiet hours (Matt, Oct 15 2026; moved to 21:00-07:00 ET on Nov 2 2026):
 *  nobody on the team works weeknights 21:00-07:00 ET.
 *  Weekend nights run longer (Matt, Oct 24 2026): Friday and Saturday nights
 *  are quiet 20:00-08:00 ET.
 *
 *  Every overnight automation delivery to a non-exempt lane holds until the
 *  window ends: teammate messages, routine fires, job results, watch wakes, and Desk
 *  check-in nudges. Exempt: Matt's own messages (Desk answers, voice
 *  continuations, and human channel posts — the boss may always speak),
 *  Max's lanes (the Chief of Staff is on overnight outage duty), Samwise's
 *  lane (Matt, Oct 19 2026: he and his comms routines keep working through
 *  the window) and Pippin, Samwise's coding companion (Matt, Nov 2 2026), and
 *  Max's overnight emergency check by routine id. Any other teammate is
 *  exempt while a quiet-hours pass is in force (quietPasses.ts, Matt, Nov 12
 *  2026): Matt, or Max on his say, lifts the window for a set stretch and it
 *  applies again on its own when the stretch ends. Held never means lost:
 *  every gated path parks its record durably and the next tick after the
 *  window ends (or after a pass lifts it) delivers it unchanged.
 *
 *  This module owns the shared clock and lane facts so the call sites can
 *  never drift apart on the window, the roster ids, or the exemptions. The
 *  person-sourced record test itself lives with the queue in teamBus.ts
 *  (personSourced), next to the batch class logic it must stay consistent
 *  with. */

import { activeQuietPass } from './quietPasses.ts';

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

/** Weeknight quiet window, Eastern hour of day, half-open: [21:00, 07:00)
 *  (Matt, Nov 2 2026; was 22:00-05:00). */
export const QUIET_START_ET = 21;
export const QUIET_END_ET = 7;

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

/** Samwise's lane and Pippin, his coding companion: the standing teammate
 *  exceptions (Matt, Oct 19 2026 for Samwise; Nov 2 2026 for Pippin). They
 *  and their routines keep working through the quiet window, so deliveries
 *  to them, their jobs, and their routines never hold. Anyone else needs a
 *  time-boxed pass (quietPasses.ts). */
export const SAMWISE_LANE_AGENT_IDS: ReadonlySet<string> = new Set(['samwise', 'pippin-2']);

/** Max's overnight emergency check: exempt by id even if its owner moves. */
export const MAX_EMERGENCY_ROUTINE_ID = 'rt-mv09wwrd-s5u8';

/** Per-agent timestamp (epoch ms) of the most recent exempt wake inside a
 *  quiet window (a person-sourced message or an explicit quietExempt routine
 *  fire). Jobs and watches started in the SAME quiet window at or after this
 *  wake may deliver their results overnight; a turn that started before
 *  the window start has no exempt wake in the current window, so jobs it
 *  spawns after the start hold until the window ends (Opus review 3, Oct 16). */
const exemptWakeAtByAgent = new Map<string, number>();

/** Eastern hour of day for an epoch-ms timestamp, 0-23. */
export function etHour(ms: number): number {
  return Number(etHourFmt.format(new Date(ms)));
}

/** The pre-restart check's side copy (RIVENDELL_SIDE_COPY=1) has no real
 *  teammates and no night to protect: its only lanes are the check's own
 *  sandbox probes. Quiet hours there would turn the check's team_message
 *  wait:true into a held, reply-less receipt, so an overnight update could
 *  never pass the team leg (Nov 4 2026). */
const SIDE_COPY = process.env.RIVENDELL_SIDE_COPY === '1';

/** The window rule itself, side copy or not. */
function inQuietWindow(ms: number): boolean {
  const { weekday, minuteOfDay } = etClock(ms);
  return minuteOfDay < quietEndMinute(weekday) || minuteOfDay >= quietStartMinute(weekday);
}

/** True inside the quiet window (weeknights 21:00-07:00 ET, Friday and
 *  Saturday nights 20:00-08:00 ET, half-open). Never true in a side copy. */
export function inQuietHours(ms: number): boolean {
  return !SIDE_COPY && inQuietWindow(ms);
}

/** True when agentId is one of Max's lanes. */
export function isMaxLane(agentId: string | undefined | null): boolean {
  return typeof agentId === 'string' && MAX_LANE_AGENT_IDS.has(agentId);
}

/** True when agentId is Samwise's lane or Pippin's. */
export function isSamwiseLane(agentId: string | undefined | null): boolean {
  return typeof agentId === 'string' && SAMWISE_LANE_AGENT_IDS.has(agentId);
}

/** True when agentId always works through quiet hours: Max's lanes, and
 *  Samwise's lane and Pippin's. These never need a pass. */
export function hasStandingQuietExemption(agentId: string | undefined | null): boolean {
  return isMaxLane(agentId) || isSamwiseLane(agentId);
}

/** True when the overnight holds do not apply to agentId at `nowMs`: the
 *  standing exceptions, and any teammate whose quiet-hours pass is still in
 *  force. Every quiet-hours gate reads this, so the exemption set can never
 *  drift between call sites, and a pass starts and ends for every gate at
 *  once. */
export function isQuietExemptLane(agentId: string | undefined | null, nowMs: number = Date.now()): boolean {
  return hasStandingQuietExemption(agentId) || activeQuietPass(agentId, nowMs) !== undefined;
}

/** True when quiet hours hold automation for agentId at `nowMs`: inside the
 *  window and not exempt. Read it at the moment of delivery, never once up
 *  front: a pass can start or end while a delivery waits for admission. */
export function quietHoldsFor(agentId: string | undefined | null, nowMs: number = Date.now()): boolean {
  return inQuietHours(nowMs) && !isQuietExemptLane(agentId, nowMs);
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
 *  this window at or before `startedAtMs`. An exempt lane (standing, or on
 *  a pass at `nowMs`) always is. */
export function isQuietExemptWork(agentId: string, startedAtMs: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(startedAtMs) || !inQuietHours(nowMs)) return false;
  if (isQuietExemptLane(agentId, nowMs)) return true;
  const windowStart = lastQuietStartMs(nowMs);
  if (startedAtMs < windowStart || startedAtMs > nowMs) return false;
  const wakeAt = exemptWakeAtByAgent.get(agentId);
  return typeof wakeAt === 'number' && wakeAt >= windowStart && startedAtMs >= wakeAt;
}

/** Clear recorded exempt wakes (for tests). */
export function resetQuietExemptWakes(): void {
  exemptWakeAtByAgent.clear();
}

/** When each of the next `count` quiet windows ends, starting with the one in
 *  force at `ms`: the ends a lift for tonight, 3 nights or a week runs to.
 *  Windows open and close on the hour in Eastern time, so an hourly walk
 *  lands exactly on each edge. */
export function quietWindowEnds(ms: number, count: number): number[] {
  const ends: number[] = [];
  let t = hourFloor(ms);
  while (ends.length < count) {
    while (!inQuietWindow(t)) t += HOUR_MS;
    while (inQuietWindow(t)) t += HOUR_MS;
    ends.push(t);
  }
  return ends;
}

/** Milliseconds until the quiet window ends, for scheduling a held retry.
 *  Outside quiet hours this is the time until the next window's end. */
export function msUntilQuietEnd(ms: number): number {
  let t = hourFloor(ms);
  if (!inQuietHours(t)) t = nextHourWithState(t, true);
  return Math.max(nextHourWithState(t, false) - ms, 0);
}
