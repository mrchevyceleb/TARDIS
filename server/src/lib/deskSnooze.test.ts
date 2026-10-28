import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('snooze persists on the item, hides alerts and wakes once across notifier restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-snooze-'));
  process.env.RIVENDELL_STATE_DIR = dir;
  const { createTodo, readDesk, snoozeTodo, isTodoOpen, setTodoStatus, updateTodo } = await import('./deskStore.ts');
  const { createDeskNotifier, isQuietHours } = await import('./deskNotify.ts');
  try {
    const owner = { kind: 'owner' as const, id: 'owner', name: 'Owner' };
    const todo = await createTodo({ title: 'Review the proposal', priority: 'high' }, owner);
    assert.throws(() => snoozeTodo(todo.id, 12), /Choose/);
    for (const hours of [24, 48, 72, 168]) {
      const before = Date.now();
      const sleeping = await snoozeTodo(todo.id, hours);
      assert.ok(Date.parse(sleeping.snoozedUntil!) >= before + hours * 3_600_000);
      assert.equal(isTodoOpen(sleeping), false);
    }
    const sleeping = await snoozeTodo(todo.id, 24);
    assert.equal((await readDesk()).todos[0].id, todo.id);
    assert.equal(JSON.parse(await readFile(join(dir, 'desk.json'), 'utf8')).todos[0].snoozedUntil, sleeping.snoozedUntil);
    const sends: string[] = [];
    let at = new Date();
    while (isQuietHours(at)) at = new Date(at.getTime() + 60_000);
    const options = {
      now: () => at,
      stateFile: join(dir, 'notify.json'),
      send: async (payload: { title: string }) => { sends.push(payload.title); return { ok: true as const }; },
      log: () => {},
    };
    await createDeskNotifier(options).tick();
    assert.equal(sends.length, 0);
    let resetPushes = 0;
    const resetOptions = { ...options, stateFile: join(dir, 'future-notify.json'), send: async (payload: { title: string }) => { if (payload.title === todo.title) resetPushes++; return { ok: true as const }; } };
    await createDeskNotifier(resetOptions).tick();
    at = new Date(Date.parse(sleeping.snoozedUntil!));
    assert.equal(isTodoOpen(sleeping, at.getTime()), true);
    // Respect the existing push window, rather than changing notification policy.
    while (isQuietHours(at)) at = new Date(at.getTime() + 60_000);
    await createDeskNotifier(options).tick();
    assert.equal(sends.filter((title) => title === todo.title).length, 1);
    await createDeskNotifier(options).tick();
    assert.equal(sends.filter((title) => title === todo.title).length, 1);
    await createDeskNotifier(resetOptions).tick();
    await createDeskNotifier(resetOptions).tick();
    assert.equal(resetPushes, 1, 'a future wake survives first-run seeding and restart');
    // A missing notification state file must not replay an old wake-up.
    at = new Date(at.getTime() + 1000);
    await createDeskNotifier({ ...options, stateFile: join(dir, 'reset-notify.json') }).tick();
    assert.equal(sends.filter((title) => title === todo.title).length, 1);
    await snoozeTodo(todo.id, 48);
    const awake = await snoozeTodo(todo.id, null);
    assert.equal(isTodoOpen(awake), true);
    await createDeskNotifier(options).tick();
    assert.equal(sends.filter((title) => title === todo.title).length, 1);
    const repeated = await snoozeTodo(todo.id, 24);
    assert.equal(repeated.snoozeReturnedPriority, undefined);
    at = new Date(Math.max(at.getTime(), Date.parse(repeated.snoozedUntil!)));
    while (isQuietHours(at)) at = new Date(at.getTime() + 60_000);
    await createDeskNotifier(options).tick();
    await createDeskNotifier(options).tick();
    assert.equal(sends.filter((title) => title === todo.title).length, 2);
    const normal = await createTodo({ title: 'Pick a date' }, owner);
    await snoozeTodo(normal.id, 24);
    const normalReturn = await snoozeTodo(normal.id, null);
    assert.equal(normalReturn.snoozeReturnedPriority, 'normal');
    await createDeskNotifier(options).tick();
    assert.equal(sends.filter((title) => title === normal.title).length, 0, 'normal-priority early return stays silent with intact state');
    const normalResetSends: string[] = [];
    const normalReset = { ...options, stateFile: join(dir, 'normal-reset.json'), send: async (payload: { title: string }) => { normalResetSends.push(payload.title); return { ok: true as const }; } };
    await createDeskNotifier(normalReset).tick();
    assert.equal(normalResetSends.filter((title) => title === normal.title).length, 0, 'normal-priority early return stays silent after state reset');
    await updateTodo(normal.id, { priority: 'high' });
    await createDeskNotifier(options).tick();
    assert.equal(sends.filter((title) => title === normal.title).length, 1, 'promotion alerts with intact notification state');
    await createDeskNotifier(normalReset).tick();
    assert.equal(normalResetSends.filter((title) => title === normal.title).length, 1, 'promotion also alerts after notification state reset');
    const done = await setTodoStatus(todo.id, 'done', { note: 'Reviewed', by: owner });
    assert.equal(done.snoozedUntil, undefined);
    await assert.rejects(snoozeTodo(todo.id, 24), /already done/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bringing a high item back early keeps its later reminder across notifier restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-return-reminder-'));
  const { createDeskNotifier } = await import('./deskNotify.ts');
  try {
    let at = new Date('2026-10-26T12:00:00Z');
    const owner = { kind: 'owner' as const, id: 'owner', name: 'Owner' };
    const todo = { id: 'todo-return', title: 'Review proposal', status: 'open' as const, priority: 'high' as const,
      from: owner, createdAt: at.toISOString(), updatedAt: at.toISOString(), snoozedUntil: '2026-10-27T12:00:00Z',
      snoozeReturnedPriority: undefined as 'high' | undefined };
    const sends: string[] = [];
    const options = { now: () => at, readDesk: async () => ({ version: 1 as const, rev: 1, todos: [todo], cards: [] }),
      stateFile: join(dir, 'notify.json'), log: () => {},
      send: async (payload: { title: string }) => { sends.push(payload.title); return { ok: true as const }; } };
    const notifier = createDeskNotifier(options);
    await notifier.tick();
    at = new Date(at.getTime() + 60_000);
    todo.snoozedUntil = at.toISOString();
    todo.snoozeReturnedPriority = 'high';
    await notifier.tick();
    assert.equal(sends.length, 0, 'explicit return stays quiet');
    at = new Date(at.getTime() + 3 * 3_600_000);
    await createDeskNotifier(options).tick();
    assert.equal(sends.filter((title) => title === `Still waiting: ${todo.title}`).length, 1);
    await createDeskNotifier(options).tick();
    assert.equal(sends.filter((title) => title === `Still waiting: ${todo.title}`).length, 1, 'restart never repeats a reminder');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
