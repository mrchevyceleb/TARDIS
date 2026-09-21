/** Z.ai coding-plan window exhaustion, and the Fireworks fallback for GLM.
 *
 *  The GLM coding plan is metered in fixed prompt windows (a rolling 5-hour
 *  window plus a weekly cap), NOT against an account balance. Z.ai bills the
 *  Anthropic endpoint against balance only for accounts that never bought a
 *  plan, so topping up credits cannot clear a `[1308] Usage limit reached`
 *  429 — the plan simply stops until the window resets.
 *
 *  Fireworks serves the same GLM weights behind its own Anthropic-compatible
 *  Messages endpoint, which the stock `claude` binary drives with nothing but
 *  a base URL and token swap (verified: Bearer auth, `role: "system"` entries
 *  inside `messages`, tools, and streaming all behave, so unlike xAI this
 *  needs no transform proxy). When the plan window closes, GLM keeps running
 *  there on metered Fireworks tokens and returns to the plan on its own.
 */

export type ZaiMode = 'plan' | 'fireworks';

// Z.ai's documented plan-exhaustion codes (docs.z.ai/api-reference/api-code).
// 1308 is the rolling window, 1310 the weekly/monthly cap, 1316-1321 the
// "insufficient balance for extra usage" variants, and 1309 an outright
// expired plan. Matching only 1308 left GLM pinned to a dead plan for a whole
// week whenever the weekly cap tripped. 1302 ("Rate limit reached for
// requests") is deliberately absent: that is ordinary throttling that clears
// on its own, not a closed window.
const PLAN_QUOTA = /\[(?:1308|1309|1310|131[6-9]|132[01])\]|usage limit reached for\b|limit exhausted\b/i;
// Both spellings ship: 1308/1310 say "will reset at", 1316-1321 say "Resets at".
const RESET_AT = /resets?\s+at\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/i;
// Z.ai request ids lead with the server's own `YYYYMMDDHHMMSS`, in the same
// clock as the reset timestamp. Differencing the two keeps the window length
// timezone-independent instead of guessing Z.ai's server offset.
const REQUEST_STAMP = /\b(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})[0-9a-f]{6,}\b/i;

const MAX_WINDOW_MS = 8 * 24 * 60 * 60 * 1000; // the weekly cap is the longest real window
const WINDOW_BUFFER_MS = 30_000;

/** Only the GLM ids Fireworks actually serves. An unmapped brain (glm-5.1, and
 *  any future pin) simply has no fallback and keeps today's behaviour. */
const FIREWORKS_MODELS: Record<string, string> = {
  'glm-5.3[1m]': 'accounts/fireworks/models/glm-5p3',
  'glm-5.3-flash[1m]': 'accounts/fireworks/models/glm-5p3-flash',
};

const planBaseUrl = (): string =>
  process.env.RIVENDELL_ZAI_BASE_URL?.trim() || 'https://api.z.ai/api/anthropic';
// No `/v1` suffix: the Anthropic client appends `/v1/messages` itself, and
// `/inference/v1` makes it request `/inference/v1/v1/messages`, which the CLI
// reports as "an issue with the selected model" rather than a 404.
const fireworksBaseUrl = (): string =>
  process.env.RIVENDELL_ZAI_FALLBACK_BASE_URL?.trim() || 'https://api.fireworks.ai/inference';
const planKey = (): string => process.env.Z_AI_API_KEY?.trim() || '';
// The host wrapper unsets FIREWORKS_API_KEY before exec so no wrapped CLI can
// inherit a metered key; it stashes the value under the fallback-specific name
// first. Read that, and accept the plain name for a bare `npm start`.
const fireworksKey = (): string =>
  process.env.RIVENDELL_ZAI_FALLBACK_API_KEY?.trim() || process.env.FIREWORKS_API_KEY?.trim() || '';

function defaultCooldownMs(): number {
  const raw = Number(process.env.RIVENDELL_ZAI_PLAN_COOLDOWN_MS?.trim());
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_WINDOW_MS) : 60 * 60 * 1000;
}

/** How long a failing Fireworks fallback is benched. Without this, a dead
 *  Fireworks key would flap on every turn: plan 429 -> Fireworks -> failure ->
 *  plan -> 429, burning a turn each way. */
