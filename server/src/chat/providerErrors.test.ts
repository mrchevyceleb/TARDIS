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
