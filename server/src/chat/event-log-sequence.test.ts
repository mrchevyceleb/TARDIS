import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { redactSecrets } from './secretRedaction.ts';
import {
  latestEventLogSeq,
  normalizeEventLogSequence,
  reserveEventLogSeq,
} from './event-log-store.ts';

test('repairs cross-engine sequence regressions in durable file order', () => {
  const input = [
    JSON.stringify({ seq: 8, ev: { type: 'event', event: { type: '_user_echo', text: 'one' } } }),
    JSON.stringify({ seq: 9, ev: { type: 'turnEnd' } }),
    JSON.stringify({ seq: 4, ev: { type: 'event', event: { type: '_user_echo', text: 'late' } } }),
    JSON.stringify({ seq: 4, ev: { type: 'turnEnd' } }),
  ];

  const result = normalizeEventLogSequence(input);
  assert.equal(result.repaired, true);
  assert.deepEqual(result.lines.map((line) => JSON.parse(line).seq), [8, 9, 10, 11]);
  assert.equal(JSON.parse(result.lines[2]).ev.event.text, 'late');
});

test('moves a repaired tail above every cursor from the old file', () => {
  const result = normalizeEventLogSequence([
    JSON.stringify({ seq: 100, ev: { type: 'turnEnd' } }),
    JSON.stringify({ seq: 50, ev: { type: 'event', event: { type: 'assistant' } } }),
    JSON.stringify({ seq: 101, ev: { type: 'turnEnd' } }),
  ]);
  assert.deepEqual(result.lines.map((line) => JSON.parse(line).seq), [100, 102, 103]);
});

test('shares one monotonic allocator across native sessions for the same log', () => {
  const key = `test-thread-${process.pid}-${Date.now()}`;
  assert.equal(reserveEventLogSeq(key, 20), 20);
  assert.equal(reserveEventLogSeq(key, 3), 21);
  assert.equal(latestEventLogSeq(key, 0), 21);
});

// A token-shaped tool event must not monopolize the server before it is saved.
test('event redaction finishes on long underscore names and retains masking', () => {
  const moduleUrl = new URL('./secretRedaction.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {redactSecrets} from ${JSON.stringify(moduleUrl)}; redactSecrets('TOKEN_'.repeat(50_000)); console.log('finished');`], { encoding: 'utf8', timeout: 3000 });
  assert.equal(child.status, 0, 'redaction exceeded its isolated hard deadline');
  assert.equal(child.stdout.trim(), 'finished');
  for (const suffix of ['', '=example-value-42', ': example-value-42']) {
    const value = 'TOKEN_' + 'A_'.repeat(358) + 'A' + suffix;
    const result = redactSecrets(value);
    assert.equal(redactSecrets(result), result);
    assert.ok(!result.includes('example-value-42'));
  }
  for (const value of ['TOKEN__X=example-value-42', 'TOKEN___=example-value-42', '"MY_API_KEY_V2": "example-value-42"']) {
    assert.ok(!redactSecrets(value).includes('example-value-42'));
  }
  assert.ok(!redactSecrets('plain=value API_KEY=example-value-42').includes('example-value-42'));
  assert.ok(!redactSecrets('plain: value \"API_KEY\": \"example-value-42\"').includes('example-value-42'));
  assert.equal(redactSecrets('MAX_TOKEN_=40'), 'MAX_TOKEN_=40');
  assert.equal(redactSecrets('snake_key_=foo bar baz'), 'snake_key_=foo bar baz');
  assert.equal(redactSecrets('TOKEN_COUNT=5'), 'TOKEN_COUNT=5');
  assert.equal(redactSecrets('API_TOKEN_TTL: 30'), 'API_TOKEN_TTL: 30');
});
