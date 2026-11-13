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

test('a teammate stuck two minutes tells Max once, never the Desk, and Max hears the recovery', async () => {
  const { sent, deps, at } = harness(() => true);
  const info = { name: 'Adam', waiting: 24, error: 'disk full' };
  noteInboxFailed('bot-adam', info, deps);
  at(INBOX_STALL_ALERT_MS - 1); noteInboxFailed('bot-adam', info, deps);
  assert.deepEqual(sent, []);
  at(INBOX_STALL_ALERT_MS); noteInboxFailed('bot-adam', info, deps); await settle();
  at(INBOX_STALL_ALERT_MS + 15_000); noteInboxFailed('bot-adam', info, deps); await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^max:Adam's inbox has not moved .*24 messages are waiting/);
  at(5 * 60_000); noteInboxMoved('bot-adam', deps); await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /^max:Adam's inbox is moving again after about 5 minutes/);
});

test('a jam that beat the alert still reaches Max afterwards, and only Max', async () => {
  let diskFull = true;
  const { sent, deps, at } = harness(() => !diskFull);
  const info = { name: 'Riley', waiting: 3, error: 'no space left' };
  noteInboxFailed('bot-riley', info, deps);
  at(3 * 60_000); noteInboxFailed('bot-riley', info, deps); await settle();
  assert.deepEqual(sent, []);
  diskFull = false;
  at(4 * 60_000); noteInboxMoved('bot-riley', deps); await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^max:Riley's inbox was stuck for about 4 minutes .*nothing was lost/);
});

test("Max's own stuck inbox goes to the Desk instead, and the item closes when it clears", async () => {
  const { sent, deps, at } = harness(() => true);
  noteInboxFailed('chief-of-staff', { name: 'Max', waiting: 2, error: 'disk full' }, deps);
  at(INBOX_STALL_ALERT_MS); noteInboxFailed('chief-of-staff', { name: 'Max', waiting: 2, error: 'disk full' }, deps); await settle();
  at(3 * 60_000); noteInboxMoved('chief-of-staff', deps); await settle();
  assert.deepEqual(sent, ["desk:Max's inbox is stuck", 'closed:todo-1']);
});
