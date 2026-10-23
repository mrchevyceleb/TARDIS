import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { APP_ROOT, ELROND_WORKSPACE_PATH } from '../config.ts';
import { listAgents, cliForAgentEngine } from '../chat/agents.ts';
import { resolveCodexBin } from '../chat/codex-models.ts';
import { getXaiAuth, type XaiAuth } from '../routes/xai-oauth.ts';
import { cliProfiles, subscriptionEnvForLane, cliProfileForEnv, type CliProfile } from './cliProfiles.ts';
import { listCliAccounts, accountForProfile, type CliAccount } from './cliAccounts.ts';

export type UsageWindow = { id: string; label: string; used: number; limit: number; remaining: number; unit: 'percent' | 'requests' | 'characters' | 'credits'; resetsAt: string | null; active?: boolean };
export type UsageAmount = { label: string; amount: number; currency: string; period: string; scope: 'key' | 'account' | 'subscription' };
export type UsagePace = { label: string; currency: string; perMinute: number; observedMinutes: number; samples: number; minutesLeft: number | null; balance: number | null; scope: UsageAmount['scope'] };
export type UsageAccount = {
  id: string; provider: string; name: string; email?: string; plan?: string;
  kind: 'subscription' | 'api'; status: 'live' | 'unavailable' | 'stale';
  checkedAt: string | null; attemptedAt: string; windows: UsageWindow[];
  amounts: UsageAmount[]; agents: string[]; note: string;
  source: string; href: string; billingGroup?: string; pace?: UsagePace[];
};
export type AccountUsage = { generatedAt: string; refreshSeconds: number; accounts: UsageAccount[] };
const cache = new Map<string, UsageAccount>();
const observations = new Map<string, Array<{ at: number; amount: number }>>();
/** Estimate only from fresh readings of the same balance or cumulative spend.
 * A top-up, reset or changed currency starts a new sample. No invented prices. */
function measuredPace(a: UsageAccount): UsagePace[] {
  if (a.status !== 'live' || !a.checkedAt) return [];
  const at = Date.parse(a.checkedAt), result: UsagePace[] = [];
  const balances = a.amounts.filter(m => ['Account credit balance', 'Available balance', 'Key budget remaining', 'Cash balance', 'Voucher balance', 'Cash', 'Voucher'].includes(m.label));
  const spending = a.amounts.find(m => /spend/i.test(m.label) && /day/i.test(m.period)) || a.amounts.find(m => /spend/i.test(m.label));
  for (const tracked of balances.length ? balances : spending ? [spending] : []) {
    const m = tracked, isBalance = balances.includes(m), id = [a.id, m.label, m.currency, m.period, m.scope].join('|');
    let points = (observations.get(id) || []).filter(p => at - p.at <= 15 * 60_000 && p.at <= at);
    const previous = points.at(-1);
    if (previous && (isBalance ? m.amount > previous.amount + 0.000001 : m.amount < previous.amount - 0.000001)) points = [];
    if (!previous || at - previous.at >= 10_000 || !points.length) points.push({ at, amount: m.amount });
    observations.set(id, points);
    const first = points[0], elapsed = (at - first.at) / 60_000;
    const change = isBalance ? first.amount - m.amount : m.amount - first.amount;
    if (elapsed < 0.75 || change < 0 || points.length < 2) continue;
    const perMinute = change / elapsed;
    result.push({ label: m.label, currency: m.currency, perMinute, observedMinutes: elapsed, samples: points.length,
      minutesLeft: isBalance && m.amount <= 0 ? 0 : isBalance && perMinute > 0 ? m.amount / perMinute : null,
      balance: isBalance ? m.amount : null, scope: m.scope });
  }
  // Account/key changes cannot grow the process cache without bound.
  if (observations.size > 200) for (const [id, points] of observations) if (!points.length || at - points.at(-1)!.at > 30 * 60_000) observations.delete(id);
  while (observations.size > 200) observations.delete(observations.keys().next().value!);
  return result;
}
let last: AccountUsage | undefined;
let inFlight: Promise<AccountUsage> | undefined;
let lastRead = 0;
const TIMEOUT = 10_000;
const RECENT_MS = 45_000;
const rec = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const signed = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const label = (v: unknown): string | undefined => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160) || undefined : undefined;
const timestamp = (v: unknown, milliseconds = false): string | null => {
  const value = typeof v === 'number' ? v * (milliseconds ? 1 : 1000) : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(value) && value > 0 && value < 8.64e15 ? new Date(value).toISOString() : null;
};
const hash = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 16);
const key = (...names: string[]): string => names.map(name => process.env[name]?.trim()).find(Boolean) || '';
const keys = (...names: string[]): string[] => [...new Set(names.map(name => process.env[name]?.trim()).filter((value): value is string => Boolean(value)))];
const now = () => new Date().toISOString();
function percent(id: string, title: string, value: unknown, reset: unknown, active?: boolean, ms = false): UsageWindow | null {
  const used = num(value);
  return used === undefined ? null : { id, label: title, used, limit: 100, remaining: Math.max(0, 100 - used), unit: 'percent', resetsAt: timestamp(reset, ms), active };
}
function money(raw: unknown): { amount: number; currency: string } | null {
  const v = rec(raw), amount = num(v.amount_minor), exponent = num(v.exponent);
  return amount !== undefined && exponent !== undefined && Number.isInteger(exponent) && exponent <= 6 && /^[A-Z]{3}$/.test(v.currency || '')
    ? { amount: amount / 10 ** exponent, currency: v.currency } : null;
}
class FeedError extends Error {
  constructor(public readonly code: number) { super('Usage feed unavailable.'); }
}
/** Read only, fixed provider hosts, bounded bodies. Never log upstream bodies,
 * key labels, headers, credentials, or an exception containing them. */
