import assert from 'node:assert/strict';
import test from 'node:test';
import { INBOX_STALL_ALERT_MS, noteInboxFailed, noteInboxMoved, type StallAlertDeps } from './inboxStallAlert.ts';

test('a failing inbox alerts Max and the Desk once after two minutes, and both hear the recovery', async () => {
  const sent: string[] = [];
  const deps: StallAlertDeps = {
    tellMax: async (text) => { sent.push(`max:${text}`); return { delivered: true }; },
    openDeskAlert: async (title) => { sent.push(`desk:${title}`); return 'todo-1'; },
    closeDeskAlert: async (id) => { sent.push(`closed:${id}`); },
  };
  const info = { name: 'Adam', waiting: 24, error: 'disk full' };
  noteInboxFailed('bot-adam', info, deps, 0);
  noteInboxFailed('bot-adam', info, deps, INBOX_STALL_ALERT_MS - 1);
  assert.deepEqual(sent, []);
  noteInboxFailed('bot-adam', info, deps, INBOX_STALL_ALERT_MS);
  await new Promise((resolve) => setImmediate(resolve));
  noteInboxFailed('bot-adam', info, deps, INBOX_STALL_ALERT_MS + 15_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.match(sent[0], /^max:Adam's inbox has not moved .*24 messages are waiting/);
  assert.equal(sent[1], "desk:Adam's inbox is stuck");
  noteInboxMoved('bot-adam', deps, 5 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent[2], /^max:Adam's inbox is moving again after about 5 minutes/);
  assert.equal(sent[3], 'closed:todo-1');
});
