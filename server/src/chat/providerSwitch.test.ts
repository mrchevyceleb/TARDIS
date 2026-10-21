import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openRouterContinueBudget,
  pendingProviderCut,
  PROVIDER_CONTINUE_PROMPT,
  providerContinuePrompt,
  providerCutEventFields,
  providerCutGuidance,
  resetProviderSwitchState,
  spendOpenRouterContinue,
} from './providerSwitch.ts';

/** Oct 21 (card-b8ebac): OpenRouter-family cuts ride the same automatic
 *  continue as GLM provider switches, with a per-lane cap so a hard-down
 *  provider stops instead of looping, and the write-size rule that keeps a
 *  continued turn from dying the same way (one oversized tool call outlasts
 *  the provider's response cutoff). */

const cutEvent = (providerCut: unknown) => ({ ev: { type: 'event', event: { type: '_terminal_error', message: 'cut', providerCut } } });
const assistantEvent = { ev: { type: 'event', event: { type: 'assistant', message: { content: [] } } } };
const interruptedEvent = { ev: { type: 'event', event: { type: '_interrupted', ts: 1 } } };

test('an OpenRouter-family cut stays pending until a later turn reaches the model', () => {
  assert.deepEqual(pendingProviderCut([cutEvent({ engine: 'openrouter' })]), { engine: 'openrouter' });
  assert.deepEqual(pendingProviderCut([cutEvent({ engine: 'openrouter2' })]), { engine: 'openrouter2' });
  assert.deepEqual(pendingProviderCut([cutEvent({ engine: 'openrouter' }), assistantEvent]), null);
  assert.deepEqual(pendingProviderCut([cutEvent({ engine: 'openrouter' }), interruptedEvent]), null);
  // The GLM switch marker still reads exactly as before.
  assert.deepEqual(pendingProviderCut([cutEvent({ from: 'plan', to: 'fireworks' })]), { from: 'plan', to: 'fireworks' });
  assert.deepEqual(pendingProviderCut([cutEvent({ from: 'fireworks', to: 'plan' })]), { from: 'fireworks', to: 'plan' });
  assert.equal(pendingProviderCut([cutEvent({ from: 'plan' })]), null);
});

test('engine-cut guidance carries the write-size rule; a GLM cut does not', () => {
  assert.match(providerCutGuidance([cutEvent({ engine: 'openrouter' })]), /15 KB/);
  assert.doesNotMatch(providerCutGuidance([cutEvent({ from: 'plan', to: 'fireworks' })]), /15 KB/);
  assert.equal(providerCutGuidance([assistantEvent]), '');
});

test('the continue prompt for an engine cut tells the lane to write in pieces', () => {
  assert.match(providerContinuePrompt({ engine: 'openrouter' }), /15 KB/);
  assert.equal(providerContinuePrompt({ from: 'plan', to: 'fireworks' }), PROVIDER_CONTINUE_PROMPT);
});

test('engine-cut continues are capped per lane per window, then allowed again', () => {
  resetProviderSwitchState();
  const lane = { logKey: 'thread__test', chatId: 'chat-test' };
  const t0 = 1_000_000_000;
  for (let i = 0; i < 4; i += 1) spendOpenRouterContinue(lane, t0 + i);
  assert.equal(openRouterContinueBudget(lane, t0 + 10), false);
  // Another lane is never affected.
  assert.equal(openRouterContinueBudget({ logKey: 'thread__test', chatId: 'chat-other' }, t0 + 10), true);
  // The window passes and the lane may continue again.
  assert.equal(openRouterContinueBudget(lane, t0 + 20 * 60_000 + 1), true);
  resetProviderSwitchState();
});

test('a continue event names the engine cut as the engine, a GLM cut as from/to', () => {
  assert.deepEqual(providerCutEventFields({ engine: 'openrouter' }), { engine: 'openrouter' });
  assert.deepEqual(providerCutEventFields({ engine: 'openrouter2' }), { engine: 'openrouter2' });
  assert.deepEqual(providerCutEventFields({ from: 'plan', to: 'fireworks' }), { from: 'plan', to: 'fireworks' });
});
