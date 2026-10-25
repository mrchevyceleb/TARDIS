// Who may end a running turn at a tool boundary, shared by every engine that
// cannot take a message mid-turn and pauses instead (claude, agy, muse).
//
// Pausing a turn is not neutral: whatever work is left runs in the NEXT turn,
// and that turn belongs to whoever started it. When a teammate or an
// automated nudge paused the person's own turn, the rest of his work and its
// final reply ran in the sender's turn and folded under that exchange, so the
// person never saw his answer (Ivy, Oct 25 2026). So only a waiting person
// may end a person's turn; teammates and automation wait for it to finish.

/** A teammate's handoff may pause a working turn at most this often, so a burst
 *  of handoffs cannot starve the agent of any uninterrupted work. A person's
 *  message is never held off. */
export const PEER_BOUNDARY_INTERRUPT_GAP_MS = 60_000;

/** How long a scheduled, wake- or job-result-started (automation) turn runs
 *  before a teammate's handoff may end it at a tool boundary. Tim's
 *  job-started turns ran 40+ minutes with Riley's handoffs queued the whole
 *  time because automation turns were never interruptible for peers; the
 *  grace only protects a just-started turn's chance to report. */
export const PEER_AUTOMATION_TURN_GRACE_MS = 60_000;

/** Person-class roles a delivery can carry: the owner on the Desk, his own
 *  voice call continuing, and a real person on Slack (teamBus's human class). */
const PERSON_ROLES: ReadonlySet<string> = new Set(['desk', 'voice', 'slack']);

/** The turn this input opens belongs to a person, not a teammate or routine. */
export function personStartedTurn(opts: { peerFrom?: string; peerFromRole?: string }): boolean {
  if (opts.peerFromRole === 'automation') return false;
  return !opts.peerFrom || PERSON_ROLES.has(opts.peerFromRole ?? '');
}

/** A cut turn resumed by provider-continue keeps its person provenance. */
export function personOrigin(origin: { human: boolean; peers: Array<{ role: string }> }): boolean {
  return origin.human || origin.peers.some((peer) => PERSON_ROLES.has(peer.role));
}

export type BoundaryTurnState = {
  /** Waiters that are a person (Hall, Desk, voice, Slack, a person's channel post). */
  humanWaiters: number;
  /** The open turn was started by a person (see personStartedTurn). */
  personTurn: boolean;
  automationTurn: boolean;
  turnStartedAt: number;
  lastInterruptAt: number;
};

/** True when the waiters may end the open turn at this tool boundary. */
export function boundaryInterruptEligible(state: BoundaryTurnState, now: number = Date.now()): boolean {
  if (state.humanWaiters > 0) return true;
  if (state.personTurn) return false;
  if (now - state.lastInterruptAt < PEER_BOUNDARY_INTERRUPT_GAP_MS) return false;
  return !state.automationTurn || now - state.turnStartedAt >= PEER_AUTOMATION_TURN_GRACE_MS;
}
