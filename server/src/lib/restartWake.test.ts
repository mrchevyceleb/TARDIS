import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { restartMarkerEvent } from '../chat/crashTombstone.ts';
import { unansweredRestartCutAt } from './restartWake.ts';

const cut = 1_000_000;
const boot = cut + 4_000;
const rows = (...extra: object[]) => [
  { seq: 1, at: cut - 5_000, ev: { type: 'turnStart' } },
  { seq: 2, at: cut, ev: restartMarkerEvent('SIGTERM') },
  ...extra,
];

function cutAt(lines: object[]): number | null {
  const dir = mkdtempSync(join(tmpdir(), 'restart-wake-'));
  try {
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, lines.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return unansweredRestartCutAt(file, { bootMs: boot });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('housekeeping the new process writes at boot never reads as the lane being back at work', () => {
  // What Claude Code wrote for Riley right after the restart: its killed
  // timers' notifications, an init, a zero-turn result, a turnEnd.
  const housekeeping = rows(
    { seq: 3, at: boot + 200, ev: { type: 'event', event: { type: 'system', subtype: 'task_notification', status: 'stopped' } } },
    { seq: 4, at: boot + 210, ev: { type: 'event', event: { type: 'system', subtype: 'init' } } },
    { seq: 5, at: boot + 220, ev: { type: 'event', event: { type: 'result', num_turns: 0 } } },
    { seq: 6, at: boot + 230, ev: { type: 'turnEnd' } },
  );
  assert.equal(cutAt(housekeeping), cut);
  // A turn that really starts after boot means someone already picked the lane up.
  assert.equal(cutAt([...housekeeping, { seq: 7, at: boot + 900, ev: { type: 'turnStart' } }]), null);
});
