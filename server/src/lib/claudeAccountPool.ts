import type { TerminalProviderError } from '../chat/providerErrors.ts';
import type { UsageAccount } from './accountUsage.ts';

type Reading = { profileIds: string[]; usage: UsageAccount };
type Block = { until: number; kind: TerminalProviderError['limitKind']; inferred?: boolean };

/** Temporary routing only: saved account choices remain the preference. */
export class ClaudeAccountPool {
  private readings: Reading[] = [];
  private blocked = new Map<string, Block>();
  private redirects = new Map<string, string>();

  update(readings: Reading[]): void {
    for (const reading of readings) {
      const blocks = [reading.usage.id, ...reading.profileIds].flatMap(id => this.blocked.has(id) ? [this.blocked.get(id)!] : []);
      if (blocks.length) {
        let block = blocks.sort((a, b) => b.until - a.until)[0];
        const resets = reading.usage.status === 'live' && block.inferred && block.kind !== 'monthly'
          ? reading.usage.windows.filter(w => w.limit > 0 && w.used >= w.limit).map(w => Date.parse(w.resetsAt ?? '')).filter(time => time > Date.parse(reading.usage.checkedAt ?? '')) : [];
        if (resets.length) block = { ...block, until: Math.max(...resets), inferred: false };
        for (const id of new Set([reading.usage.id, ...reading.profileIds])) this.blocked.set(id, block);
      }
    }
    this.readings = readings;
  }

  private reading(profileId: string): Reading | undefined {
    return this.readings.find(item => item.profileIds.includes(profileId));
  }

  private full(usage: UsageAccount, now: number): boolean {
    return usage.windows.some(window => window.limit > 0 && window.used >= window.limit
      && (!window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > now));
  }

  private unavailable(profileId: string, now: number): boolean {
    const reading = this.reading(profileId);
    const block = this.blocked.get(reading?.usage.id ?? profileId);
    if (block && block.until > now) return true;
    return reading ? this.full(reading.usage, now) : false;
  }

  isLimited(profileId: string, now = Date.now()): boolean { return this.unavailable(profileId, now); }

  select(preferred: string, available: string[], now = Date.now()): string {
    if (!this.unavailable(preferred, now)) return preferred;
    const candidates = this.readings.filter(item => (item.usage.status === 'live' || item.usage.status === 'stale')
      && item.usage.checkedAt
      && item.usage.windows.length > 0 && !this.unavailable(item.profileIds[0], now));
    const fresh = (item: Reading) => item.usage.status === 'live' && now - Date.parse(item.usage.checkedAt!) < 120_000 ? 0 : 1;
    candidates.sort((a, b) => fresh(a) - fresh(b) || Math.max(...a.usage.windows.map(w => w.used / (w.limit || 1)))
      - Math.max(...b.usage.windows.map(w => w.used / (w.limit || 1))));
    const eligible = candidates.flatMap(item => item.profileIds).filter(id => available.includes(id));
    const key = this.reading(preferred)?.usage.id ?? preferred;
    const previous = this.redirects.get(key);
    const selected = previous && eligible.includes(previous) ? previous : eligible[0];
    if (selected) this.redirects.set(key, selected);
    return selected ?? preferred;
  }

  reject(profileId: string, error: TerminalProviderError, now = Date.now()): void {
    const reading = this.reading(profileId);
    const key = reading?.usage.id ?? profileId;
    const previous = this.blocked.get(key);
    const resets = error.limitKind === 'monthly' ? [] : reading?.usage.windows.filter(window => window.used >= window.limit && window.limit > 0)
      .map(window => Date.parse(window.resetsAt ?? '')).filter(time => time > now) ?? [];
    // A CLI rejection outranks an older quota reading. Never clear it just
    // because a cached feed still says there is room.
    const fallback = previous && previous.until > now && previous.kind === error.limitKind ? previous.until
      : error.limitKind === 'monthly' ? Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1)
      : now + (error.limitKind === 'weekly' ? 7 * 24 : 5) * 3_600_000;
    const matching = reading?.usage.windows.filter(window => error.limitKind === 'session' ? /session|five|hour/i.test(window.label)
      : error.limitKind === 'weekly' ? /all models|seven[ _]day$/.test(window.label.toLowerCase()) : false)
      .map(window => Date.parse(window.resetsAt ?? '')).filter(time => time > now) ?? [];
    const reset = resetTimestamp(error.resetTime, now);
    const until = Math.max(reset ?? (resets.length ? Math.max(...resets) : matching[0] ?? fallback), ...resets);
    const block = previous && (previous.until > until || (previous.until === until && !previous.inferred)) ? previous
      : { until, kind: error.limitKind, inferred: reset === undefined && !resets.length && !matching.length };
    for (const id of new Set([key, profileId, ...(reading?.profileIds ?? [])])) this.blocked.set(id, block);
  }
}

/** Native Claude supplies a local clock, optionally with a month/day. */
export function resetTimestamp(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const match = /^(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d+), )?(\d+):(\d+) (AM|PM) \(([^)]+)\)$/.exec(value);
  if (!match) return undefined;
  try {
    const format = new Intl.DateTimeFormat('en-US', { timeZone: match[6], year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts = (time: number) => Object.fromEntries(format.formatToParts(time).map(p => [p.type, p.value]));
    const local = parts(now);
    const month = match[1] ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1]) : Number(local.month) - 1;
    const hour = Number(match[3]) % 12 + (match[5] === 'PM' ? 12 : 0);
    const target = Date.UTC(Number(local.year), month, match[2] ? Number(match[2]) : Number(local.day), hour, Number(match[4]));
    const convert = (wall: number) => {
      let time = wall;
      for (let i = 0; i < 3; i++) {
        const p = parts(time);
        time += wall - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
      }
      return time;
    };
    let time = convert(target);
    if (time <= now) time = convert(match[1] ? Date.UTC(Number(local.year) + 1, month, Number(match[2]), hour, Number(match[4])) : target + 24 * 3_600_000);
    return time;
  } catch { return undefined; }
}

export const claudeAccountPool = new ClaudeAccountPool();
