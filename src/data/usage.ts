import { apiJson } from './api';

export type UsageWindow = {
  id: string; label: string; used: number; limit: number; remaining: number;
  unit: 'percent' | 'requests' | 'characters' | 'credits'; resetsAt: string | null; active?: boolean;
};
export type UsageAmount = { label: string; amount: number; currency: string; period: string; scope: 'key' | 'account' | 'subscription' };
export type UsagePace = { label: string; currency: string; perMinute: number; observedMinutes: number; samples: number; minutesLeft: number | null; balance: number | null; scope: UsageAmount['scope'] };
export type UsageAccount = {
  id: string; provider: string; name: string; email?: string; plan?: string;
  kind: 'subscription' | 'api'; status: 'live' | 'unavailable' | 'stale';
  checkedAt: string | null; attemptedAt: string; windows: UsageWindow[];
  amounts: UsageAmount[]; agents: string[]; note: string;
  source: string; href: string; billingGroup?: string; pace?: UsagePace[];
};
export type AccountUsage = { generatedAt: string; refreshSeconds: number; accounts: UsageAccount[] };

export const fetchUsage = (refresh = false, signal?: AbortSignal) =>
  apiJson<AccountUsage>('/api/usage' + (refresh ? '?refresh=1' : ''), { signal, cache: 'no-store' });
