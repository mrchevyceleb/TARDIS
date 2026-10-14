// Owner flag digests (Matt, Oct 14, card-d7bf78 b): past-due commitment
// raises and Desk silence nudges go to their owner as ONE digest message
// every 30 minutes instead of one message per item. Entries queue per owner
// keyed by a stable id (a re-queued item upserts, never stacks duplicates),
// the 30-minute pacing clock is shared per owner across all instances (the
// commitment sweep and the Desk hygiene count the same window), and the
// queues persist durably with best-effort atomic writes, so a restart inside
// a window re-delivers rather than silently consuming a nudge whose pacing
// state already marked it handled. Only a successful flush clears entries
// and advances pacing, and it does so BEFORE running the per-entry
// callbacks, which run isolated: a failed mark (e.g. a store write) re-queues
// just that entry for the next window instead of resending the whole digest.
// Entries restored after a restart deliver without their callbacks (the
// marks they would have set are not persisted with them), so a restored
// past-due raise may send again next window; the hygiene texts carry no
// callbacks and deliver exactly once.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';

export type FlagDigest = {
  queue(ownerId: string, key: string, text: string, onDelivered?: () => void): void;
  flush(): Promise<void>;
};

const DIGEST_INTERVAL_MS = 30 * 60_000;
const QUEUE_FILE = join(STATE_DIR, 'flag-digest-queues.json');

type Entry = { key: string; text: string; onDelivered?: () => void };
type InstanceState = { states: Map<string, Map<string, Entry>>; loaded: boolean };

/** instanceId -> state; each instance keeps its own delivery path. */
const instances = new Map<string, InstanceState>();
/** Shared across instances: one 30-minute pacing clock per owner, so an
 *  owner gets at most one flag digest per window even when two sources
 *  (the commitment sweep and the Desk hygiene) both have entries. */
const ownerLastFlush = new Map<string, number>();

function persistNow(): void {
  const out: Record<string, Record<string, { key: string; text: string }[]>> = {};
  for (const [id, instance] of instances) {
    for (const [ownerId, entries] of instance.states) {
      if (!entries.size) continue;
      (out[id] ??= {})[ownerId] = [...entries.values()].map(({ key, text }) => ({ key, text }));
    }
  }
  const tmp = `${QUEUE_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(out)}\n`);
    renameSync(tmp, QUEUE_FILE);
  } catch (error) {
    console.warn(`[flag-digest] queue persist failed (an unflushed digest could be lost to a restart): ${(error as Error).message}`);
  }
}

function restore(instanceId: string, instance: InstanceState): void {
  if (instance.loaded) return;
  instance.loaded = true;
  let persisted: unknown;
  try {
    persisted = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return; // no queue file yet: nothing to restore
  }
  const section = (persisted as Record<string, unknown>)[instanceId];
  if (!section || typeof section !== 'object') return;
  for (const [ownerId, entries] of Object.entries(section as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const map = instance.states.get(ownerId) ?? new Map<string, Entry>();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof (entry as Entry).key !== 'string' || typeof (entry as Entry).text !== 'string') continue;
      if (!map.has((entry as Entry).key)) map.set((entry as Entry).key, { key: (entry as Entry).key, text: (entry as Entry).text });
    }
    instance.states.set(ownerId, map);
  }
}

export function createFlagDigest(instanceId: string, deliver: (ownerId: string, text: string) => Promise<boolean>): FlagDigest {
  const instance: InstanceState = { states: new Map(), loaded: false };
  instances.set(instanceId, instance);
  return {
    queue(ownerId, key, text, onDelivered) {
      restore(instanceId, instance);
      const entries = instance.states.get(ownerId) ?? new Map<string, Entry>();
      // Upsert by stable key: a past-due commitment requeued every sweep
      // minute replaces its earlier entry instead of stacking duplicates.
      entries.set(key, { key, text, onDelivered });
      instance.states.set(ownerId, entries);
      persistNow();
    },
    async flush() {
      restore(instanceId, instance);
      const now = Date.now();
      for (const [ownerId, entries] of instance.states) {
        if (!entries.size) continue;
        if (now - Math.max(ownerLastFlush.get(ownerId) ?? 0, 0) < DIGEST_INTERVAL_MS && ownerLastFlush.has(ownerId)) continue;
        const ok = await deliver(ownerId, ['[TARDIS] Flag digest (one message per 30 minutes; act on each line):', ...[...entries.values()].map((entry) => entry.text)].join('\n'));
        if (!ok) continue;
        // Commit the delivery BEFORE the callbacks: a throwing mark must not
        // resend the already-delivered digest. Each callback is isolated.
        const delivered = [...entries.values()];
        entries.clear();
        ownerLastFlush.set(ownerId, now);
        persistNow();
        for (const entry of delivered) {
          try {
            entry.onDelivered?.();
          } catch (error) {
            console.warn(`[flag-digest] ${instanceId} ${ownerId}: a delivered entry's callback failed (the entry re-queues next window): ${(error as Error).message}`);
          }
        }
      }
    },
  };
}
