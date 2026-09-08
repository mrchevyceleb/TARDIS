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

test('parseSchedule still accepts the three schedule shapes', () => {
  assert.ok(parseSchedule('every:30m'));
  assert.ok(parseSchedule('weekdays:09:00'));
  assert.ok(parseSchedule('cron:0 8 * * 1-5'));
  assert.equal(parseSchedule('nope'), null);
});
