import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from './jsonStore.ts';

type Item = { id: string; value: string };

test('JsonStore writes atomically and refuses to erase corrupt state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tardis-json-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'items.json');
  const store = new JsonStore<Item>('items.json', [], directory);

  await store.create({ value: 'kept' });
  assert.equal((await store.list())[0]?.value, 'kept');
  assert.deepEqual(await readdir(directory), ['items.json']);

  await writeFile(path, '{broken', 'utf8');
  await assert.rejects(() => store.list(), /refusing to overwrite stored data/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('JsonStore first write survives a concurrent first read', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tardis-json-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore<Item>('items.json', [], directory);

  // Fresh store: an unqueued read and the first queued mutation race. The
  // read must not seed-write and erase the record.
  const [listed, created] = await Promise.all([store.list(), store.create({ value: 'first' })]);
  assert.deepEqual(listed, []);
  const after = await store.list();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, created.id);
  assert.equal(after[0].value, 'first');
});
