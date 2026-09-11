import assert from 'node:assert/strict';
import test from 'node:test';
import { humanizeCron } from '../src/grok/BotPanel.tsx';

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
