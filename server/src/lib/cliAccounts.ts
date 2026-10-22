import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP_ROOT } from '../config.ts';
import { resolveCodexBin } from '../chat/codex-models.ts';
import { cliProfiles, cliProfileId, cliProfileForEnv, type AccountEngine, type CliProfile } from './cliProfiles.ts';
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

export async function claudeIdentity(env: NodeJS.ProcessEnv): Promise<Identity> {
  let stdout: string;
  try {
    ({ stdout } = await run('claude', ['auth', 'status', '--json'], {
      cwd: APP_ROOT, env, timeout: 8_000, maxBuffer: 64 * 1024, windowsHide: true,
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
  const signature = ['.credentials.json', 'auth.json'].map(name => {
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
  const grouped = new Map<string, CliAccount>();
  for (const { profile, data } of entries) {
    // Two Claude directories are one login only when native status proves
    // both the email and organization match. Codex gives no workspace ID, so
    // separate Codex profiles stay separate even when the emails match.
    const key = profile.engine === 'claude' && data.status === 'connected' && data.email && data.organizationId
      ? `${profile.engine}:${data.email.toLowerCase()}:${data.organizationId}` : profile.id;
    const existing = grouped.get(key);
    if (existing) { existing.profileIds.push(profile.id); continue; }
    const { organizationId: _organizationId, ...publicIdentity } = data;
    grouped.set(key, { id: profile.id, engine: profile.engine, ...publicIdentity, profileIds: [profile.id] });
  }
  return [...grouped.values()];
}

export function accountForProfile(accounts: CliAccount[], engine: AccountEngine, profile: string): CliAccount | undefined {
  const id = cliProfileId(engine, profile);
  return accounts.find((account) => account.engine === engine && account.profileIds.includes(id));
}
