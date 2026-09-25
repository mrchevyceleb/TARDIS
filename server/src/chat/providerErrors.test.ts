import assert from 'node:assert/strict';
import test from 'node:test';
import { isSyntheticApiErrorText, syntheticApiErrorReason, terminalExecutionError, terminalProviderError } from './providerErrors.ts';

test('xAI capacity errors are not mislabeled as account rate limits', () => {
  const error = terminalProviderError('xai', {
    type: 'result',
    api_error_status: 429,
    errors: [{ message: 'resource-exhausted: The model is currently at capacity due to high demand.' }],
  });
  assert.equal(error?.message, 'xAI is temporarily at capacity. Try again in a few minutes or switch brains.');
  assert.equal(error?.retryable, true);
});

test('resource-exhausted quota errors remain rate-limit errors', () => {
  const error = terminalProviderError('xai', {
    type: 'result',
    api_error_status: 429,
    errors: [{ message: 'resource-exhausted: monthly quota exceeded' }],
  });
  assert.equal(error?.message, "xAI's usage window is full, so this turn could not run. Switch brains or try again after the limit resets.");
});

test('an OAuth refresh collision is not reported as a dead local runner', () => {
  // Seen live on 2026-09-22: the CLI streams the collision text as assistant
  // prose, then ends with a bare failed result. The generic bucket called it
  // a dead local runner, which is both wrong and scarier than the truth.
  const result = { type: 'result', subtype: 'success', is_error: true };
  const text = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute.';
  const error = terminalExecutionError('claude', result, null, text);
  assert.match(error?.message ?? '', /login token refresh collided/);
  assert.equal(error?.retryable, true);
  assert.equal(error?.code, 'oauth_refresh_collision');
});

test('an unparseable tool call is reported as the model failing, not the runner', () => {
  // Same morning, second failure: the model's tool call failed to parse, the
  // CLI nudged a retry, the retry failed too, and the result carried the
  // parse-failure text.
  const result = { type: 'result', subtype: 'success', is_error: true, result: "The model's tool call could not be parsed (retry also failed)." };
  const error = terminalExecutionError('claude', result);
  assert.match(error?.message ?? '', /malformed tool call twice/);
  assert.equal(error?.retryable, true);
  assert.equal(error?.code, 'tool_call_unparseable');
});

test('a synthetic API error keeps the real reason instead of blaming the local runner', () => {
  // Claude Code can end a turn with a synthetic `API Error:` message and then a
  // result carrying no api_error_status. Reporting that as a dead local runner
  // hides the only actionable part.
  const result = { type: 'result', subtype: 'success', is_error: true };
  assert.match(
    terminalExecutionError('claude', result)?.message ?? '',
    /local runner stopped/,
  );
  assert.equal(syntheticApiErrorReason('API Error: Request rejected'), 'the request was rejected upstream');
  assert.equal(syntheticApiErrorReason('API Error: upstream said no (503)'), 'HTTP 503');
  // The direct form must be recognised too, or its reason is unreachable
  // and its text never gets scrubbed from the transcript.
  assert.equal(isSyntheticApiErrorText('API Error: 429 rate limited'), true);
  assert.equal(syntheticApiErrorReason('API Error: 429 rate limited'), 'HTTP 429');
  assert.equal(isSyntheticApiErrorText('API Errors happen sometimes'), false);
  assert.equal(syntheticApiErrorReason('I am an ordinary answer.'), null);
  assert.match(
    terminalExecutionError('claude', result, 'the request was rejected upstream')?.message ?? '',
    /could not answer this turn \(the request was rejected upstream\)/,
  );
});
