// The past-due commitment sweep (card-baadaf gap 1): commitments cannot
// depend on memory alone, so a past-due entry is raised to its owner and to
// the Chief of Staff automatically. Each recipient is marked raised only
// when they actually SEE the raise — the flag digest's admission ack — so a
// held, delayed, or failed raise retries on the next tick and never claims
// an admission that did not happen. Legacy entries without a stored
// absolute instant get theirs persisted on first read, so a relative
// display due ("10pm tomorrow") can no longer move with every reparse.
// Same 60s cadence as the other hygiene loops; side copies never run it.

import { flushFlagDigests, queueFlagDigest } from './flagDigest.ts';
import { listCommitments, markCommitmentRaised, markCommitmentInheritedRaise, noteCommitmentDueAt, chiefRaiseHeldByText, inheritedOwnerRaiseAt, raiseTextKey } from './commitmentStore.ts';
import { parseDue } from './promiseScan.ts';

const TICK_MS = 60_000;
const CHIEF_ID = 'chief-of-staff';

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
