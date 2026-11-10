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
writeFileSync(join(bin, 'claude'), `#!/bin/sh
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && grep -q '"authMethod":"oauth_token"' "$STATUS_JSON_FILE"; then
  printf '{"loggedIn":false}\\n'
else
  cat "$STATUS_JSON_FILE"
fi
`);
chmodSync(join(bin, 'claude'), 0o755);

const { claudeIdentity, probeLongLivedClaudeToken } = await import('./cliAccounts.ts');
const { subscriptionRoutingKey, withLongLivedClaudeToken, withVerifiedLongLivedClaudeToken } = await import('./cliProfiles.ts');
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
  const before = subscriptionRoutingKey('claude', status);
  assert.equal((await claudeIdentity(status, verdict('invalid'))).status, 'signed_out', 'auth status alone says loggedIn for any token; the provider verdict decides');
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'rejected tokens cannot override a native login on future lane spawns');
  assert.notEqual(subscriptionRoutingKey('claude', status), before, 'provider rejection retires workers holding the rejected token without a file change');
  assert.equal((await claudeIdentity(stubStatus({ loggedIn: true, authMethod: 'claude.ai', email: 'year@example.com' }), verdict('invalid'))).status, 'connected', 'a native login remains usable after token rejection');
  writeFileSync(join(profile, '.long-lived-oauth-token'), 'year@example.com\nsk-ant-oat01-replacement-token-0123456789\n');
  assert.equal((await claudeIdentity(stubStatus({ loggedIn: true, authMethod: 'oauth_token' }), verdict('unknown'))).status, 'unavailable', 'an unverified replacement is neither signed out nor proven connected');
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

test('only authentication evidence verifies a token, not arbitrary HTTP responses', async (t) => {
  const scopeError = { type: 'error', error: { type: 'permission_error', message: 'OAuth token does not meet scope requirement any_of(user:profile, user:office)' } };
  const rewordedScopeError = { type: 'error', error: { type: 'permission_error', message: 'This token is missing the required scope user:profile' } };
  const pluralScopeError = { type: 'error', error: { type: 'permission_error', message: 'Token lacks required scopes: user:office' } };
  const cases: Array<[number, unknown, LongLivedVerdict]> = [
    [200, {}, 'valid'], [401, {}, 'invalid'], [403, scopeError, 'valid'], [403, rewordedScopeError, 'valid'], [403, pluralScopeError, 'valid'],
    [403, { error: { type: 'permission_error', message: 'Account is disabled' } }, 'unknown'],
    [403, '<html>Forbidden</html>', 'unknown'], [429, {}, 'unknown'], [503, {}, 'unknown'], [302, {}, 'unknown'],
    [403, 'x'.repeat(9 * 1024), 'unknown'],
  ];
  for (const [index, [status, body, expected]] of cases.entries()) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async (...[url, options]: Parameters<typeof fetch>) => {
      assert.equal(url, 'https://api.anthropic.com/api/oauth/profile');
      assert.equal(options?.redirect, 'error');
      assert.match(new Headers(options?.headers).get('Authorization') ?? '', /^Bearer /);
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    });
    assert.equal(await probeLongLivedClaudeToken(`probe-case-${index}`), expected, `HTTP ${status}: ${JSON.stringify(body).slice(0, 100)}`);
    fetchMock.mock.restore();
  }
});

test('provider probes coalesce, recheck rejections after TTL, and preserve definitive verdicts during outages', async (t) => {
  const token = 'sk-ant-oat01-coalesced';
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let status = 200;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status }));
  assert.deepEqual(await Promise.all([probeLongLivedClaudeToken(token), probeLongLivedClaudeToken(token)]), ['valid', 'valid']);
  assert.equal(fetchMock.mock.callCount(), 1);
  clock += 11 * 60_000;
  status = 503;
  assert.equal(await probeLongLivedClaudeToken(token), 'valid', 'a previously verified token survives provider outages');
  assert.equal(await probeLongLivedClaudeToken('never-verified'), 'unknown', 'an outage never invents a first verification');
  const afterUnknown = fetchMock.mock.callCount();
  assert.equal(await probeLongLivedClaudeToken('never-verified'), 'unknown');
  assert.equal(fetchMock.mock.callCount(), afterUnknown, 'unknown probes back off instead of delaying every lane spawn');
  clock += 31_000;
  status = 401;
  assert.equal(await probeLongLivedClaudeToken(token), 'invalid', 'a revocation supersedes the old valid verdict');
  writeFileSync(join(profile, '.claude.json'), '{}');
  writeFileSync(join(profile, '.long-lived-oauth-token'), `year@example.com\n${token}\n`);
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  clock += 11 * 60_000;
  status = 200;
  assert.equal((await withVerifiedLongLivedClaudeToken({}, profile)).CLAUDE_CODE_OAUTH_TOKEN, token, 'a rejected token is rechecked after TTL instead of remaining stuck');
  clock += 11 * 60_000;
  status = 401;
  assert.equal(await probeLongLivedClaudeToken(token), 'invalid');
  clock += 11 * 60_000;
  fetchMock.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network unavailable'); });
  assert.equal(await probeLongLivedClaudeToken(token), 'invalid', 'network trouble never undoes a revocation');
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
