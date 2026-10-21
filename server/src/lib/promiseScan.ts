// Record outgoing promises through the same validated commitment store.
import { addCommitment, listCommitments } from './commitmentStore.ts';
import { findPromisedTimes, type PromisedTime } from './promiseTime.ts';
export { findPromisedTimes, parseDue, type PromisedTime } from './promiseTime.ts';

/** One outgoing agent message: every promise clause that has no matching
 *  open commitment is auto-added (each with its resolved absolute instant),
 *  so no promise in the message can silently vanish. `sourceId` (the
 *  outgoing message's own id) makes the scan idempotent: a message that was
 *  already scanned is never processed twice, while distinct promises —
 *  restatements included — each land their own entry for the owner to clear.
 *  Returns every add, and the first add failure so the caller can nudge. */
export function scanOutgoingPromise(
  agentId: string,
  text: string,
  sourceId?: string,
  now: Date = new Date(),
): { added: Array<{ id: string; due: string }>; addError?: string; promise?: PromisedTime } {
  const promises = findPromisedTimes(text, now);
  if (!promises.length) return { added: [] };
  // Per-promise source ids (message id capped, then # ordinal, always under
  // the store's 120-char field): one message never double-adds a promise, a
  // partial failure never poisons the others, and a long id never truncates
  // into a collision. A promise already recorded is matched by identity (the
  // normalized clause plus the same instant), so a verbatim restatement from
  // a new message does not duplicate while a different promise at the same
  // time still lands.
  const sourcePrefix = sourceId ? `${sourceId.slice(0, 100)}#` : '';
  const open = listCommitments(agentId);
  const existingSources = new Set(open.map((c) => c.sourceId));
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const added: Array<{ id: string; due: string }> = [];
  let firstError: { error: string; promise: PromisedTime } | undefined;
  for (let i = 0; i < promises.length; i += 1) {
    const promise = promises[i];
    const perSource = sourceId ? `${sourcePrefix}${i}` : undefined;
    if (perSource && existingSources.has(perSource)) continue;
    const clause = promise.clause.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (open.some((c) => c.dueAt === promise.dueAt && norm(c.text) === norm(clause))) continue;
    const result = addCommitment(agentId, clause, promise.due, { dueAt: promise.dueAt, sourceId: perSource });
    if (result.error) {
      // Keep going: the later promises in this message still land, and every
      // failure is reported (the first one carries the nudge).
      if (!firstError) firstError = { error: result.error, promise };
      continue;
    }
    added.push({ id: result.commitment!.id, due: promise.due });
  }
  return firstError ? { added, addError: firstError.error, promise: firstError.promise } : { added };
}
