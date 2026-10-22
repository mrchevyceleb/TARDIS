// Agent-scoped routines — TARDIS-local automations that fire a prompt into
// a specific agent's home thread on a schedule. Quiet no-ops stay off the
// visible feed and unread badge; real ship/fail/needs-user results still land.
// Store: ~/.rivendell/routines.json.
//
// Schedules (kept deliberately simple + human):
//   "every:30m"          — every 30 minutes
//   "every:2h"           — every 2 hours
//   "daily:09:00"        — every day at 9am local
//   "weekdays:09:00"     — Mon–Fri at 9am local
//   "cron:*/10 * * * *"  — 5-field cron (minute granularity, */n + wildcards)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { listAgents, type Agent } from './agents.ts';
import { sendToAgentHome } from './teamBus.ts';
import { jevConfigured } from '../lib/jev.ts';
import { inQuietHours, isQuietExemptLane, msUntilQuietEnd, MAX_EMERGENCY_ROUTINE_ID } from '../lib/quietHours.ts';
import { runRoutineGate, type RoutineGateConfig } from './routineGate.ts';

export type Routine = {
  id: string;
  name: string;
  agentId: string;
  schedule: string;
  prompt: string;
  paused?: boolean;
  lastRunAt?: number;
  /** Timestamp (epoch ms) recorded when quiet hours hold a scheduled run;
   *  cleared by markRun on delivery or by updateRoutine on pause/reschedule. */
  heldSlotAt?: number;
  createdAt: number;
  /** Declarative pre-check run BEFORE the agent turn (see routineGate.ts):
   *  what to fetch, what to drop, what Jev should judge, and what justifies
   *  waking the agent. Absent, or with Jev unconfigured, the routine fires
   *  its plain turn exactly as before. */
  gate?: RoutineGateConfig;
};

const ROUTINES_FILE = join(STATE_DIR, 'routines.json');

export function listRoutines(): Routine[] {
  try {
    const data = JSON.parse(readFileSync(ROUTINES_FILE, 'utf8')) as { routines?: Routine[] };
    return Array.isArray(data.routines) ? data.routines : [];
  } catch {
    return [];
  }
}

function saveRoutines(routines: Routine[]): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ROUTINES_FILE, JSON.stringify({ routines }, null, 2));
}

