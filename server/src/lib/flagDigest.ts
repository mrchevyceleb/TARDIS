// One shared owner flag digest (Matt, Oct 14, card-d7bf78 b): past-due
// commitment raises and Desk silence nudges go to their owner as ONE digest
// message every 30 minutes instead of one message per item. There is ONE
// digest per owner across all flag sources — a single queue, a single
// 30-minute pacing clock, and a single delivery path (deliverTeamMessage
// from the non-roster pseudo-sender TARDIS) — so no source can starve
// another and the owner never gets two digests in one window. Entries queue
// keyed by a stable id (a re-queued line upserts its slot, never stacks),
// the queues AND the per-owner pacing clock persist durably with
// best-effort atomic writes (a restart inside a window re-delivers rather
// than silently consuming a nudge whose pacing state marked it handled, and
// the clock survives so a restart does not double-send inside a window). A
// successful flush advances pacing and marks its entries IN FLIGHT on the
// record's durable receipt; their callbacks run only at the record's
// actual ADMISSION — the recipient saw the line — via the ack the teamBus
// drain fires, so a producer's mark always means a seen line and a held or
// delayed record never claims one. An isolated callback failure at
// admission re-queues exactly its own entry for the next window instead of
// resending the whole digest.
//
// Accepted limitation, stated plainly: entries restored after a restart are
// not revalidated against their source's current state — a flag whose
// condition resolved during downtime can deliver once after the restart.
// Each producer's next cycle self-corrects; producer-side pruning of
// obsolete keys is a follow-up if it ever bites.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { inQuietHours, isMaxLane } from './quietHours.ts';
import { LIVE_HOLD_CEILING_MS, agentsWithLiveTurns } from './laneLiveness.ts';

const DIGEST_INTERVAL_MS = 30 * 60_000;
/** (review P1, Oct 18) Successor slots per queue key: a key's slot can be
 *  IN FLIGHT (immutable, bound to its durable record) while genuinely
 *  distinct lines arrive for the same key — each gets its own slot. Eight
 *  concurrent distinct lines on one key is pathological; past that the
 *  re-queue is dropped with a warning and the producer's next tick retries
 *  as records admit and slots free up. */
const MAX_SLOTS_PER_KEY = 8;
/** Bounded batches: a huge backlog must never build a message the transport
 *  cannot carry (a permanent delivery failure with an ever-growing queue).
 *  The delivered head clears now; the retained tail rides the next window. */
const MAX_DIGEST_ENTRIES = 40;
const MAX_DIGEST_CHARS = 20_000;
const STATE_FILE = join(STATE_DIR, 'flag-digest.json');

type Entry = {
  key: string;
  text: string;
  priority?: boolean;
  firstQueuedAt?: number;
  onDelivered?: () => void;
  /** (card-b3468c verify P1) In flight: the digest record's durable receipt
   *  landed (sentDeliveryId is the record id, shared by every entry that
   *  rode it) but the recipient has not seen it yet. The entry waits for the
   *  admission ack (admittedDeliveryAck, fired by the teamBus drain) to run
   *  its callback and clear it; a flush never re-sends it while the record
   *  still sits in the durable delivery queue. Gone from the queue without
   *  its ack having cleared the entry (dropped by a Stop, or its recipient
   *  left the roster — review P1, Oct 18), the next flush re-sends the line:
   *  the record's presence in the queue is the only proof it died, never
   *  elapsed time. */
  sentAt?: number;
  sentDeliveryId?: string;
};

/** ownerId -> key -> entry. */
const queues = new Map<string, Map<string, Entry>>();
/** Per owner, the last successful digest delivery (persisted with the queues). */
const ownerLastFlush = new Map<string, number>();
let restored = false;

type Persisted = {
  lastFlush?: Record<string, number>;
  queues?: Record<string, { key: string; text: string; priority?: boolean; firstQueuedAt?: number; sentAt?: number; sentDeliveryId?: string }[]>;
};

