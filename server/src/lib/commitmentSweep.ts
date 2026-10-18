// The past-due commitment sweep (card-baadaf gap 1): commitments cannot
// depend on memory alone, so a past-due entry is raised to its owner and to
// the Chief of Staff automatically. Each recipient is marked raised only
// after its delivery succeeds, so a failed raise retries on the next tick.
// Legacy entries without a stored absolute instant get theirs persisted on
// first read, so a relative display due ("10pm tomorrow") can no longer move
// with every reparse. Same 60s cadence as the other hygiene loops; side
// copies never run it.

import { deliverTeamMessage } from '../chat/teamBus.ts';
import { flushFlagDigests, queueFlagDigest } from './flagDigest.ts';
import { listCommitments, markCommitmentRaised, noteCommitmentDueAt, ownerRaiseHeldByText } from './commitmentStore.ts';
import { LIVE_HOLD_CEILING_MS, agentsWithLiveTurns } from './laneLiveness.ts';
import { parseDue } from './promiseScan.ts';

const TICK_MS = 60_000;
const CHIEF_ID = 'chief-of-staff';
/** The pseudo-sender the raises arrive from: not a roster agent, so the
 *  outgoing-promise scan itself never re-processes a raise message. The
 *  owner digest delivers through the same pseudo-sender (flagDigest.ts). */
const SWEEPER = 'TARDIS';

let busy = false;

async function run(): Promise<void> {
  const now = new Date();
  // Lane-liveness (Max, Oct 18 2026, card-b3468c): the Chief copy holds,
  // unmarked, while the Chief's lane is mid-turn, bounded by the hold
  // ceiling so a stuck lane still gets it. The owner raise rides the flag
  // digest, which applies its own gate. Fail-open: an unreadable roster
  // delivers instead of holding.
  const liveLanes = await agentsWithLiveTurns();
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
    // Owner raises go out as one digest per owner every 30 minutes instead
    // of one message per item (Matt, Oct 14, card-d7bf78 b). The raise is
    // marked only when the digest actually delivers it.
    if (!commitment.raised?.owner && !ownerRaiseHeldByText(commitment.agentId, commitment.text)) {
      // The commitment id is the stable queue key: the every-minute sweep
      // re-queues an undelivered raise, and the shared owner digest upserts
      // it instead of stacking duplicates. The text mark above (Max, Oct
      // 18 2026, card-b3468c) stops the re-track loop: an interrupted agent
      // clears the entry and re-adds the same text under a NEW id, and an
      // id-keyed mark alone would reset with it — re-raising into the very
      // turn the digest just derailed, over and over.
      queueFlagDigest(commitment.agentId, commitment.id, raise, () => markCommitmentRaised(commitment.id, 'owner', { agentId: commitment.agentId, text: commitment.text }));
    }
    // The Chief copy escalates only once the owner raise actually went out
    // (the digest flush sets the raised mark), so it never claims a delivery
    // that is still queued.
    if (commitment.agentId !== CHIEF_ID && commitment.raised?.owner && !commitment.raised?.chief) {
      if (liveLanes.has(CHIEF_ID) && now.getTime() - dueAt < LIVE_HOLD_CEILING_MS) {
        // held (card-b3468c): the Chief's lane is mid-turn; the copy is
        // unmarked and retried next tick, bounded by the ceiling so a
        // stuck Chief lane still gets it. Holding never means losing.
        continue;
      }
      // The copy's wording says what actually happened: it only runs once
      // the owner raise was delivered, so "it went to them" is always true
      // here; a queued-but-undelivered raise never escalates as done.
      const outcome = 'It went to them; make sure they act on it.';
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
  await flushFlagDigests();
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
