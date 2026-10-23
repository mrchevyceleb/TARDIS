import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const { claudeProfileInLanePool } = await import('./cliProfiles.ts');
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

test('an account in two pools fails closed instead of bridging them', () => {
  withPools('game|game,rally', () => {
    assert.equal(claudeProfileInLanePool(rallyDir, gameDir), false);
    assert.equal(claudeProfileInLanePool(otherDir, rallyDir), false);
  });
});

test('a broken pool config fails closed', () => {
  withPools('game|nope', () => {
    assert.equal(claudeProfileInLanePool(rallyDir, gameDir), false, 'a foreign profile is refused when pools cannot be read');
    assert.equal(claudeProfileInLanePool(gameDir, gameDir), true, "the lane's own resolved profile is never foreign to itself");
  });
});