function persistNow(): void {
  const out: Persisted = {
    lastFlush: Object.fromEntries(ownerLastFlush),
    queues: {},
  };
  for (const [ownerId, entries] of queues) {
    if (entries.size) out.queues![ownerId] = [...entries.values()].map(({ key, text, priority, firstQueuedAt, sentAt, sentDeliveryId }) => ({ key, text, priority, firstQueuedAt, sentAt, sentDeliveryId }));
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
  let migrated = false;
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
      if (!map.has(entry.key)) {
        // Restored entries carry no callbacks; firstQueuedAt survives the
        // restart so a held digest keeps its hold age. A legacy entry
        // without one gets a CONCRETE migration instant now (review P1,
        // Oct 18): an undefined age would read as just-queued on every
        // flush, holding a live lane's digest without bound — holding
        // never means losing. The migrated value persists below.
        const legacy = typeof entry.firstQueuedAt !== 'number' || !Number.isFinite(entry.firstQueuedAt) || entry.firstQueuedAt <= 0;
        if (legacy) migrated = true;
        // (card-b3468c verify P1) In-flight markers survive the restart: the
        // durable record survives too, so its admission ack post-restart
        // must still find the entry. Restored entries carry no callbacks
        // (the source's next cycle re-arms them); the ack of a callbackless
        // entry deletes it and the sweep re-queues it, which re-sends that
        // one line once — the stated restart limitation, not a new one.
        const sentAt = typeof entry.sentAt === 'number' && Number.isFinite(entry.sentAt) && entry.sentAt > 0 ? entry.sentAt : undefined;
        const sentDeliveryId = typeof entry.sentDeliveryId === 'string' && entry.sentDeliveryId ? entry.sentDeliveryId.slice(0, 120) : undefined;
        map.set(entry.key, {
          key: entry.key,
          text: entry.text,
          priority: entry.priority === true,
          firstQueuedAt: legacy ? Date.now() : entry.firstQueuedAt,
          ...(sentAt !== undefined ? { sentAt } : {}),
          ...(sentDeliveryId !== undefined ? { sentDeliveryId } : {}),
        });
      }
    }
    queues.set(ownerId, map);
  }
  // Persist the migration immediately: a legacy entry's concrete
  // firstQueuedAt must survive a restart before any other write happens.
  if (migrated) persistNow();
}

/** Queue one flag for the owner's next digest. A key's family is the key
 *  plus its successor slots (key~1, key~2, ...); one slot holds one
 *  distinct line. Re-queuing a line that already has a slot upserts that
 *  slot (the every-minute producers re-queue an undelivered raise, and it
 *  replaces its earlier entry instead of stacking duplicates) — or is a
 *  no-op when that slot is already in flight: the record carrying the
 *  exact same line will run the mark at its admission. An IN FLIGHT slot
 *  is immutable (review P1, Oct 18): its text and callback are bound to
 *  the durable record already carrying its line, so a later queue can
 *  never rebind them — a genuinely fresh same-key line (a fresh commitment
 *  whose raise names a different id) gets its OWN successor slot and its
 *  own line, instead of hijacking the in-flight record's admission mark. */
export function queueFlagDigest(ownerId: string, key: string, text: string, onDelivered?: () => void, priority = false): void {
  restore();
  const entries = queues.get(ownerId) ?? new Map<string, Entry>();
  const slotNames: string[] = [key];
  for (let i = 1; i <= MAX_SLOTS_PER_KEY; i++) slotNames.push(`${key}~${i}`);
  // A repeat of a line already in the family never stacks a second copy of
  // it: refresh the slot's callback and priority while it is still waiting
  // for its window, and leave it entirely alone once it is in flight.
  for (const slotKey of slotNames) {
    const slot = entries.get(slotKey);
    if (!slot || slot.text !== text) continue;
    if (slot.sentDeliveryId === undefined) {
      entries.set(slotKey, {
        key: slotKey,
        text,
        onDelivered,
        priority,
        // The upsert preserves the slot's original firstQueuedAt (Max, Oct
        // 18 2026, card-b3468c): a producer re-queuing an undelivered flag
        // every minute must not refresh the hold age, or a busy lane would
        // hold its digest without bound. Holding never means losing.
        firstQueuedAt: slot.firstQueuedAt ?? Date.now(),
      });
      queues.set(ownerId, entries);
      persistNow();
    }
    return;
  }
  // No slot holds this line: bind it to the first slot name in the family
  // that does not exist yet. Existing slots are never displaced — a pending
  // slot's line has not gone out, and an in-flight one is immutable — so a
  // key with concurrent distinct lines carries one slot per line and each
  // line keeps its own first queue time.
  for (const slotKey of slotNames) {
    if (entries.has(slotKey)) continue;
    entries.set(slotKey, { key: slotKey, text, onDelivered, priority, firstQueuedAt: Date.now() });
    queues.set(ownerId, entries);
    persistNow();
    return;
  }
  console.warn(`[flag-digest] ${ownerId}: every slot for key "${key.slice(0, 80)}" is in flight; dropping this re-queue (the producer's next tick retries as slots free)`);
}

/** The durable queue's ground truth for one sent record (review P1, Oct
 *  18): true while the record still waits for admission, false once it is
 *  gone from the queue (admitted — its ack should have fired — or dropped),
 *  null when the queue cannot be read (the caller treats null as still
 *  pending and re-checks next window). Injectable so the flush's staleness
 *  path is testable without the whole chat graph. */
async function defaultRecordStillPending(deliveryId: string): Promise<boolean | null> {
  try {
    const { teamDeliveryRecordPending } = await import('../chat/teamBus.ts');
    return await teamDeliveryRecordPending(deliveryId);
  } catch {
    return null;
  }
}

