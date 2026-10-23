import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { UsageAccount } from '../lib/accountUsage.ts';

// Import after configuring an isolated office: no real roster, account
// choices, credential files or provider processes are touched by this test.
const dir = mkdtempSync(join(tmpdir(), 'tardis-provider-queue-'));
const previous = { ...process.env };
process.env.RIVENDELL_STATE_DIR = dir;
process.env.RIVENDELL_ACCOUNT_MAP = join(dir, 'accounts.json');
process.env.RIVENDELL_DEFAULT_CLI_ACCOUNT = '';
process.env.RIVENDELL_AGENT_ACCOUNTS = '';
const preferred = join(dir, 'preferred');
const backup = join(dir, 'backup');
mkdirSync(join(dir, 'personas'));
const agent = { id: 'worker', name: 'Worker', role: 'Developer', engine: 'claude', home: 'bot-worker', createdAt: 1 };
writeFileSync(join(dir, 'personas', 'agents.json'), JSON.stringify({ agents: [agent] }));
writeFileSync(process.env.RIVENDELL_ACCOUNT_MAP, JSON.stringify({
  default_account: 'preferred', rules: [],
  accounts: Object.fromEntries([['preferred', preferred], ['backup', backup]].map(([name, path]) =>
    [name, { claude_config_dir: relative(homedir(), path), codex_home: relative(homedir(), join(dir, 'codex')) }])),
}));
const { providerParkKeyForAgent, queuedRetryDelay } = await import('./teamBus.ts');
const { cliProfileId } = await import('../lib/cliProfiles.ts');
const { claudeAccountPool } = await import('../lib/claudeAccountPool.ts');
const { clearProviderParks, parkProviderAccount, providerParkKeyForProfile, PROVIDER_LIMIT_FALLBACK_PARK_MS } = await import('../lib/providerLimitAlert.ts');
after(() => {
  clearProviderParks();
  process.env = previous;
  rmSync(dir, { recursive: true, force: true });
});
const now = Date.UTC(2026, 9, 23, 13);
function reading(path: string, used: number) {
  const id = cliProfileId('claude', path);
  const usage: UsageAccount = {
    id, provider: 'Claude', name: 'Test account', kind: 'subscription', status: 'live',
    checkedAt: new Date(now).toISOString(), attemptedAt: new Date(now).toISOString(),
    windows: [{ id: 'session', label: 'Session', used, limit: 100, remaining: 100 - used, unit: 'percent', resetsAt: new Date(now + 3_600_000).toISOString() }],
    amounts: [], agents: [], note: '', source: '', href: '',
  };
  return { profileIds: [id], usage };
}
const peer: Parameters<typeof queuedRetryDelay>[1][number] = {
  id: 'pending', fromId: 'lead', fromName: 'Lead', toId: 'worker', text: 'A pending task', hop: 1,
};

test('parked queues recheck routing without hammering and person messages keep their fast wake', t => {
  t.mock.method(Date, 'now', () => now);
  clearProviderParks();
  claudeAccountPool.update([reading(preferred, 100), reading(backup, 100)]);
  assert.equal(providerParkKeyForAgent(agent), providerParkKeyForProfile(preferred));
  parkProviderAccount(providerParkKeyForProfile(preferred), '10:00 AM (America/New_York)', now);
  assert.equal(queuedRetryDelay('worker', [peer]), PROVIDER_LIMIT_FALLBACK_PARK_MS);
  assert.equal(queuedRetryDelay('worker', [{ ...peer, fromRole: 'desk' }]), 15_000);
});

test('a healthy account redirect bypasses only the failed profile park and restores the saved choice at reset', t => {
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  clearProviderParks();
  claudeAccountPool.update([reading(preferred, 100), reading(backup, 10)]);
  parkProviderAccount(providerParkKeyForProfile(preferred), '10:00 AM (America/New_York)', now);
  assert.equal(providerParkKeyForAgent(agent), providerParkKeyForProfile(backup));
  assert.equal(queuedRetryDelay('worker', [peer]), 15_000);
  clock = now + 3_600_000 + 60_001;
  assert.equal(providerParkKeyForAgent(agent), providerParkKeyForProfile(preferred));
  assert.equal(queuedRetryDelay('worker', [peer]), 15_000);
});
