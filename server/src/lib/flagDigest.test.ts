import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The flag-digest store lives under RIVENDELL_STATE_DIR, resolved at module
 *  load, so the test redirects it to a throwaway dir BEFORE importing. */
const stateDir = mkdtempSync(join(tmpdir(), 'flagdigest-test-'));
process.env.RIVENDELL_STATE_DIR = stateDir;
writeFileSync(join(stateDir, 'agent-session-policy.json'), JSON.stringify({ agents: { naomi: { lead: true } } }));
const { queueFlagDigest, flushFlagDigests } = await import('./flagDigest.ts');

/** A fixed instant inside the quiet window, Eastern wall-clock via the
 *  UTC-shift trick (EDT, UTC-4), like quietHours.test.ts. */
const et = (wall: string): number => Date.parse(`${wall}:00Z`) + 4 * 3_600_000;

test('a held digest does not even try overnight: entries stay queued, no marks, no rate-limit burn', async () => {
  let marked = false;
  queueFlagDigest('naomi', 'probe-key', 'probe raise text', () => { marked = true; });

  // 23:30 ET, inside the window, for a non-Max owner: the flush must skip
  // before any delivery, so nothing is delivered, marked, or re-queued.
  await flushFlagDigests(et('2026-10-15T23:30'));

  assert.equal(marked, false, 'the onDelivered mark must not run while held');
  const state = JSON.parse(readFileSync(join(stateDir, 'flag-digest.json'), 'utf8')) as {
    queues?: Record<string, unknown[]>;
    lastFlush?: Record<string, number>;
  };
  assert.ok(state.queues?.naomi?.some((e) => JSON.stringify(e).includes('probe-key')), 'the entry stays queued untouched');
  assert.ok(!state.lastFlush?.naomi, 'the pacing clock must not advance while held');

  // The same flush with a Max-lane owner is NOT held by this gate — but that
  // path calls real delivery, so the test does not exercise it; the negative
  // case above is the regression the review flagged.
});

test('a live lane holds its digest: nothing delivered or marked, and a re-queue keeps the original hold age', async () => {
  // 14:20 ET, outside the quiet window: only the lane-liveness gate holds
  // (card-b3468c). The live set is injected, so the flush never touches the
  // real roster; the delivery path itself stays unexercised, like the
  // quiet-hours test above.
  let marked = false;
  queueFlagDigest('naomi', 'live-key', 'live probe raise', () => { marked = true; });

  await flushFlagDigests(et('2026-10-15T14:20'), new Set(['naomi']));

  assert.equal(marked, false, 'a live lane must not run the onDelivered mark');
  type PersistedQueue = { key: string; firstQueuedAt?: number };
  const read = () => JSON.parse(readFileSync(join(stateDir, 'flag-digest.json'), 'utf8')) as { queues?: Record<string, PersistedQueue[]>; lastFlush?: Record<string, number> };
  const state = read();
  const entry = state.queues?.naomi?.find((e) => e.key === 'live-key');
  assert.ok(entry, 'the entry stays queued untouched while held');
  assert.ok(entry!.firstQueuedAt, 'a held entry records its first queue time');
  assert.ok(!state.lastFlush?.naomi, 'the pacing clock must not advance while held');

  // Holding never means losing: a producer's re-queue must NOT refresh the
  // hold age, or a busy lane would hold its digest without bound.
  queueFlagDigest('naomi', 'live-key', 'live probe raise (re-queued)');
  const requeued = read();
  assert.equal(
    requeued.queues?.naomi?.find((e) => e.key === 'live-key')?.firstQueuedAt,
    entry!.firstQueuedAt,
    'a re-queue must keep the original firstQueuedAt',
  );
});

// Clean up the throwaway state dir after the run.
test('cleanup', () => {
  rmSync(stateDir, { recursive: true, force: true });
});
