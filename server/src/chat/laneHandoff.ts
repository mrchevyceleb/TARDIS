/**
 * Handing live lanes from a stopping server to the next one.
 *
 * At shutdown every engine running in a lane host (lib/laneHost.ts) is detached
 * instead of killed, and what the server knew about it is written here: which
 * host, the byte it had read up to, and the turn state the engine's own output
 * cannot rebuild (who the turn is for, which tool calls are open, background
 * work, deliveries waiting for their receipt). The next server adopts each one
 * at boot and carries on reading from that byte, so the turn, its shells and
 * its timers simply continue, and nothing is emitted twice or skipped.
 *
 * Sync file IO: the writer is a process with seconds to live.
 */

import { readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import type { HostedDetach } from '../lib/laneHost.ts';
import type { NativeRouteSnapshot } from './nativeCompactProxy.ts';

export type LaneHandoffBase = {
  /** Session-map key and identity of the lane. */
  key: string;
  cli: string;
  cwd: string;
  chatId: string;
  logKey: string;
  host: HostedDetach;
  /** When the old server let go; a lane that cannot be adopted is marked cut at this time. */
  detachedAt: number;
  /** Was a turn running? Decides whether a failed adoption needs a restart marker. */
  busy: boolean;
  /** Background work running inside the engine, by plain description. */
  backgroundWork: string[];
};

export type ClaudeLaneHandoff = LaneHandoffBase & {
  kind: 'claude';
  model: string;
  effort: string;
  nativeBaseUrl: string | null;
  /** The engine's compact-proxy route, re-registered under the same URL. */
  route: NativeRouteSnapshot | null;
  /** Plain-data session fields, restored verbatim (see CLAUDE_HANDOFF_FIELDS in runner.ts). */
  state: Record<string, unknown>;
};

/** Only Claude lanes run in lane hosts today; the other engines are cut at a
 *  restart and woken by restart wake (lib/restartWake.ts). */
export type LaneHandoff = ClaudeLaneHandoff;

type HandoffFile = { version: 1; pid: number; writtenAt: number; lanes: LaneHandoff[] };

export function laneHandoffFile(): string {
  return process.env.RIVENDELL_LANE_HANDOFF_FILE?.trim() || join(STATE_DIR, 'lane-handoff.json');
}

/** Write (or overwrite) this server's handoff. Idempotent: shutdown may call it twice. */
export function writeLaneHandoff(lanes: LaneHandoff[]): boolean {
  const file = laneHandoffFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const body: HandoffFile = { version: 1, pid: process.pid, writtenAt: Date.now(), lanes };
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (error) {
    console.warn(`[lane-handoff] could not write ${file}: ${(error as Error).message}`);
    return false;
  }
}

/** Read the last server's handoff and remove it, so it is adopted at most once. */
export function takeLaneHandoff(): LaneHandoff[] {
  const file = laneHandoffFile();
  let parsed: Partial<HandoffFile>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<HandoffFile>;
  } catch {
    return [];
  } finally {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.lanes)) return [];
  return parsed.lanes.filter((lane): lane is LaneHandoff =>
    Boolean(lane && typeof lane.key === 'string' && lane.host && typeof lane.host.hostId === 'string'
      && lane.kind === 'claude'));
}

/** Copy plain-data fields off an object (Sets and Maps become arrays). */
export function pickState(source: object, fields: readonly string[]): Record<string, unknown> {
  const from = source as Record<string, unknown>;
  const state: Record<string, unknown> = {};
  for (const field of fields) {
    const value = from[field];
    if (value instanceof Map) state[field] = { $map: [...value.entries()] };
    else if (value instanceof Set) state[field] = { $set: [...value] };
    else if (value !== undefined) state[field] = value;
  }
  return state;
}

/** The inverse of pickState, for the fields present in `state`. */
export function restoreState(target: object, fields: readonly string[], state: Record<string, unknown>): void {
  const to = target as Record<string, unknown>;
  for (const field of fields) {
    if (!(field in state)) continue;
    const value = state[field] as { $map?: [unknown, unknown][]; $set?: unknown[] } | unknown;
    if (value && typeof value === 'object' && Array.isArray((value as { $map?: unknown }).$map)) to[field] = new Map((value as { $map: [unknown, unknown][] }).$map);
    else if (value && typeof value === 'object' && Array.isArray((value as { $set?: unknown }).$set)) to[field] = new Set((value as { $set: unknown[] }).$set);
    else to[field] = value;
  }
}
