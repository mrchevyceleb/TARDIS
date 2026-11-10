import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// claudeIdentity is proven against a stub `claude` binary on PATH: the panel
// must read a year-token profile as connected even though the CLI answers
// authMethod "oauth_token" with no email, and never fall back to "Sign-in
// needed" while the token itself authenticates. Env is set before the module
// under test is imported, so the import is dynamic.
const root = mkdtempSync(join(tmpdir(), 'tardis-accounts-test-'));
const home = join(root, 'home');
const mapPath = join(root, 'account-map.json');
writeFileSync(mapPath, JSON.stringify({ accounts: {}, default_account: '', rules: [] }));
const savedHome = process.env.HOME;
const savedMap = process.env.RIVENDELL_ACCOUNT_MAP;
process.env.HOME = home;
process.env.RIVENDELL_ACCOUNT_MAP = mapPath;

const bin = join(root, 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), '#!/bin/sh\ncat "$STATUS_JSON_FILE"\n');
chmodSync(join(bin, 'claude'), 0o755);

const { claudeIdentity } = await import('./cliAccounts.ts');
type LongLivedVerdict = import('./cliAccounts.ts').LongLivedVerdict;

const profile = join(home, '.claude-year');
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, '.long-lived-oauth-token'), 'year@example.com\nsk-ant-oat01-example-token-0123456789\n');

function stubStatus(json: unknown): NodeJS.ProcessEnv {
  writeFileSync(join(bin, 'status.json'), JSON.stringify(json));
  return { PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: profile, STATUS_JSON_FILE: join(bin, 'status.json') };
}

/** `auth status` says loggedIn for ANY token in env, so the provider probe is
 *  the only validity check; tests inject its verdict instead of the network. */
const verdict = (value: LongLivedVerdict) => async () => value;

test.after(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedMap === undefined) delete process.env.RIVENDELL_ACCOUNT_MAP; else process.env.RIVENDELL_ACCOUNT_MAP = savedMap;
  rmSync(root, { recursive: true, force: true });
});

test('a year-token profile reads as connected with the token account', async () => {
  // The saved account matches the token: identity carries org and plan too.
  writeFileSync(join(profile, '.claude.json'), JSON.stringify({ oauthAccount: {
    emailAddress: 'Year@Example.com', organizationUuid: 'org-1', organizationName: 'Acme', planDisplayName: 'Pro',
  } }));
  const identity = await claudeIdentity(stubStatus({ loggedIn: true, authMethod: 'oauth_token' }), verdict('valid'));
  assert.equal(identity.status, 'connected');
  assert.equal(identity.email, 'year@example.com');
  assert.equal(identity.organizationId, 'org-1');
  assert.equal(identity.plan, 'Pro');
});

test('a wiped year-token profile still reads as connected', async () => {
  // The wipe takes the .claude.json account with it; the token is the identity.
  writeFileSync(join(profile, '.claude.json'), JSON.stringify({}));
  const identity = await claudeIdentity(stubStatus({ loggedIn: true, authMethod: 'oauth_token' }), verdict('valid'));
  assert.equal(identity.status, 'connected');
  assert.equal(identity.email, 'year@example.com');
  assert.equal(identity.organizationId, undefined);
});

test('a rejected year token reads as signed out; network trouble does not', async () => {
  writeFileSync(join(profile, '.claude.json'), JSON.stringify({}));
  const status = stubStatus({ loggedIn: true, authMethod: 'oauth_token' });
  assert.equal((await claudeIdentity(status, verdict('invalid'))).status, 'signed_out', 'auth status alone says loggedIn for any token; the provider verdict decides');
  assert.equal((await claudeIdentity(status, verdict('unknown'))).status, 'connected', 'an unreachable provider must not condemn a good token');
  assert.equal((await claudeIdentity(stubStatus({ loggedIn: false }), verdict('valid'))).status, 'signed_out');
});

test('a foreign account is never dressed up as the token account', async () => {
  writeFileSync(join(profile, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'other@example.com', organizationUuid: 'org-2' } }));
  // A token whose profile is signed in as someone else never rides the
  // auth-status env, so even an oauth_token-shaped answer cannot name it.
  const stray = await claudeIdentity(stubStatus({ loggedIn: true, authMethod: 'oauth_token' }), verdict('valid'));
  assert.notEqual(stray.email, 'year@example.com');
  // The real CLI answers for the profile's own login instead.
  const native = await claudeIdentity(stubStatus({ loggedIn: true, authMethod: 'claude.ai', email: 'other@example.com' }), verdict('valid'));
  assert.equal(native.status, 'connected');
  assert.equal(native.email, 'other@example.com');
  assert.equal(native.organizationId, undefined, 'a foreign saved account never lends its organization');
});

test('profiles without a year token keep the native answer', async () => {
  const plain = join(home, '.claude-plain');
  writeFileSync(join(bin, 'status.json'), JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'native@example.com', orgName: 'Native Org', subscriptionType: 'Max' }));
  const identity = await claudeIdentity({ PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: plain, STATUS_JSON_FILE: join(bin, 'status.json') });
  assert.equal(identity.status, 'connected');
  assert.equal(identity.email, 'native@example.com');
  assert.equal(identity.plan, 'Max');
  assert.equal((await claudeIdentity({ ...stubStatus({ loggedIn: true, authMethod: 'api_key' }), CLAUDE_CONFIG_DIR: plain })).status, 'unsupported');
});
