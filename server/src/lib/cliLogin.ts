import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { APP_ROOT } from '../config.ts';
import { resolveCodexBin } from '../chat/codex-models.ts';
import { claudeIdentity, codexIdentity } from './cliAccounts.ts';
import { createLoginProfile, registerLoginProfile, type AccountEngine } from './cliProfiles.ts';

export type CliLogin = {
  id: string; engine: AccountEngine;
  status: 'starting' | 'waiting' | 'checking' | 'connected' | 'failed' | 'cancelled';
  expiresAt: number; url?: string; userCode?: string; accountId?: string; email?: string; message?: string;
};
type Attempt = { view: CliLogin; child?: ChildProcess; timer?: NodeJS.Timeout; completing?: boolean };
const attempts = new Map<string, Attempt>();

function stop(attempt: Attempt): void {
  clearTimeout(attempt.timer);
  const child = attempt.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.destroy();
  child.kill('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1500);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

function fail(attempt: Attempt, message = 'Sign-in did not finish. Try again.'): void {
  if (['connected', 'cancelled', 'failed'].includes(attempt.view.status)) return;
  attempt.view = { ...attempt.view, status: 'failed', url: undefined, userCode: undefined, message };
  stop(attempt);
}

export function getCliLogin(id: string): CliLogin | undefined {
  const value = attempts.get(id)?.view;
  return value && { ...value };
}

export function cancelCliLogin(id: string): void {
  const attempt = attempts.get(id);
  if (!attempt || attempt.view.status === 'connected') return;
  attempt.view = { ...attempt.view, status: 'cancelled', url: undefined, userCode: undefined };
  stop(attempt);
}

export function submitCliLoginCode(id: string, code: unknown): void {
  const attempt = attempts.get(id);
  if (!attempt || attempt.view.engine !== 'claude' || attempt.view.status !== 'waiting') throw new Error('Start a fresh Claude sign-in.');
  if (typeof code !== 'string' || !code.trim() || code.length > 4096 || /\s/.test(code.trim())) throw new Error('Paste the code shown after signing in.');
  if (!attempt.child?.stdin?.writable) throw new Error('This sign-in has ended. Start a fresh one.');
  attempt.view.status = 'checking';
  attempt.child.stdin.write(`${code.trim()}\n`, error => { if (error) fail(attempt); });
}

function officialUrl(value: unknown, engine: AccountEngine): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    const hosts = engine === 'claude' ? ['claude.ai', 'claude.com'] : ['auth.openai.com', 'chatgpt.com'];
    if (url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password) return url.href;
  } catch { /* Native output is untrusted until parsed. */ }
}

/** Native CLIs own OAuth and persist credentials only inside a new private
 * profile. No existing login is overwritten, and raw CLI output is never logged. */
export async function startCliLogin(engine: AccountEngine): Promise<CliLogin> {
  for (const [id, attempt] of attempts) {
    if (Date.now() > attempt.view.expiresAt + 5 * 60_000) { stop(attempt); attempts.delete(id); }
    else if (attempt.view.engine === engine && ['starting', 'waiting', 'checking'].includes(attempt.view.status)) return { ...attempt.view };
  }
  const profile = await createLoginProfile(engine);
  const view: CliLogin = { id: randomUUID(), engine, status: 'starting', expiresAt: Date.now() + 10 * 60_000 };
  const attempt: Attempt = { view };
  attempts.set(view.id, attempt);
  attempt.timer = setTimeout(() => fail(attempt, 'This sign-in expired. Start a fresh one.'), 10 * 60_000);
  attempt.timer.unref();
  const complete = async () => {
    if (attempt.completing || ['connected', 'cancelled', 'failed'].includes(attempt.view.status)) return;
    attempt.completing = true;
    attempt.view.status = 'checking';
    try {
      const identity = await (engine === 'claude' ? claudeIdentity(profile.env) : codexIdentity(profile.env));
      if (['cancelled', 'failed'].includes(attempt.view.status)) return;
      if (identity.status !== 'connected') throw new Error('No subscription sign-in.');
      await registerLoginProfile(profile.managedId, engine);
      attempt.view = { id: view.id, engine, status: 'connected', expiresAt: view.expiresAt, accountId: profile.id, email: identity.email };
      stop(attempt);
    } catch { fail(attempt, 'I could not verify the subscription sign-in. Please try again.'); }
  };

  const child = spawn(engine === 'claude' ? 'claude' : resolveCodexBin(), engine === 'claude' ? ['auth', 'login', '--claudeai'] : ['app-server', '-c', 'cli_auth_credentials_store="file"'], {
    cwd: APP_ROOT, env: { ...profile.env, BROWSER: process.platform === 'win32' ? 'cmd /c exit 1' : '/bin/false' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  attempt.child = child;
  child.on('error', () => fail(attempt, 'The sign-in service could not start. Try again.'));
  child.stdin.on('error', () => fail(attempt));

  if (engine === 'claude') {
    let output = '';
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      if (output.length > 64 * 1024) { fail(attempt); return; }
      for (const raw of output.match(/https:\/\/[^\s<>]+/g) || []) {
        const url = officialUrl(raw, engine);
        if (url && new URL(url).pathname.includes('authorize')) {
          attempt.view = { ...attempt.view, status: 'waiting', url };
          break;
        }
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('close', code => { if (code === 0) void complete(); else fail(attempt); });
  } else {
    let output = '';
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 64 * 1024) { fail(attempt); return; }
      let end: number;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.error) { fail(attempt, 'Codex sign-in could not start. Check that device-code sign-in is allowed in your ChatGPT security settings, then try again.'); continue; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/login/start', params: { type: 'chatgptDeviceCode' } })}\n`);
        }
        if (message.id === 2) {
          const url = officialUrl(message.result?.verificationUrl, engine);
          const code = message.result?.userCode;
          if (!url || typeof code !== 'string' || !/^[a-z0-9-]{4,32}$/i.test(code)) { fail(attempt); continue; }
          attempt.view = { ...attempt.view, status: 'waiting', url, userCode: code };
        }
        if (message.method === 'account/login/completed') {
          if (message.params?.success === true) void complete();
          else fail(attempt);
        }
      }
    });
    child.once('close', () => { if (!attempt.completing) fail(attempt); });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'tardis-login', version: '0.1.0' } } })}\n`);
  }
  // Polling owns the long OAuth wait. The HTTP request never waits on the user.
  return { ...attempt.view };
}
