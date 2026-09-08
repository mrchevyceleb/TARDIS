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

export type Routine = {
  id: string;
  name: string;
  agentId: string;
  schedule: string;
  prompt: string;
  paused?: boolean;
  lastRunAt?: number;
  createdAt: number;
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

export function createRoutine(input: { name: string; agentId: string; schedule: string; prompt: string }): Routine | null {
  if (!listAgents().some((a) => a.id === input.agentId)) return null;
  const routine: Routine = {
    id: `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: input.name.trim().slice(0, 80) || 'Routine',
    agentId: input.agentId,
    schedule: parseSchedule(input.schedule) ? input.schedule.trim() : 'daily:09:00',
    prompt: input.prompt.trim().slice(0, 8000),
    createdAt: Date.now(),
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
  const next: Routine = {
    ...routines[idx],
    name: patch.name !== undefined ? (patch.name.trim().slice(0, 80) || routines[idx].name) : routines[idx].name,
    schedule: patch.schedule !== undefined && parseSchedule(patch.schedule) ? patch.schedule.trim() : routines[idx].schedule,
    prompt: patch.prompt !== undefined ? (patch.prompt.trim().slice(0, 8000) || routines[idx].prompt) : routines[idx].prompt,
    paused: patch.paused !== undefined ? patch.paused : routines[idx].paused,
  };
  routines[idx] = next;
  saveRoutines(routines);
  return next;
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
export async function runRoutine(id: string): Promise<{ ran: boolean; reason?: string }> {
  const routine = listRoutines().find((r) => r.id === id);
  if (!routine) return { ran: false, reason: 'routine not found' };
  const agent = listAgents().find((a) => a.id === routine.agentId);
  if (!agent) return { ran: false, reason: 'agent was deleted' };
  const text = `[routine: ${routine.name}]\n${routine.prompt}\n\n(Scheduled automation. Do the work. If nothing happened, reply with exactly NO_UPDATE and nothing else; TARDIS suppresses that protocol token from chat. Never emit a provider end-of-sequence marker, an empty-message marker, "I checked," or a watermark recap. Only post in the thread when something shipped, failed, or needs the user.)`;
  const result = await sendToAgentHome(agent, text, {
    peerFrom: `⚙︎ ${routine.name}`,
    peerFromRole: 'automation',
    peerText: routine.name,
  });
  if (result.delivered) {
    markRun(id, Date.now());
    skipUntil.delete(id);
    return { ran: true };
  }
  skipUntil.set(id, Date.now() + SKIP_COOLDOWN_MS);
  return { ran: false, reason: result.reason };
}

function markRun(id: string, at: number): void {
  const routines = listRoutines();
  const idx = routines.findIndex((r) => r.id === id);
  if (idx >= 0) {
    routines[idx] = { ...routines[idx], lastRunAt: at };
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

/** Slot timestamp (ms) for today at the given minutes-of-day, local time. */
function todaySlot(minutes: number): number {
  const d = new Date();
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
    if (sched.weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) return false;
    const slot = todaySlot(sched.minutes);
    return now >= slot && last < slot;
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
          console.log(`[routines] ${routine.name} → ${result.ran ? 'fired' : `skipped (${result.reason})`}`);
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