async function json(url: string, token: string, extra: Record<string, string> = {}, body?: unknown): Promise<Record<string, any>> {
  const response = await fetch(url, { headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok) { await response.body?.cancel(); throw new FeedError(response.status); }
  const reader = response.body?.getReader();
  if (!reader) throw new FeedError(502);
  const parts: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 1024 * 1024) throw new FeedError(502);
      parts.push(value);
    }
    return rec(JSON.parse(Buffer.concat(parts).toString('utf8')));
  } finally { await reader.cancel().catch(() => {}); }
}
function account(id: string, provider: string, name: string, kind: UsageAccount['kind'], source: string, href: string): UsageAccount {
  return { id, provider, name, kind, source, href, status: 'live', checkedAt: now(), attemptedAt: now(), windows: [], amounts: [], agents: [], note: '' };
}
async function guarded(base: UsageAccount, load: () => Promise<UsageAccount>): Promise<UsageAccount> {
  try {
    const result = await load(); cache.set(base.id, result); return result;
  } catch (error) {
    const previous = cache.get(base.id);
    const reason = error instanceof FeedError && [401, 403].includes(error.code) ? 'This connection cannot read usage. Open the provider to check its access.'
      : error instanceof FeedError && error.code === 429 ? 'The provider asked for a pause. The next automatic check will try again.'
      : 'The provider could not report usage just now. The next check will try again.';
    return { ...(previous || base), agents: [], attemptedAt: now(), checkedAt: previous?.checkedAt || null, status: previous ? 'stale' : 'unavailable', note: reason + (previous ? ' These are the last reported figures.' : '') };
  }
}

