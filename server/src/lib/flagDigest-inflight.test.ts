import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The flag-digest store lives under RIVENDELL_STATE_DIR, resolved at module
 *  load, so the test redirects it to a throwaway dir BEFORE importing — and
 *  seeds its IN-FLIGHT state in the file itself, so the module's first
 *  restore() reads entries whose records are already durable. The queue's
 *  ground truth (recordStillPending) and the live-lane set are injected, so
 *  no test ever touches the roster, the chat graph, or a real delivery. */
const stateDir = mkdtempSync(join(tmpdir(), 'flagdigest-inflight-test-'));
process.env.RIVENDELL_STATE_DIR = stateDir;
writeFileSync(join(stateDir, 'agent-session-policy.json'), JSON.stringify({ agents: { naomi: { lead: true } } }));
const et = (wall: string): number => Date.parse(`${wall}:00Z`) + 4 * 3_600_000;
writeFileSync(join(stateDir, 'flag-digest.json'), JSON.stringify({
  queues: {
    naomi: [
      { key: 'commitment:naomi|p1', text: 'raise line A', firstQueuedAt: 1_000, sentAt: 2_000, sentDeliveryId: 'rec-1' },
      { key: 'flag-live', text: 'line with a living record', firstQueuedAt: et('2026-10-15T14:19'), sentAt: et('2026-10-15T14:10'), sentDeliveryId: 'rec-live' },
      { key: 'flag-dead', text: 'line whose record died', firstQueuedAt: et('2026-10-15T14:19'), sentAt: et('2026-10-15T14:10'), sentDeliveryId: 'rec-dead' },
    ],
  },
}));
const { queueFlagDigest, flushFlagDigests } = await import('./flagDigest.ts');

type PersistedEntry = { key: string; text: string; firstQueuedAt?: number; sentAt?: number; sentDeliveryId?: string };
const read = () => JSON.parse(readFileSync(join(stateDir, 'flag-digest.json'), 'utf8')) as {
  queues?: Record<string, PersistedEntry[]>;
  lastFlush?: Record<string, number>;
};
const naomi = (): PersistedEntry[] => read().queues?.naomi ?? [];

test('an in-flight slot is immutable: a fresh same-key line gets its own successor slot', () => {
  // (review P1, Oct 18) A genuinely fresh same-key line — a fresh commitment
  // whose raise names a different id, so a different text — must never
  // rebind the in-flight slot's payload or callback: it gets its own
  // successor slot, and the in-flight line keeps the binding to the record
  // already carrying it.
  queueFlagDigest('naomi', 'commitment:naomi|p1', 'raise line B', () => {}, true);
  const inFlight = naomi().find((e) => e.key === 'commitment:naomi|p1');
  assert.equal(inFlight?.sentDeliveryId, 'rec-1', 'the in-flight slot keeps its record binding');
  assert.equal(inFlight?.text, 'raise line A', 'the in-flight slot keeps its own line');
  const successor = naomi().find((e) => e.key === 'commitment:naomi|p1~1');
  assert.ok(successor, 'a genuinely fresh same-key line gets its own successor slot');
  assert.equal(successor?.text, 'raise line B');
  // A repeat of the in-flight line itself never stacks a second copy of it.
  queueFlagDigest('naomi', 'commitment:naomi|p1', 'raise line A');
  assert.equal(naomi().filter((e) => e.text === 'raise line A').length, 1, 'a repeat of an in-flight line never stacks');
});

test('an in-flight entry re-sends only when its record is gone from the durable queue', async () => {
  // (review P1, Oct 18) rec-live and rec-1 still sit in the durable queue:
  // their entries stay in flight and are never re-sent. rec-dead is gone:
  // its entry's markers reset and the line re-queues for the next window —
  // held out of THIS window's batch by the live-lane partition (its first
  // queue time is one minute before the pinned flush time), which is also
  // what keeps this test hermetic: no delivery is ever attempted.
  await flushFlagDigests(
    et('2026-10-15T14:20'),
    new Set(['naomi']),
    async (id) => (id === 'rec-dead' ? false : true),
  );
  assert.equal(naomi().find((e) => e.key === 'flag-live')?.sentDeliveryId, 'rec-live', 'a living record is never re-sent');
  assert.equal(naomi().find((e) => e.key === 'commitment:naomi|p1')?.sentDeliveryId, 'rec-1', 'a living record is never re-sent (seeded entry)');
  const dead = naomi().find((e) => e.key === 'flag-dead');
  assert.equal(dead?.sentDeliveryId, undefined, 'a dead record resets the in-flight markers');
  assert.equal(dead?.text, 'line whose record died', 'the dead line re-queues for the next window, never lost');
  assert.ok(!read().lastFlush?.naomi, 'no send happened: the pacing clock must not advance');
});

// Clean up the throwaway state dir after the run.
test('cleanup', () => {
  rmSync(stateDir, { recursive: true, force: true });
});
