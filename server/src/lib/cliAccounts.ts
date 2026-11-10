import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP_ROOT } from '../config.ts';
import { resolveCodexBin } from '../chat/codex-models.ts';
import { cliProfiles, cliProfileId, cliProfileForEnv, longLivedClaudeToken, longLivedTokenApplies, withLongLivedClaudeToken, type AccountEngine, type CliProfile } from './cliProfiles.ts';
export { cliProfileId, cliProfileForEnv };
export type { AccountEngine };

export type CliAccount = {
  id: string;
  engine: AccountEngine;
  email?: string;
  organization?: string;
  plan?: string;
  status: 'connected' | 'signed_out' | 'unavailable' | 'unsupported';
  checkedAt: number;
  /** Opaque profile keys also recognize an existing duplicate login. */
  profileIds: string[];
};

type Identity = Omit<CliAccount, 'id' | 'engine' | 'profileIds'> & { organizationId?: string };
type Profile = CliProfile;
const run = promisify(execFile);
const cache = new Map<string, { at: number; signature: string; result: Promise<Identity> }>();

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 180) || undefined : undefined;
}

export type LongLivedVerdict = 'valid' | 'invalid' | 'unknown';
const tokenVerdicts = new Map<string, { at: number; verdict: LongLivedVerdict }>();
const VERDICT_TTL_MS = 10 * 60_000;

/** `claude auth status` reports loggedIn for ANY token in the environment —
 *  it checks presence, not validity (a fabricated token passes). The provider
 *  settles it for free: an auth-bearing GET rejects a dead token with 401 and
 *  answers a live one with any other status (the year token lacks the oauth
 *  scope, so it gets 403). Read-only, fixed host, no paid call; network
 *  trouble reports `unknown` rather than condemning a good token. Verdicts
 *  cache ten minutes — the token never rotates, but it can be revoked. */
export async function probeLongLivedClaudeToken(token: string): Promise<LongLivedVerdict> {
  const key = createHash('sha256').update(token).digest('hex');
  const cached = tokenVerdicts.get(key);
  if (cached && Date.now() - cached.at < VERDICT_TTL_MS) return cached.verdict;
  let verdict: LongLivedVerdict;
  try {
    // The URL is overridable so isolated tests can steer the verdict; the
    // default is the provider's own endpoint, and the token only ever rides
    // the Authorization header to that host.
    const url = process.env.RIVENDELL_CLAUDE_TOKEN_PROBE_URL?.trim() || 'https://api.anthropic.com/api/oauth/profile';
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/usage' },
      redirect: 'error', signal: AbortSignal.timeout(6_000),
    });
    await response.body?.cancel();
    verdict = response.status === 401 ? 'invalid' : 'valid';
  } catch { verdict = 'unknown'; }
  // Only definitive verdicts cache: an `unknown` (network trouble) must never
  // overwrite a fresh 401 rejection, and retrying it next read is one bounded
  // fetch, not a storm.
  if (verdict !== 'unknown') tokenVerdicts.set(key, { at: Date.now(), verdict });
  return verdict;
}

export async function claudeIdentity(env: NodeJS.ProcessEnv, verifyToken: (token: string) => Promise<LongLivedVerdict> = probeLongLivedClaudeToken): Promise<Identity> {
  // A profile holding a year token authenticates with it, and `claude auth
  // status` only proves that login when the token rides the environment; its
  // answer then says loggedIn with authMethod "oauth_token" and no email, so
  // the account identity comes from the token file, with the profile's saved
  // account supplying the organization while it still matches. But the CLI's
  // answer only proves the token is PRESENT — the provider probe above is
  // what proves it still opens doors, and a rejected one reads signed out.
  const profileDir = cliProfileForEnv('claude', env);
  const longLived = longLivedClaudeToken(profileDir);
  let stdout: string;
  try {
    ({ stdout } = await run('claude', ['auth', 'status', '--json'], {
      cwd: APP_ROOT, env: longLived ? withLongLivedClaudeToken({ ...env }, profileDir) : env,
      timeout: 8_000, maxBuffer: 64 * 1024, windowsHide: true,
    }));
  } catch (error) {
    // A signed-out CLI may return valid status JSON with a nonzero exit.
    const output = (error as { stdout?: unknown }).stdout;
    if (typeof output !== 'string' || !output.trim()) throw new Error('Account status unavailable.');
    stdout = output;
  }
  const data = JSON.parse(stdout);
  const checkedAt = Date.now();
  if (data.loggedIn !== true) return { status: 'signed_out', checkedAt };
  // The oauth_token answer is the token's own voice, so it only names the
  // token account when the token actually rides this profile — the same rule
  // lane spawns use, so the panel never shows an account its lanes can't bill.
  if (longLived && longLivedTokenApplies(longLived, profileDir) && data.authMethod === 'oauth_token') {
    if (await verifyToken(longLived.token) === 'invalid') return { status: 'signed_out', checkedAt };
    let organization: string | undefined, organizationId: string | undefined, plan: string | undefined;
    try {
      const saved = JSON.parse(readFileSync(join(profileDir, '.claude.json'), 'utf8'))?.oauthAccount;
      if (typeof saved?.emailAddress === 'string' && saved.emailAddress.toLowerCase() === longLived.email.toLowerCase()) {
        organization = text(saved.organizationName);
        organizationId = text(saved.organizationUuid);
        plan = text(saved.planDisplayName) ?? text(saved.seatTier);
      }
    } catch { /* A wiped profile: the token alone is the identity. */ }
    return { status: 'connected', checkedAt, email: longLived.email, organization, organizationId, plan };
  }
  if (data.authMethod !== 'claude.ai') return { status: 'unsupported', checkedAt };
  const email = text(data.email);
  return {
    status: email ? 'connected' : 'unavailable', checkedAt, email,
    organization: text(data.orgName), organizationId: text(data.orgId), plan: text(data.subscriptionType),
  };
}

