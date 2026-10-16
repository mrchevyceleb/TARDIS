// Pin TZ to ET before any Date call so the local wall-clock slots (todaySlot)
// and the ET quiet window align on CI's UTC runners as well as Moria (review 3, P2 #3).
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSchedule, routineIsDue, type Routine } from './routines.ts';

function local(y: number, m: number, d: number, hh: number, mm: number): number {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

function routine(partial: Partial<Routine> & Pick<Routine, 'schedule' | 'lastRunAt'>): Routine {
  return {
    id: 'rt-test',
    name: 'Test',
    agentId: 'chief-of-staff',
    prompt: 'x',
    createdAt: local(2026, 9, 1, 0, 0),
    ...partial,
  };
}

test('weekday 8:00 cron is still due later the same day if it never delivered', () => {
  const r = routine({
    schedule: 'cron:0 8 * * 1-5',
    lastRunAt: local(2026, 9, 7, 8, 0), // Sunday prior delivery
  });
  // Tuesday Sep 8 2026 11:19 local: most recent slot is 08:00 today.
  assert.equal(routineIsDue(r, local(2026, 9, 8, 11, 19)), true);
});

test('weekday 8:00 cron is not due again after a same-day delivery', () => {
  const r = routine({
    schedule: 'cron:0 8 * * 1-5',
    lastRunAt: local(2026, 9, 8, 8, 0) + 28_000,
  });
  assert.equal(routineIsDue(r, local(2026, 9, 8, 11, 19)), false);
});

test('every-10-minute cron still matches the current minute', () => {
  const r = routine({
    schedule: 'cron:*/10 7-22 * * *',
    lastRunAt: local(2026, 9, 8, 10, 50),
  });
  assert.equal(routineIsDue(r, local(2026, 9, 8, 11, 0)), true);
  assert.equal(routineIsDue(r, local(2026, 9, 8, 11, 3)), true);
  const delivered = routine({
    schedule: 'cron:*/10 7-22 * * *',
    lastRunAt: local(2026, 9, 8, 11, 0) + 5_000,
  });
  assert.equal(routineIsDue(delivered, local(2026, 9, 8, 11, 3)), false);
});

test('every-5-minute cron is due on the next five-minute slot', () => {
  const r = routine({
    schedule: 'cron:*/5 7-22 * * *',
    lastRunAt: local(2026, 9, 8, 11, 0),
  });
  assert.equal(routineIsDue(r, local(2026, 9, 8, 11, 5)), true);
  assert.equal(routineIsDue(r, local(2026, 9, 8, 11, 4)), false);
  const delivered = routine({
    schedule: 'cron:*/5 7-22 * * *',
    lastRunAt: local(2026, 9, 8, 11, 5) + 2_000,
  });
  assert.equal(routineIsDue(delivered, local(2026, 9, 8, 11, 7)), false);
});

test('parseSchedule still accepts the three schedule shapes', () => {
  assert.ok(parseSchedule('every:30m'));
  assert.ok(parseSchedule('weekdays:09:00'));
  assert.ok(parseSchedule('cron:0 8 * * 1-5'));
  assert.equal(parseSchedule('nope'), null);
});

// ---- quiet-hours daily legs (Opus verify, Oct 16) --------------------------

test('a daily slot held overnight catches up after 05:00 via heldSlotAt', () => {
  const now = local(2026, 10, 16, 5, 30);
  const last = local(2026, 10, 14, 23, 0); // ran the night before the held one
  const heldSlotAt = local(2026, 10, 15, 23, 0);
  assert.equal(
    routineIsDue(routine({ schedule: 'daily:23:00', lastRunAt: last, heldSlotAt, agentId: 'naomi' }), now),
    true,
  );
});

test('a daily slot already caught up today does not fire twice', () => {
  const now = local(2026, 10, 16, 5, 30);
  const last = local(2026, 10, 16, 5, 5); // the catch-up run itself
  assert.equal(routineIsDue(routine({ schedule: 'daily:23:00', lastRunAt: last, agentId: 'naomi' }), now), false);
});

test('a Max-lane slot is never held, so it never catches up', () => {
  const now = local(2026, 10, 16, 5, 30);
  const last = local(2026, 10, 14, 23, 0);
  const heldSlotAt = local(2026, 10, 15, 23, 0);
  assert.equal(routineIsDue(routine({ schedule: 'daily:23:00', lastRunAt: last, heldSlotAt }), now), false);
});

test('an unpaused daily:23:00 with no heldSlotAt does not fire a false catch-up at 06:00', () => {
  const now = local(2026, 10, 16, 6, 0);
  const last = local(2026, 10, 14, 23, 0); // paused over yesterday's 23:00 slot
  assert.equal(routineIsDue(routine({ schedule: 'daily:23:00', lastRunAt: last, agentId: 'naomi' }), now), false);
});

test('a Friday weekdays:22:30 slot held overnight catches up on Saturday morning', () => {
  const saturdayMorning = local(2026, 10, 17, 5, 30); // Saturday Oct 17 2026
  const last = local(2026, 10, 15, 22, 30); // Thursday night
  const heldSlotAt = local(2026, 10, 16, 22, 30); // Friday night held
  assert.equal(
    routineIsDue(routine({ schedule: 'weekdays:22:30', lastRunAt: last, heldSlotAt, agentId: 'naomi' }), saturdayMorning),
    true,
  );
});

test('a pre-22:00 slot that slipped into quiet hours catches up after 05:00 via heldSlotAt', () => {
  const now = local(2026, 10, 16, 5, 5);
  const last = local(2026, 10, 14, 21, 50);
  const heldSlotAt = local(2026, 10, 15, 22, 2); // held when busy lane released at 22:02
  assert.equal(
    routineIsDue(routine({ schedule: 'daily:21:50', lastRunAt: last, heldSlotAt, agentId: 'naomi' }), now),
    true,
  );
});

test('a daytime slot missed to downtime does not fire a stale catch-up', () => {
  const now = local(2026, 10, 16, 6, 0);
  const last = local(2026, 10, 14, 9, 0); // yesterday's 09:00 never ran
  assert.equal(routineIsDue(routine({ schedule: 'daily:09:00', lastRunAt: last, agentId: 'naomi' }), now), false);
});

test('a weekdays routine does not double-fire on Monday morning', () => {
  // Friday ran; Saturday and Sunday have no slot; Monday 05:30 is before the slot.
  const now = local(2026, 10, 19, 5, 30);
  const last = local(2026, 10, 16, 9, 0);
  assert.equal(routineIsDue(routine({ schedule: 'weekdays:09:00', lastRunAt: last, agentId: 'naomi' }), now), false);
});

test('a weekdays routine fires at its own slot on Monday', () => {
  const now = local(2026, 10, 19, 9, 0);
  const last = local(2026, 10, 16, 9, 0);
  assert.equal(routineIsDue(routine({ schedule: 'weekdays:09:00', lastRunAt: last, agentId: 'naomi' }), now), true);
});
