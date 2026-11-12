/** Quiet-hours passes (Matt, Nov 12 2026): a time-boxed lift of the
 *  overnight quiet window for one teammate. Matt grants one from the
 *  teammate's editor, or Max does on his say. Until the pass ends the
 *  teammate works through quiet hours exactly like the standing exceptions
 *  (routines, job results, watch wakes, T3 Code session wakes, teammate
 *  messages, Desk nudges), and from that instant on the window applies to
 *  them again on its own: no code change, no restart.
 *
 *  Passes persist in <state>/quiet-hours-passes.json. Every quiet-hours gate
 *  reads them synchronously through quietHours.isQuietExemptLane, so this
 *  module keeps them in memory: read from disk on first use (a pass written
 *  before a restart is in force from boot) and replaced after every write.
 *  Only this server process writes the file. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { JsonStore } from './jsonStore.ts';

export type QuietPass = {
  /** The teammate's agent id: one pass per teammate. */
  id: string;
  /** ISO instant the pass ends; quiet hours hold this teammate again from then. */
  until: string;
  /** Why it was lifted, in a few words (shown to Matt and Max). */
  reason?: string;
  /** Who lifted it: Matt from the app, or Max on Matt's say. */
  grantedBy: string;
  createdAt?: string;
  updatedAt?: string;
};

const FILE = 'quiet-hours-passes.json';
const store = new JsonStore<QuietPass>(FILE, []);

/** The longest stretch one pass may cover, so every pass ends on its own. */
export const MAX_QUIET_PASS_MS = 30 * 24 * 3_600_000;

/** A grant the store refuses (bad end time); the message is for the person. */
export class QuietPassError extends Error {}

let passes: Map<string, QuietPass> | null = null;
const grantedListeners = new Set<(agentId: string) => void>();

const endsAt = (pass: QuietPass): number => Date.parse(pass.until);

function isPass(value: unknown): value is QuietPass {
  const pass = value as QuietPass | null;
  return Boolean(pass) && typeof pass?.id === 'string' && pass.id.length > 0
    && typeof pass.until === 'string' && Number.isFinite(endsAt(pass));
}

function current(): Map<string, QuietPass> {
  if (passes) return passes;
  passes = new Map();
  try {
    const saved: unknown = JSON.parse(readFileSync(join(STATE_DIR, FILE), 'utf8'));
    if (Array.isArray(saved)) for (const pass of saved) if (isPass(pass)) passes.set(pass.id, pass);
  } catch (error) {
    // No file is the normal case. An unreadable one lifts nothing, so quiet
    // hours keep applying to everyone (and the store refuses to overwrite it).
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[quiet-hours] ${FILE} unreadable, so no pass is in force: ${(error as Error).message}`);
    }
  }
  return passes;
}

/** The teammate's pass when one is in force at `nowMs`. */
export function activeQuietPass(agentId: string | undefined | null, nowMs: number = Date.now()): QuietPass | undefined {
  if (typeof agentId !== 'string') return undefined;
  const pass = current().get(agentId);
  return pass && endsAt(pass) > nowMs ? pass : undefined;
}

/** Every pass in force at `nowMs`, soonest end first. */
export function listQuietPasses(nowMs: number = Date.now()): QuietPass[] {
  return [...current().values()]
    .filter((pass) => endsAt(pass) > nowMs)
    .sort((a, b) => endsAt(a) - endsAt(b));
}

/** Runs after every grant. Each quiet-hours park that waits for the window
 *  end (routine fires, job-watch wakes, the team delivery queue) releases
 *  that teammate's held work here, so a lift granted at 23:00 delivers what
 *  is already waiting instead of leaving it parked until morning. */
export function onQuietPassGranted(listener: (agentId: string) => void): void {
  grantedListeners.add(listener);
}

/** One write under the store's chain. Expired passes drop out on the way. */
async function save(change: (live: QuietPass[]) => QuietPass[], nowMs: number): Promise<void> {
  const next = await store.modify((items) => change(items.filter((p) => isPass(p) && endsAt(p) > nowMs)));
  passes = new Map(next.map((pass) => [pass.id, pass]));
}

/** Grant `agentId` a pass until `until` (epoch ms), replacing any pass it has. */
export async function grantQuietPass(
  input: { agentId: string; until: number; reason?: string; grantedBy: string },
  nowMs: number = Date.now(),
): Promise<QuietPass> {
  if (!Number.isFinite(input.until) || input.until <= nowMs) throw new QuietPassError('Pick an end time in the future.');
  if (input.until - nowMs > MAX_QUIET_PASS_MS) throw new QuietPassError('A quiet-hours lift runs 30 days at most. Pick a sooner end.');
  const reason = input.reason?.trim().slice(0, 200);
  const stamp = new Date(nowMs).toISOString();
  const pass: QuietPass = {
    id: input.agentId,
    until: new Date(input.until).toISOString(),
    ...(reason ? { reason } : {}),
    grantedBy: input.grantedBy,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await save((live) => [...live.filter((p) => p.id !== pass.id), pass], nowMs);
  for (const listener of grantedListeners) {
    try { listener(pass.id); } catch (error) {
      console.warn(`[quiet-hours] releasing held work for ${pass.id} failed: ${(error as Error).message}`);
    }
  }
  return pass;
}

/** End `agentId`'s pass now. True when one was in force. */
export async function endQuietPass(agentId: string, nowMs: number = Date.now()): Promise<boolean> {
  if (!current().has(agentId)) return false;
  const wasActive = Boolean(activeQuietPass(agentId, nowMs));
  await save((live) => live.filter((p) => p.id !== agentId), nowMs);
  return wasActive;
}
