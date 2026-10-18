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
import { listCommitments, markCommitmentRaised, markCommitmentInheritedRaise, noteCommitmentDueAt, chiefRaiseHeldByText, inheritedOwnerRaiseAt, raiseTextKey } from './commitmentStore.ts';
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
    // Re-track lineage (card-b3468c verify P1): a same-text raise already
    // delivered inside the TTL suppresses ONLY a re-tracked blown promise —
    // one that was already past due when its agent added it. It inherits
    // the original raise's admission instant instead of re-nudging the
    // owner (a re-added commitment cannot reset its own flag), which also
    // keeps the Chief copy's hold bounded from the raise's true delivery.
    // A commitment created before its own due is a genuinely fresh promise:
    // it always gets its own raise when it goes past due, however many
    // same-text promises were raised before it.
    let ownerRaisedAt = commitment.raised?.owner;
    if (!ownerRaisedAt) {
      const inheritedAt = inheritedOwnerRaiseAt(commitment);
      if (typeof inheritedAt === 'number') {
        markCommitmentInheritedRaise(commitment.id, inheritedAt);
        ownerRaisedAt = inheritedAt;
      } else {
        // The queue key is the normalized agent+text (review P1, Oct 18),
        // NOT the commitment id: an interrupted agent re-tracks a past-due
        // commitment under a NEW id, and an id key would queue the
        // re-tracked raise beside the still-queued original — two lines for
        // one promise in one digest. The text-stable key makes the re-track
        // UPSERT the original instead. The digest line itself names the
        // current id. The text mark (Max, Oct 18 2026, card-b3468c) stops the
        // re-track loop: an id-keyed mark alone would reset with the new id
        // — re-raising into the very turn the digest just derailed, over
        // and over.
        queueFlagDigest(commitment.agentId, `commitment:${raiseTextKey(commitment.agentId, commitment.text)}`, raise, () => markCommitmentRaised(commitment.id, 'owner', { agentId: commitment.agentId, text: commitment.text }));
      }
    }
    // The Chief copy escalates only once the owner raise actually went out
    // (the digest's admission ack sets the raised mark, verify P1), so it
    // never claims a delivery that is still queued — and only ONCE per
    // promise text inside the TTL: concurrent same-text re-tracks share one
    // escalation (chiefRaiseHeldByText).
    if (commitment.agentId !== CHIEF_ID && typeof ownerRaisedAt === 'number' && !commitment.raised?.chief
      && !chiefRaiseHeldByText(commitment.agentId, commitment.text)) {
      // The hold is bounded from the OWNER raise's delivery instant
      // (review P1, Oct 18), not the commitment's original due: the copy
      // only becomes pending once the owner digest actually delivered,
      // and quiet hours or a liveness hold can push that hours past the
      // due — measuring from the due would let a freshly-eligible copy
      // cut a live Chief turn immediately.
      if (liveLanes.has(CHIEF_ID) && now.getTime() - ownerRaisedAt < LIVE_HOLD_CEILING_MS) {
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
          // card-b3468c review P0, Oct 18: the drain-side admission enforces
          // the hold atomically — a Chief lane that went busy after this
          // sweep's snapshot never gets steered under the ceiling.
          nudgeHoldSince: ownerRaisedAt,
        });
        if (copy.delivered) markCommitmentRaised(commitment.id, 'chief', { agentId: commitment.agentId, text: commitment.text });
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
