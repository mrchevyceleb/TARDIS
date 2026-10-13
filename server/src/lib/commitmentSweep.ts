// The past-due commitment sweep (card-baadaf gap 1): commitments cannot
// depend on memory alone, so a past-due entry is raised to its owner and to
// the Chief of Staff automatically, once per entry. Same 60s cadence as the
// other hygiene loops; side copies never run it.

import { deliverTeamMessage } from '../chat/teamBus.ts';
import { listCommitments, markCommitmentFlagged } from './commitmentStore.ts';
import { parseDue } from './promiseScan.ts';

const TICK_MS = 60_000;
const CHIEF_ID = 'chief-of-staff';
/** The pseudo-sender the flags arrive from: not a roster agent, so the
 *  outgoing-promise scan itself never re-processes a flag message. */
const SWEEPER = 'TARDIS';

async function run(): Promise<void> {
  const now = new Date();
  for (const commitment of listCommitments()) {
    if (commitment.flaggedAt || !commitment.due) continue;
    const dueAt = parseDue(commitment.due, now);
    if (dueAt === null || dueAt > now.getTime()) continue;
    if (!markCommitmentFlagged(commitment.id)) continue; // raised already, by another tick
    const raise = `Past-due commitment [${commitment.id}] "${commitment.text}" (due ${commitment.due}) is past due. Clear it with the commitments tool the moment it is done, or tell Max the new time if it slipped.`;
    try {
      const toOwner = await deliverTeamMessage({ from: SWEEPER, to: commitment.agentId, text: raise, wait: false, priority: true });
      if (!toOwner.delivered) console.warn(`[commitments] past-due flag to ${commitment.agentId} not delivered: ${toOwner.reason}`);
    } catch (error) {
      console.warn(`[commitments] past-due flag to ${commitment.agentId} failed: ${(error as Error).message}`);
    }
    if (commitment.agentId === CHIEF_ID) continue;
    try {
      const copy = await deliverTeamMessage({
        from: SWEEPER,
        to: CHIEF_ID,
        text: `Past-due flag: ${commitment.agentId}'s commitment [${commitment.id}] "${commitment.text}" (due ${commitment.due}) is past due. It went to them; make sure they act on it.`,
        wait: false,
        priority: true,
      });
      if (!copy.delivered) console.warn(`[commitments] past-due flag copy to the Chief not delivered: ${copy.reason}`);
    } catch (error) {
      console.warn(`[commitments] past-due flag copy to the Chief failed: ${(error as Error).message}`);
    }
  }
}

export function startCommitmentSweeper(): void {
  const timer = setInterval(() => {
    void run().catch((error) => console.warn('[commitments] sweep failed:', (error as Error).message));
  }, TICK_MS);
  timer.unref?.();
  void run().catch((error) => console.warn('[commitments] sweep failed:', (error as Error).message));
}