async function claude(accountInfo: CliAccount, profile: CliProfile): Promise<UsageAccount> {
  const base = account(accountInfo.id, 'Claude', 'Claude subscription', 'subscription', 'Claude live quota', 'https://claude.ai/settings/usage');
  base.email = accountInfo.email; base.plan = accountInfo.plan;
  return guarded(base, async () => {
    const credentials = rec(JSON.parse(await readFile(join(profile.path, '.credentials.json'), 'utf8')));
    const token = rec(credentials.claudeAiOauth).accessToken;
    if (typeof token !== 'string' || !token) throw new FeedError(401);
    const data = await json('https://api.anthropic.com/api/oauth/usage', token, { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/usage' });
    const names: Record<string, string> = { session: 'Session', weekly_all: 'All models · week', weekly_scoped: 'Model · week' };
    if (Array.isArray(data.limits)) {
      base.windows = data.limits.flatMap((raw: unknown, index: number) => {
        const item = rec(raw), model = label(rec(rec(item.scope).model).display_name);
        const title = model ? model + ' · week' : names[item.kind] || label(item.kind) || 'Plan window';
        const window = percent(String(index), title, item.percent, item.resets_at, typeof item.is_active === 'boolean' ? item.is_active : undefined);
        return window ? [window] : [];
      });
    } else {
      base.windows = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].flatMap(name => {
        const item = rec(data[name]); const window = percent(name, name === 'five_hour' ? 'Five hours' : name.replaceAll('_', ' '), item.utilization, item.resets_at);
        return window ? [window] : [];
      });
    }
    if (!base.windows.length) throw new FeedError(502);
    const spend = rec(data.spend);
    for (const [field, title] of [['used', 'Usage credits spent'], ['limit', 'Usage credits limit'], ['balance', 'Usage credits balance']] as const) {
      const value = money(spend[field]); if (value) base.amounts.push({ ...value, label: title, period: 'Provider reporting period', scope: 'subscription' });
    }
    const extra = rec(data.extra_usage);
    base.note = extra.is_enabled === true ? 'Extra usage is enabled. A full plan window may keep running on paid credits.'
      : extra.disabled_reason === 'out_of_credits' ? 'Extra usage is off because this account is out of credits.'
      : extra.is_enabled === false || label(extra.disabled_reason) ? 'Extra usage is off.' : 'Extra usage status is not reported.';
    if (!base.amounts.length) base.note += ' Subscription price is not supplied by this quota feed.';
    return base;
  });
}
async function codexRpc(profile: CliProfile): Promise<Record<string, any>> {
  const child = spawn(resolveCodexBin(), ['app-server'], { cwd: APP_ROOT, env: profile.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  let buffer = '', id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let failed = false;
  const fail = () => { failed = true; for (const p of pending.values()) p.reject(new FeedError(503)); pending.clear(); };
  child.on('error', fail); child.on('close', fail); child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (part: string) => {
    buffer += part; if (buffer.length > 256 * 1024) { fail(); child.kill(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const message = JSON.parse(line), p = pending.get(message.id); if (!p) continue; pending.delete(message.id); if (message.error) p.reject(new FeedError(503)); else p.resolve(message.result); } catch { /* Native startup diagnostics are not account data. */ }
    }
  });
  const request = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (failed || !child.stdin.writable) { reject(new FeedError(503)); return; }
    const requestId = ++id; pending.set(requestId, { resolve, reject }); child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n', error => { if (error) fail(); });
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, TIMEOUT);
  try {
    await request('initialize', { clientInfo: { name: 'tardis-usage', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return rec(await request('account/rateLimits/read'));
  } finally {
    clearTimeout(timer); child.stdin.end(); child.kill();
    const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000); kill.unref(); child.once('close', () => clearTimeout(kill));
  }
}
async function codex(info: CliAccount, profile: CliProfile): Promise<UsageAccount> {
  const base = account(info.id, 'Codex', 'ChatGPT subscription', 'subscription', 'Codex native quota', 'https://chatgpt.com/codex/settings/usage');
  base.email = info.email; base.plan = info.plan;
  return guarded(base, async () => {
    const data = await codexRpc(profile);
    const buckets = Object.keys(rec(data.rateLimitsByLimitId)).length ? rec(data.rateLimitsByLimitId) : { codex: rec(data.rateLimits) };
    for (const [bucketId, raw] of Object.entries(buckets)) {
      const bucket = rec(raw);
      for (const field of ['primary', 'secondary']) {
        const item = rec(bucket[field]), mins = num(item.windowDurationMins);
        const title = (label(bucket.limitName) || (bucketId === 'codex' ? 'Codex' : bucketId)) + (mins ? ' · ' + (mins >= 1440 ? String(mins / 1440) + ' days' : String(mins / 60) + ' hours') : ' · ' + field);
        const window = percent(bucketId + '-' + field, title, item.usedPercent, item.resetsAt);
        if (window) base.windows.push(window);
      }
      const credits = rec(bucket.credits), balance = typeof credits.balance === 'string' && /^\d+(\.\d+)?$/.test(credits.balance) ? Number(credits.balance) : num(credits.balance);
      if (balance !== undefined) base.windows.push({ id: bucketId + '-credits', label: 'Workspace credits left', used: 0, limit: balance, remaining: balance, unit: 'credits', resetsAt: null });
    }
    if (!base.windows.length) throw new FeedError(502);
    base.note = 'Plan windows come directly from Codex. Subscription price and metered dollar cost are not supplied by this feed.';
    return base;
  });
}
async function openRouter(token: string, personal: boolean): Promise<UsageAccount> {
  const base = account('openrouter-' + hash(token), 'OpenRouter', personal ? 'OpenRouter personal' : 'OpenRouter', 'api', 'OpenRouter key and credit APIs', 'https://openrouter.ai/settings/credits');
  return guarded(base, async () => {
    const data = rec((await json('https://openrouter.ai/api/v1/key', token)).data);
    const credits = await json('https://openrouter.ai/api/v1/credits', token).then(value => rec(value.data)).catch(() => rec(null));
    base.billingGroup = 'openrouter-' + hash(String(data.organization_id || data.creator_user_id || base.id));
    for (const [field, title, period] of [['usage_daily', 'Key spend', 'Current UTC day'], ['usage_monthly', 'Key spend', 'Current UTC month'], ['limit_remaining', 'Key budget remaining', 'Current key budget']] as const) {
      const amount = num(data[field]); if (amount !== undefined) base.amounts.push({ label: title, amount, currency: 'USD', period, scope: 'key' });
    }
    const total = num(credits.total_credits), spent = num(credits.total_usage);
    if (total !== undefined && spent !== undefined) base.amounts.push({ label: 'Account credit balance', amount: total - spent, currency: 'USD', period: 'Whole billing account', scope: 'account' });
    const budgets = Array.isArray(data.budgets) ? data.budgets : [];
    base.windows = budgets.flatMap((raw: unknown, index: number) => {
      const item = rec(raw), limit = num(item.limit_usd), used = num(item.spend_usd);
        const scope = item.scope === 'key_limit' ? 'Key' : item.scope === 'account_limit' ? 'Account' : (label(item.scope) || 'Key').replaceAll('_', ' ');
        const window = limit !== undefined && limit > 0 && used !== undefined ? percent('budget-' + index, scope + ' budget', used / limit * 100, item.resets_at) : null;
      return window ? [window] : [];
    });
    if (!base.amounts.length && !base.windows.length) throw new FeedError(502);
    base.note = 'Key spend and key caps cover this key. Account credit balance is shared with other keys on the same billing account.';
    return base;
  });
}
function fireworksMoney(raw: unknown): { amount: number; currency: string } | null {
  const value = rec(raw), units = value.units === undefined ? 0 : typeof value.units === 'string' && /^-?\d+$/.test(value.units) ? Number(value.units) : value.units;
  const nanos = value.nanos === undefined ? 0 : value.nanos;
  return typeof units === 'number' && Number.isFinite(units) && typeof nanos === 'number' && Number.isFinite(nanos) && /^[A-Z]{3}$/.test(value.currencyCode || '')
    ? { amount: units + nanos / 1e9, currency: value.currencyCode } : null;
}
const fireworksAccounts = new Map<string, string[]>();
async function fireworks(token: string, personal: boolean): Promise<UsageAccount[]> {
  const root = account('fireworks-' + hash(token), 'Fireworks', personal ? 'Fireworks personal key' : 'Fireworks shared key', 'api', 'Fireworks billing summary', 'https://app.fireworks.ai/billing');
  try {
    const listing = await json('https://api.fireworks.ai/v1/accounts?pageSize=50', token);
    if (!Array.isArray(listing.accounts) || !listing.accounts.length) throw new FeedError(403);
    const valid = listing.accounts.slice(0, 50).filter((raw: unknown) => /^accounts\/[a-zA-Z0-9_-]+$/.test(label(rec(raw).name) || ''));
    if (!valid.length) throw new FeedError(502);
    const result = await Promise.all(valid.map((raw: unknown) => {
      const item = rec(raw), name = label(item.name);
      if (!name || !/^accounts\/[a-zA-Z0-9_-]+$/.test(name)) throw new FeedError(502);
      const base = { ...root, id: 'fireworks-' + hash(name), email: label(item.email), name: label(item.displayName) || 'Fireworks API', billingGroup: 'fireworks-' + hash(name), amounts: [] as UsageAmount[] };
      return guarded(base, async () => {
        const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
        const end = new Date(); end.setUTCDate(end.getUTCDate() + 1); end.setUTCHours(0, 0, 0, 0);
        const query = new URLSearchParams({ startTime: start.toISOString(), endTime: end.toISOString() });
        const data = await json('https://api.fireworks.ai/v1/' + name + '/billing/summary?' + query, token);
        if (!Array.isArray(data.lineItems)) throw new FeedError(502);
        const totals = new Map<string, number>();
        for (const line of data.lineItems) { const value = fireworksMoney(rec(line).totalCost); if (value) totals.set(value.currency, (totals.get(value.currency) || 0) + value.amount); }
        if (data.lineItems.length && !totals.size) throw new FeedError(502);
        base.amounts = [...totals].map(([currency, amount]) => ({ label: 'Rated account spend', amount, currency, period: 'Current UTC month · daily aggregation', scope: 'account' }));
        base.note = data.lineItems.length ? 'Fireworks rates usage by day, so recent requests may arrive later. This API does not supply a live credit balance.' : 'No rated line items have been reported for the current UTC month. Total, currency and live credit balance are not supplied.';
        return base;
      });
    }));
    fireworksAccounts.set(hash(token), result.map(value => value.id));
    return result;
  } catch (error) {
    const previous = (fireworksAccounts.get(hash(token)) || []).flatMap(id => { const value = cache.get(id); return value ? [value] : []; });
    return Promise.all((previous.length ? previous : [root]).map(base => guarded(base, async () => { throw error; })));
  }
}
async function zai(token: string): Promise<UsageAccount> {
  const base = account('zai-' + hash(token), 'Z.ai', 'GLM Coding Plan', 'subscription', 'Z.ai plan quota API', 'https://z.ai/manage-apikey/subscription');
  return guarded(base, async () => {
    const reply = await json('https://api.z.ai/api/monitor/usage/quota/limit', token);
    const data = rec(reply.data); if (reply.success !== true || !Array.isArray(data.limits)) throw new FeedError(502);
    base.plan = label(data.level);
    base.windows = data.limits.flatMap((raw: unknown, index: number) => {
      const item = rec(raw), time = item.unit === 3 ? String(item.number || '') + ' hours' : item.unit === 6 ? String(item.number || '') + ' week' : item.unit === 5 ? String(item.number || '') + ' month' : 'Plan window';
      const window = percent(String(index), (item.type === 'TIME_LIMIT' ? 'Tools · ' : 'Coding · ') + time, item.percentage, item.nextResetTime, undefined, true);
      return window ? [window] : [];
    });
    if (!base.windows.length) throw new FeedError(502);
    base.note = 'Coding plan quota is separate from pay-as-you-go API credits. The provider does not supply the subscription price here.';
    return base;
  });
}
async function elevenLabs(token: string): Promise<UsageAccount> {
  const base = account('elevenlabs-' + hash(token), 'ElevenLabs', 'Voice subscription', 'subscription', 'ElevenLabs subscription API', 'https://elevenlabs.io/app/subscription');
  return guarded(base, async () => {
    const data = await json('https://api.elevenlabs.io/v1/user/subscription', '', { 'xi-api-key': token });
    const used = num(data.character_count), limit = num(data.character_limit);
    if (used === undefined || limit === undefined) throw new FeedError(502);
    base.plan = label(data.tier); base.windows = [{ id: 'characters', label: 'Voice characters', used, limit, remaining: Math.max(0, limit - used), unit: 'characters', resetsAt: timestamp(data.next_character_count_reset_unix) }];
    base.note = 'Voice quota is provider-reported. Overage and invoices can use a different billing period.';
    return base;
  });
}
async function moonshot(token: string): Promise<UsageAccount> {
  const base = account('moonshot-' + hash(token), 'Moonshot', 'Moonshot API', 'api', 'Moonshot balance API', 'https://platform.moonshot.ai/console/account');
  return guarded(base, async () => {
    const reply = await json('https://api.moonshot.ai/v1/users/me/balance', token), data = rec(reply.data);
    if (reply.code !== 0 || reply.status !== true || signed(data.available_balance) === undefined) throw new FeedError(502);
    for (const [field, title] of [['available_balance', 'Available balance'], ['cash_balance', 'Cash balance'], ['voucher_balance', 'Voucher balance']] as const) {
      const amount = signed(data[field]); if (amount !== undefined) base.amounts.push({ label: title, amount, currency: 'USD', period: 'Current account balance', scope: 'account' });
    }
    base.note = 'Balance comes from the international Moonshot account. No token-to-dollar estimate is used.'; return base;
  });
}
async function xai(auth: XaiAuth): Promise<UsageAccount> {
  const base = account('xai-subscription', 'Grok', 'SuperGrok subscription', 'subscription', 'Grok subscription billing', 'https://grok.com');
  return guarded(base, async () => {
    if (auth.mode !== 'oauth') throw new FeedError(401);
    const version = process.env.PI_XAI_CLIENT_VERSION?.trim() || '1.0.44', identifier = process.env.PI_XAI_CLIENT_NAME?.trim() || 'grok-shell';
    const os = platform() === 'darwin' ? 'macos' : platform() === 'win32' ? 'windows' : platform(), cpu = arch() === 'arm64' ? 'aarch64' : arch() === 'x64' ? 'x86_64' : arch();
    const headers = { 'User-Agent': `${identifier}/${version} (${os}; ${cpu})`, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-client-identifier': identifier, 'x-grok-client-version': version, 'x-grok-client-mode': 'interactive', 'x-authenticateresponse': 'authenticate-response' };
    const user = await json('https://cli-chat-proxy.grok.com/v1/user', auth.token, headers);
    const userId = label(user.userId || user.id); if (!userId || !/^[\x21-\x7e]+$/.test(userId)) throw new FeedError(502);
    const data = await json('https://cli-chat-proxy.grok.com/v1/billing?format=credits', auth.token, { ...headers, 'x-userid': userId });
    const config = rec(data.config); base.email = label(user.email); base.plan = label(data.subscriptionTier);
    const window = percent('included', 'Included credits', config.creditUsagePercent, rec(config.currentPeriod).end || config.billingPeriodEnd);
    if (window) base.windows.push(window);
    for (const [field, title] of [['used', 'Included credits used'], ['monthlyLimit', 'Included credit allowance'], ['prepaidBalance', 'Prepaid balance'], ['onDemandUsed', 'On-demand spend']] as const) {
      const raw = rec(config[field]).val, cents = typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : num(raw);
      if (cents !== undefined && Number.isFinite(cents)) base.amounts.push({ label: title, amount: cents / 100, currency: 'USD', period: 'Current provider billing period', scope: 'subscription' });
    }
    if (!base.windows.length && !base.amounts.length) throw new FeedError(502);
    base.note = 'Subscription credits are separate from the xAI metered API account. The provider billing endpoint may change.'; return base;
  });
}
async function fal(token: string): Promise<UsageAccount> {
  const base = account('fal-' + hash(token), 'fal', 'fal image and video account', 'api', 'fal account billing API', 'https://fal.ai/dashboard/billing');
  return guarded(base, async () => {
    const data = await json('https://api.fal.ai/v1/account/billing?expand=credits', '', { Authorization: 'Key ' + token });
    const credits = rec(data.credits), amount = num(credits.current_balance);
    if (amount === undefined || !/^[A-Z]{3}$/.test(credits.currency || '')) throw new FeedError(502);
    base.name = label(data.username) || base.name;
    base.amounts = [{ label: 'Account credit balance', amount, currency: credits.currency, period: 'Current account balance', scope: 'account' }];
    base.note = 'Image and video credits share this billing account. Request costs may arrive later.';
    return base;
  });
}
function unavailable(id: string, provider: string, name: string, kind: UsageAccount['kind'], href: string, note: string): UsageAccount {
  return { ...account(id, provider, name, kind, 'Provider dashboard', href), status: 'unavailable', checkedAt: null, note };
}
async function collect(): Promise<AccountUsage> {
  const native = await listCliAccounts(); const profiles = cliProfiles(), agents = listAgents();
  const pending: Array<Promise<UsageAccount[]>> = native.map(info => {
    const profile = profiles.find(p => p.engine === info.engine && info.profileIds.includes(p.id));
    if (!profile || info.status !== 'connected') return Promise.resolve([unavailable(info.id, info.engine === 'claude' ? 'Claude' : 'Codex', 'Subscription needs attention', 'subscription', info.engine === 'claude' ? 'https://claude.ai/settings/usage' : 'https://chatgpt.com/codex/settings/usage', 'Open an agent account picker to check this sign-in.')]);
    return (info.engine === 'claude' ? claude(info, profile) : codex(info, profile)).then(value => [value]);
  });
  const router = key('RIVENDELL_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'), personal = key('RIVENDELL_PERSONAL_OPENROUTER_API_KEY', 'PERSONAL_OPENROUTER_API_KEY');
  if (router) pending.push(openRouter(router, false).then(value => [value]));
  if (personal && personal !== router) pending.push(openRouter(personal, true).then(value => [value]));
  const fireworksKey = key('RIVENDELL_ZAI_FALLBACK_API_KEY', 'FIREWORKS_API_KEY');
  for (const token of keys('RIVENDELL_ZAI_FALLBACK_API_KEY', 'FIREWORKS_API_KEY', 'FIREWORKS_PERSONAL_API_KEY')) pending.push(fireworks(token, token !== fireworksKey));
  const zaiKey = key('Z_AI_API_KEY'); if (zaiKey) pending.push(zai(zaiKey).then(value => [value]));
  const voice = key('ELEVENLABS_API_KEY'); if (voice) pending.push(elevenLabs(voice).then(value => [value]));
  const kimi = key('MOONSHOT_API_KEY'); if (kimi) pending.push(moonshot(kimi).then(value => [value]));
  const falKey = key('FAL_API_KEY', 'FAL_KEY'); if (falKey) pending.push(fal(falKey).then(value => [value]));
  pending.push(getXaiAuth().then(auth => auth.mode === 'unconfigured' ? [] : xai(auth).then(value => [value])));
  // The catalog is not a quota feed. Current Antigravity exposes quota through
  // its interactive /usage panel and secure keyring, not `agy models`.
  const gemini = unavailable('gemini-subscription', 'Gemini', 'Gemini subscription', 'subscription', 'https://antigravity.google', 'Quota and reset times are not available through this connection. Open Antigravity and check Usage.');
  if (agents.some(agent => cliForAgentEngine(agent.engine) === 'agy') || process.env.RIVENDELL_AGY_BIN?.trim() || existsSync(join(homedir(), '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt'))) pending.push(Promise.resolve([gemini]));
  const extra: Array<[string, string, string, string]> = [
    ['GROK_API_KEY', 'xAI API', 'https://console.x.ai', 'Metered API usage is separate from SuperGrok.'],
    ['GOOGLE_API_KEY', 'Google AI API', 'https://console.cloud.google.com/billing', 'Cloud billing needs project-level billing access.'],
    ['ALIBABA_CODING_PLAN_KEY', 'Alibaba Coding Plan', 'https://bailian.console.aliyun.com', 'The coding key does not include billing-dashboard access.'],
    ['GROQ_API_KEY', 'Groq', 'https://console.groq.com', 'Usage and spend are available in the provider dashboard.'],
    ['TOGETHER_API_KEY', 'Together', 'https://api.together.ai', 'Usage and spend are available in the provider dashboard.'],
    ['STEPFUN_API_KEY', 'StepFun', 'https://platform.stepfun.com', 'Usage and spend are available in the provider dashboard.'],
  ];
  const accounts = (await Promise.all(pending)).flat();
  for (const [env, provider, href, detail] of extra) if (key(env, ...(env === 'GROK_API_KEY' ? ['XAI_API_KEY'] : []))) accounts.push(unavailable(provider.toLowerCase().replaceAll(' ', '-'), provider, provider, 'api', href, detail + ' A live usage feed is not connected here.'));
  const unique = new Map<string, UsageAccount>();
  for (const value of accounts) if (!unique.has(value.id) || unique.get(value.id)!.status !== 'live') unique.set(value.id, value);
  for (const agent of agents) {
    const engine = cliForAgentEngine(agent.engine); let id: string | undefined;
    if (engine === 'claude' || engine === 'codex') {
      try { const env = subscriptionEnvForLane(engine, ELROND_WORKSPACE_PATH, agent.home, agent.name); id = accountForProfile(native, engine, cliProfileForEnv(engine, env))?.id; } catch { /* Account recovery remains in the picker. */ }
    } else if (engine === 'openrouter') id = router ? 'openrouter-' + hash(router) : undefined;
    else if (engine === 'openrouter2') id = personal ? 'openrouter-' + hash(personal) : undefined;
    else if (engine === 'zai') id = zaiKey ? 'zai-' + hash(zaiKey) : undefined;
    else if (engine === 'agy') id = gemini.id;
    else if (engine === 'xai') id = process.env.RIVENDELL_PI_XAI_PROVIDER === 'xai-oauth' ? 'xai-subscription' : 'xai-api';
    else if (engine === 'fireworks' && fireworksKey) {
      const targets = fireworksAccounts.get(hash(fireworksKey));
      id = targets?.length === 1 ? targets[0] : targets ? undefined : 'fireworks-' + hash(fireworksKey);
    }
    if (id && unique.has(id)) unique.get(id)!.agents.push(agent.name);
  }
  for (const a of unique.values()) a.pace = measuredPace(a);
  return { generatedAt: now(), refreshSeconds: 60, accounts: [...unique.values()] };
}
export function readAccountUsage(force = false): Promise<AccountUsage> {
  if (inFlight) return inFlight;
  if (last && Date.now() - lastRead < (force ? 10_000 : RECENT_MS)) return Promise.resolve(last);
  const started = Date.now();
  inFlight = collect().then(value => { last = value; lastRead = started; return value; }).finally(() => { inFlight = undefined; });
  return inFlight;
}
