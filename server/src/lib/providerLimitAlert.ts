import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TerminalProviderError } from '../chat/providerErrors.ts';

const sent = new Map<string, { at: number; attempt: symbol }>();
const ALL_FULL = 'claude-all-full';
type Delivery = (text: string) => Promise<{ delivered: boolean }>;
const deliver: Delivery = async (text) => {
  const { deliverTeamMessage } = await import('../chat/teamBus.ts');
  return deliverTeamMessage({ from: 'TARDIS', to: 'chief-of-staff', text, wait: false });
};

export function clearAllClaudeAccountsFullAlert(): void { sent.delete(ALL_FULL); }

/** One alert per profile/reset, or per outage when no account has room. */
export function noteProviderUsageLimit(account: string, lane: string, error: TerminalProviderError, send: Delivery = deliver, now = Date.now(), movedTo?: string): void {
  if (!error.usageLimit) return;
  const window = error.resetTime ?? 'reset unknown';
  const key = movedTo ? JSON.stringify([account, error.limitKind ?? 'usage', window]) : ALL_FULL;
  if (movedTo) clearAllClaudeAccountsFullAlert();
  const cooldown = error.limitKind === 'weekly' || error.limitKind === 'monthly' ? 7 * 24 * 3_600_000 : error.resetTime ? 24 * 3_600_000 : 5 * 3_600_000;
  for (const [entryKey, entry] of sent) if (entryKey !== ALL_FULL && now - entry.at >= 7 * 24 * 3_600_000) sent.delete(entryKey);
  if (key !== ALL_FULL && sent.has(key) && now - sent.get(key)!.at >= cooldown) sent.delete(key);
  if (sent.has(key)) return;
  const attempt = Symbol();
  sent.set(key, { at: now, attempt });
  const name = lane.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 40);
  const text = movedTo
    ? `One Claude subscription reached its ${error.limitKind ?? 'usage'} limit. Moved ${name} and every other lane using it to another signed-in account with room. The failed turn is retrying with the same brain, and saved account choices return after reset.${error.resetTime ? ` Reset: ${error.resetTime}.` : ''}`
    : `All signed-in Claude accounts are full or have no confirmed room. ${name} stayed on its saved account because there is nowhere safe to move it. ${error.resetTime ? `That usage window resets at ${error.resetTime}.` : 'Try again after a usage window resets.'}${error.limitKind === 'monthly' ? ' Check the monthly spend limit at claude.ai/settings/usage.' : ''} No brain was changed.`;
  void Promise.resolve().then(() => send(text)).then((result) => {
    if (!result.delivered) throw new Error('not accepted');
  }).catch(() => {
    if (sent.get(key)?.attempt === attempt) sent.delete(key);
    console.warn('[provider-limit] alert not delivered');
  });
}

// ---------------------------------------------------------------------------
// In-memory per-account usage-limit park; queued deliveries stay durable.
//
// Juno and Tim locked out on Oct 23 2026: every fresh-spawned turn died with
// Claude's usage-window 429, the runner reported peer_delivery_rejected, and
// the team-bus drain retried every 15s forever (163 attempts on Juno). The
// fresh-thread reset could never complete because each rejection restarts
// the turn, so the recipient stayed "busy" and the wipe held forever.
//
// The park is the root guard: once an account reports a usage limit, every
// lane on that account stops admitting new queued deliveries until the
// provider's own reset time (plus a small buffer). The durable queue keeps
// the records; the drain simply waits for the reset instead of hammering a
// dead window. State is in-memory and account-keyed: lanes share one CLI
// profile, so one lane's 429 parks them all, and healthy lanes on other
// accounts are untouched. A process restart clears it, which is safe: the
// first post-restart failure re-parks immediately.
// ---------------------------------------------------------------------------

/** Fallback park when the provider gave no parseable reset time. */
export const PROVIDER_LIMIT_FALLBACK_PARK_MS = 5 * 60_000;
/** Buffer past the provider's stated reset before admitting again. */
export const PROVIDER_LIMIT_RESET_BUFFER_MS = 60_000;
/** A reset label read within this long after the stated instant is the
 *  window that just opened, not the next day's or next year's: the notice
 *  is persisted and replayed seconds after the failure, so a hair-past
 *  label must not jump a full period (Codex review, Oct 23 2026). */
export const PROVIDER_LIMIT_RESET_GRACE_MS = 5 * 60_000;
/** Bound a bad reset label instead of leaving the account parked indefinitely. */
export const PROVIDER_LIMIT_MAX_PARK_MS = 7 * 24 * 3_600_000;

/** The one canonical park key for a CLI profile directory. The runner
 *  parks with the profile it actually spawned (canonicalized there); the
 *  team bus derives the same profile through the lane's account routing
 *  and canonicalizes it identically, so both sides land on one key. */
export function providerParkKeyForProfile(profileDir: string): string {
  let canonical = resolve(profileDir);
  try { canonical = realpathSync(canonical); } catch { /* use the absolute path until the profile exists */ }
  return `claude-profile:${canonical}`;
}

const parks = new Map<string, number>();

/** Parse a provider reset label like "10:00 AM (America/New_York)" (the
 *  shape providerErrors.safeResetTime emits) into epoch ms. Accepts an
 *  optional "Mon D, " date prefix; without one it means the next occurrence
 *  of that wall-clock time in the named zone. Returns undefined for anything
 *  unparseable, so callers fall back instead of guessing a wrong instant. */