/** Deliver due owner digests. One owner, one window, one message carrying
 *  every pending flag from every source. Callers keep their own tick
 *  cadence; the shared clock decides. `now` defaults to the wall clock and
 *  is injectable so the quiet-hours gate is testable against a pinned time;
 *  `recordStillPending` (the durable queue's ground truth for one sent
 *  record) is injectable the same way, so the in-flight staleness path is
 *  testable without the chat graph. */
export async function flushFlagDigests(now: number = Date.now(), liveLanes?: ReadonlySet<string>, recordStillPending: (deliveryId: string) => Promise<boolean | null> = defaultRecordStillPending): Promise<void> {
  restore();
  // Lane-liveness (Max, Oct 18 2026, card-b3468c): fetched once per flush,
  // only when something is pending, from the ground-truth roster /api/team
  // serves; fail-open (an unreadable roster delivers instead of holding).
  let live = liveLanes;
  if (!live && [...queues.values()].some((entries) => entries.size)) live = await agentsWithLiveTurns();
  if (!live) live = new Set<string>();
  for (const [ownerId, entries] of queues) {
    if (!entries.size) continue;
    // Quiet hours (Matt, Oct 15 2026; Opus review 3, Oct 16): a held digest
    // must not even try overnight. Every sweep (commitmentSweep, deskHygiene)
    // re-runs this flush every 60 seconds, and deliverTeamMessage writes a
    // NEW durable queue record per call, so a "held" digest that still called
    // delivery piled up ~840 duplicate records per owner per night and burned
    // the global rate limit Matt's Desk answers need. Skip before any
    // delivery: the entries stay queued untouched and the first flush after
    // 05:00 delivers them once.
    if (inQuietHours(now) && !isMaxLane(ownerId)) continue;
    const last = ownerLastFlush.get(ownerId);
    if (last !== undefined && now - last < DIGEST_INTERVAL_MS) continue;
    // Bounded batch (see MAX_DIGEST_ENTRIES / MAX_DIGEST_CHARS): the
    // delivered head clears now; a retained tail rides the next window.
    // Lane-liveness partition (Max, Oct 18 2026, card-b3468c; review P0,
    // Oct 18): a digest must never derail a live turn, and the whole
    // payload rides ONE record, so the batch is selected such that a record
    // which can admit into a live turn carries ONLY entries past their own
    // ceilings. While the owner's lane is live, an under-ceiling entry
    // never joins the batch — it stays queued, unmarked, untouched, exactly
    // like the quiet-hours gate above, bounded by its OWN first queue time
    // (a re-queue never refreshes it), so a lane stuck in one long turn
    // still gets its digest once the entry ages past the ceiling — holding
    // never means losing. An entry with no readable first queue time cannot
    // prove a fresh hold: it joins (fail open) rather than hold without
    // bound; queueFlagDigest and restore always stamp one, so this is
    // corrupted-state territory. Max's lane is partitioned too: a mid-turn
    // digest derails it the same way.
    const laneLive = live.has(ownerId);
    const batch: Entry[] = [];
    let chars = 0;
    let resetInFlight = false;
    for (const entry of entries.values()) {
      if (batch.length >= MAX_DIGEST_ENTRIES || chars + entry.text.length > MAX_DIGEST_CHARS) break;
      // In flight (card-b3468c verify P1): this entry's digest record is
      // already durable and waiting for its admission ack — never re-send
      // it while the record still lives. The record's presence in the
      // durable delivery queue is the ONLY proof it died (review P1, Oct
      // 18): a record can legitimately wait out repeated 30-minute
      // admission windows and then quiet hours, so elapsed time proves
      // nothing. Gone from the queue without its ack having cleared this
      // entry — dropped by a Stop, or its recipient left the roster — the
      // markers reset and this window re-sends the line: holding never
      // means losing.
      if (entry.sentDeliveryId !== undefined) {
        const stillPending = await recordStillPending(entry.sentDeliveryId);
        if (stillPending !== false) continue;
        entry.sentDeliveryId = undefined;
        entry.sentAt = undefined;
        resetInFlight = true;
      }
      if (laneLive) {
        const queuedAt = entry.firstQueuedAt;
        if (typeof queuedAt === 'number' && Number.isFinite(queuedAt) && queuedAt > 0
          && now - queuedAt < LIVE_HOLD_CEILING_MS) continue;
      }
      batch.push(entry);
      chars += entry.text.length;
    }
    // A marker reset is a real state transition — the record is gone, so
    // its line returns to the pending pool — and it persists the moment it
    // happens, never riding on a later send's write: a restart between the
    // reset and the next window must not resurrect the dead record's
    // in-flight markers (which would only cost one extra queue check, but
    // the durable state must not lie in the meantime).
    if (resetInFlight) persistNow();
    if (!batch.length) continue;
    // The record's hold origin (review P0, Oct 18): the NEWEST first-queue
    // time among the entries actually included. The drain-side admission
    // enforces the hold atomically from this one origin, so it must be the
    // binding (newest) entry's — an oldest-origin record would let an
    // hour-old flag deliver a fresh one into a live turn mid-ceiling. The
    // partition above is the flush's snapshot; this origin is what the
    // drain holds by when a lane goes busy before the record admits.
    let holdOrigin: number | undefined;
    for (const entry of batch) {
      const queuedAt = entry.firstQueuedAt;
      if (typeof queuedAt === 'number' && Number.isFinite(queuedAt) && queuedAt > 0
        && (holdOrigin === undefined || queuedAt > holdOrigin)) {
        holdOrigin = queuedAt;
      }
    }
    const payload = ['[TARDIS] Flag digest (one message per 30 minutes; act on each line):', ...batch.map((entry) => entry.text)].join('\n');
    // The digest carries urgency when any of its entries does: a past-due
    // commitment raise is urgent; a digest of only hygiene nudges stays
    // unprioritized, so scheduled hygiene keeps yielding to live turns.
    const send = await deliverDigest(ownerId, payload, batch.some((entry) => entry.priority === true), holdOrigin);
    if (!send.ok) continue;
    // (card-b3468c verify P1) The receipt above proves DURABILITY, not
    // admission: an automation digest never steers a live turn, so the
    // record admits at the recipient's next real turn end. Mark the batch
    // sent (in flight: not re-delivered, callbacks not yet run) and let the
    // record's admission ack (admittedDeliveryAck, fired by the drain)
    // run the callbacks — so a producer's mark means the recipient actually
    // saw the flag, never a claim on a delivery that is still queued. The
    // pacing clock advances: the record did go out.
    for (const entry of batch) {
      entry.sentAt = now;
      entry.sentDeliveryId = send.deliveryId;
    }
    ownerLastFlush.set(ownerId, now);
    persistNow();
  }
}

