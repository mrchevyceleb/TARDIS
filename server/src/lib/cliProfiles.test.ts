import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The pool check reads the operator's account map; point it at a synthetic
// one so the test never touches real credentials. Env must be set before the
// module under test is imported, so the import is dynamic.
const root = mkdtempSync(join(tmpdir(), 'tardis-pool-test-'));
const home = join(root, 'home');
const mapPath = join(root, 'account-map.json');
writeFileSync(mapPath, JSON.stringify({
  accounts: {
    game: { claude_config_dir: '.claude-game', codex_home: '.codex' },
    rally: { claude_config_dir: '.claude-rally', codex_home: '.codex' },
    other: { claude_config_dir: '.claude-other', codex_home: '.codex' },
  },
  default_account: 'rally',
  rules: [],
}));

const saved = {
  map: process.env.RIVENDELL_ACCOUNT_MAP,
  pools: process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS,
  home: process.env.HOME,
};
process.env.RIVENDELL_ACCOUNT_MAP = mapPath;
process.env.HOME = home;

const { claudeProfileInLanePool, longLivedClaudeToken, recordLongLivedTokenVerdict, subscriptionRoutingKey, subscriptionRoutingKeysMatch, withLongLivedClaudeToken, withVerifiedLongLivedClaudeToken } = await import('./cliProfiles.ts');
const gameDir = join(home, '.claude-game');
const rallyDir = join(home, '.claude-rally');
const otherDir = join(home, '.claude-other');

function withPools(value: string | undefined, fn: () => void): void {
  if (value === undefined) delete process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS;
  else process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS = value;
  try { fn(); } finally {
    if (saved.pools === undefined) delete process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS;
    else process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS = saved.pools;
  }
}

test.after(() => {
  if (saved.map === undefined) delete process.env.RIVENDELL_ACCOUNT_MAP; else process.env.RIVENDELL_ACCOUNT_MAP = saved.map;
  if (saved.pools === undefined) delete process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS; else process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS = saved.pools;
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  rmSync(root, { recursive: true, force: true });
});

test('a profile from another pool is refused for detached work', () => {
  withPools('game|rally', () => {
    assert.equal(claudeProfileInLanePool(rallyDir, gameDir), false, 'Rally profile must not bill a game lane');
    assert.equal(claudeProfileInLanePool(gameDir, rallyDir), false, 'game profile must not bill a Rally lane');
    assert.equal(claudeProfileInLanePool(gameDir, gameDir), true, 'own pool is fine');
    assert.equal(claudeProfileInLanePool(otherDir, gameDir), false, 'unpooled profile must not bill a pooled lane');
    assert.equal(claudeProfileInLanePool(otherDir, otherDir), true, 'unpooled lane may use an unpooled profile');
    assert.equal(claudeProfileInLanePool(rallyDir, otherDir), false, 'pooled profile must not bill an unpooled lane');
  });
});

test('no pool config means no pool restriction', () => {
  withPools(undefined, () => {
    assert.equal(claudeProfileInLanePool(rallyDir, gameDir), true);
  });
});

test('a shared backup stays with the pool where it comes first', () => {
  withPools('game,other,rally|rally', () => {
    assert.equal(claudeProfileInLanePool(rallyDir, gameDir), true, 'a game lane may borrow the shared backup');
    assert.equal(claudeProfileInLanePool(otherDir, gameDir), true);
    assert.equal(claudeProfileInLanePool(gameDir, rallyDir), false, 'a Rally lane never borrows the game login');
    assert.equal(claudeProfileInLanePool(otherDir, rallyDir), false);
  });
});

test('a broken pool config fails closed', () => {
  withPools('game|nope', () => {
    assert.equal(claudeProfileInLanePool(rallyDir, gameDir), false, 'a foreign profile is refused when pools cannot be read');
    assert.equal(claudeProfileInLanePool(gameDir, gameDir), true, "the lane's own resolved profile is never foreign to itself");
  });
});

