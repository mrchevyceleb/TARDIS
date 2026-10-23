import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearProviderParks,
  parkProviderAccount,
  parseProviderResetAt,
  providerParkedUntil,
  providerParkKeyForProfile,
  PROVIDER_LIMIT_FALLBACK_PARK_MS,
  PROVIDER_LIMIT_MAX_PARK_MS,
  PROVIDER_LIMIT_RESET_BUFFER_MS,
} from './providerLimitAlert.ts';

test('parseProviderResetAt reads the provider label in its own zone', () => {
  // 09:30 ET on Oct 23 2026: the next 10:00 AM in America/New_York is
  // 14:00 UTC the same day.
  const now = Date.UTC(2026, 9, 23, 13, 30, 0);
  const at = parseProviderResetAt('10:00 AM (America/New_York)', now);
  assert.equal(at, Date.UTC(2026, 9, 23, 14, 0, 0));
});

test('parseProviderResetAt steps to tomorrow once today\'s time has passed', () => {
  // 10:30 ET: today's 10:00 AM is gone, so the reset is tomorrow 10:00 AM ET.
  const now = Date.UTC(2026, 9, 23, 14, 30, 0);
  const at = parseProviderResetAt('10:00 AM (America/New_York)', now);
  assert.equal(at, Date.UTC(2026, 9, 24, 14, 0, 0));
});

test('parseProviderResetAt honors an explicit date', () => {
  const now = Date.UTC(2026, 9, 23, 13, 30, 0);
  const at = parseProviderResetAt('Oct 24, 9:15 AM (America/New_York)', now);
  assert.equal(at, Date.UTC(2026, 9, 24, 13, 15, 0));
});

test('parseProviderResetAt refuses junk instead of guessing', () => {
  const now = Date.UTC(2026, 9, 23, 13, 30, 0);
  assert.equal(parseProviderResetAt(undefined, now), undefined);
  assert.equal(parseProviderResetAt('soon', now), undefined);
  assert.equal(parseProviderResetAt('10:00 AM (Not/AZone)', now), undefined);
  assert.equal(parseProviderResetAt('25:00 AM (America/New_York)', now), undefined);
  // Impossible calendar dates refuse instead of rolling into another day.
  assert.equal(parseProviderResetAt('Apr 31, 10:00 AM (America/New_York)', now), undefined);
  assert.equal(parseProviderResetAt('Oct 0, 10:00 AM (America/New_York)', now), undefined);
  assert.equal(parseProviderResetAt('Feb 29, 10:00 AM (America/New_York)', Date.UTC(2026, 0, 1)), undefined);
  // Feb 29 is real in a leap year: Feb 28 2028 (09:00 ET) reads it as the
  // next day's reset, 15:00 UTC (EST).
  assert.equal(
    parseProviderResetAt('Feb 29, 10:00 AM (America/New_York)', Date.UTC(2028, 1, 28, 14, 0, 0)),
    Date.UTC(2028, 1, 29, 15, 0, 0),
  );
  // A reset further out than the park cap is not a window reset.
  assert.equal(parseProviderResetAt('Dec 25, 10:00 AM (America/New_York)', now), undefined);
});

test('a reset read just after its instant stays the window that opened', () => {
  // The failure notice is persisted and replayed seconds later: at 10:00:30
  // ET the 10:00 AM label is this morning's reset, not tomorrow's.
  const now = Date.UTC(2026, 9, 23, 14, 0, 30);
  assert.equal(parseProviderResetAt('10:00 AM (America/New_York)', now), Date.UTC(2026, 9, 23, 14, 0, 0));
  assert.equal(parseProviderResetAt('Oct 23, 10:00 AM (America/New_York)', now), Date.UTC(2026, 9, 23, 14, 0, 0));
  // Well past the grace window it does step forward.
  const later = Date.UTC(2026, 9, 23, 14, 30, 0);
  assert.equal(parseProviderResetAt('10:00 AM (America/New_York)', later), Date.UTC(2026, 9, 24, 14, 0, 0));
});

test('explicit dates resolve in the provider zone, not UTC', () => {
  // 2027-01-01T00:30Z is still Dec 31 2026, 7:30 PM in New York: an 8 PM
  // label is 30 minutes ahead, not next year's.
  const now = Date.UTC(2027, 0, 1, 0, 30, 0);
  assert.equal(
    parseProviderResetAt('Dec 31, 8:00 PM (America/New_York)', now),
    Date.UTC(2027, 0, 1, 1, 0, 0),
  );
});

