import type { LiveSession } from '../data/types';

export const RECENT_TURN_MS = 2 * 60_000;

/** A busy flag can outlive its process. Count recent signals, not just open turns. */
export function lastTurnSignal(session: LiveSession): number {
  return Math.max(session.lastActivityAt || 0, session.busySince || 0, session.activity?.at || 0);
}

export function hasRecentTurnSignal(session: LiveSession, now = Date.now()): boolean {
  return session.busy && now - lastTurnSignal(session) <= RECENT_TURN_MS;
}
