import assert from 'node:assert/strict';
import test from 'node:test';
import { agyCatalogPayload, agyModelSpec, resolveAgyEffort, resolveAgyModel } from './agy-models.ts';

const CARBON = 'gemini-4-carbon';

test('the agy catalog offers Carbon with its own label and effort metadata', () => {
  const { models } = agyCatalogPayload();
  assert.deepEqual(models.map(model => model.id), ['gemini-4-argon', CARBON, 'gemini-3.8-flash']);
  assert.deepEqual(models.find(model => model.id === CARBON), {
    id: CARBON, label: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium', contextWindow: 1_000_000,
  });
  assert.equal(agyModelSpec(CARBON)?.id, CARBON);
});

test('Carbon survives model validation at every supported effort without forwarding suffixed ids', () => {
  assert.equal(resolveAgyModel(CARBON), CARBON);
  for (const effort of ['low', 'medium', 'high']) {
    assert.equal(resolveAgyModel(`${CARBON}-${effort}`), CARBON);
    assert.equal(resolveAgyEffort(CARBON, effort), effort);
  }
  assert.equal(resolveAgyEffort(CARBON, undefined), 'medium');
  assert.equal(resolveAgyEffort(CARBON, 'max'), 'medium');
  assert.equal(resolveAgyEffort(CARBON, 'invalid', 'low'), 'low');
});

test('adding Carbon keeps the Argon default, Flash pins and configured fallbacks intact', () => {
  assert.equal(resolveAgyModel(undefined), 'gemini-4-argon');
  assert.equal(resolveAgyModel('unknown'), 'gemini-4-argon');
  assert.equal(resolveAgyModel('gemini-3.8-flash-high'), 'gemini-3.8-flash');
  assert.equal(resolveAgyEffort('gemini-3.8-flash', undefined), 'high');
  assert.equal(resolveAgyModel('unknown', CARBON), CARBON);
  assert.equal(resolveAgyModel(undefined, `${CARBON}-high`), CARBON);
});
