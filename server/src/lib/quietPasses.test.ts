import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from live state before the modules load: quietPasses reads
// <state>/quiet-hours-passes.json on first use and rewrites it on every grant.
const state = mkdtempSync(join(tmpdir(), 'quiet-passes-'));
process.env.RIVENDELL_STATE_DIR = state;
after(() => { rmSync(state, { recursive: true, force: true }); });

/** Fixed instants in America/New_York (EST, UTC-5, after the Nov 1 2026 change). */
const et = (wall: string): number => Date.parse(`${wall}:00Z`) + 5 * 3_600_000;
const FILE = join(state, 'quiet-hours-passes.json');

// A pass saved before a restart: in force from the first read at boot.
writeFileSync(FILE, JSON.stringify([
  { id: 'jammer', until: new Date(et('2026-11-15T21:00')).toISOString(), reason: 'Game jam', grantedBy: 'Owner' },
]));

const { inQuietHours, isQuietExemptLane, isQuietExemptWork, quietHoldsFor } = await import('./quietHours.ts');
const { activeQuietPass, endQuietPass, grantQuietPass, listQuietPasses, onQuietPassGranted, QuietPassError } = await import('./quietPasses.ts');

test('a saved pass lets the lane work through quiet hours until it ends, then the window holds again', () => {
  const thursdayNight = et('2026-11-12T21:05');
  assert.equal(inQuietHours(thursdayNight), true);
  assert.equal(isQuietExemptLane('jammer', thursdayNight), true);
  assert.equal(quietHoldsFor('jammer', thursdayNight), false);
  assert.equal(quietHoldsFor('bystander', thursdayNight), true);
  // Work started before the window still delivers overnight under the pass.
  assert.equal(isQuietExemptWork('jammer', et('2026-11-12T18:00'), thursdayNight), true);
  assert.equal(quietHoldsFor('jammer', et('2026-11-14T03:00')), false);
  // The pass ends as Sunday's window opens: from then on it holds as usual.
  assert.equal(quietHoldsFor('jammer', et('2026-11-15T21:00')), true);
  assert.equal(isQuietExemptWork('jammer', et('2026-11-15T20:00'), et('2026-11-15T21:30')), false);
});

test('grants refuse a bad end, replace, release held work, persist, and end early', async () => {
  const now = et('2026-11-12T22:00');
  const released: string[] = [];
  onQuietPassGranted((agentId) => released.push(agentId));

  await assert.rejects(grantQuietPass({ agentId: 'nova', until: now - 1, grantedBy: 'Owner' }, now), QuietPassError);
  await assert.rejects(grantQuietPass({ agentId: 'nova', until: now + 31 * 24 * 3_600_000, grantedBy: 'Owner' }, now), QuietPassError);
  assert.deepEqual(released, []);

  await grantQuietPass({ agentId: 'nova', until: et('2026-11-13T07:00'), reason: '  late push  ', grantedBy: 'Max' }, now);
  assert.deepEqual(released, ['nova']);
  assert.equal(activeQuietPass('nova', now)?.reason, 'late push');
  assert.equal(quietHoldsFor('nova', now), false);

  await grantQuietPass({ agentId: 'nova', until: et('2026-11-14T08:00'), grantedBy: 'Owner' }, now);
  assert.equal(activeQuietPass('nova', now)?.until, new Date(et('2026-11-14T08:00')).toISOString());
  assert.deepEqual(listQuietPasses(now).map((pass) => pass.id), ['nova', 'jammer']);
  const saved = JSON.parse(readFileSync(FILE, 'utf8')) as { id: string }[];
  assert.deepEqual(saved.map((pass) => pass.id).sort(), ['jammer', 'nova']);

  assert.equal(await endQuietPass('nova', now), true);
  assert.equal(quietHoldsFor('nova', now), true);
  assert.equal(await endQuietPass('nova', now), false);
});