async function deliverDigest(ownerId: string, text: string, priority: boolean, nudgeHoldSince?: number): Promise<{ ok: boolean; deliveryId?: string }> {
  const { deliverTeamMessage } = await import('../chat/teamBus.ts');
  try {
    // The pseudo-sender TARDIS is not a roster agent, so the outgoing-promise
    // scan never re-processes a digest, and the digest lands as a system-ish
    // handoff for both flag sources alike.
    // admissionAck (card-b3468c verify P1): the record asks the drain to
    // notify this queue at its actual admission, so the entries' callbacks
    // run when the recipient sees the line, not when the receipt is durable.
    const result = await deliverTeamMessage({ from: 'TARDIS', to: ownerId, text, wait: false, priority, nudgeHoldSince, admissionAck: 'flag-digest' });
    // Quiet hours (Opus verify, Oct 16): a held digest is durable but will
    // not land until after 05:00. Report it undelivered so the flush keeps
    // the entries queued and unmarked — the next window after 05:00 delivers
    // them and runs the marks then. Marking here would let the commitment
    // sweep claim "It went to them" about a held raise.
    if (result.delivered !== true || result.held === 'quiet-hours') return { ok: false };
    return { ok: true, deliveryId: result.deliveryId };
  } catch {
    return { ok: false };
  }
}

/** The admission ack for one sent digest record (card-b3468c verify P1),
 *  invoked by the teamBus drain at the record's actual admission — the
 *  recipient saw the line. Run exactly the entries that record carried
 *  (their callbacks mark their producers' state), clear them, and persist.
 *  An isolated callback failure re-queues exactly its entry without the
 *  in-flight markers, so the next window re-sends only that line. */
export function admittedDeliveryAck(ownerId: string, deliveryId: string): void {
  restore();
  if (!deliveryId) return;
  const entries = queues.get(ownerId);
  if (!entries?.size) return;
  const mine = [...entries.values()].filter((entry) => entry.sentDeliveryId === deliveryId);
  if (!mine.length) return;
  for (const entry of mine) {
    entries.delete(entry.key);
    try {
      entry.onDelivered?.();
    } catch (error) {
      // Re-queue exactly this entry (its mark did not land), with its
      // original hold age; the next window re-sends only it.
      const q = queues.get(ownerId) ?? new Map<string, Entry>();
      if (!q.has(entry.key)) q.set(entry.key, { key: entry.key, text: entry.text, firstQueuedAt: entry.firstQueuedAt });
      queues.set(ownerId, q);
      console.warn(`[flag-digest] ${ownerId}: an admitted entry's callback failed (it re-queues for the next window): ${(error as Error).message}`);
    }
  }
  persistNow();
}