export function parseProviderResetAt(resetTime: string | undefined, now = Date.now()): number | undefined {
  if (!resetTime) return undefined;
  const match = /^(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s*)?(1[0-2]|[1-9]):([0-5]\d)\s*(AM|PM)\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC)\)$/i.exec(resetTime.trim());
  if (!match) return undefined;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = match[1] ? months.indexOf(match[1].toLowerCase()) + 1 : undefined;
  const day = match[2] ? Number(match[2]) : undefined;
  let hour = Number(match[3]) % 12;
  if (/pm/i.test(match[5])) hour += 12;
  const minute = Number(match[4]);
  const zone = match[6];
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { return undefined; }
  // Offset of the zone at an instant, via Intl parts.
  const offsetMs = (instant: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const hourPart = get('hour') % 24;
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hourPart, get('minute'), get('second'));
    return asUtc - Math.floor(instant / 1000) * 1000;
  };
  const candidate = (year: number, mo: number, d: number): number | undefined => {
    const wallAsUtc = Date.UTC(year, mo - 1, d, hour, minute, 0);
    // Check offsets on both sides of a transition. Spring-forward gaps
    // produce no valid instant; a repeated fall-back clock may still have
    // a second occurrence ahead even after the first one has passed.
    const dayMs = 24 * 3_600_000;
    const offsets = new Set([-dayMs, 0, dayMs].map(delta => offsetMs(wallAsUtc + delta)));
    const instants = [...offsets].map(offset => wallAsUtc - offset)
      .filter(instant => instant + offsetMs(instant) === wallAsUtc).sort((a, b) => a - b);
    return instants.find(instant => instant > now - PROVIDER_LIMIT_RESET_GRACE_MS) ?? instants.at(-1);
  };
  // A label read within the grace window after its instant names the
  // window that just opened: keep it, and parkProviderAccount's buffer
  // (inside the grace) turns it into a short park instead of a day away.
  const withinGrace = (instant: number): number | undefined =>
    (instant > now - PROVIDER_LIMIT_RESET_GRACE_MS ? instant : undefined);
  // Zone-local calendar date of an instant. Candidate years and days are
  // read in the provider's zone, never UTC: around New Year the zone is
  // still in the previous year while UTC has already rolled over.
  const zoneDateParts = (instantMs: number): { year: number; month: number; day: number } => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(instantMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return { year: get('year'), month: get('month'), day: get('day') };
  };
  if (month !== undefined && day !== undefined) {
    // Reject impossible dates (Apr 31, Feb 29 off-leap): Date.UTC would
    // silently roll them into a different day and park to a wrong instant.
    // The probe uses the candidate year itself, so Feb 29 stays valid in
    // leap years and refuses in common ones.
    const validDate = (year: number): boolean => {
      const probe = new Date(Date.UTC(year, month - 1, day));
      return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
    };
    const localYear = zoneDateParts(now).year;
    for (const year of [localYear - 1, localYear, localYear + 1]) {
      if (!validDate(year)) continue;
      const instant = candidate(year, month, day);
      if (instant === undefined) continue;
      if (instant <= now) {
        const justOpened = withinGrace(instant);
        if (justOpened !== undefined) return justOpened;
        continue;
      }
      // A reset further out than the park cap is not a window reset: refuse
      // it so the caller falls back instead of parking (nearly) forever.
      if (instant - now > PROVIDER_LIMIT_MAX_PARK_MS) return undefined;
      return instant;
    }
    return undefined;
  }
  // No date: the next occurrence of that wall time in the zone. Start from
  // the zone-local date of `now` and step forward a day until it is future.
  const localNow = zoneDateParts(now);
  // A notice received just after local midnight may still name yesterday's
  // reset. Apply the same grace across day/month/year boundaries.
  const previous = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day - 1));
  const prior = candidate(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
  if (prior !== undefined && prior <= now && withinGrace(prior) !== undefined) return prior;
  let instant = candidate(localNow.year, localNow.month, localNow.day);
  if (instant === undefined) return undefined;
  if (instant <= now) {
    const justOpened = withinGrace(instant);
    if (justOpened !== undefined) return justOpened;
    const next = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + 1));
    instant = candidate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  }
  return instant;
}

/** Park an account until its provider window resets. Only ever extends an
 *  existing park, never shortens one, and never past the park cap.
 *  Returns the park expiry. */
export function parkProviderAccount(account: string, resetTime?: string, now = Date.now()): number {
  const parsed = parseProviderResetAt(resetTime, now);
  // A grace-window label resolves to an instant already past: park the full
  // fallback window from now, never to a past instant that would resume the
  // retry loop at once.
  const until = parsed !== undefined
    ? Math.max(parsed + PROVIDER_LIMIT_RESET_BUFFER_MS, parsed <= now ? now + PROVIDER_LIMIT_FALLBACK_PARK_MS : 0)
    : now + PROVIDER_LIMIT_FALLBACK_PARK_MS;
  const existing = parks.get(account) ?? 0;
  const next = Math.min(Math.max(existing, until), now + PROVIDER_LIMIT_MAX_PARK_MS);
  parks.set(account, next);
  return next;
}

/** Epoch ms until which this account is parked, or 0 when it is not. An
 *  expired park clears itself, so admission resumes without a timer. */
export function providerParkedUntil(account: string, now = Date.now()): number {
  const until = parks.get(account) ?? 0;
  if (until <= now) {
    if (until) parks.delete(account);
    return 0;
  }
  return until;
}

/** Test hook: forget every park. */
export function clearProviderParks(): void {
  parks.clear();
}
