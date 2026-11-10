import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Exercise the public account/usage pipeline with synthetic profiles, a stub
// CLI and intercepted HTTP. No real logins, provider calls or renewal turns.
const root = mkdtempSync(join(tmpdir(), 'tardis-usage-test-'));
const home = join(root, 'home');
const bin = join(root, 'bin');
mkdirSync(bin, { recursive: true });
const saved = { ...process.env };
process.env.HOME = home;
process.env.RIVENDELL_STATE_DIR = join(root, 'state');
process.env.RIVENDELL_ACCOUNT_MAP = join(root, 'accounts.json');
process.env.RIVENDELL_CODEX_BIN = join(bin, 'no-codex');
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-token-must-not-reach-renewal';
writeFileSync(process.env.RIVENDELL_ACCOUNT_MAP, JSON.stringify({
  accounts: Object.fromEntries(['first', 'peer', 'wiped'].map(name => [name, { claude_config_dir: `.claude-${name}`, codex_home: '.codex' }])),
  default_account: 'first', rules: [],
}));
writeFileSync(join(bin, 'claude'), `#!/bin/sh
if [ "$1" = auth ]; then
  printf '{"loggedIn":true,"authMethod":"oauth_token"}\\n'
else
  printf '%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" >> "$CLAUDE_CONFIG_DIR/renewals"
fi
`);
chmodSync(join(bin, 'claude'), 0o755);
const dirs = Object.fromEntries(['first', 'peer', 'wiped'].map(name => [name, join(home, `.claude-${name}`)]));
for (const [name, dir] of Object.entries(dirs)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.long-lived-oauth-token'), 'year@example.com\nsk-ant-oat01-usage-test-token\n');
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(name === 'wiped' ? {} : { oauthAccount: { emailAddress: 'year@example.com', organizationUuid: 'org-1', planDisplayName: 'Pro' } }));
}
const { refreshClaudeAccountUsage } = await import('./accountUsage.ts');
const { listCliAccounts } = await import('./cliAccounts.ts');

test.after(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

test('merged token accounts use healthy normal credentials and renew only that login', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let usageCalls = 0;
  let usageStatus = 200;
  t.mock.method(globalThis, 'fetch', async (...[url, options]: Parameters<typeof fetch>) => {
    if (url === 'https://api.anthropic.com/api/oauth/profile') return new Response('{}');
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer normal-pass', 'usage must never submit the year token');
    usageCalls++;
    return Response.json({ five_hour: { utilization: 12, resets_at: new Date(clock + 3_600_000).toISOString() } }, { status: usageStatus });
  });
  const credentials = join(dirs.peer!, '.credentials.json');
  const writeCredentials = (value: unknown) => writeFileSync(credentials, JSON.stringify({ claudeAiOauth: value }));
  const refresh = () => { clock += 61_000; return refreshClaudeAccountUsage(); };
  writeCredentials({ accessToken: 'normal-pass', expiresAt: clock + 3_600_000 });

  const accounts = (await listCliAccounts()).filter(item => item.engine === 'claude');
  assert.equal(accounts.length, 1, 'a wiped same-email profile folds into its unambiguous organization');
  assert.equal(accounts[0]!.profileIds.length, 3);
  for (const field of ['organizationId', 'tokenId', 'tokenIds']) assert.equal(field in accounts[0]!, false, 'internal grouping metadata stays private');
  assert.equal((await refresh())[0]!.status, 'live', 'a missing representative credential file falls back to its healthy peer');
  writeFileSync(join(dirs.first!, '.credentials.json'), '{torn');
  assert.equal((await refresh())[0]!.status, 'live', 'a torn representative also falls back');
  usageStatus = 403;
  const forbidden = (await refresh())[0]!;
  assert.equal(forbidden.status, 'stale');
  assert.doesNotMatch(forbidden.note, /Lanes keep running/, 'a provider 403 is not proof that the separate login was removed');
  usageStatus = 200;
  writeFileSync(join(dirs.first!, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'nearly-expired-pass', expiresAt: clock + 61_001 } }));
  assert.equal((await refresh())[0]!.status, 'live', 'a safely valid peer outranks a token with one millisecond left');
  writeFileSync(join(dirs.first!, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'expired-pass', expiresAt: clock - 1 } }));
  assert.equal((await refresh())[0]!.status, 'live', 'a fresh peer outranks an expired representative');
  writeFileSync(join(dirs.first!, '.credentials.json'), '{torn');
  writeFileSync(credentials, '{torn');
  const unreadable = (await refresh())[0]!;
  assert.equal(unreadable.status, 'stale');
  assert.doesNotMatch(unreadable.note, /Lanes keep running/, 'a torn credential read stays unknown instead of claiming the sign-in was removed');
  rmSync(join(dirs.first!, '.credentials.json'));
  rmSync(credentials);
  const callsBeforeWipe = usageCalls;
  const wiped = (await refresh())[0]!;
  assert.equal(wiped.status, 'stale');
  assert.equal(wiped.windows[0]!.used, 12, 'a wipe preserves honest last-reported quota');
  assert.match(wiped.note, /Lanes keep running.*year token/);
  assert.match(wiped.note, /only usage reporting needs a fresh sign-in/);
  assert.equal(usageCalls, callsBeforeWipe, 'no normal pass means no usage request with the year token');
  assert.equal(Object.values(dirs).some(dir => existsSync(join(dir, 'renewals'))), false, 'no refresh token means no futile renewal');

  // Even if expiresAt is in the future, an empty access token needs renewal.
  // A renewable peer outranks an expired representative without a refresh.
  writeFileSync(join(dirs.first!, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'expired-pass', expiresAt: clock - 1 } }));
  writeCredentials({ accessToken: '', refreshToken: 'normal-refresh', expiresAt: clock + 3_600_000 });
  assert.equal((await refresh())[0]!.status, 'stale');
  const renewalFile = join(dirs.peer!, 'renewals');
  for (let attempt = 0; attempt < 100 && !existsSync(renewalFile); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(readFileSync(renewalFile, 'utf8').trim(), 'unset', 'renewal must use normal refresh credentials, never an inherited or profile year token');
  await refresh();
  assert.equal(readFileSync(renewalFile, 'utf8').trim(), 'unset', 'the renewal cooldown prevents concurrent refreshes');
});

test('organization-less profiles only fold with same-token proof and an unambiguous organization', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const tokenPath = join(dirs.wiped!, '.long-lived-oauth-token');
  writeFileSync(tokenPath, 'year@example.com\nsk-ant-oat01-different-organization-token\n');
  const distinct = (await listCliAccounts(true)).filter(item => item.engine === 'claude');
  assert.equal(distinct.length, 2, 'a different token with the same email cannot borrow an organization');
  writeFileSync(tokenPath, 'year@example.com\nsk-ant-oat01-usage-test-token\n');
  writeFileSync(join(dirs.peer!, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'year@example.com', organizationUuid: 'org-2' } }));
  const accounts = (await listCliAccounts(true)).filter(item => item.engine === 'claude');
  assert.equal(accounts.length, 3);
  assert.ok(accounts.every(item => item.status === 'connected' && item.profileIds.length === 1));
  for (const dir of Object.values(dirs)) writeFileSync(join(dir, '.claude.json'), '{}');
  assert.equal((await listCliAccounts(true)).filter(item => item.engine === 'claude').length, 3, 'email without organization proof never groups profiles');
});
