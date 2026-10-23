import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeAccountPool, resetTimestamp } from './claudeAccountPool.ts';
import type { UsageAccount } from './accountUsage.ts';
import { clearAllClaudeAccountsFullAlert, noteProviderUsageLimit } from './providerLimitAlert.ts';

const now = Date.parse('2026-10-23T13:00:00Z');
function reading(id: string, session: number, weekly = 0) {
  const usage: UsageAccount = {
    id, provider: 'Claude', name: 'Subscription', kind: 'subscription', status: 'live',
    checkedAt: new Date(now).toISOString(), attemptedAt: new Date(now).toISOString(),
    windows: [
      { id: 'session', label: 'Session', used: session, limit: 100, remaining: 100 - session, unit: 'percent', resetsAt: '2026-10-23T14:00:00Z' },
      { id: 'week', label: 'All models · week', used: weekly, limit: 100, remaining: 100 - weekly, unit: 'percent', resetsAt: '2026-10-27T13:00:00Z' },
    ], amounts: [], agents: [], note: '', source: '', href: '',
  };
  return { profileIds: [id], usage };
}

test('full accounts and duplicate logins are skipped for every lane; preferences return at reset', () => {
  const pool = new ClaudeAccountPool();
  const full = reading('preferred', 100);
  full.profileIds.push('duplicate');
  pool.update([full, reading('weekly', 0, 100), reading('backup', 0)]);
  const ids = ['preferred', 'duplicate', 'weekly', 'backup'];
  assert.equal(pool.select('preferred', ids, now), 'backup');
  assert.equal(pool.select('duplicate', ids, now), 'backup');
  assert.equal(pool.select('weekly', ids, now), 'backup');
  assert.equal(pool.select('preferred', ids, Date.parse('2026-10-23T14:00:00Z')), 'preferred');
  assert.equal(pool.select('weekly', ids, Date.parse('2026-10-23T14:00:00Z')), 'backup');
});

test('a CLI rejection overrides a lagging feed and retries cannot slide its reset forward', () => {
  const pool = new ClaudeAccountPool();
  const first = reading('preferred', 10);
  first.profileIds.push('duplicate');
  pool.update([first, reading('backup', 0)]);
  pool.reject('duplicate', { message: 'full', usageLimit: true, limitKind: 'session', resetTime: '10:00 AM (America/New_York)' }, now);
  pool.update([first, reading('backup', 0)]);
  assert.equal(pool.select('preferred', ['preferred', 'backup'], now), 'backup');
  pool.reject('preferred', { message: 'full', usageLimit: true, limitKind: 'session' }, now + 30_000);
  assert.equal(pool.isLimited('duplicate', Date.parse('2026-10-23T14:00:00Z') - 1), true);
  assert.equal(pool.select('preferred', ['preferred', 'backup'], Date.parse('2026-10-23T14:00:00Z')), 'preferred');
});

test('all-full or signed-out alternatives cannot cause an account retry loop', () => {
  const pool = new ClaudeAccountPool();
  const stale = reading('stale', 0); stale.usage.status = 'stale';
  const signedOut = reading('out', 0); signedOut.usage.status = 'unavailable';
  pool.update([reading('first', 100), reading('second', 0, 100), signedOut]);
  const ids = ['first', 'second', 'stale', 'out'];
  assert.equal(pool.select('first', ids, now), 'first');
  assert.equal(pool.isLimited('first', now), true);
  assert.equal(pool.select('second', ids, now), 'second');
  pool.update([reading('first', 100), reading('second', 0, 100), stale, signedOut]);
  assert.equal(pool.select('first', ids, now), 'stale', 'last reported room is safer than a known-full account');
  assert.equal(pool.select('first', ids, now + 5 * 60_000), 'stale', 'keep the working redirect through a slow refresh');
  pool.reject('first', { message: 'full', usageLimit: true, limitKind: 'monthly' }, now);
  assert.equal(pool.isLimited('first', Date.parse('2026-10-31T23:59:59Z')), true);
  assert.equal(pool.isLimited('first', Date.parse('2026-11-01T00:00:00Z')), false);
});

test('native clocks use the provider timezone, including dated weekly resets and year rollover', () => {
  assert.equal(resetTimestamp('10:00 AM (America/New_York)', now), Date.parse('2026-10-23T14:00:00Z'));
  assert.equal(resetTimestamp('Oct 27, 5:00 PM (America/New_York)', now), Date.parse('2026-10-27T21:00:00Z'));
  assert.equal(resetTimestamp('Jan 1, 1:00 AM (UTC)', Date.parse('2026-12-31T23:00:00Z')), Date.parse('2027-01-01T01:00:00Z'));
  assert.equal(resetTimestamp('unsafe reset', now), undefined);
});

test('rejections survive late identity grouping and a longer limit extends the block', () => {
  const pool = new ClaudeAccountPool();
  pool.reject('alias', { message: 'full', usageLimit: true, limitKind: 'session' }, now);
  const account = reading('preferred', 10); account.profileIds.push('alias');
  pool.update([account, reading('backup', 0)]);
  assert.equal(pool.select('preferred', ['preferred', 'backup'], now), 'backup');
  pool.reject('preferred', { message: 'full', usageLimit: true, limitKind: 'monthly' }, now + 1);
  pool.reject('alias', { message: 'full', usageLimit: true, limitKind: 'usage' }, now + 2);
  pool.update([account, reading('backup', 0)]);
  assert.equal(pool.isLimited('alias', Date.parse('2026-10-31T23:59:59Z')), true);
  assert.equal(pool.isLimited('alias', Date.parse('2026-11-01T00:00:00Z')), false);
});