/** Native metadata RPC only. Never starts a thread, a turn, or a paid query. */
export async function codexIdentity(env: NodeJS.ProcessEnv): Promise<Identity> {
  const app = spawn(resolveCodexBin(), ['app-server'], {
    cwd: APP_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  let failed = false;
  const rejectAll = () => {
    failed = true;
    for (const entry of pending.values()) entry.reject(new Error('Account status unavailable.'));
    pending.clear();
  };
  app.on('error', rejectAll);
  app.on('close', rejectAll);
  app.stdin.on('error', rejectAll);
  app.stderr.resume();
  app.stdout.setEncoding('utf8');
  app.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 256 * 1024) { rejectAll(); app.kill(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error('Account status unavailable.'));
      else entry.resolve(message.result);
    }
  });
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolveResult, reject) => {
    if (failed || !app.stdin.writable) { reject(new Error('Account status unavailable.')); return; }
    const id = nextId++;
    pending.set(id, { resolve: resolveResult, reject });
    app.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) rejectAll(); });
  });
  const deadline = setTimeout(() => { rejectAll(); app.kill(); }, 8_000);
  try {
    await request('initialize', { clientInfo: { name: 'tardis-accounts', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    app.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const result = await request('account/read', { refreshToken: false });
    const checkedAt = Date.now();
    if (!result?.account) return { status: 'signed_out', checkedAt };
    if (result.account.type !== 'chatgpt') return { status: 'unsupported', checkedAt };
    const email = text(result.account.email);
    return { status: email ? 'connected' : 'unavailable', checkedAt, email, plan: text(result.account.planType) };
  } finally {
    clearTimeout(deadline);
    app.stdin.end();
    app.kill('SIGTERM');
    const kill = setTimeout(() => { if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL'); }, 2_000);
    kill.unref();
    app.once('close', () => clearTimeout(kill));
  }
}

function identity(profile: Profile, refresh: boolean): Promise<Identity> {
  const previous = cache.get(profile.id);
  // The year-token file and the saved account shape the answer as much as the
  // native credentials do, so all three feed the cache signature.
  const signature = ['.credentials.json', 'auth.json', '.claude.json', '.long-lived-oauth-token'].map(name => {
    try { const st = statSync(join(profile.path, name)); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
  }).join('|');
  // Even explicit refreshes coalesce, so opening several agents cannot spawn
  // an auth-status storm. Failures recover without restarting TARDIS.
  if (previous && previous.signature === signature && Date.now() - previous.at < (refresh ? 5_000 : 60_000)) return previous.result;
  const result = (profile.engine === 'claude' ? claudeIdentity(profile.env) : codexIdentity(profile.env))
    .catch((): Identity => ({ status: 'unavailable', checkedAt: Date.now() }));
  cache.set(profile.id, { at: Date.now(), signature, result });
  return result;
}

export async function listCliAccounts(refresh = false): Promise<CliAccount[]> {
  const entries = await Promise.all(cliProfiles().map(async (profile) => ({ profile, data: await identity(profile, refresh) })));
  const grouped = new Map<string, CliAccount & { organizationId?: string }>();
  for (const { profile, data } of entries) {
    // Two Claude directories are one login only when native status proves
    // both the email and organization match. Codex gives no workspace ID, so
    // separate Codex profiles stay separate even when the emails match.
    const key = profile.engine === 'claude' && data.status === 'connected' && data.email
      ? `${profile.engine}:${data.email.toLowerCase()}:${data.organizationId ?? ''}` : profile.id;
    const existing = grouped.get(key);
    if (existing) {
      existing.profileIds.push(profile.id);
      continue;
    }
    grouped.set(key, { id: profile.id, engine: profile.engine, ...data, profileIds: [profile.id] });
  }
  const rows = [...grouped.values()];
  // A wiped year-token profile carries the email but no organization; fold it
  // into the healthy row for the same email so the panel never shows the same
  // login twice, whichever profile the reader happened to see first.
  const healthy = new Map(rows.filter(row => row.engine === 'claude' && row.status === 'connected' && row.email && row.organizationId).map(row => [row.email!.toLowerCase(), row]));
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    const host = row.engine === 'claude' && row.status === 'connected' && row.email && !row.organizationId ? healthy.get(row.email.toLowerCase()) : undefined;
    if (host && host !== row) { host.profileIds.push(...row.profileIds); if (!host.organization && row.organization) host.organization = row.organization; rows.splice(index, 1); }
  }
  return rows.map(({ organizationId: _organizationId, ...row }) => row);
}

export function accountForProfile(accounts: CliAccount[], engine: AccountEngine, profile: string): CliAccount | undefined {
  const id = cliProfileId(engine, profile);
  return accounts.find((account) => account.engine === engine && account.profileIds.includes(id));
}