test('reset grace survives local midnight and New Year with or without a date', () => {
  const now = Date.UTC(2027, 0, 1, 0, 2);
  assert.equal(parseProviderResetAt('Dec 31, 11:59 PM (UTC)', now), Date.UTC(2026, 11, 31, 23, 59));
  assert.equal(parseProviderResetAt('11:59 PM (UTC)', now), Date.UTC(2026, 11, 31, 23, 59));
  assert.equal(parseProviderResetAt('11:59 PM (America/New_York)', Date.UTC(2027, 0, 1, 5, 2)), Date.UTC(2027, 0, 1, 4, 59));
});

test('zone offsets handle midnight, fractional hours and DST without inventing wall clocks', () => {
  assert.equal(parseProviderResetAt('12:00 AM (UTC)', Date.UTC(2026, 9, 23, 23, 30)), Date.UTC(2026, 9, 24));
  assert.equal(parseProviderResetAt('10:00 AM (Asia/Kathmandu)', Date.UTC(2026, 9, 23, 4)), Date.UTC(2026, 9, 23, 4, 15));
  assert.equal(parseProviderResetAt('10:00 AM (America/New_York)', Date.UTC(2026, 2, 7, 16)), Date.UTC(2026, 2, 8, 14));
  assert.equal(parseProviderResetAt('2:30 AM (America/New_York)', Date.UTC(2026, 2, 8, 5)), undefined);
  // 1:40 EDT precedes the second 1:30 (EST): do not jump to tomorrow.
  assert.equal(parseProviderResetAt('1:30 AM (America/New_York)', Date.UTC(2026, 10, 1, 5, 40)), Date.UTC(2026, 10, 1, 6, 30));
});

test('a grace-window report still parks into the future', () => {
  clearProviderParks();
  // Four minutes past the 10:00 AM reset: inside the 5-minute grace, but
  // already past reset + buffer. The park must still expire ahead of now.
  const now = Date.UTC(2026, 9, 23, 14, 4, 0);
  const until = parkProviderAccount('acct-grace', '10:00 AM (America/New_York)', now);
  assert.equal(until, now + PROVIDER_LIMIT_FALLBACK_PARK_MS);
  assert.equal(providerParkedUntil('acct-grace', now), until);
});

test('park keys canonicalize the profile the runner and drain share', () => {
  // The runner parks with its spawned profile; the drain derives the same
  // directory through lane routing. One builder, one canonical form.
  assert.equal(providerParkKeyForProfile('/home/tester/.claude'), 'claude-profile:/home/tester/.claude');
  const dir = mkdtempSync(join(tmpdir(), 'tardis-park-key-'));
  try {
    const profile = join(dir, 'profile');
    const alias = join(dir, 'alias');
    mkdirSync(profile);
    symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(providerParkKeyForProfile(alias), providerParkKeyForProfile(profile));
    assert.equal(providerParkKeyForProfile(join(dir, 'missing')), providerParkKeyForProfile(`${dir}/./missing`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('park holds until reset plus buffer and only ever extends', () => {
  clearProviderParks();
  const now = Date.UTC(2026, 9, 23, 13, 30, 0);
  const until = parkProviderAccount('acct-a', '10:00 AM (America/New_York)', now);
  assert.equal(until, Date.UTC(2026, 9, 23, 14, 0, 0) + PROVIDER_LIMIT_RESET_BUFFER_MS);
  assert.equal(providerParkedUntil('acct-a', now), until);
  // A second, earlier report never shortens the park.
  const again = parkProviderAccount('acct-a', '9:45 AM (America/New_York)', now);
  assert.equal(again, until);
  // Past the expiry the park clears itself.
  assert.equal(providerParkedUntil('acct-a', until + 1), 0);
});

test('park without a reset time uses the fallback window', () => {
  clearProviderParks();
  const now = Date.UTC(2026, 9, 23, 13, 30, 0);
  const until = parkProviderAccount('acct-b', undefined, now);
  assert.equal(until, now + PROVIDER_LIMIT_FALLBACK_PARK_MS);
  assert.equal(providerParkedUntil('acct-b', now), until);
  assert.equal(providerParkedUntil('acct-c', now), 0);
});

test('park never exceeds the cap, however the label reads', () => {
  clearProviderParks();
  const now = Date.UTC(2026, 9, 23, 13, 30, 0);
  // Six days out is inside the cap and parks to the reset.
  const weekly = parkProviderAccount('acct-d', 'Oct 29, 10:00 AM (America/New_York)', now);
  assert.equal(weekly, Date.UTC(2026, 9, 29, 14, 0, 0) + PROVIDER_LIMIT_RESET_BUFFER_MS);
  assert.ok(weekly - now <= PROVIDER_LIMIT_MAX_PARK_MS);
});
