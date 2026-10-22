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

// One stuck expression must fail the test, never freeze the test process.
test('event redaction finishes on hostile names and retains baseline masking', () => {
  const moduleUrl = new URL('./secretRedaction.ts', import.meta.url).href;
  const source = `import {redactSecrets} from ${JSON.stringify(moduleUrl)};
    const keys = '_KEY'.repeat(64000);
    const started = performance.now();
    const inputs = ['A'+keys+'!', 'A'+keys+'=', 'A'+keys+'=fake-value',
      '\"A'+keys+'\": \"fake-value\"', 'A_'+'COUNT_'.repeat(40000)+'x_KEY=fake-value',
      'TOKEN_'+'A_'.repeat(20000)+'A', 'TOKEN_'.repeat(50000)];
    if (inputs.some(x=>redactSecrets(x).includes('fake-value'))) process.exit(2);
    if (performance.now()-started > 500) process.exit(3);
    console.log('finished');`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, 'redaction exceeded its isolated hard deadline');
  assert.equal(child.stdout.trim(), 'finished');
  for (const value of ['TOKEN__X=example-value-42', 'TOKEN___=example-value-42', '\"MY_API_KEY_V2\": \"example-value-42\"', 'plain=value API_KEY=example-value-42']) {
    assert.ok(!redactSecrets(value).includes('example-value-42'));
  }
  for (const input of ['pwd:API_KEYx=', 'MAX_TOKEN_=40', 'TOKEN_COUNT=5', 'API_TOKEN_TTL: 30', '\"grafana_token\": \"example-value-42\"']) {
    assert.equal(redactSecrets(redactSecrets(input)), redactSecrets(input));
  }
});

test('password-named credentials mask; config-dimension names stay readable', () => {
  for (const [input, expected] of [
    ['DATABASE_PASSWORD=example-value-42', 'DATABASE_PASSWORD=[redacted secret]'],
    ['SESSION_SECRET=example-value-42', 'SESSION_SECRET=[redacted secret]'],
    ['ADMIN_PASSWORD=example-value-42', 'ADMIN_PASSWORD=[redacted secret]'],
    ['DATABASE_PASSWORD: correct horse battery staple', 'DATABASE_PASSWORD: [redacted secret]'],
    ['"SESSION_SECRET": "example-value-42"', '"SESSION_SECRET": "[redacted secret]"'],
    ['TOKEN_COUNT_DATABASE_PASSWORD=example-value-42', 'TOKEN_COUNT_DATABASE_PASSWORD=[redacted secret]'],
    ['DATABASE_PASSWORD_TOKEN_COUNT=example-value-42', 'DATABASE_PASSWORD_TOKEN_COUNT=[redacted secret]'],
    ['SIGN_IN_PASSWORD=example-value-42', 'SIGN_IN_PASSWORD=[redacted secret]'],
    ['ON_CALL_SECRET=example-value-42', 'ON_CALL_SECRET=[redacted secret]'],
    ['SECRET_IN_KEYVAULT=example-value-42', 'SECRET_IN_KEYVAULT=[redacted secret]'],
    ['"database_password": "example-value-42"', '"database_password": "[redacted secret]"'],
    ['"db_password": "example-value-42"', '"db_password": "[redacted secret]"'],
    ['"api_key_v2": "example-value-42"', '"api_key_v2": "[redacted secret]"'],
    ['DATABASE_PASSWD=example-value-42', 'DATABASE_PASSWD=[redacted secret]'],
    ['HOST_PASSWORD=example-value-42', 'HOST_PASSWORD=[redacted secret]'],
    ['DATABASE_PASSWORD_ROTATION=example-value-42', 'DATABASE_PASSWORD_ROTATION=[redacted secret]'],
    ['PASSWORD_HASH=argon2FakeWhatever1', 'PASSWORD_HASH=[redacted secret]'],
    ['{"databasePassword":"example-value-42"}', '{"databasePassword":"[redacted secret]"}'],
  ]) {
    assert.equal(redactSecrets(input), expected);
  }
  for (const input of [
    'PASSWORD_EXPIRY_DAYS=90',
    'PASSWORD_MIN_LENGTH=12',
    'INPUT_TOKEN_COUNT=2048',
    'MAX_TOKEN_LIMIT=4096',
    'RATE_LIMIT_SECRET_PATH=/tmp/x',
    'TOKEN_COUNT_ROTATION_DAYS=30',
    'SESSION_SECRET_ROTATION_DAYS=30',
    'PASSWORD_HASH_ALGORITHM=argon2id',
    'PASSWORD_POLICY_ENABLED=false',
    'PASSWORD_REQUIRE_SPECIAL_CHAR=true',
    'PASSWORD_HISTORY_DEPTH=8',
  ]) {
    assert.equal(redactSecrets(input), input);
  }
});
