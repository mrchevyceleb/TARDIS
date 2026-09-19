import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexHomeFor, codexRolloutMissing, latestThreadIdFromEvents } from './codex-threads.ts';
import type { SeqEvent } from './runner.ts';

type Stamped = SeqEvent & { eng?: string };

const init = (seq: number, sessionId: string, eng?: string): Stamped => ({
  seq,
  ev: { type: 'event', event: { type: 'system', subtype: 'init', session_id: sessionId } } as SessionEventLike,
  ...(eng ? { eng } : {}),
});
const turnEnd = (seq: number, sessionId: string, eng?: string): Stamped => ({
  seq,
  ev: { type: 'turnEnd', sessionId } as SessionEventLike,
  ...(eng ? { eng } : {}),
});
type SessionEventLike = SeqEvent['ev'];

test('a foreign engine session id is never recovered as our thread id', () => {
  // The exact shape that resumed a Claude session id on the codex lane and
  // failed every later turn with "no rollout found for thread id".
  const log: Stamped[] = [
    init(2, 'claude-session', 'claude'),
    turnEnd(783, 'claude-session', 'claude'),
  ];
  assert.equal(latestThreadIdFromEvents(log, 'codex'), null);
  assert.equal(latestThreadIdFromEvents(log, 'claude'), 'claude-session');
});

test('our own thread id still wins, stamped or freshly emitted', () => {
  const log: Stamped[] = [
    init(2, 'claude-session', 'claude'),
    turnEnd(783, 'claude-session', 'claude'),
    init(784, 'codex-thread-a', 'codex'),
    // Events this process just emitted carry no provenance stamp yet.
    turnEnd(790, 'codex-thread-b'),
  ];
  assert.equal(latestThreadIdFromEvents(log, 'codex'), 'codex-thread-b');
});

const rolloutStore = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const day = join(home, 'sessions', '2026', '09', '19');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-2026-09-19T13-17-45-01a0baac-8c89-74b1-a3aa-f865680e3643.jsonl'), '');
  return home;
};

test('a rollout that is present is resumable', () => {
  assert.equal(
    codexRolloutMissing(rolloutStore(), '01a0baac-8c89-74b1-a3aa-f865680e3643'),
    false,
  );
});

test('a pruned rollout in a populated store is proven missing', () => {
  assert.equal(
    codexRolloutMissing(rolloutStore(), '326883bc-1921-4d23-9405-e9877665ec47'),
    true,
  );
});

test('a compressed rollout still counts as resumable', () => {
  const home = rolloutStore();
  const day = join(home, 'sessions', '2026', '09', '18');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-2026-09-18T09-02-11-0199a0de-1f4c-7a10-9f3d-2b6d5c41e701.jsonl.zst'), '');
  assert.equal(codexRolloutMissing(home, '0199a0de-1f4c-7a10-9f3d-2b6d5c41e701'), false);
});

test('an unknown or unreadable store never discards a thread id', () => {
  const empty = mkdtempSync(join(tmpdir(), 'codex-home-'));
  assert.equal(codexRolloutMissing(empty, 'any-thread'), false);
  assert.equal(codexRolloutMissing(join(empty, 'nope'), 'any-thread'), false);
  // A store whose layout we don't recognise holds no rollout-*.jsonl files.
  const foreign = mkdtempSync(join(tmpdir(), 'codex-home-'));
  mkdirSync(join(foreign, 'sessions'), { recursive: true });
  writeFileSync(join(foreign, 'sessions', 'threads.sqlite'), '');
  assert.equal(codexRolloutMissing(foreign, 'any-thread'), false);
  assert.equal(codexRolloutMissing(rolloutStore(), ''), false);
});

test('codex home follows the account env the turn bills', () => {
  assert.equal(codexHomeFor({ CODEX_HOME: '/home/someone/.codex-work' }), '/home/someone/.codex-work');
  assert.equal(codexHomeFor({ CODEX_HOME: '  ' }).endsWith('/.codex'), true);
  assert.equal(codexHomeFor({}).endsWith('/.codex'), true);
});
