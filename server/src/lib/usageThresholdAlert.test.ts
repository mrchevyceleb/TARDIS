// A usage alert names the limit it is about. An account at 61% of its
// all-models week and 92% of its Fable-only week once got "is at 92% usage",
// and the provider's page showed 61% first, so the alert looked wrong.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { UsageAccount, UsageWindow } from './accountUsage.ts';

process.env.RIVENDELL_STATE_DIR = mkdtempSync(join(tmpdir(), 'usage-alert-'));
const { alertText } = await import('./usageThresholdAlert.ts');

const used = (id: string, label: string, percent: number): UsageWindow =>
  ({ id, label, used: percent, limit: 100, remaining: 100 - percent, unit: 'percent', resetsAt: '2026-11-19T14:00:00.000Z' });

test('the alert says which limit is nearly full and for which account, as the provider page puts it', () => {
  // What the Claude usage feed reports for that account, as accountUsage.ts labels it.
  const account: UsageAccount = {
    id: 'claude-1', provider: 'Claude', name: 'Claude subscription', email: 'sam@example.com', plan: 'max', kind: 'subscription',
    status: 'live', checkedAt: null, attemptedAt: '2026-11-12T18:00:00.000Z', amounts: [], agents: [], note: '', source: '', href: '',
    windows: [used('0', 'Session', 12), used('1', 'All models · week', 61), used('2', 'Fable · week', 92)],
  };
  const fable = alertText(account, account.windows[2]!, 92);
  assert.equal(fable.title, 'Fable-only weekly limit 92% used · Claude sam@example.com');
  assert.equal(fable.detail, 'Claude sam@example.com (max plan) has used 92% of its Fable-only weekly limit. It resets Nov 19, 9:00 AM ET. '
    + 'Right now its all-models weekly limit is 61% used. Open Usage to decide what to do before it fills up.');
  // The other way round names the other limit, and never the short session.
  account.windows = [used('0', 'Session', 12), used('1', 'All models · week', 92), used('2', 'Fable · week', 61)];
  const all = alertText(account, account.windows[1]!, 92);
  assert.equal(all.title, 'All-models weekly limit 92% used · Claude sam@example.com');
  assert.match(all.detail, /Right now its Fable-only weekly limit is 61% used\. Open/);
});
