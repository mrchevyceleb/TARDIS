import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP_ROOT } from '../config.ts';
import { resolveCodexBin } from '../chat/codex-models.ts';
import { cliProfiles, cliProfileId, cliProfileForEnv, longLivedClaudeToken, longLivedTokenApplies, recordLongLivedTokenVerdict, withVerifiedLongLivedClaudeToken, type AccountEngine, type CliProfile } from './cliProfiles.ts';
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

type Identity = Omit<CliAccount, 'id' | 'engine' | 'profileIds'> & { organizationId?: string; tokenId?: string };
type Profile = CliProfile;
const run = promisify(execFile);
const cache = new Map<string, { at: number; signature: string; result: Promise<Identity> }>();

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 180) || undefined : undefined;
}

export type LongLivedVerdict = 'valid' | 'invalid' | 'unknown';
const tokenVerdicts = new Map<string, { at: number; verdict: LongLivedVerdict }>();
const tokenProbes = new Map<string, Promise<LongLivedVerdict>>();
const VERDICT_TTL_MS = 10 * 60_000;

/** Presence is not authentication. Only success or the provider's explicit
 * missing-profile-scope response proves a year token; generic 403s, outages
 * and throttling prove nothing. A transient failure preserves the last
 * definitive verdict, never inventing a first successful verification. */
