import assert from 'node:assert/strict';
import test from 'node:test';
import {
  etHour,
  inQuietHours,
  isMaxLane,
  isQuietExemptLane,
  isQuietExemptWork,
  isSamwiseLane,
  lastQuietEndMs,
  lastQuietStartMs,
  msUntilQuietEnd,
  recordQuietExemptWake,
  resetQuietExemptWakes,
} from './quietHours.ts';

/** Fixed instants in America/New_York (EDT, UTC-4, no DST boundary). */
const et = (wall: string): number => Date.parse(`${wall}:00Z`) + 4 * 3_600_000;

test('the quiet window is 21:00-07:00 ET, half-open', () => {
  assert.equal(inQuietHours(et('2026-10-15T20:59')), false);
  assert.equal(inQuietHours(et('2026-10-15T21:00')), true);
  assert.equal(inQuietHours(et('2026-10-16T00:00')), true);
  assert.equal(inQuietHours(et('2026-10-16T06:59')), true);
  assert.equal(inQuietHours(et('2026-10-16T07:00')), false);
  assert.equal(inQuietHours(et('2026-10-16T12:00')), false);
});

test('etHour reads the Eastern hour regardless of host timezone', () => {
  assert.equal(etHour(et('2026-10-16T00:30')), 0);
  assert.equal(etHour(et('2026-10-16T21:30')), 21);
  assert.equal(etHour(et('2026-10-16T22:30')), 22);
});

test('msUntilQuietEnd targets the next 07:00 ET', () => {
  const hour = 3_600_000;
  assert.equal(msUntilQuietEnd(et('2026-10-15T21:00')), 10 * hour);
  assert.equal(msUntilQuietEnd(et('2026-10-16T00:00')), 7 * hour);
  assert.equal(msUntilQuietEnd(et('2026-10-16T06:00')), 1 * hour);
  assert.equal(msUntilQuietEnd(et('2026-10-16T06:30')), 0.5 * hour);
});

test('lastQuietStartMs is the most recent 21:00 ET at or before now', () => {
  assert.equal(lastQuietStartMs(et('2026-10-15T21:00')), et('2026-10-15T21:00'));
  assert.equal(lastQuietStartMs(et('2026-10-15T23:30') + 12_345), et('2026-10-15T21:00'));
  assert.equal(lastQuietStartMs(et('2026-10-16T01:15')), et('2026-10-15T21:00'));
  assert.equal(lastQuietStartMs(et('2026-10-16T06:59')), et('2026-10-15T21:00'));
});

test('lastQuietEndMs is the most recent 07:00 ET at or before now', () => {
  // Inside the window: the previous morning's end.
  assert.equal(lastQuietEndMs(et('2026-10-16T01:00')), et('2026-10-15T07:00'));
  assert.equal(lastQuietEndMs(et('2026-10-15T23:30')), et('2026-10-15T07:00'));
  // Outside the window: this morning's end.
  assert.equal(lastQuietEndMs(et('2026-10-16T08:00')), et('2026-10-16T07:00'));
  assert.equal(lastQuietEndMs(et('2026-10-16T12:00')), et('2026-10-16T07:00'));
});

test('Max lanes are exempt, everything else holds', () => {
  assert.equal(isMaxLane('chief-of-staff'), true);
  assert.equal(isMaxLane('max-voice'), true);
  assert.equal(isMaxLane('naomi'), false);
  assert.equal(isMaxLane(undefined), false);
  assert.equal(isMaxLane(null), false);
});

test('Samwise and Pippin are the teammates exempt from quiet hours; nobody else moves', () => {
  assert.equal(isSamwiseLane('samwise'), true);
  assert.equal(isSamwiseLane('chief-of-staff'), false);
  assert.equal(isQuietExemptLane('samwise'), true);
  assert.equal(isQuietExemptLane('pippin-2'), true);
  assert.equal(isQuietExemptLane('chief-of-staff'), true);
  assert.equal(isQuietExemptLane('max-voice'), true);
  assert.equal(isQuietExemptLane('naomi'), false);
  assert.equal(isQuietExemptLane('jessica'), false);
  assert.equal(isQuietExemptLane(undefined), false);
});

test('Samwise lane work is exempt overnight even with no exempt wake', () => {
  resetQuietExemptWakes();
  const tonightNow = et('2026-10-15T23:30');
  assert.equal(isQuietExemptWork('samwise', et('2026-10-15T22:05'), tonightNow), true);
  assert.equal(isQuietExemptWork('jessica', et('2026-10-15T22:05'), tonightNow), false);
  resetQuietExemptWakes();
});

test('isQuietExemptWork requires an exempt wake inside the current quiet window', () => {
  resetQuietExemptWakes();
  const tonightNow = et('2026-10-15T23:30');

  // 1) A turn started before 21:00 spawns a job at 22:05 with no overnight exempt wake: NOT exempt.
  assert.equal(isQuietExemptWork('naomi', et('2026-10-15T22:05'), tonightNow), false);

  // 2) An exempt wake from the PREVIOUS night's window (02:00 yesterday) does not exempt tonight's work,
  //    nor a 24h job started at 02:00 yesterday that finishes at 23:30 tonight.
  recordQuietExemptWake('naomi', et('2026-10-15T01:30'));
  assert.equal(isQuietExemptWork('naomi', et('2026-10-15T02:00'), tonightNow), false);
  assert.equal(isQuietExemptWork('naomi', et('2026-10-15T22:05'), tonightNow), false);

  // 3) A daytime wake outside the window is ignored; only a wake inside the current window arms it,
  //    and only for jobs started at or after that wake.
  recordQuietExemptWake('naomi', et('2026-10-15T20:55'));
  assert.equal(isQuietExemptWork('naomi', et('2026-10-15T22:05'), tonightNow), false);

  recordQuietExemptWake('naomi', et('2026-10-15T22:10'));
  assert.equal(isQuietExemptWork('naomi', et('2026-10-15T22:05'), tonightNow), false);
  assert.equal(isQuietExemptWork('naomi', et('2026-10-15T22:10'), tonightNow), true);
  assert.equal(isQuietExemptWork('naomi', et('2026-10-15T22:15'), tonightNow), true);

  resetQuietExemptWakes();
});
