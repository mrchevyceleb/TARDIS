import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from live state before the module loads: zaiQuota captures STATE_DIR
// at import time, seeds its plan window from <state>/zai-quota.json, persists
// window changes back to that file, and prefers an inherited
// RIVENDELL_ZAI_FALLBACK_API_KEY over the FIREWORKS_API_KEY these tests set.
// A bare run on the dev box or inside a service-env job therefore read the
// real (exhausted) window and the wrapped fallback key, failing both tests.
const state = mkdtempSync(join(tmpdir(), 'zai-quota-'));
process.env.RIVENDELL_STATE_DIR = state;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('RIVENDELL_ZAI_')) delete process.env[key];
}
const {
  isZaiFallbackProviderFailure,
  isZaiPlanQuotaEvent,
  noteZaiFallbackFailure,
  noteZaiPlanQuota,
  resetZaiQuotaState,
  zaiCredentials,
  zaiModeFor,
} = await import('./zaiQuota.ts');
after(() => { rmSync(state, { recursive: true, force: true }); });

const GLM = 'glm-5.3[1m]';
const FLASH = 'glm-5.3-flash[1m]';
const QUOTA_RESULT = {
  type: 'result',
  api_error_status: 429,
  result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","code":"1308","message":"[1308][Usage limit reached for 5 hour. Your limit will reset at 2026-09-21 23:07:07][20260921210633ef9b37ab742d4184]"}}',
};

function withKeys<T>(keys: Record<string, string | undefined>, fn: () => T): T {
  const prior = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(keys)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetZaiQuotaState();
  }
}

test('only a real plan-window refusal moves GLM to Fireworks', () => {
  resetZaiQuotaState();
  withKeys({ Z_AI_API_KEY: 'plan-key', FIREWORKS_API_KEY: 'fw-key' }, () => {
    // A capacity 429 is ordinary rate limiting; a 401 is an auth problem.
    // Neither means the plan window closed.
    assert.equal(isZaiPlanQuotaEvent({ type: 'result', api_error_status: 429, result: 'model is currently at capacity' }), false);
    assert.equal(isZaiPlanQuotaEvent({ type: 'result', api_error_status: 401, result: '[1308] Usage limit reached for 5 hour' }), false);
    assert.equal(isZaiPlanQuotaEvent(QUOTA_RESULT), true);
    // A mid-turn api_retry reports the same exhaustion under a different key.
    assert.equal(isZaiPlanQuotaEvent({ type: 'system', subtype: 'api_retry', error_status: 429, error: '[1308][Usage limit reached for 5 hour]' }), true);

    assert.equal(zaiModeFor(GLM), 'plan');
    assert.equal(zaiCredentials(GLM).token, 'plan-key');

    noteZaiPlanQuota(QUOTA_RESULT);
    for (const model of [GLM, FLASH]) {
      const swapped = zaiCredentials(model);
      assert.equal(swapped.mode, 'fireworks');
      assert.equal(swapped.token, 'fw-key');
      // No `/v1`: the Anthropic client appends `/v1/messages` itself.
      assert.equal(swapped.baseUrl, 'https://api.fireworks.ai/inference');
    }
    // `--model` has to carry Fireworks' own name for the same weights.
    assert.equal(zaiCredentials(GLM).wireModel, 'accounts/fireworks/models/glm-5p3');
    assert.equal(zaiCredentials(FLASH).wireModel, 'accounts/fireworks/models/glm-5p3-flash');
    // A brain Fireworks does not serve keeps today's behaviour rather than
    // being silently answered by a different model.
    assert.equal(zaiModeFor('glm-5.1'), 'plan');

    // Every documented plan-exhaustion code must move GLM, not just 1308.
    // Missing the weekly cap left it pinned to a dead plan for a week.
    for (const detail of [
      '[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-28 23:07:07]',
      '[1317][Usage limit reached for the past 7 days. Insufficient balance for extra usage. Resets at 2026-09-28 23:07:07]',
      '[1309][Your GLM Coding Plan package has expired and is temporarily unavailable]',
    ]) {
      resetZaiQuotaState();
      assert.equal(zaiModeFor(GLM), 'plan');
      assert.equal(noteZaiPlanQuota({ type: 'result', api_error_status: 429, result: detail }), true, detail);
      assert.equal(zaiModeFor(GLM), 'fireworks', detail);
    }
    // Ordinary throttling clears on its own and must NOT burn the fallback.
    resetZaiQuotaState();
    assert.equal(isZaiPlanQuotaEvent({ type: 'result', api_error_status: 429, result: '[1302][Rate limit reached for requests]' }), false);
  });
});

test('GLM never flaps between two failing providers', () => {
  resetZaiQuotaState();
  // With no Fireworks key there is nothing to fall back to.
  withKeys({ Z_AI_API_KEY: 'plan-key', FIREWORKS_API_KEY: undefined }, () => {
    noteZaiPlanQuota(QUOTA_RESULT);
    assert.equal(zaiModeFor(GLM), 'plan');
    assert.equal(zaiCredentials(GLM).token, 'plan-key');
  });

  resetZaiQuotaState();
  withKeys({ Z_AI_API_KEY: 'plan-key', FIREWORKS_API_KEY: 'fw-key' }, () => {
    noteZaiPlanQuota(QUOTA_RESULT);
    assert.equal(zaiModeFor(GLM), 'fireworks');
    // Only account-wide failures condemn Fireworks. One oversized request
    // says nothing about the provider, and benching on it would send every
    // GLM lane back to the plan window we already know is closed.
    for (const status of [400, 413, 422]) {
      assert.equal(isZaiFallbackProviderFailure({ type: 'result', api_error_status: status }), false, String(status));
    }
    for (const status of [401, 403, 429, 500, 503]) {
      assert.equal(isZaiFallbackProviderFailure({ type: 'result', api_error_status: status }), true, String(status));
    }
    // A mid-turn api_retry carries its status under a different key.
    assert.equal(isZaiFallbackProviderFailure({ type: 'system', subtype: 'api_retry', error_status: 401 }), true);

    // While the plan window is exhausted, a Fireworks failure must NOT bench
    // it: benching routes every GLM turn back to a plan that 429s until the
    // window resets (observed 2026-10-05: a single 503 blip benched Fireworks
    // for 15 minutes against a plan closed for days, so every GLM turn in the
    // bench died on the dead plan). A transient Fireworks blip beats a
    // guaranteed-dead plan, so GLM keeps retrying Fireworks.
    noteZaiFallbackFailure();
    assert.equal(zaiModeFor(GLM), 'fireworks');
    // A plan-window refusal also drops any bench still active from when the
    // plan was healthy: carried into the closed window it would route every
    // GLM turn to a guaranteed 429, so the window closing under an existing
    // bench keeps GLM on Fireworks too.
    resetZaiQuotaState();
    noteZaiFallbackFailure();
    noteZaiPlanQuota(QUOTA_RESULT);
    assert.equal(zaiModeFor(GLM), 'fireworks');
  });
});