export async function probeLongLivedClaudeToken(token: string): Promise<LongLivedVerdict> {
  const key = createHash('sha256').update(token).digest('hex');
  const cached = tokenVerdicts.get(key);
  if (cached && Date.now() - cached.at < VERDICT_TTL_MS) return cached.verdict;
  const pending = tokenProbes.get(key);
  if (pending) return pending;
  const probe = (async (): Promise<LongLivedVerdict> => {
    let verdict: LongLivedVerdict = 'unknown';
    try {
      const response = await fetch('https://api.anthropic.com/api/oauth/profile', {
        headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/usage' },
        redirect: 'error', signal: AbortSignal.timeout(6_000),
      });
      try {
        if (response.status === 401) verdict = 'invalid';
        else if (response.ok) verdict = 'valid';
        else if (response.status === 403) {
          // A setup-token intentionally lacks user:profile/user:office. Read
          // only enough of the error to distinguish that from a proxy/WAF 403.
          const reader = response.body?.getReader();
          if (reader) {
            const parts: Uint8Array[] = []; let length = 0;
            try {
              while (true) {
                const { value, done } = await reader.read(); if (done) break;
                length += value.length;
                if (length > 8 * 1024) throw new Error('Oversized auth response.');
                parts.push(value);
              }
              const error = JSON.parse(Buffer.concat(parts).toString('utf8'))?.error;
              if (error?.type === 'permission_error' && typeof error.message === 'string'
                && error.message.includes('OAuth token does not meet scope requirement')
                && /user:(profile|office)\b/.test(error.message)) verdict = 'valid';
            } finally { await reader.cancel().catch(() => {}); }
          }
        }
      } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); }
    } catch { /* No authentication verdict: keep the last provider evidence. */ }
    if (verdict !== 'unknown') {
      tokenVerdicts.set(key, { at: Date.now(), verdict });
      recordLongLivedTokenVerdict(token, verdict);
    }
    return verdict === 'unknown' ? cached?.verdict ?? 'unknown' : verdict;
  })().finally(() => { tokenProbes.delete(key); });
  tokenProbes.set(key, probe);
  return probe;
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
  let tokenVerdict: LongLivedVerdict | undefined;
  const statusEnv = await withVerifiedLongLivedClaudeToken({ ...env }, profileDir, async token => {
    tokenVerdict = await verifyToken(token);
    return tokenVerdict;
  });
  let stdout: string;
  try {
    ({ stdout } = await run('claude', ['auth', 'status', '--json'], {
      cwd: APP_ROOT, env: statusEnv,
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
  if (data.loggedIn !== true) return tokenVerdict === 'unknown'
    ? { status: 'unavailable', checkedAt, email: longLived?.email }
    : { status: 'signed_out', checkedAt };
  // The oauth_token answer is the token's own voice, so it only names the
  // token account when the token actually rides this profile — the same rule
  // lane spawns use, so the panel never shows an account its lanes can't bill.
  if (longLived && tokenVerdict !== undefined && data.authMethod === 'oauth_token') {
    if (tokenVerdict === 'invalid') return { status: 'signed_out', checkedAt };
    if (statusEnv.CLAUDE_CODE_OAUTH_TOKEN !== longLived.token || !longLivedTokenApplies(longLived, profileDir)) {
      return { status: 'unavailable', checkedAt, email: longLived.email };
    }
    let organization: string | undefined, organizationId: string | undefined, plan: string | undefined;
    try {
      const saved = JSON.parse(readFileSync(join(profileDir, '.claude.json'), 'utf8'))?.oauthAccount;
      if (typeof saved?.emailAddress === 'string' && saved.emailAddress.toLowerCase() === longLived.email.toLowerCase()) {
        organization = text(saved.organizationName);
        organizationId = text(saved.organizationUuid);
        plan = text(saved.planDisplayName) ?? text(saved.seatTier);
      }
    } catch { /* A wiped profile: the token alone is the identity. */ }
    return { status: 'connected', checkedAt, email: longLived.email, organization, organizationId, plan,
      tokenId: createHash('sha256').update(longLived.token).digest('hex') };
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
  const grouped = new Map<string, CliAccount & { organizationId?: string; tokenIds: Set<string> }>();
  for (const { profile, data } of entries) {
    // Two Claude directories are one login only when native status proves
    // both the email and organization match. Codex gives no workspace ID, so
    // separate Codex profiles stay separate even when the emails match.
    const key = profile.engine === 'claude' && data.status === 'connected' && data.email && data.organizationId
      ? `${profile.engine}:${data.email.toLowerCase()}:${data.organizationId}` : profile.id;
    const existing = grouped.get(key);
    if (existing) {
      existing.profileIds.push(profile.id);
      if (data.tokenId) existing.tokenIds.add(data.tokenId);
      continue;
    }
    const { tokenId, ...publicIdentity } = data;
    grouped.set(key, { id: profile.id, engine: profile.engine, ...publicIdentity, profileIds: [profile.id], tokenIds: new Set(tokenId ? [tokenId] : []) });
  }
  const rows = [...grouped.values()];
  // A wiped token profile may fold into one unambiguous organization-backed
  // row only when the same verified token proves equivalence. Email alone
  // never proves that two profiles bill the same organization.
  const healthyRows = rows.filter(row => row.engine === 'claude' && row.status === 'connected' && row.email && row.organizationId);
  const ambiguous = new Set(healthyRows.map(row => row.email!.toLowerCase()).filter((email, index, all) => all.indexOf(email) !== index));
  const healthy = new Map(healthyRows.filter(row => !ambiguous.has(row.email!.toLowerCase())).map(row => [row.email!.toLowerCase(), row]));
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    const host = row.engine === 'claude' && row.status === 'connected' && row.email && !row.organizationId ? healthy.get(row.email.toLowerCase()) : undefined;
    if (host && host !== row && row.tokenIds.size && [...row.tokenIds].every(id => host.tokenIds.has(id))) {
      host.profileIds.push(...row.profileIds);
      if (!host.organization && row.organization) host.organization = row.organization;
      rows.splice(index, 1);
    }
  }
  return rows.map(({ organizationId: _organizationId, tokenIds: _tokenIds, ...row }) => row);
}

export function accountForProfile(accounts: CliAccount[], engine: AccountEngine, profile: string): CliAccount | undefined {
  const id = cliProfileId(engine, profile);
  return accounts.find((account) => account.engine === engine && account.profileIds.includes(id));
}
