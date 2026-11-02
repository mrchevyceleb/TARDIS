import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The store binds its directory at import, so point state at a temp dir first.
const stateDir = mkdtempSync(join(tmpdir(), 'qa-board-test-'));
process.env.RIVENDELL_STATE_DIR = stateDir;
process.env.RIVENDELL_QA_REPOS = 'acme/operly,acme/studio';
process.env.RIVENDELL_QA_TESTER_LOGINS = 'sud=sud-board,edgar=edgar-board,martin=martin-board';

const { routeQaItem, upsertQaItem, qaBoard, applyQaOutcome, qaPinnedList, qaDriftCheck } = await import('./qaBoard.ts');

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test('routing sends Operly to Martin, Studio to Edgar, Sud work to Sud', () => {
  assert.equal(routeQaItem({ app: 'Operly' }), 'martin');
  assert.equal(routeQaItem({ app: 'Studio' }), 'edgar');
  assert.equal(routeQaItem({ app: 'Operly', needsSud: true }), 'sud');
  assert.equal(routeQaItem({ app: 'Studio', builderIsTester: true }), 'sud');
  assert.equal(routeQaItem({ app: 'Operly', tester: 'sud' }), 'sud');
});

test('a staging merge lands once and keeps the thread status on re-merge', async () => {
  const item = await upsertQaItem({ repo: 'acme/operly', pr: 12, title: 'Usage meter reset', app: 'Operly', slackThreadUrl: 'https://slack.example/t12' });
  assert.ok(item);
  assert.equal(item.tester, 'martin');
  assert.equal(item.status, 'up_next');
  await applyQaOutcome(item.id, 'testing');
  const again = await upsertQaItem({ repo: 'acme/operly', pr: 12, title: 'Usage meter reset', app: 'Operly' });
  assert.ok(again);
  assert.equal(again.id, item.id);
  assert.equal(again.status, 'testing');
  const board = await qaBoard();
  assert.equal(board.martin.filter((i) => i.app === 'Operly').length, 1);
  assert.equal(board.martin.find((i) => i.app === 'Operly')?.id, item.id);
});

test('validated drops the card; a fail loops Sud to retest', async () => {
  const sudItem = await upsertQaItem({ repo: 'acme/studio', pr: 7, title: 'Mobile fixes', app: 'Studio', needsSud: true });
  assert.ok(sudItem);
  const failed = await applyQaOutcome(sudItem.id, 'fail');
  assert.equal(failed?.status, 'retest');
  const passed = await applyQaOutcome(sudItem.id, 'validated');
  assert.equal(passed?.status, 'validated');
  const board = await qaBoard();
  assert.equal(board.sud.length, 0);
});

test('the pinned Slack list renders from the same records as the board', async () => {
  const board = await qaBoard();
  const list = qaPinnedList('martin', board.martin);
  assert.match(list, /Martin's live list/);
  assert.match(list, /Usage meter reset \[testing\] due /);
});

test('drift flags a record whose PR is gone and one with no thread', () => {
  const items = [
    { id: 'a', repo: 'acme/operly', pr: 99, title: 'Gone', app: 'Operly' as const, tester: 'martin' as const, status: 'up_next' as const, dueAt: new Date().toISOString() },
    { id: 'b', repo: 'acme/operly', pr: 12, title: 'Live', app: 'Operly' as const, tester: 'martin' as const, status: 'testing' as const, dueAt: new Date().toISOString(), slackThreadUrl: 'https://slack.example/t12' },
  ];
  const drift = qaDriftCheck(items, [
    { repo: 'acme/operly', pr: 99, state: 'closed' },
    { repo: 'acme/operly', pr: 12, state: 'merged' },
  ]);
  // One entry per record even when it fails twice over; the live item b,
  // merged and threaded, is clean.
  assert.deepEqual(drift.map((d) => d.id), ['a']);
});

test('unconfigured repos never land, and concurrent merges land once', async () => {
  const refused = await upsertQaItem({ repo: 'acme/other', pr: 1, title: 'Not QA work', app: 'Studio' });
  assert.equal(refused, null);
  const [a, b] = await Promise.all([
    upsertQaItem({ repo: 'acme/operly', pr: 21, title: 'Race lander', app: 'Operly' }),
    upsertQaItem({ repo: 'acme/operly', pr: 21, title: 'Race lander', app: 'Operly' }),
  ]);
  assert.equal(a?.id, b?.id);
  const board = await qaBoard();
  assert.equal(board.martin.filter((i) => i.pr === 21).length, 1);
});

test('a validated card stays validated under a racing fail and a retried merge', async () => {
  const item = await upsertQaItem({ repo: 'acme/studio', pr: 22, title: 'Race outcomes', app: 'Studio' });
  assert.ok(item);
  await Promise.all([applyQaOutcome(item.id, 'validated'), applyQaOutcome(item.id, 'fail')]);
  const retried = await upsertQaItem({ repo: 'acme/studio', pr: 22, title: 'Race outcomes', app: 'Studio' });
  assert.equal(retried?.status, 'validated');
  const board = await qaBoard();
  assert.equal(board.edgar.filter((i) => i.pr === 22).length, 0);
});

test('a column shows at most eight cards per app, and parked cards wait off the board', async () => {
  for (let pr = 400; pr < 410; pr++) await upsertQaItem({ repo: 'acme/studio', pr, title: `Cap ${pr}`, app: 'Studio' });
  const capped = (await qaBoard()).edgar.filter((i) => i.app === 'Studio');
  assert.equal(capped.length, 8);
  const parked = capped[0];
  await applyQaOutcome(parked.id, 'parked');
  const after = (await qaBoard()).edgar.filter((i) => i.app === 'Studio');
  assert.equal(after.length, 8);
  assert.ok(!after.some((i) => i.id === parked.id));
  await applyQaOutcome(parked.id, 'up_next');
  assert.ok((await qaBoard()).edgar.some((i) => i.id === parked.id));
});

test('routing on a later signal moves an existing card; titles never name the builder', async () => {
  const synced = await upsertQaItem({ repo: 'acme/operly', pr: 23, title: 'Naomi — repair billing', app: 'Operly' });
  assert.equal(synced?.tester, 'martin');
  assert.equal(synced?.title, 'repair billing');
  const routed = await upsertQaItem({ repo: 'acme/operly', pr: 23, title: 'repair billing', app: 'Operly', needsSud: true });
  assert.equal(routed?.tester, 'sud');
});