test('a year token rides lane environments, and the wipe it survives', async () => {
  const profile = join(root, 'token-profile');
  mkdirSync(profile, { recursive: true });
  const writeToken = (email: string, token: string) => writeFileSync(join(profile, '.long-lived-oauth-token'), `${email}\n${token}\n`);
  const writeAccount = (email?: string) => writeFileSync(join(profile, '.claude.json'), JSON.stringify(email ? { oauthAccount: { emailAddress: email, organizationUuid: 'org-1', organizationName: 'Acme', planDisplayName: 'Pro' } } : {}));
  const good = 'sk-ant-oat01-example-token-0123456789';

  // No token file: nothing applies, and an inherited token never leaks in.
  writeAccount('someone@example.com');
  assert.equal(longLivedClaudeToken(profile), null);
  assert.equal(withLongLivedClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: 'inherited' }, profile).CLAUDE_CODE_OAUTH_TOKEN, undefined);

  // Malformed tokens and headerless emails never apply.
  writeToken('not-an-email', good);
  assert.equal(longLivedClaudeToken(profile), null);
  writeToken('a@example.com', 'sk-ant-wrongprefix');
  assert.equal(longLivedClaudeToken(profile), null);
  writeToken('a@example.com', '');
  assert.equal(longLivedClaudeToken(profile), null);

  // A matching signed-in account (case-insensitive) and a wiped profile
  // (no account at all) both ride the token; only a different signed-in
  // account keeps it out so a re-login never bills the old one.
  writeToken('A@Example.com', good);
  writeAccount('a@example.com');
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'token presence alone never overrides a native login');
  assert.equal((await withVerifiedLongLivedClaudeToken({}, profile, async () => 'unknown')).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'an initial outage does not invent authentication');
  assert.equal((await withVerifiedLongLivedClaudeToken({}, profile, async () => 'valid')).CLAUDE_CODE_OAUTH_TOKEN, good);
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, good);
  writeAccount(undefined);
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, good, 'a wiped profile authenticates on its year token');
  writeAccount('someone-else@example.com');
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'a different signed-in account never bills the token account');

  // An UNREADABLE account state is not a wiped one: only a confirmed absent
  // account file (ENOENT) leaves the token as the identity. A malformed or
  // permission-denied .claude.json must refuse the token, so a profile that
  // quietly signed in as someone else can never keep billing the old account.
  rmSync(join(profile, '.claude.json'));
  writeAccount('someone-else@example.com');
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  rmSync(join(profile, '.claude.json'));
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, good, 'a confirmed missing account file leaves the token in charge');
  for (const raw of ['{"oauthAccount":{"emailAddress":"a@example.com"', 'null', '[]', 'false', '{"oauthAccount":42}', '{"oauthAccount":{"emailAddress":42}}']) {
    writeFileSync(join(profile, '.claude.json'), raw);
    assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'a malformed account file never authorizes the token');
  }
  writeAccount(undefined);
  chmodSync(join(profile, '.claude.json'), 0o000);
  try {
    assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'an unreadable account file never authorizes the token');
  } finally {
    chmodSync(join(profile, '.claude.json'), 0o644);
  }
});

