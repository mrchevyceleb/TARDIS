// A nudge must never derail a live turn (Matt via Max, Oct 18 2026,
// card-b3468c): the flag digest, the Desk quiet-check sweep, and the past-due
// Chief copy hold a recipient's nudge — unmarked and queued, exactly like
// the quiet-hours hold — while that recipient's lane is mid-turn, and it
// lands on the first window after the turn ends. Holding never means
// losing: the hold is bounded by LIVE_HOLD_CEILING_MS, so a lane stuck in
// one long turn still gets its nudge once the pending nudge ages past the
// ceiling.
//
// Liveness is ground truth, not inference: the same busy-lane availability
// /api/team serves (a busy home-lane session in the live roster), read
// through ONE dynamic import so no static cycle is introduced between the
// chat module graph and the nudge paths. A read failure fails OPEN (no
// lane counts as live, nudges deliver): a broken gate must never swallow a
// nudge — a mid-turn nudge is a recoverable annoyance, a silently held
// one forever is a loss.

export const LIVE_HOLD_CEILING_MS = 60 * 60_000;

/** The set of agent ids whose lane is mid-turn right now (busy), or an
 *  empty set when the roster cannot be read (fail open). */
export async function agentsWithLiveTurns(): Promise<ReadonlySet<string>> {
  try {
    const { teamRoster } = await import('../chat/teamBus.ts');
    const roster = await teamRoster();
    const live = new Set<string>();
    for (const agent of roster) {
      if (agent.busy === true) live.add(agent.id);
    }
    return live;
  } catch {
    return new Set<string>();
  }
}
