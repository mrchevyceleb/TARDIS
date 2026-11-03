import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEverySchedule, CUSTOM_INTERVAL_VALUE, customIntervalError, customIntervalLabel, humanizeCron, humanizeRoutine, parseEveryInterval, scheduleOptions } from '../src/grok/routineSchedule.ts';

test('Sarina babysitter crons read as English', () => {
  assert.equal(humanizeCron('cron:12,42 9-16 * * 1-5'), 'Weekdays · every 30 min, 9:12 AM to 4:42 PM');
  assert.equal(humanizeCron('17 18,22,2,6 * * 1-5'), 'Weekdays · 6:17 PM, 10:17 PM, 2:17 AM, 6:17 AM');
  assert.equal(humanizeCron('17 */4 * * 0,6'), 'Weekends · every 4 hours at :17');
  assert.equal(humanizeCron('23 8-17 * * 1-5'), 'Weekdays · hourly at :23, 8:23 AM to 5:23 PM');
  assert.equal(humanizeCron('23 21,1,5 * * 1-5'), 'Weekdays · 9:23 PM, 1:23 AM, 5:23 AM');
  assert.equal(humanizeCron('23 */4 * * 0,6'), 'Weekends · every 4 hours at :23');
  assert.equal(humanizeCron('0 * * * *'), 'hourly at :00');
  assert.equal(humanizeCron('0 9 * * 1-5'), 'Weekdays · 9:00 AM');
});

test('custom intervals parse, build and label any minutes or hours', () => {
  assert.deepEqual(parseEveryInterval('every:5m'), { value: 5, unit: 'm' });
  assert.deepEqual(parseEveryInterval('every:45m'), { value: 45, unit: 'm' });
  assert.deepEqual(parseEveryInterval('every:3h'), { value: 3, unit: 'h' });
  assert.deepEqual(parseEveryInterval('every:5min'), { value: 5, unit: 'm' });
  assert.equal(parseEveryInterval('daily:09:00'), null);
  assert.equal(buildEverySchedule(45, 'm'), 'every:45m');
  assert.equal(buildEverySchedule(3, 'h'), 'every:3h');
  assert.equal(customIntervalLabel(1, 'm'), 'Every 1 minute');
  assert.equal(customIntervalLabel(45, 'm'), 'Every 45 minutes');
  assert.equal(customIntervalLabel(1, 'h'), 'Every 1 hour');
  assert.equal(customIntervalLabel(3, 'h'), 'Every 3 hours');
});

test('custom interval input rejects empty, zero and over-31-day values', () => {
  assert.equal(customIntervalError('5', 'm'), null);
  assert.equal(customIntervalError('744', 'h'), null);
  assert.ok(customIntervalError('', 'm'));
  assert.ok(customIntervalError('0', 'm'));
  assert.ok(customIntervalError('abc', 'm'));
  assert.ok(customIntervalError('745', 'h'));
  assert.ok(customIntervalError('44641', 'm'));
});

test('the picker offers Custom right after the every presets', () => {
  const values = scheduleOptions('daily:09:00').map((o) => o.value);
  assert.deepEqual(values.slice(0, 4), ['every:30m', 'every:2h', 'every:4h', CUSTOM_INTERVAL_VALUE]);
  // A custom schedule being edited is shown by the custom fields, not as a duplicate option.
  assert.equal(scheduleOptions('every:45m', true).some((o) => o.value === 'every:45m'), false);
  // A cron schedule no preset covers still gets its own readable entry.
  assert.equal(scheduleOptions('cron:7 3 * * 2')[0].value, 'cron:7 3 * * 2');
  assert.equal(humanizeRoutine('every:45m'), 'Every 45 min');
  assert.equal(humanizeRoutine('every:3h'), 'Every 3 hours');
  assert.equal(humanizeRoutine('every:1h'), 'Every 1 hour');
});
