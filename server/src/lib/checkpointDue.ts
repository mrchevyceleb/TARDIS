/** Validate actual checkpoint instants only. Never inspect work prose. */
import { inQuietHours } from './quietHours.ts';
export const CHECKPOINT_WINDOW_MS = 30 * 60_000;
const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
export const CHECKPOINT_REFUSAL = 'Set a checkpoint within 30 minutes on the whole job. Keep its full scope with one owner; do not shrink or split it.';
export function checkpointCeiling(now: number): number {
  let cap = now + CHECKPOINT_WINDOW_MS;
  if (inQuietHours(cap)) {
    // Advance through real instants, including DST, to the first 05:00 ET.
    let next = Math.floor(cap / 60_000) * 60_000;
    for (let i = 0; i < 9 * 60; i++, next += 60_000) {
      if (clock.format(new Date(next)) === '05:00') return next + CHECKPOINT_WINDOW_MS;
    }
  }
  return cap;
}
export function checkpointDueError(dueAt: number, now = Date.now()): string | undefined {
  if (!Number.isFinite(dueAt) || dueAt <= 0) return 'Use a real date and time for the checkpoint.';
  return dueAt > checkpointCeiling(now) ? CHECKPOINT_REFUSAL : undefined;
}
