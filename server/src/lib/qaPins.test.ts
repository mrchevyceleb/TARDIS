import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const stateDir = mkdtempSync(join(tmpdir(), 'qa-pins-test-'));
process.env.RIVENDELL_STATE_DIR = stateDir;
process.env.RIVENDELL_QA_REPOS = 'acme/operly,acme/studio';
process.env.RIVENDELL_QA_TESTER_LOGINS = 'sud=sud-board,edgar=edgar-board,martin=martin-board';
process.env.RIVENDELL_QA_AUTH_SECRET = 'test-only-secret-value';
process.env.RIVENDELL_QA_SLACK_CHANNELS = 'sud=C-SUD,edgar=C-EDGAR,martin=C-MARTIN';

const { upsertQaItem, applyQaOutcome } = await import('./qaBoard.ts');
const { qaPinsForTest, qaSlackChannels } = await import('./qaPins.ts');

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test('pin channels parse per tester', () => {
  assert.deepEqual(qaSlackChannels(), { sud: 'C-SUD', edgar: 'C-EDGAR', martin: 'C-MARTIN' });
});

test('held sends are attempted once per distinct list, never per sweep', async () => {
  const item = await upsertQaItem({ repo: 'acme/operly', pr: 31, title: 'Pin refresh candidate', app: 'Operly' });
  assert.ok(item);
  let calls = 0;
  const heldTool = async () => { calls += 1; return { held: true, draftId: `d${calls}` }; };
  const first = await qaPinsForTest.refreshQaPinsWith(heldTool);
  assert.deepEqual(first.refreshed, []);
  assert.deepEqual(first.held, ['sud', 'edgar', 'martin']);
  assert.equal(calls, 3);
  // Same board, second sweep: nothing is attempted again, so no new drafts.
  const second = await qaPinsForTest.refreshQaPinsWith(heldTool);
  assert.deepEqual(second.held, []);
  assert.equal(calls, 3);
  // A changed list is one new attempt for the changed tester only.
  await applyQaOutcome(item.id, 'testing');
  const third = await qaPinsForTest.refreshQaPinsWith(heldTool);
  assert.deepEqual(third.held, ['edgar']);
  assert.equal(calls, 4);
});

test('a confirmed send records the pin and skips an unchanged list', async () => {
  let calls = 0;
  const sentTool = async () => { calls += 1; return { success: true, timestamp: `170000000${calls}.000100` }; };
  // Martin's list still equals its held-attempt text, so a confirmed-send
  // tool changes nothing for anyone yet: the attempted text already names
  // exactly what the pin would show.
  const first = await qaPinsForTest.refreshQaPinsWith(sentTool);
  assert.deepEqual(first.refreshed, []);
  assert.equal(calls, 0);
  // A new card changes Edgar's list: he posts, and the record lands.
  const edgarItem = await upsertQaItem({ repo: 'acme/studio', pr: 32, title: 'Studio card for pins', app: 'Studio' });
  assert.ok(edgarItem);
  const second = await qaPinsForTest.refreshQaPinsWith(sentTool);
  assert.deepEqual(second.refreshed, ['edgar']);
  assert.equal(calls, 1);
  // Unchanged board: nothing re-posts.
  const third = await qaPinsForTest.refreshQaPinsWith(sentTool);
  assert.deepEqual(third.refreshed, []);
  assert.equal(calls, 1);
});
