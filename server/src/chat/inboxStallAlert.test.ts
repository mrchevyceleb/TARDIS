import assert from 'node:assert/strict';
import test from 'node:test';
import { INBOX_STALL_ALERT_MS, noteInboxFailed, noteInboxMoved, type StallAlertDeps } from './inboxStallAlert.ts';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(deliver: () => boolean) {
  const sent: string[] = [];
  let now = 0;
  const deps: StallAlertDeps = {
    now: () => now,
    tellMax: async (text) => { const ok = deliver(); if (ok) sent.push(`max:${text}`); return { delivered: ok }; },
    openDeskAlert: async (title) => { if (!deliver()) throw new Error('ENOSPC'); sent.push(`desk:${title}`); return 'todo-1'; },
    closeDeskAlert: async (id) => { if (!deliver()) throw new Error('ENOSPC'); sent.push(`closed:${id}`); },
  };
  return { sent, deps, at: (ms: number) => { now = ms; } };
}

test('a failing inbox alerts Max and the Desk once after two minutes, and both hear the recovery', async () => {
  const { sent, deps, at } = harness(() => true);
  const info = { name: 'Adam', waiting: 24, error: 'disk full' };
  noteInboxFailed('bot-adam', info, deps);
  at(INBOX_STALL_ALERT_MS - 1); noteInboxFailed('bot-adam', info, deps);
  assert.deepEqual(sent, []);
  at(INBOX_STALL_ALERT_MS); noteInboxFailed('bot-adam', info, deps); await settle();
  at(INBOX_STALL_ALERT_MS + 15_000); noteInboxFailed('bot-adam', info, deps); await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[0], /^max:Adam's inbox has not moved .*24 messages are waiting/);
  assert.equal(sent[1], "desk:Adam's inbox is stuck");
  at(5 * 60_000); noteInboxMoved('bot-adam', deps); await settle();
  assert.match(sent[2], /^max:Adam's inbox is moving again after about 5 minutes/);
  assert.equal(sent[3], 'closed:todo-1');
});

test('an inbox that recovers before any alert could land still tells Max what happened', async () => {
  let diskFull = true;
  const { sent, deps, at } = harness(() => !diskFull);
  const info = { name: 'Riley', waiting: 3, error: 'no space left' };
  noteInboxFailed('bot-riley', info, deps);
  at(3 * 60_000); noteInboxFailed('bot-riley', info, deps); await settle();
  assert.deepEqual(sent, []);
  diskFull = false;
  at(4 * 60_000); noteInboxMoved('bot-riley', deps); await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[0], /^max:Riley's inbox was stuck for about 4 minutes .*nothing was lost/);
  assert.equal(sent[1], "desk:Riley's inbox was stuck for a while");
});
