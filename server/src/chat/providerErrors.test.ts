import assert from 'node:assert/strict';
import test from 'node:test';
import { isContextLengthRejection, isSyntheticApiErrorText, syntheticApiErrorReason, terminalExecutionError, terminalProviderError } from './providerErrors.ts';

test('a scrubbed monthly usage-limit message still triggers account rollover', () => {
  const reason = syntheticApiErrorReason("You've hit your monthly spend limit · resets 5pm (UTC)");
  assert.equal(reason, 'usage limit (monthly)');
  const error = terminalExecutionError('claude', { type: 'result', is_error: true }, reason);
  assert.equal(error?.usageLimit, true);
  assert.equal(error?.limitKind, 'monthly');
  assert.equal(error?.resetTime, undefined);
});

test('every provider family\'s context-length wording is caught, output caps are not', () => {
  // Oct 20: OpenRouter's "exceeds the model's context window" slipped past the
  // old list and the runner never reseeded, so a lane died on every message.
  for (const detail of [
    'This endpoint\'s maximum context length is 16384 tokens. However, you requested about 20000 tokens.',
    'prompt is too long: 1050000 tokens > 1048576 maximum',
    'This model\'s context window was exceeded',
    'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
    'Input length (12345) exceeds the maximum length (4096)',
    'Please reduce the length of the messages or completion.',
    'The maximum prompt length is 131072 but the prompt is longer.',
    'Codex ran out of room in the model\'s context window. Start a new conversation.',
    'context_length_exceeded',
    'Input too long',
    'too many input tokens',
    // Review P2 (Oct 20): these two wordings slipped the list entirely.
    'context limit exceeded',
    'input tokens exceed the configured limit',
  ]) {
    assert.equal(isContextLengthRejection(detail), true, detail);
  }
  // An output-cap error is a different recovery and must not reseed.
  assert.equal(isContextLengthRejection('exceeded the 32000 output token maximum'), false);
  assert.equal(isContextLengthRejection('the model produced invalid JSON twice'), false);
  // Review P2 (Oct 20): prose that merely mentions the window, and
  // output-subject wording, must not match.
  assert.equal(isContextLengthRejection('The context window is full of useful details'), false);
  assert.equal(isContextLengthRejection('Requested output exceeds the model context window.'), false);
});

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
