// The past-due commitment sweep (card-baadaf gap 1): commitments cannot
// depend on memory alone, so a past-due entry is raised to its owner and to
// the Chief of Staff automatically. Each recipient is marked raised only
// when they actually SEE the raise — the flag digest's admission ack — so a
// held, delayed, or failed raise retries on the next tick and never claims
// an admission that did not happen. Legacy entries without a stored
// absolute instant get theirs persisted on first read, so a relative
// display due ("10pm tomorrow") can no longer move with every reparse.
// Same 60s cadence as the other hygiene loops; side copies never run it.
//
// Due-time wake (Matt, Oct 29 2026: parked work restarts at 5am on its own).
// A worker's flags ride its lead's digest, so before this a worker who
// promised "resume at 5am" was never told the time had come: only the lead
// heard "past due", and the work sat until someone nudged it. Now the moment
// a worker's commitment comes due, TARDIS hands the promise straight back to
// that worker as its own wake. The lead's past-due flag waits WAKE_GRACE_MS
// after it and only goes out if the promise is still open.

import { digestOwner, flushFlagDigests, queueFlagDigest } from './flagDigest.ts';
import { type Commitment, listCommitments, markCommitmentRaised, markCommitmentInheritedRaise, noteCommitmentDueAt, chiefRaiseHeldByText, inheritedOwnerRaiseAt, raiseTextKey } from './commitmentStore.ts';
import { parseDue } from './promiseScan.ts';
import { inQuietHours, isQuietExemptLane } from './quietHours.ts';

const TICK_MS = 60_000;
const CHIEF_ID = 'chief-of-staff';
/** The owner gets this long after its wake to pick the promise up before
 *  the lead hears it is past due. */
const WAKE_GRACE_MS = 30 * 60_000;
/** Only a promise that came due recently is a wake. Long enough to cover
 *  the longest quiet window (12h, Friday and Saturday nights) plus slack;
 *  anything older is a stale entry the past-due flag already covers. */
const WAKE_WINDOW_MS = 16 * 3_600_000;

/** Hand a worker its own due promise. True once the wake is durably queued. */
async function wakeOwner(commitment: Commitment): Promise<boolean> {
  const { deliverTeamMessage } = await import('../chat/teamBus.ts');
  const text = `[TARDIS] It's time: your commitment [${commitment.id}] "${commitment.text}" (due ${commitment.due}) is due now. Pick it up now, and clear it with the commitments tool when it is done.`;
  try {
    const result = await deliverTeamMessage({ from: 'TARDIS', to: commitment.agentId, text, wait: false, priority: true });
    return result.delivered === true;
  } catch {
    return false;
  }
}

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
    // A worker's own promise wakes the worker first (see the header). A
    // promise added after its own due is a re-track by an agent that is
    // already awake, so it never wakes; quiet hours hold the wake until the
    // window ends, the same as every other overnight delivery.
    if (digestOwner(commitment.agentId) !== commitment.agentId) {
      const fresh = commitment.createdAt < dueAt && now.getTime() - dueAt < WAKE_WINDOW_MS;
      if (fresh && !commitment.raised?.wake && !commitment.raised?.owner) {
        if (inQuietHours(now.getTime()) && !isQuietExemptLane(commitment.agentId)) continue;
        // A wake that cannot be queued falls through to the lead's flag, so
        // a promise never goes silent because its owner was unreachable.
        if (await wakeOwner(commitment)) {
          markCommitmentRaised(commitment.id, 'wake');
          continue;
        }
      }
      const wokeAt = commitment.raised?.wake;
      if (wokeAt && now.getTime() - wokeAt < WAKE_GRACE_MS) continue;
    }
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
        // NOT the commitment id: the key groups one promise text's lines
        // into one family. A re-tracked blown promise never re-queues at
        // all — it inherits above — and a genuinely fresh same-text promise
        // (a different id, so a different line) gets its OWN successor slot
        // in that family (flagDigest.ts, review P1, Oct 18) instead of
        // hijacking any in-flight line's admission mark. The digest line
        // itself names the current id.
        queueFlagDigest(commitment.agentId, `commitment:${raiseTextKey(commitment.agentId, commitment.text)}`, raise, () => markCommitmentRaised(commitment.id, 'owner', { agentId: commitment.agentId, text: commitment.text }));
      }
    }
    // The Chief copy escalates only once the owner raise actually went out
    // (the digest's admission ack sets the raised mark, verify P1), and it
    // rides the CHIEF'S OWN flag digest (review P0, Oct 18): the direct
    // wait:false receipt proved only that the copy was durably queued, so
    // marking raised.chief on it claimed an admission that never happened —
    // a held, delayed, or never-admitted copy falsely said the Chief saw it
    // and suppressed its own retries. As a digest entry its mark runs at
    // the record's actual admission, and it inherits the digest's own
    // guarantees: the Chief's live turn is never steered under the ceiling,
    // quiet hours hold, one message per window, and only ONCE per promise
    // text inside the TTL (chiefRaiseHeldByText).
    if (commitment.agentId !== CHIEF_ID && typeof ownerRaisedAt === 'number' && !commitment.raised?.chief
      && !chiefRaiseHeldByText(commitment.agentId, commitment.text)) {
      // The copy's wording says what actually happened: it only queues once
      // the owner raise was admitted, so "it went to them" is always true
      // by the time the Chief reads it.
      queueFlagDigest(
        CHIEF_ID,
        `chief-escalation:${raiseTextKey(commitment.agentId, commitment.text)}`,
        `Past-due flag: ${commitment.agentId}'s commitment [${commitment.id}] "${commitment.text}" (due ${commitment.due}) is past due. It went to them; make sure they act on it.`,
        () => markCommitmentRaised(commitment.id, 'chief', { agentId: commitment.agentId, text: commitment.text }),
        true,
      );
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
