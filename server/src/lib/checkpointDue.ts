/** Validate actual checkpoint instants only. Never inspect work prose. */
import { inQuietHours, msUntilQuietEnd } from './quietHours.ts';
export const CHECKPOINT_WINDOW_MS = 30 * 60_000;
export const CHECKPOINT_REFUSAL = 'Set a checkpoint within 30 minutes on the whole job. Keep its full scope with one owner; do not shrink or split it. Keep any owner-set job deadline in the work description; this time is your next progress check.';
export function checkpointCeiling(now: number): number {
  let cap = now + CHECKPOINT_WINDOW_MS;
  // A cap inside quiet hours moves to 30 minutes after the window ends.
  if (inQuietHours(cap)) return cap + msUntilQuietEnd(cap) + CHECKPOINT_WINDOW_MS;
  return cap;
}
export function checkpointDueError(dueAt: number, now = Date.now()): string | undefined {
  if (!Number.isFinite(dueAt) || dueAt <= 0) return 'Use a real date and time for the checkpoint.';
  return dueAt > checkpointCeiling(now) ? CHECKPOINT_REFUSAL : undefined;
}
