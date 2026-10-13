// The past-due commitment sweep (card-baadaf gap 1): commitments cannot
// depend on memory alone, so a past-due entry is raised to its owner and to
// the Chief of Staff automatically. Each recipient is marked raised only
// after its delivery succeeds, so a failed raise retries on the next tick.
// Legacy entries without a stored absolute instant get theirs persisted on
// first read, so a relative display due ("10pm tomorrow") can no longer move
// with every reparse. Same 60s cadence as the other hygiene loops; side
// copies never run it.

import { deliverTeamMessage } from '../chat/teamBus.ts';
import { listCommitments, markCommitmentRaised, noteCommitmentDueAt } from './commitmentStore.ts';
import { parseDue } from './promiseScan.ts';

const TICK_MS = 60_000;
const CHIEF_ID = 'chief-of-staff';
/** The pseudo-sender the raises arrive from: not a roster agent, so the
 *  outgoing-promise scan itself never re-processes a raise message. */
const SWEEPER = 'TARDIS';

let busy = false;

async function run(): Promise<void> {
  const now = new Date();
  for (const commitment of listCommitments()) {
    if (!commitment.due) continue;
    let dueAt = commitment.dueAt;
    if (dueAt === undefined) {
      // A legacy relative due ("10pm tomorrow") is parsed anchored at the
      // entry's own creation, not at this sweep: the promise meant the day it
      // was written, and an overdue one must stay overdue instead of moving
      // into the future with every reparse.
      const parsed = parseDue(commitment.due, new Date(commitment.createdAt || now.getTime()));
      if (parsed === null) continue; // unreadable dues are never raised
      noteCommitmentDueAt(commitment.id, parsed);
      dueAt = parsed;
    }
    if (dueAt > now.getTime()) continue;
    const raise = `Past-due commitment [${commitment.id}] "${commitment.text}" (due ${commitment.due}) is past due. Clear it with the commitments tool the moment it is done, or tell Max the new time if it slipped.`;
    let ownerDelivered: boolean | null = null;
    if (!commitment.raised?.owner) {
      try {
        const toOwner = await deliverTeamMessage({ from: SWEEPER, to: commitment.agentId, text: raise, wait: false, priority: true });
        ownerDelivered = toOwner.delivered === true;
        if (toOwner.delivered) markCommitmentRaised(commitment.id, 'owner');
        else console.warn(`[commitments] past-due raise to ${commitment.agentId} not delivered (retried next tick): ${toOwner.reason}`);
      } catch (error) {
        ownerDelivered = false;
        console.warn(`[commitments] past-due raise to ${commitment.agentId} failed (retried next tick): ${(error as Error).message}`);
      }
    }
    if (commitment.agentId !== CHIEF_ID && !commitment.raised?.chief) {
      // The copy's wording says what actually happened: "it went to them"
      // only when it did; a failing owner delivery must not read as done to
      // the Chief it is escalating to.
      const wentWell = ownerDelivered === null ? Boolean(commitment.raised?.owner) : ownerDelivered;
      const outcome = wentWell
        ? 'It went to them; make sure they act on it.'
        : 'Their raise is currently NOT delivering (it retries every minute) — chase them directly.';
      try {
        const copy = await deliverTeamMessage({
          from: SWEEPER,
          to: CHIEF_ID,
          text: `Past-due flag: ${commitment.agentId}'s commitment [${commitment.id}] "${commitment.text}" (due ${commitment.due}) is past due. ${outcome}`,
          wait: false,
          priority: true,
        });
        if (copy.delivered) markCommitmentRaised(commitment.id, 'chief');
        else console.warn(`[commitments] past-due flag copy to the Chief not delivered (retried next tick): ${copy.reason}`);
      } catch (error) {
        console.warn(`[commitments] past-due flag copy to the Chief failed (retried next tick): ${(error as Error).message}`);
      }
    }
  }
}

export function startCommitmentSweeper(): void {
  const attempt = () => {
    if (busy) return; // a slow run keeps its tick; the next one covers the rest
    busy = true;
    void run()
      .catch((error) => console.warn('[commitments] sweep failed:', (error as Error).message))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(attempt, TICK_MS);
  timer.unref?.();
  attempt();
}
