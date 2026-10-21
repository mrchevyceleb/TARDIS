/** Quiet hours (Matt, Oct 15 2026): nobody on the team works 22:00-05:00 ET.
 *
 *  Every overnight automation delivery to a non-exempt lane holds until 05:00
 *  ET: teammate messages, routine fires, job results, watch wakes, and Desk
 *  check-in nudges. Exempt: Matt's own messages (Desk answers, voice
 *  continuations, and human channel posts — the boss may always speak),
 *  Max's lanes (the Chief of Staff is on overnight outage duty), Samwise's
 *  lane (Matt, Oct 19 2026: he and his comms routines keep working through
 *  the window, and only him), and Max's overnight emergency check by routine
 *  id. Held never means lost: every gated path parks its record durably and
 *  the next tick after 05:00 ET delivers it unchanged.
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

/** Quiet window, Eastern hour of day, half-open: [22:00, 05:00). */
export const QUIET_START_ET = 22;
export const QUIET_END_ET = 5;

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

/** True inside the quiet window (22:00-05:00 ET, half-open). */
export function inQuietHours(ms: number): boolean {
  const h = etHour(ms);
  return h < QUIET_END_ET || h >= QUIET_START_ET;
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

/** Epoch ms of the most recent 22:00 ET quiet start at or before `ms`. Inside
 *  the window this is the current window's start; outside it, the previous
 *  night's start. Floored to the minute so sub-minute timestamps compare
 *  against the true 22:00:00.000 boundary. */
export function lastQuietStartMs(ms: number): number {
  const [h, m] = etMinuteFmt.format(new Date(ms)).split(':').map(Number);
  const minuteOfDay = h * 60 + m;
  const minutesSinceStart = (minuteOfDay - QUIET_START_ET * 60 + 1440) % 1440;
  const wholeMinuteMs = Math.floor(ms / 60_000) * 60_000;
  return wholeMinuteMs - minutesSinceStart * 60_000;
}

/** Epoch ms of the most recent 05:00 ET quiet end at or before `ms`. Inside
 *  the window this is the previous morning's end; outside it, this
 *  morning's. Minute arithmetic like msUntilQuietEnd: a DST-transition day
 *  can land an hour off, and callers only use it as a grace anchor. */
export function lastQuietEndMs(ms: number): number {
  const [h, m] = etMinuteFmt.format(new Date(ms)).split(':').map(Number);
  const minuteOfDay = h * 60 + m;
  const minutesSinceEnd = (minuteOfDay - QUIET_END_ET * 60 + 1440) % 1440;
  const wholeMinuteMs = Math.floor(ms / 60_000) * 60_000;
  return wholeMinuteMs - minutesSinceEnd * 60_000;
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

/** Milliseconds until the 05:00 ET quiet end, for scheduling a held retry.
 *  Minute-of-day arithmetic (not wall-clock reconstruction): a
 *  DST-transition night can land the timer up to an hour off, and the
 *  tick/retry that follows self-corrects — a held record re-aborts and
 *  reschedules, never lost. */
export function msUntilQuietEnd(ms: number): number {
  const [h, m] = etMinuteFmt.format(new Date(ms)).split(':').map(Number);
  const minuteOfDay = h * 60 + m;
  const QUIET_END_MIN = QUIET_END_ET * 60;
  const remaining = minuteOfDay < QUIET_END_MIN
    ? QUIET_END_MIN - minuteOfDay
    : 24 * 60 - minuteOfDay + QUIET_END_MIN;
  return Math.min(Math.max(remaining, 0), 8 * 60) * 60_000;
}