function fallbackCooldownMs(): number {
  const raw = Number(process.env.RIVENDELL_ZAI_FALLBACK_COOLDOWN_MS?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
}

let planExhaustedUntilMs = 0;
let fallbackBenchedUntilMs = 0;

function quotaDetail(ev: unknown): string {
  if (!ev || typeof ev !== 'object') return '';
  const e = ev as Record<string, any>;
  const parts: string[] = [];
  const push = (value: unknown) => { if (typeof value === 'string') parts.push(value); };
  push(e.result);
  push(e.error);
  push(e.message);
  if (Array.isArray(e.errors)) {
    for (const entry of e.errors) {
      if (typeof entry === 'string') parts.push(entry);
      else push(entry?.message);
    }
  }
  return parts.join('\n');
}

function windowMsFromDetail(detail: string): number {
  const reset = RESET_AT.exec(detail);
  if (!reset) return defaultCooldownMs();
  const resetMs = Date.UTC(+reset[1], +reset[2] - 1, +reset[3], +reset[4], +reset[5], +reset[6]);
  const stamp = REQUEST_STAMP.exec(detail);
  if (stamp) {
    const sentMs = Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6]);
    const delta = resetMs - sentMs;
    if (delta > 0 && delta <= MAX_WINDOW_MS) return delta;
  }
  return defaultCooldownMs();
}

/** True when this event is a Z.ai plan-window refusal rather than ordinary
 *  rate limiting or an auth failure. Only a 429 can qualify. */
export function isZaiPlanQuotaEvent(ev: unknown): boolean {
  const e = ev as Record<string, any> | null;
  if (!e || typeof e !== 'object') return false;
  if (e.api_error_status !== 429 && e.error_status !== 429) return false;
  return PLAN_QUOTA.test(quotaDetail(e));
}

/** Record a plan-window refusal. Idempotent: a retry storm reporting the same
 *  window never shortens an already-open one. */
export function noteZaiPlanQuota(ev: unknown): boolean {
  if (!isZaiPlanQuotaEvent(ev)) return false;
  const until = Date.now() + windowMsFromDetail(quotaDetail(ev)) + WINDOW_BUFFER_MS;
  if (until > planExhaustedUntilMs) {
    planExhaustedUntilMs = until;
    console.warn(`[chat zai] coding-plan window exhausted until ${new Date(until).toISOString()}`);
  }
  return true;
}

/** Whether a Fireworks failure condemns the PROVIDER or just this request.
 *
 *  Benching sends every GLM lane back to an already-exhausted plan, so it must
 *  only answer account-wide problems: a bad key (401/403), Fireworks' own rate
 *  limit (429), or an outage (5xx). A request-specific 400/413/422 — one
 *  oversized or malformed turn — says nothing about the provider's health and
 *  must stay local to that turn. */
export function isZaiFallbackProviderFailure(ev: unknown): boolean {
  const e = ev as Record<string, any> | null;
  if (!e || typeof e !== 'object') return false;
  const status = typeof e.api_error_status === 'number' ? e.api_error_status
    : typeof e.error_status === 'number' ? e.error_status
    : undefined;
  if (status === undefined) return false;
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/** Fireworks itself is unusable. Bench it so GLM does not flap between two
 *  failing providers; the plan key is no worse and reopens on its own. */
export function noteZaiFallbackFailure(): void {
  fallbackBenchedUntilMs = Date.now() + fallbackCooldownMs();
  console.warn('[chat zai] Fireworks fallback benched after a provider-level failure');
}

/** The provider a GLM spawn of this model should run on right now. */
export function zaiModeFor(model: string): ZaiMode {
  if (Date.now() >= planExhaustedUntilMs) return 'plan';
  if (Date.now() < fallbackBenchedUntilMs) return 'plan';
  if (!fireworksKey()) return 'plan';
  return FIREWORKS_MODELS[model] ? 'fireworks' : 'plan';
}

/** Auth token, base URL, and the id to put on `--model` for the next spawn.
 *  `wireModel` differs from the brain's own id only on Fireworks, which names
 *  the same weights `accounts/fireworks/models/glm-5p3`. */
export function zaiCredentials(model: string): {
  token: string;
  baseUrl: string;
  wireModel: string;
  mode: ZaiMode;
} {
  const mode = zaiModeFor(model);
  return mode === 'fireworks'
    ? { token: fireworksKey(), baseUrl: fireworksBaseUrl(), wireModel: FIREWORKS_MODELS[model], mode }
    : { token: planKey(), baseUrl: planBaseUrl(), wireModel: model, mode };
}

/** Millisecond epoch the plan window reopens, or 0 when the plan is healthy. */
export function zaiPlanWindowResetsAt(): number {
  return Date.now() < planExhaustedUntilMs ? planExhaustedUntilMs : 0;
}

/** Tests only. */
export function resetZaiQuotaState(): void {
  planExhaustedUntilMs = 0;
  fallbackBenchedUntilMs = 0;
}