export function createRoutine(input: { name: string; agentId: string; schedule: string; prompt: string; paused?: boolean }): Routine | null {
  if (!listAgents().some((a) => a.id === input.agentId)) return null;
  const routine: Routine = {
    id: `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: input.name.trim().slice(0, 80) || 'Routine',
    agentId: input.agentId,
    schedule: parseSchedule(input.schedule) ? input.schedule.trim() : 'daily:09:00',
    prompt: input.prompt.trim().slice(0, 8000),
    createdAt: Date.now(),
    paused: input.paused ?? false,
  };
  if (!routine.prompt) return null;
  const routines = listRoutines();
  routines.push(routine);
  saveRoutines(routines);
  return routine;
}

export function updateRoutine(id: string, patch: Partial<Pick<Routine, 'name' | 'schedule' | 'prompt' | 'paused'>>): Routine | null {
  const routines = listRoutines();
  const idx = routines.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const { heldSlotAt: prevHeld, ...rest } = routines[idx];
  const clearHeld = patch.schedule !== undefined || patch.paused === true;
  const next: Routine = {
    ...rest,
    ...(clearHeld || prevHeld === undefined ? {} : { heldSlotAt: prevHeld }),
    name: patch.name !== undefined ? (patch.name.trim().slice(0, 80) || routines[idx].name) : routines[idx].name,
    schedule: patch.schedule !== undefined && parseSchedule(patch.schedule) ? inputScheduleTrim(patch.schedule) : routines[idx].schedule,
    prompt: patch.prompt !== undefined ? (patch.prompt.trim().slice(0, 8000) || routines[idx].prompt) : routines[idx].prompt,
    paused: patch.paused !== undefined ? patch.paused : routines[idx].paused,
  };
  routines[idx] = next;
  saveRoutines(routines);
  return next;
}

function inputScheduleTrim(s: string): string {
  return s.trim();
}

/** Cascade: an agent's routines die with it (no ghost retry loops). */
export function deleteRoutinesForAgent(agentId: string): void {
  const routines = listRoutines();
  const next = routines.filter((r) => r.agentId !== agentId);
  if (next.length !== routines.length) saveRoutines(next);
}

export function deleteRoutine(id: string): boolean {
  const routines = listRoutines();
  const next = routines.filter((r) => r.id !== id);
  if (next.length === routines.length) return false;
  saveRoutines(next);
  return true;
}

/** Fire a routine now (manual run or scheduler). Only stamp lastRunAt on
 *  actual delivery. A watched-thread or busy-engine skip must not consume
 *  the daily slot; the scheduler retries after a short cooldown. */
export async function runRoutine(id: string, opts: { manual?: boolean } = {}): Promise<{ ran: boolean; reason?: string; gated?: string; agent?: string }> {
  const routine = listRoutines().find((r) => r.id === id);
  if (!routine) return { ran: false, reason: 'routine not found' };
  const agent = listAgents().find((a) => a.id === routine.agentId);
  if (!agent) return { ran: false, reason: 'agent was deleted' };
  const outcome = await runRoutineFor(routine, agent, opts);
  // The scheduler logs its own outcomes; a manual press used to vanish
  // without a trace, which read as a silent failure.
  if (opts.manual) console.log(`[routines] ${routine.name} (manual) → ${outcome.gated ? `gated (${outcome.gated})` : outcome.ran ? `fired → ${agent.name}` : `skipped (${outcome.reason})`}`);
  return { ...outcome, agent: agent.name };
}

async function runRoutineFor(routine: Routine, agent: Agent, opts: { manual?: boolean }): Promise<{ ran: boolean; reason?: string; gated?: string }> {
  const id = routine.id;
  // Quiet hours (Matt, Oct 15 2026) come before the gate and before any
  // spend: a scheduled fire to a non-Max lane inside 22:00-05:00 ET skips
  // without consuming the slot, records heldSlotAt on the routine, and parks
  // the retry at 05:00 ET so the first tick after 05:00 fires it unchanged.
  // Exempt: Max's lanes (overnight outage duty), Max's overnight emergency
  // check by id, and a manual press (someone explicitly asked for this run
  // now, like a person message).
  const nowEntry = Date.now();
  if (!opts.manual && id !== MAX_EMERGENCY_ROUTINE_ID
      && inQuietHours(nowEntry) && !isQuietExemptLane(agent.id)) {
    markHeld(id, nowEntry);
    skipUntil.set(id, nowEntry + msUntilQuietEnd(nowEntry));
    return { ran: false, reason: 'quiet hours (22:00-05:00 ET): held until 05:00' };
  }
  // A manual press or Max's emergency routine is an explicit ask for this
  // run now; sendToAgentHome would otherwise refuse the automation prompt
  // during the window and retry it every cooldown (Opus review, Oct 16).
  const quietExempt = opts.manual === true || id === MAX_EMERGENCY_ROUTINE_ID;
  // Gate first. A quiet result consumes the slot exactly like a delivered
  // NO_UPDATE turn would, without the turn. Any gate failure falls OPEN to
  // the plain agent turn: the sweep must never silently stop because Jev or
  // the MCP had a bad minute.
  let findings = '';
  let commitGate: (() => void) | null = null;
  // Pressing Run means "run the agent", not "check whether the agent should
  // run": a manual press skips the gate entirely.
  if (routine.gate && jevConfigured() && !opts.manual) {
    try {
      const outcome = await runRoutineGate(routine.id, routine.gate);
      if (!outcome.wake) {
        outcome.commit();
        markRun(id, Date.now());
        skipUntil.delete(id);
        return { ran: true, gated: `quiet — ${outcome.summary}` };
      }
      findings = `\n\n${outcome.digest}`;
      // Watermarks advance only once the agent has actually received the
      // items; a dropped delivery must not lose what caused the wake.
      commitGate = outcome.commit;
      console.log(`[routines] ${routine.name} gate woke the agent — ${outcome.summary}`);
    } catch (err) {
      console.warn(`[routines] ${routine.name} gate failed, running the full turn instead:`, (err as Error).message);
    }
  }
  const text = `[routine: ${routine.name}]\n${routine.prompt}${findings}\n\n(Scheduled automation. Do the work. If nothing happened, reply with exactly NO_UPDATE and nothing else; TARDIS suppresses that protocol token from chat. Never emit a provider end-of-sequence marker, an empty-message marker, "I checked," or a watermark recap. Only post in the thread when something shipped, failed, or needs the user.)`;
  const result = await sendToAgentHome(agent, text, {
    peerFrom: `⚙︎ ${routine.name}`,
    peerFromRole: 'automation',
    peerText: routine.name,
    // A manual press lands in the thread Matt is looking at; scheduled
    // fires keep their normal background lane.
    lane: opts.manual ? 'main' : undefined,
    quietExempt,
  });
  if (result.delivered) {
    commitGate?.();
    markRun(id, Date.now());
    skipUntil.delete(id);
    return { ran: true };
  }
  const nowAfter = Date.now();
  if ((result.reason ?? '').startsWith('quiet hours')) {
    markHeld(id, nowAfter);
    skipUntil.set(id, nowAfter + msUntilQuietEnd(nowAfter));
    return { ran: false, reason: result.reason };
  }
  skipUntil.set(id, nowAfter + SKIP_COOLDOWN_MS);
  return { ran: false, reason: result.reason };
}

function markHeld(id: string, at: number): void {
  const routines = listRoutines();
  const idx = routines.findIndex((r) => r.id === id);
  if (idx >= 0) {
    const prev = routines[idx].heldSlotAt;
    const last = routines[idx].lastRunAt ?? routines[idx].createdAt;
    routines[idx] = {
      ...routines[idx],
      heldSlotAt: typeof prev === 'number' && prev > last ? prev : at,
    };
    saveRoutines(routines);
  }
}

function markRun(id: string, at: number): void {
  const routines = listRoutines();
  const idx = routines.findIndex((r) => r.id === id);
  if (idx >= 0) {
    const { heldSlotAt: _cleared, ...rest } = routines[idx];
    routines[idx] = { ...rest, lastRunAt: at };
    saveRoutines(routines);
  }
}

const SKIP_COOLDOWN_MS = 2 * 60 * 1000;
const skipUntil = new Map<string, number>();

// ---- schedule parsing / due checks -------------------------------------------

type Schedule =
  | { kind: 'every'; ms: number }
  | { kind: 'daily'; minutes: number; weekdaysOnly: boolean }
  | { kind: 'cron'; fields: string[] };

export function parseSchedule(raw: string): Schedule | null {
  const s = raw.trim().toLowerCase();
  let m = /^every:(\d+)(m|min|h|hr)$/.exec(s);
  if (m) {
    const n = Math.max(1, parseInt(m[1], 10));
    return { kind: 'every', ms: n * (m[2].startsWith('h') ? 3_600_000 : 60_000) };
  }
  m = /^(weekdays|daily):(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hh = parseInt(m[2], 10);
    const mm = parseInt(m[3], 10);
    if (hh > 23 || mm > 59) return null;
    return { kind: 'daily', minutes: hh * 60 + mm, weekdaysOnly: m[1] === 'weekdays' };
  }
  m = /^cron:(.+)$/.exec(raw.trim());
  if (m) {
    const fields = m[1].trim().split(/\s+/);
    if (fields.length !== 5) return null;
    return { kind: 'cron', fields };
  }
  return null;
}

/** Slot timestamp (ms) for the day of `now` at the given minutes-of-day,
 *  local time. `now` seeds the day so the daily legs are testable against a
 *  pinned clock (Opus verify, Oct 16). */
function todaySlot(minutes: number, now: number): number {
  const d = new Date(now);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    const step = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!step) continue;
    const [, range, stepRaw] = step;
    const stepN = stepRaw ? Math.max(1, parseInt(stepRaw, 10)) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const dash = range.indexOf('-');
      lo = dash >= 0 ? parseInt(range.slice(0, dash), 10) : parseInt(range, 10);
      hi = dash >= 0 ? parseInt(range.slice(dash + 1), 10) : (stepRaw ? max : lo);
    }
    if (value >= lo && value <= hi && (value - lo) % stepN === 0) return true;
  }
  return false;
}

function cronMatchesAt(fields: string[], at: Date): boolean {
  const [minF, hourF, domF, monF, dowF] = fields;
  return cronFieldMatches(minF, at.getMinutes(), 0, 59)
    && cronFieldMatches(hourF, at.getHours(), 0, 23)
    && (domF === '*' || cronFieldMatches(domF, at.getDate(), 1, 31))
    && (monF === '*' || cronFieldMatches(monF, at.getMonth() + 1, 1, 12))
    && (dowF === '*' || cronFieldMatches(dowF, at.getDay(), 0, 6));
}

/** Most recent matching cron minute at or before `now`, searching back 24h. */
function mostRecentCronSlot(fields: string[], now: number): number | null {
  const d = new Date(now);
  d.setSeconds(0, 0);
  for (let i = 0; i < 24 * 60; i++) {
    if (cronMatchesAt(fields, d)) return d.getTime();
    d.setMinutes(d.getMinutes() - 1);
  }
  return null;
}

export function routineIsDue(routine: Routine, now: number): boolean {
  if ((skipUntil.get(routine.id) ?? 0) > now) return false;
  const sched = parseSchedule(routine.schedule);
  if (!sched) return false;
  const last = routine.lastRunAt ?? routine.createdAt;
  if (sched.kind === 'every') {
    return now >= last + sched.ms;
  }
  if (sched.kind === 'daily') {
    const d = new Date(now);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    if (!sched.weekdaysOnly || !isWeekend) {
      const slot = todaySlot(sched.minutes, now);
      if (now >= slot && last < slot) return true;
    }
    // Catch up a slot that quiet hours actually held (persisted on the
    // routine as heldSlotAt when the quiet-hours hold fired, either at
    // entry or after admission slipped past 22:00 ET, and cleared in
    // markRun). Recording the hold instead of guessing from yesterday's
    // slot time means:
    // - a Friday weekdays:22:30 slot held at 22:30 catches up after 05:00 ET
    //   even across the weekend (Saturday's weekend guard only blocks a new
    //   Saturday slot, not Friday's held run),
    // - a daily:21:50 slot whose busy retry or admission wait slipped into
    //   22:00+ ET catches up after 05:00 ET, and
    // - a paused or freshly unpaused routine never fires a stale catch-up
    //   for a slot that was never held (Opus review 3, Oct 16).
    return typeof routine.heldSlotAt === 'number'
      && last < routine.heldSlotAt
      && !inQuietHours(now)
      && !isQuietExemptLane(routine.agentId);
  }
  // cron: due if the most recent matching slot has not been delivered yet.
  // A watched-thread skip must not burn that slot for the rest of the day.
  const slot = mostRecentCronSlot(sched.fields, now);
  return slot != null && last < slot;
}

/** Minute scheduler — started once at boot. inFlight is the overlap guard so
 *  a skipped delivery can retry; lastRunAt is stamped only after delivery. */
const inFlight = new Set<string>();
export function startRoutineScheduler(): void {
  const tick = async () => {
    const now = Date.now();
    const due: Routine[] = [];
    for (const routine of listRoutines()) {
      if (routine.paused || inFlight.has(routine.id)) continue;
      if (routineIsDue(routine, now)) {
        inFlight.add(routine.id);
        due.push(routine);
      }
    }
    for (const routine of due) {
      void (async () => {
        try {
          const result = await runRoutine(routine.id);
          console.log(`[routines] ${routine.name} → ${result.gated ? `gated (${result.gated})` : result.ran ? 'fired' : `skipped (${result.reason})`}`);
        } catch (err) {
          console.warn(`[routines] ${routine.name} failed:`, (err as Error).message);
        } finally {
          inFlight.delete(routine.id);
        }
      })();
    }
  };
  const iv = setInterval(() => { void tick(); }, 30_000);
  iv.unref?.();
}

/** Routines (with agent names) for the panel. */
export function routinesWithAgents(): Array<Routine & { agentName: string }> {
  const agents = new Map(listAgents().map((a) => [a.id, a.name]));
  return listRoutines()
    .filter((r) => agents.has(r.agentId))
    .map((r) => ({ ...r, agentName: agents.get(r.agentId) ?? '' }));
}
