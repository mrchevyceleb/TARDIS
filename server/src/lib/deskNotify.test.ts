import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a side Desk stays quiet for new items and old reminders; only weekday digests send', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-digest-only-'));
  process.env.RIVENDELL_STATE_DIR = dir;
  const { createTodo, readDesk, setTodoStatus, snoozeTodo } = await import('./deskStore.ts');
  const { createDeskNotifier, pushoverSender } = await import('./deskNotify.ts');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T13:00:00Z') });
  const received: URLSearchParams[] = [];
  const sink = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push(new URLSearchParams(body));
    res.setHeader('Content-Type', 'application/json');
    res.end('{"status":1}');
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  try {
    const address = sink.address();
    assert.ok(address && typeof address !== 'string');
    const stateFile = join(dir, 'desk-notify.json');
    const options = {
      stateFile, readDesk, log: () => {},
      send: pushoverSender({ token: 'test-token', user: 'test-user', endpoint: `http://127.0.0.1:${address.port}` }),
    };
    let notifier = createDeskNotifier(options);
    await notifier.tick();
    t.mock.timers.setTime(Date.parse('2026-11-13T13:01:00Z'));
    const agent = { kind: 'agent' as const, id: 'test-agent', name: 'Test Agent' };
    const high = await createTodo({ title: 'Review the test proposal', priority: 'high' }, agent);
    const normal = await createTodo({ title: 'Choose a test date', priority: 'normal' }, agent);
    const low = await createTodo({ title: 'Read the test note', priority: 'low' }, agent);
    await notifier.tick();
    assert.equal(received.length, 0, 'adding items at every priority sends nothing');
    assert.equal((await readDesk()).todos.length, 3, 'the items really persist on the side Desk');

    // Upgrade a real version-1 file with an old successful push and pending retry.
    await writeFile(stateFile, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), digests: {}, items: {
      [high.id]: { push: { tries: 1, sentAt: new Date().toISOString() }, renudge: { tries: 1, lastTryAt: new Date().toISOString() } },
      [normal.id]: { push: { tries: 1, lastTryAt: new Date().toISOString() } },
    } }));
    notifier = createDeskNotifier(options);
    t.mock.timers.setTime(Date.parse('2026-11-13T16:01:00Z')); // 11:01 ET, three hours later
    await notifier.tick();
    assert.equal(received.length, 0, 'legacy push retries and three-hour reminders stay silent after restart');
    await setTodoStatus(high.id, 'done', { by: agent, note: 'Test resolved' });
    await notifier.tick();
    await setTodoStatus(high.id, 'open');
    await notifier.tick();
    assert.equal(received.length, 0, 'reopening also stays quiet');

    for (const instant of ['2026-11-13T18:30:00Z', '2026-11-13T21:30:00Z', '2026-11-16T14:30:00Z']) {
      const before: number = received.length;
      t.mock.timers.setTime(Date.parse(instant));
      await notifier.tick();
      assert.equal(received.length, before + 1, 'each weekday slot still sends a digest');
      assert.equal(received.at(-1)!.get('title'), 'Needs you');
      assert.equal(received.at(-1)!.get('priority'), '0');
      assert.match(received.at(-1)!.get('message')!, /^3 open:/);
      notifier = createDeskNotifier(options);
      await notifier.tick();
      assert.equal(received.length, before + 1, 'restart never repeats a digest');
      if (instant.includes('21:30')) {
        t.mock.timers.setTime(Date.parse('2026-11-14T14:30:00Z'));
        await notifier.tick();
        assert.equal(received.length, before + 1, 'weekend slots stay quiet');
      }
    }
    for (const todo of [normal, low]) await setTodoStatus(todo.id, 'done', { by: agent, note: 'Test complete' });
    await snoozeTodo(high.id, 24);
    t.mock.timers.setTime(Date.parse('2026-11-16T18:30:00Z'));
    await notifier.tick();
    assert.equal(received.length, 3, 'a Desk with only a snoozed item sends no digest');
    t.mock.timers.setTime(Date.parse('2026-11-17T14:30:00Z'));
    await notifier.tick();
    assert.equal(received.length, 4, 'a woken item joins the next digest');
    assert.match(received.at(-1)!.get('message')!, /Review the test proposal/);
    await setTodoStatus(high.id, 'done', { by: agent, note: 'Test complete' });
    t.mock.timers.setTime(Date.parse('2026-11-17T18:30:00Z'));
    await notifier.tick();
    assert.equal(received.length, 4, 'an empty Desk sends no digest');
  } finally {
    await new Promise<void>((resolve, reject) => sink.close((error) => error ? reject(error) : resolve()));
    t.mock.timers.reset();
    await rm(dir, { recursive: true, force: true });
  }
});

test('answer retries continue after a day until delivery succeeds, even without phone credentials', async () => {
  const { createDeskNotifier } = await import('./deskNotify.ts');
  const answeredAt = Date.parse('2026-11-13T13:00:00Z');
  let at = answeredAt;
  let attempts = 0;
  const answer = { at: new Date(answeredAt).toISOString(), text: 'Yes', delivery: 'failed' as 'failed' | 'sent' };
  const notifier = createDeskNotifier({
    send: null, now: () => new Date(at), log: () => {},
    readDesk: async () => ({ version: 1, rev: 1, cards: [], todos: [{
      id: 'todo-answer', title: 'Test answer', priority: 'high', status: 'done',
      from: { kind: 'agent', id: 'test-agent', name: 'Test Agent' },
      createdAt: answer.at, updatedAt: answer.at, answer,
    }] }),
    retryAnswer: async (id) => {
      assert.equal(id, 'todo-answer');
      attempts++;
      if (attempts === 3) answer.delivery = 'sent';
      return { delivered: answer.delivery === 'sent', to: 'test-agent' };
    },
  });
  await notifier.tick();
  assert.equal(attempts, 0);
  for (const elapsed of [60_000, 31 * 60_000, 25 * 3_600_000]) {
    at = answeredAt + elapsed;
    await notifier.tick();
  }
  assert.equal(attempts, 3);
  assert.equal(answer.delivery, 'sent');
  at += 3_600_000;
  await notifier.tick();
  assert.equal(attempts, 3, 'delivered answers stop retrying');
});
