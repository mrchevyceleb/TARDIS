import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexCatalog, resolveCodexSelection, resolveCodexServiceTier } from './codex-models.ts';

test('resolves model-specific Codex efforts', () => {
  assert.deepEqual(resolveCodexSelection('gpt-6-astra', 'ultra'), {
    model: 'gpt-6-astra',
    effort: 'ultra', serviceTier: 'default'
  });
  assert.throws(() => resolveCodexSelection('gpt-6-astra', 'not-real'), /valid Codex effort/);
  assert.deepEqual(resolveCodexSelection('gpt-5.6-sol', 'ultra'), {
    model: 'gpt-5.6-sol',
    effort: 'ultra', serviceTier: 'default'
  });
  assert.deepEqual(resolveCodexSelection('gpt-5.6-luna', 'max'), {
    model: 'gpt-5.6-luna',
    effort: 'max', serviceTier: 'default'
  });
  assert.deepEqual(resolveCodexSelection('gpt-6-sol', 'ultra'), { model: 'gpt-6-sol', effort: 'ultra', serviceTier: 'default' });
  assert.deepEqual(resolveCodexSelection('gpt-6-luna', 'ultra'), { model: 'gpt-6-luna', effort: 'ultra', serviceTier: 'default' });
  assert.deepEqual(resolveCodexSelection('gpt-5.6-luna', 'ultra'), {
    model: 'gpt-5.6-luna',
    effort: 'ultra', serviceTier: 'default'
  });
});

test('rejects malformed browser values without coercing them', () => {
  const hostile = { toString: null, valueOf: null };
  assert.throws(() => resolveCodexSelection(['gpt-5.6-sol'], ['ultra']), /valid Codex model/);
  assert.throws(() => resolveCodexSelection(hostile, hostile), /valid Codex model/);
  assert.throws(() => resolveCodexSelection(null, null), /valid Codex model/);
  assert.throws(() => resolveCodexSelection('__proto__', 'ultra'), /valid Codex model/);
  assert.deepEqual(resolveCodexSelection('new-model-not-yet-listed', 'ultra'), { model: 'new-model-not-yet-listed', effort: 'ultra', serviceTier: 'default' });
});


test('discovers per-model speed tiers and canonicalizes legacy Fast metadata', () => {
  const row = { slug: 'example-model', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] };
  const models = parseCodexCatalog({ models: [
    { ...row, service_tiers: [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }], default_service_tier: 'priority' },
    { ...row, slug: 'legacy', additional_speed_tiers: ['fast'] },
    { ...row, slug: 'standard-only' },
  ] })!;
  assert.deepEqual(models[0].serviceTiers?.map(tier => tier.id), ['priority', 'ultrafast']);
  assert.equal(models[0].defaultServiceTier, 'priority');
  assert.deepEqual(models[1].serviceTiers?.map(tier => tier.id), ['priority']);
  assert.deepEqual(models[2].serviceTiers, []);
  assert.equal(resolveCodexSelection('gpt-6.1-sol', 'low', 'priority').serviceTier, 'priority');
  assert.equal(resolveCodexSelection('gpt-6.1-sol', 'low', 'fast').serviceTier, 'priority');
  assert.throws(() => resolveCodexServiceTier('unlisted', 'bogus'), /speed offered/);
  assert.throws(() => resolveCodexServiceTier('gpt-6.1-sol', null), /speed offered/);
  assert.equal(resolveCodexSelection('unlisted', 'low', 'priority').serviceTier, 'priority');
  assert.equal(resolveCodexSelection('unlisted', 'low', 'custom-speed').serviceTier, 'custom-speed');
});