test('a refreshed full window replaces a conservative fallback with its actual reset', () => {
  const pool = new ClaudeAccountPool();
  pool.reject('preferred', { message: 'full', usageLimit: true, limitKind: 'session' }, now);
  pool.update([reading('preferred', 100), reading('backup', 0)]);
  assert.equal(pool.isLimited('preferred', Date.parse('2026-10-23T14:00:00Z') - 1), true);
  assert.equal(pool.isLimited('preferred', Date.parse('2026-10-23T14:00:00Z')), false);
});

test('a fresh live reading with room clears an inferred rejection block', () => {
  const pool = new ClaudeAccountPool();
  pool.update([reading('preferred', 10), reading('backup', 0)]);
  pool.reject('preferred', { message: 'full', usageLimit: true, limitKind: 'usage' }, now);
  const lagging = reading('preferred', 10);
  lagging.usage.checkedAt = new Date(now + 60_000).toISOString();
  pool.update([lagging, reading('backup', 0)]);
  assert.equal(pool.isLimited('preferred', now + 60_000), true, 'a lagging feed must not erase the CLI rejection');
  const recovered = reading('preferred', 10);
  recovered.usage.checkedAt = new Date(now + 6 * 60_000).toISOString();
  pool.update([recovered, reading('backup', 0)]);
  assert.equal(pool.isLimited('preferred', now + 6 * 60_000), false);
  assert.equal(pool.select('preferred', ['preferred', 'backup'], now + 6 * 60_000), 'preferred');

  const monthly = new ClaudeAccountPool();
  monthly.update([reading('monthly', 10), reading('backup', 0)]);
  monthly.reject('monthly', { message: 'spend limit', usageLimit: true, limitKind: 'monthly' }, now);
  const monthlyRoom = reading('monthly', 0);
  monthlyRoom.usage.checkedAt = new Date(now + 24 * 60 * 60_000).toISOString();
  monthly.update([monthlyRoom, reading('backup', 0)]);
  assert.equal(monthly.isLimited('monthly', now + 24 * 60 * 60_000), true, 'usage windows cannot clear a monthly spend block');
});

test('inactive windows never block, extend a block, or skew account pressure', () => {
  const pool = new ClaudeAccountPool();
  const inactiveOnly = reading('inactive-only', 100);
  inactiveOnly.usage.windows.forEach(window => { window.active = false; });
  pool.update([inactiveOnly, reading('other', 0)]);
  assert.equal(pool.isLimited('inactive-only', now), false);
  assert.equal(pool.select('inactive-only', ['inactive-only', 'other'], now), 'inactive-only');
  const full = reading('full', 100);
  pool.update([full, inactiveOnly, reading('other', 20)]);
  assert.equal(pool.select('full', ['full', 'inactive-only', 'other'], now), 'other', 'inactive-only readings are not zero-pressure alternatives');

  const preferred = reading('preferred', 100);
  const low = reading('low', 10);
  low.usage.windows.push({ id: 'retired', label: 'Retired window', used: 100, limit: 100, remaining: 0, unit: 'percent', resetsAt: '2027-10-23T14:00:00Z', active: false });
  const higher = reading('higher', 20);
  pool.update([preferred, low, higher]);
  assert.equal(pool.select('preferred', ['preferred', 'low', 'higher'], now), 'low');

  const rejected = new ClaudeAccountPool();
  const stale = reading('stale', 100);
  stale.usage.windows.forEach(window => { window.active = false; window.resetsAt = '2027-10-23T14:00:00Z'; });
  rejected.update([stale, reading('backup', 0)]);
  rejected.reject('stale', { message: 'full', usageLimit: true, limitKind: 'session' }, now);
  rejected.update([stale, reading('backup', 0)]);
  assert.equal(rejected.isLimited('stale', now + 5 * 3_600_000 - 1), true);
  assert.equal(rejected.isLimited('stale', now + 5 * 3_600_000), false, 'inactive reset must not extend the inferred block');
});

test('all-full alerts are once per outage across accounts and windows, then re-arm after recovery', async () => {
  clearAllClaudeAccountsFullAlert();
  const messages: string[] = [];
  const send = async (text: string) => { messages.push(text); return { delivered: true }; };
  noteProviderUsageLimit('first', 'One', { message: 'full', usageLimit: true, limitKind: 'session' }, send, now);
  noteProviderUsageLimit('second', 'Two', { message: 'full', usageLimit: true, limitKind: 'weekly' }, send, now);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /All signed-in Claude accounts/);
  clearAllClaudeAccountsFullAlert();
  noteProviderUsageLimit('first', 'One', { message: 'full', usageLimit: true }, send, now + 1, 'backup');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(messages[1], /Moved One and every other lane using it to another signed-in account with room/);
  noteProviderUsageLimit('first', 'One', { message: 'full', usageLimit: true }, send, now + 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 3);
  clearAllClaudeAccountsFullAlert();
});
