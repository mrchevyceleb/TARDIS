// Unread-badge primitives for channels (card-1327b9): posts after the read
// marker count once, marking read clears them, a stale markRead for an older
// message can never move the marker backward, same-millisecond posts keep
// their creation order, and a purged channel re-seeds clean. The env module
// import MUST stay first: it redirects JsonStore state before channels.ts
// loads its stores.
import './channels-unread-env.ts';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { rmSync } from 'node:fs';
import {
  createChannel,
  nonMemberTags,
  postChannelMessage,
  listChannels,
  markChannelRead,
  channelHistory,
  deleteChannelMessages,
} from './channels.ts';

const unreadIn = async (id: string) => (await listChannels()).find((c) => c.id === id)?.unread ?? -1;

test('posts after the read marker count, and marking read clears the badge', async () => {
  const channel = await createChannel('badge-count', ['max']);
  assert.equal(await unreadIn(channel.id), 0);
  await postChannelMessage(channel.id, 'max', 'one');
  await postChannelMessage(channel.id, 'max', 'two');
  assert.equal(await unreadIn(channel.id), 2);
  await markChannelRead(channel.id);
  assert.equal(await unreadIn(channel.id), 0);
});

test('marking read up to a message stops there: an unseen newer reply keeps its badge', async () => {
  const channel = await createChannel('badge-upto', ['max']);
  await postChannelMessage(channel.id, 'kip', 'seen');
  await postChannelMessage(channel.id, 'kip', 'unseen');
  const rows = await channelHistory(channel.id, 10);
  const { unread } = await markChannelRead(channel.id, rows[0].id);
  assert.equal(unread, 1);
  assert.equal(await unreadIn(channel.id), 1);
});

test('a new post after read counts again', async () => {
  const channel = await createChannel('badge-again', ['max']);
  await postChannelMessage(channel.id, 'max', 'one');
  await markChannelRead(channel.id);
  await postChannelMessage(channel.id, 'max', 'two');
  assert.equal(await unreadIn(channel.id), 1);
});

test('marking read up to an older message never moves the marker backward', async () => {
  const channel = await createChannel('badge-regress', ['max']);
  await postChannelMessage(channel.id, 'max', 'one');
  await postChannelMessage(channel.id, 'max', 'two');
  await postChannelMessage(channel.id, 'max', 'three');
  const oldest = (await channelHistory(channel.id, 10))[0];
  await markChannelRead(channel.id); // read to head
  // A late/duplicate client call naming the oldest message must not regress.
  const { unread } = await markChannelRead(channel.id, oldest.id);
  assert.equal(unread, 0);
  assert.equal(await unreadIn(channel.id), 0);
  // And a message posted after the head still counts.
  await postChannelMessage(channel.id, 'max', 'four');
  assert.equal(await unreadIn(channel.id), 1);
});

test('same-millisecond posts keep their posting order in history and unread counting', async () => {
  const channel = await createChannel('badge-same-ms', ['max']);
  await postChannelMessage(channel.id, 'max', 'first');
  await postChannelMessage(channel.id, 'kip', 'second');
  await markChannelRead(channel.id);
  await postChannelMessage(channel.id, 'max', 'third');
  const rows = await channelHistory(channel.id, 10);
  assert.deepEqual(rows.map((r) => r.text), ['first', 'second', 'third']);
  assert.equal(await unreadIn(channel.id), 1);
});

test('a purged channel re-seeds to its head with no stale unread', async () => {
  const channel = await createChannel('badge-purge', ['max']);
  const first = await postChannelMessage(channel.id, 'max', 'one');
  await postChannelMessage(channel.id, 'max', 'two');
  await markChannelRead(channel.id, first);
  await deleteChannelMessages(channel.id);
  assert.equal(await unreadIn(channel.id), 0);
  await postChannelMessage(channel.id, 'max', 'fresh');
  assert.equal(await unreadIn(channel.id), 1);
});

test('nonMemberTags names tagged teammates who are not members, and nothing else', () => {
  const roster = ['Max', 'Kip', 'Sam Wise', 'Sam', 'Naomi'];
  // A tagged teammate outside the channel is named (case-insensitive).
  assert.deepEqual(nonMemberTags('hey @Kip and @naomi, look', ['Max', 'Sam'], roster), ['Kip', 'Naomi']);
  // Tags of members and unknown names are not refusals.
  assert.deepEqual(nonMemberTags('thanks @Max and @Stranger', ['Max', 'Sam'], roster), []);
  // Longest-name match: @Sam Wise is Sam Wise, not the member Sam.
  assert.deepEqual(nonMemberTags('ping @Sam Wise please', ['Max', 'Sam'], roster), ['Sam Wise']);
  // A member tag never refuses, and longer names still win for members.
  assert.deepEqual(nonMemberTags('ping @Sam please', ['Max', 'Sam'], roster), []);
  // Same token semantics as delivery: an @ inside a longer token still
  // counts (mirroring mentionedMembers), and each name is named once.
  assert.deepEqual(nonMemberTags('mail a@kip.example or @Kip attached', ['Max'], roster), ['Kip']);
  assert.deepEqual(nonMemberTags('no tags at all', ['Max'], roster), []);
});

after(() => {
  rmSync(process.env.RIVENDELL_STATE_DIR ?? '', { recursive: true, force: true });
});
