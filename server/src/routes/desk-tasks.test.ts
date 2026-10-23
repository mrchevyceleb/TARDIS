import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';

test('GET /api/desk/tasks is a small projection, excluding archived, shipped and old parked work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-tasks-'));
  const before = { state: process.env.RIVENDELL_STATE_DIR, desk: process.env.RIVENDELL_DESK_FILE };
  process.env.RIVENDELL_STATE_DIR = dir;
  process.env.RIVENDELL_DESK_FILE = join(dir, 'desk.json');
  // Import after isolating all state: never read a developer's real Desk.
  const { deskRouter } = await import('./desk.ts');
  const now = Date.now();
  const owner = { kind: 'agent', id: 'test-agent', name: 'Teammate' };
  const card = (id: string, column = 'in_progress', ageDays = 0, archived = false) => ({
    id, title: `Task ${id}`, owner, column, archived, updatedAt: new Date(now - ageDays * 86_400_000).toISOString(),
    createdAt: new Date(now).toISOString(), columnSince: new Date(now).toISOString(), priority: 'normal',
    description: 'Not part of the sidebar payload', links: ['https://example.com/private-detail'],
    comments: [{ id: 'comment-test', author: owner, text: 'Not part of the sidebar payload', at: new Date(now).toISOString() }],
  });
  await writeFile(process.env.RIVENDELL_DESK_FILE, JSON.stringify({
    version: 1, rev: 42,
    todos: [{ id: 'todo-test', title: 'Not part of the sidebar payload', from: owner }],
    cards: [card('current'), card('waiting', 'in_qa'), card('staging', 'on_staging'), card('next', 'not_started', 29),
      card('old-next', 'not_started', 31), card('archived', 'in_progress', 0, true), card('shipped', 'in_production')],
  }));
  const app = express();
  app.use('/api/desk', deskRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/desk/tasks`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { rev: number; cards: Array<Record<string, unknown>> };
    assert.deepEqual(Object.keys(payload).sort(), ['cards', 'rev']);
    assert.equal(payload.rev, 42);
    assert.deepEqual(payload.cards.map((c) => c.id), ['current', 'waiting', 'staging', 'next']);
    for (const projected of payload.cards) {
      assert.deepEqual(Object.keys(projected).sort(), ['column', 'id', 'owner', 'title', 'updatedAt']);
      assert.deepEqual(projected.owner, owner);
    }
    assert.doesNotMatch(JSON.stringify(payload), /private-detail|sidebar payload/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (before.state === undefined) delete process.env.RIVENDELL_STATE_DIR;
    else process.env.RIVENDELL_STATE_DIR = before.state;
    if (before.desk === undefined) delete process.env.RIVENDELL_DESK_FILE;
    else process.env.RIVENDELL_DESK_FILE = before.desk;
    await rm(dir, { recursive: true, force: true });
  }
});
