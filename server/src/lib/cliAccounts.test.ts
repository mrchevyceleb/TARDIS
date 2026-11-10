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

const profile = join(home, '.claude-year');
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, '.long-lived-oauth-token'), 'year@example.com\nsk-ant-oat01-example-token-0123456789\n');

function stubStatus(json: unknown): NodeJS.ProcessEnv {
  writeFileSync(join(bin, 'status.json'), JSON.stringify(json));
  return { PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: profile, STATUS_JSON_FILE: join(bin, 'status.json') };
}

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
  const identity = await claudeIdentity(stubStatus({ loggedIn: true, authMethod: 'oauth_token' }));
  assert.equal(identity.status, 'connected');
  assert.equal(identity.email, 'year@example.com');
  assert.equal(identity.organizationId, 'org-1');
  assert.equal(identity.plan, 'Pro');
});

test('a wiped year-token profile still reads as connected', async () => {
  // The wipe takes the .claude.json account with it; the token is the identity.
  writeFileSync(join(profile, '.claude.json'), JSON.stringify({}));
  const identity = await claudeIdentity(stubStatus({ loggedIn: true, authMethod: 'oauth_token' }));
  assert.equal(identity.status, 'connected');
  assert.equal(identity.email, 'year@example.com');
  assert.equal(identity.organizationId, undefined);
});

test('a dead year token is a real sign-out, and a foreign account is ignored', async () => {
  writeFileSync(join(profile, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'other@example.com', organizationUuid: 'org-2' } }));
  assert.equal((await claudeIdentity(stubStatus({ loggedIn: false }))).status, 'signed_out');
  // The token authenticates, but the profile is signed in as someone else:
  // the saved account must not dress up the token's identity.
  const foreign = await claudeIdentity(stubStatus({ loggedIn: true, authMethod: 'oauth_token' }));
  assert.equal(foreign.status, 'connected');
  assert.equal(foreign.email, 'year@example.com');
  assert.equal(foreign.organizationId, undefined, 'a foreign saved account never lends its organization');
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