test('a year-token swap retires the warm-worker routing key', () => {
  const profile = join(root, 'routing-profile');
  mkdirSync(profile, { recursive: true });
  recordLongLivedTokenVerdict('sk-ant-oat01-example-token-0123456789', 'valid');
  recordLongLivedTokenVerdict('sk-ant-oat01-example-token-9876543210', 'valid');
  const writeToken = (email: string, token: string) => writeFileSync(join(profile, '.long-lived-oauth-token'), `${email}\n${token}\n`);
  // Wiped profile, no normal credentials: the token file is the identity.
  writeToken('a@example.com', 'sk-ant-oat01-example-token-0123456789');
  const first = subscriptionRoutingKey('claude', { CLAUDE_CONFIG_DIR: profile });
  const preservedTime = new Date(1_600_000_000_000);
  writeToken('b@example.com', 'sk-ant-oat01-example-token-0123456789');
  utimesSync(join(profile, '.long-lived-oauth-token'), preservedTime, preservedTime);
  const second = subscriptionRoutingKey('claude', { CLAUDE_CONFIG_DIR: profile });
  assert.notEqual(first, second, 'a token swap must recycle warm workers still billing the old account');
  // Same email, replaced token (a revoked one renewed): the token's own
  // fingerprint rides the identity, so warm workers drop the dead token.
  writeToken('b@example.com', 'sk-ant-oat01-example-token-9876543210');
  utimesSync(join(profile, '.long-lived-oauth-token'), preservedTime, preservedTime);
  const third = subscriptionRoutingKey('claude', { CLAUDE_CONFIG_DIR: profile });
  assert.notEqual(second, third, 'a same-size token replacement with its timestamp preserved must recycle warm workers');
  assert.equal(subscriptionRoutingKey('claude', { CLAUDE_CONFIG_DIR: profile }), third, 'the key is stable between changes');
  // Confirmed absence is a real sign-out, never a stale token identity, and
  // it must not wildcard-match the worker still holding the old token.
  rmSync(join(profile, '.long-lived-oauth-token'));
  const gone = subscriptionRoutingKey('claude', { CLAUDE_CONFIG_DIR: profile });
  assert.equal(gone.endsWith(':signed-out'), true);
  assert.equal(subscriptionRoutingKeysMatch(third, gone), false, 'removing the token retires warm workers holding it');
  assert.equal(subscriptionRoutingKeysMatch(gone, gone), true);
  const unknown = `${gone.slice(0, gone.lastIndexOf(':'))}:not-signed-in`;
  assert.equal(subscriptionRoutingKeysMatch(unknown, gone), false, 'unknown identity cannot wildcard-match confirmed sign-out');
  assert.equal(subscriptionRoutingKeysMatch(gone, unknown), false, 'confirmed sign-out cannot wildcard-match unknown identity');

  // The same rules hold while a saved account exists: lanes bill the token,
  // so swapping it must change the key there too.
  const saved = join(profile, '.claude.json');
  writeFileSync(saved, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com', organizationUuid: 'org-9' } }));
  writeToken('b@example.com', 'sk-ant-oat01-example-token-0123456789');
  const withAccount = subscriptionRoutingKey('claude', { CLAUDE_CONFIG_DIR: profile });
  writeToken('b@example.com', 'sk-ant-oat01-example-token-9876543210');
  const replaced = subscriptionRoutingKey('claude', { CLAUDE_CONFIG_DIR: profile });
  assert.notEqual(withAccount, replaced, 'a token swap beside a saved account must recycle warm workers');
  const token = longLivedClaudeToken(profile)!;
  recordLongLivedTokenVerdict(token.token, 'invalid');
  assert.notEqual(replaced, subscriptionRoutingKey('claude', { CLAUDE_CONFIG_DIR: profile }), 'rejection changes routing even beside an intact native account');
  recordLongLivedTokenVerdict(token.token, 'unknown');
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'an outage never clears a rejection');
  recordLongLivedTokenVerdict(token.token, 'valid');
  assert.equal(withLongLivedClaudeToken({}, profile).CLAUDE_CODE_OAUTH_TOKEN, token.token);
});

test('routing preserves a healthy worker through transient reads but recycles on a real re-login', () => {
  const profile = join(root, 'transient-routing');
  const env = { CLAUDE_CONFIG_DIR: profile };
  mkdirSync(profile, { recursive: true });
  const saved = join(profile, '.claude.json');
  const writeAccount = (email: string) => writeFileSync(saved, JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: 'org-1' } }));
  const preservedTime = new Date(1_600_000_000_000);
  writeAccount('first@example.com');
  utimesSync(saved, preservedTime, preservedTime);
  const original = subscriptionRoutingKey('claude', env);
  writeFileSync(saved, '{"oauthAccount":');
  assert.equal(subscriptionRoutingKey('claude', env), original, 'a torn account file is not a confirmed sign-out');
  rmSync(saved);
  mkdirSync(saved);
  assert.equal(subscriptionRoutingKey('claude', env), original, 'a read error is not a confirmed sign-out');
  rmSync(saved, { recursive: true });
  assert.equal(subscriptionRoutingKeysMatch(original, subscriptionRoutingKey('claude', env)), false, 'confirmed absence retires the old worker');
  writeAccount('other@example.com');
  utimesSync(saved, preservedTime, preservedTime);
  const changed = subscriptionRoutingKey('claude', env);
  assert.notEqual(changed, original);
  assert.equal(subscriptionRoutingKeysMatch(original, changed), false, 'a different login retires the old worker');
  assert.equal(subscriptionRoutingKeysMatch(`${changed.split(':')[0]}:not-signed-in`, changed), true, 'unknown identity still borrows the known identity');
});
