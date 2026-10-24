import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMuseAllowance, resolveMuseEffort, resolveMuseModel } from './muse-models.ts';
import { museSubscriptionEnvironment } from './subscription-policy.ts';

test('muse lane never resolves to a contributor (training) model', () => {
  assert.equal(resolveMuseModel('muse-wonder-1.0-contributor'), 'muse-wonder-1.0');
  assert.equal(resolveMuseModel('muse-spark-1.3-contributor'), 'muse-spark-1.3');
  assert.equal(resolveMuseModel('gpt-5'), 'muse-wonder-1.0');
  assert.equal(resolveMuseModel(undefined, 'muse-wonder-full-1.0-contributor'), 'muse-wonder-full-1.0');
  assert.equal(resolveMuseEffort('muse-spark-1.3', 'bogus'), 'high');
  assert.equal(resolveMuseEffort('muse-spark-1.3', 'xhigh'), 'xhigh');
});

test('muse allowance parses both CLI shapes and the spawn env drops endpoint overrides', () => {
  const exec = parseMuseAllowance({ tier: 'Plan', window: { used_percent: 12, resets_at_ms: 5 }, weekly: { used_percent: 3 }, as_of_ms: 9 });
  assert.deepEqual(exec, { tier: 'Plan', window: { usedPercent: 12, resetsAtMs: 5 }, weekly: { usedPercent: 3, resetsAtMs: null }, asOfMs: 9 });
  assert.equal(parseMuseAllowance({ window: { usedPercent: 40 } })?.window?.usedPercent, 40);
  assert.equal(parseMuseAllowance({}), null);
  const env = museSubscriptionEnvironment({ PATH: 'p', MUSE_BASE_URL: 'x', MUSE_API_KEY: 'k', TARDIS_MUSE_OFFICE_AUTH: 't' });
  assert.deepEqual(env, { PATH: 'p' });
});
