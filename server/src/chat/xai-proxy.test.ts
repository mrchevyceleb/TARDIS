import assert from 'node:assert/strict';
import test from 'node:test';
import { isTransientXaiCapacity, transformRequest } from './xai-proxy.ts';

test('xAI proxy fast-retries transient capacity but not quota exhaustion', () => {
  assert.equal(isTransientXaiCapacity(503, ''), false);
  assert.equal(isTransientXaiCapacity(529, ''), false);
  assert.equal(isTransientXaiCapacity(429, JSON.stringify({
    code: 'resource-exhausted',
    error: 'The model is currently at capacity due to high demand.',
  })), true);
  assert.equal(isTransientXaiCapacity(429, JSON.stringify({
    code: 'resource-exhausted',
    error: 'Monthly quota exceeded.',
  })), false);
});


test('warm xAI requests receive system-level transcript discipline without rewriting messages', () => {
  const messages = [{ role: 'user', content: 'Explain the options' }];
  const transformed = JSON.parse(transformRequest(JSON.stringify({ system: 'Existing persona', messages })));
  assert.deepEqual(transformed.messages, messages);
  assert.equal(transformed.system[0].text, 'Existing persona');
  assert.match(transformed.system.at(-1).text, /thinking\/reasoning channel/);
  assert.match(transformed.system.at(-1).text, /Between-tool messages are welcome/);
  assert.match(transformed.system.at(-1).text, /Plans explicitly requested/);
});
