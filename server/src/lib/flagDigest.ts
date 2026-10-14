// One shared owner flag digest (Matt, Oct 14, card-d7bf78 b): past-due
// commitment raises and Desk silence nudges go to their owner as ONE digest
// message every 30 minutes instead of one message per item. There is ONE
// digest per owner across all flag sources — a single queue, a single
// 30-minute pacing clock, and a single delivery path (deliverTeamMessage
// from the non-roster pseudo-sender TARDIS) — so no source can starve
// another and the owner never gets two digests in one window. Entries queue
// keyed by a stable id (a re-queued item upserts, never stacks), the queues
// AND the per-owner pacing clock persist durably with best-effort atomic
// writes (a restart inside a window re-delivers rather than silently
// consuming a nudge whose pacing state marked it handled, and the clock
// survives so a restart does not double-send inside a window). Only a
// successful flush clears entries and advances pacing, and it does so
// BEFORE running per-entry callbacks, which run isolated; a failed callback
// (e.g. a store write) re-queues exactly its own entry for the next window
// instead of resending the whole digest.
//
// Accepted limitation, stated plainly: entries restored after a restart are
// not revalidated against their source's current state — a flag whose
// condition resolved during downtime can deliver once after the restart.
// Each producer's next cycle self-corrects; producer-side pruning of
// obsolete keys is a follow-up if it ever bites.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';

const DIGEST_INTERVAL_MS = 30 * 60_000;
/** Bounded batches: a huge backlog must never build a message the transport
 *  cannot carry (a permanent delivery failure with an ever-growing queue).
 *  The delivered head clears now; the retained tail rides the next window. */
const MAX_DIGEST_ENTRIES = 40;
const MAX_DIGEST_CHARS = 20_000;
const STATE_FILE = join(STATE_DIR, 'flag-digest.json');

type Entry = { key: string; text: string; priority?: boolean; onDelivered?: () => void };

/** ownerId -> key -> entry. */
const queues = new Map<string, Map<string, Entry>>();
/** Per owner, the last successful digest delivery (persisted with the queues). */
const ownerLastFlush = new Map<string, number>();
let restored = false;

type Persisted = {
  lastFlush?: Record<string, number>;
  queues?: Record<string, { key: string; text: string; priority?: boolean }[]>;
};

function persistNow(): void {
  const out: Persisted = {
    lastFlush: Object.fromEntries(ownerLastFlush),
    queues: {},
  };
  for (const [ownerId, entries] of queues) {
    if (entries.size) out.queues![ownerId] = [...entries.values()].map(({ key, text, priority }) => ({ key, text, priority }));
  }
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(out)}\n`);
    renameSync(tmp, STATE_FILE);
  } catch (error) {
    console.warn(`[flag-digest] persist failed (a pending digest could be lost or re-sent across a restart): ${(error as Error).message}`);
  }
}

function restore(): void {
  if (restored) return;
  restored = true;
  let raw: string;
  try {
    raw = readFileSync(STATE_FILE, 'utf8');
  } catch {
    return; // no state file yet: nothing to restore
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // unreadable: start empty; the producers re-queue on their next cycle
  }
  // Validate the root and the nested collections before touching them:
  // valid JSON like `null` or a stray array must never break every producer
  // tick. Invalid state is quarantined by replacement on the next persist.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const persisted = parsed as Persisted;
  const lastFlush = persisted.lastFlush && typeof persisted.lastFlush === 'object' && !Array.isArray(persisted.lastFlush) ? persisted.lastFlush : {};
  const queuesState = persisted.queues && typeof persisted.queues === 'object' && !Array.isArray(persisted.queues) ? persisted.queues : {};
  for (const [ownerId, ms] of Object.entries(lastFlush)) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) ownerLastFlush.set(ownerId, ms);
  }
  for (const [ownerId, entries] of Object.entries(queuesState)) {
    if (!Array.isArray(entries)) continue;
    const map = queues.get(ownerId) ?? new Map<string, Entry>();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || typeof entry.text !== 'string') continue;
      // Restored entries carry no callbacks (they are not persisted with
      // them); the source's own state re-arms whatever still matters.
      if (!map.has(entry.key)) map.set(entry.key, { key: entry.key, text: entry.text, priority: entry.priority === true });
    }
    queues.set(ownerId, map);
  }
}

/** Queue one flag for the owner's next digest. Re-queuing the same key
 *  upserts: the every-minute commitment sweep re-queues an undelivered raise,
 *  and it replaces its earlier entry instead of stacking duplicates. */
export function queueFlagDigest(ownerId: string, key: string, text: string, onDelivered?: () => void, priority = false): void {
  restore();
  const entries = queues.get(ownerId) ?? new Map<string, Entry>();
  entries.set(key, { key, text, onDelivered, priority });
  queues.set(ownerId, entries);
  persistNow();
}

/** Deliver due owner digests. One owner, one window, one message carrying
 *  every pending flag from every source. Callers keep their own tick
 *  cadence; the shared clock decides. */
export async function flushFlagDigests(): Promise<void> {
  restore();
  const now = Date.now();
  for (const [ownerId, entries] of queues) {
    if (!entries.size) continue;
    const last = ownerLastFlush.get(ownerId);
    if (last !== undefined && now - last < DIGEST_INTERVAL_MS) continue;
    // Bounded batch (see MAX_DIGEST_ENTRIES / MAX_DIGEST_CHARS): the
    // delivered head clears now; a retained tail rides the next window.
    const batch: Entry[] = [];
    let chars = 0;
    for (const entry of entries.values()) {
      if (batch.length >= MAX_DIGEST_ENTRIES || chars + entry.text.length > MAX_DIGEST_CHARS) break;
      batch.push(entry);
      chars += entry.text.length;
    }
    const payload = ['[TARDIS] Flag digest (one message per 30 minutes; act on each line):', ...batch.map((entry) => entry.text)].join('\n');
    // The digest carries urgency when any of its entries does: a past-due
    // commitment raise is urgent; a digest of only hygiene nudges stays
    // unprioritized, so scheduled hygiene keeps yielding to live turns.
    const ok = await deliverDigest(ownerId, payload, batch.some((entry) => entry.priority === true));
    if (!ok) continue;
    // Commit the delivery BEFORE the callbacks: a throwing mark must never
    // resend an already-delivered digest. Only the delivered batch clears.
    const delivered = batch;
    for (const entry of delivered) entries.delete(entry.key);
    ownerLastFlush.set(ownerId, now);
    for (const entry of delivered) {
      try {
        entry.onDelivered?.();
      } catch (error) {
        // Re-queue exactly this entry (its mark did not land); the next
        // window re-sends only it.
        const q = queues.get(ownerId) ?? new Map<string, Entry>();
        if (!q.has(entry.key)) q.set(entry.key, { key: entry.key, text: entry.text });
        queues.set(ownerId, q);
        console.warn(`[flag-digest] ${ownerId}: a delivered entry's callback failed (it re-queues for the next window): ${(error as Error).message}`);
      }
    }
    persistNow();
  }
}

async function deliverDigest(ownerId: string, text: string, priority: boolean): Promise<boolean> {
  const { deliverTeamMessage } = await import('../chat/teamBus.ts');
  try {
    // The pseudo-sender TARDIS is not a roster agent, so the outgoing-promise
    // scan never re-processes a digest, and the digest lands as a system-ish
    // handoff for both flag sources alike.
    const result = await deliverTeamMessage({ from: 'TARDIS', to: ownerId, text, wait: false, priority });
    return result.delivered === true;
  } catch {
    return false;
  }
}
