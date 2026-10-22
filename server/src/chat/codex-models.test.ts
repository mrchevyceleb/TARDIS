import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCodexSelection } from './codex-models.ts';

test('resolves model-specific Codex efforts', () => {
  assert.deepEqual(resolveCodexSelection('gpt-6-astra', 'ultra'), {
    model: 'gpt-6-astra',
    effort: 'ultra',
  });
  assert.throws(() => resolveCodexSelection('gpt-6-astra', 'not-real'), /valid Codex effort/);
  assert.deepEqual(resolveCodexSelection('gpt-5.6-sol', 'ultra'), {
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  });
  assert.deepEqual(resolveCodexSelection('gpt-5.6-luna', 'max'), {
    model: 'gpt-5.6-luna',
    effort: 'max',
  });
  assert.deepEqual(resolveCodexSelection('gpt-6-sol', 'ultra'), { model: 'gpt-6-sol', effort: 'ultra' });
  assert.deepEqual(resolveCodexSelection('gpt-6-luna', 'ultra'), { model: 'gpt-6-luna', effort: 'ultra' });
  assert.deepEqual(resolveCodexSelection('gpt-5.6-luna', 'ultra'), {
    model: 'gpt-5.6-luna',
    effort: 'ultra',
  });
});

test('rejects malformed browser values without coercing them', () => {
  const hostile = { toString: null, valueOf: null };
  assert.throws(() => resolveCodexSelection(['gpt-5.6-sol'], ['ultra']), /valid Codex model/);
  assert.throws(() => resolveCodexSelection(hostile, hostile), /valid Codex model/);
  assert.throws(() => resolveCodexSelection(null, null), /valid Codex model/);
  assert.throws(() => resolveCodexSelection('__proto__', 'ultra'), /valid Codex model/);
  assert.deepEqual(resolveCodexSelection('new-model-not-yet-listed', 'ultra'), { model: 'new-model-not-yet-listed', effort: 'ultra' });
});
