import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceWork } from './voiceWork.ts';

test('ending audio waits for durable admission, not for work to finish', async () => {
  let queued!: () => void;
  let complete!: (value: { delivered: boolean; reply: string }) => void;
  let dispatches = 0;
  const work = new VoiceWork((_text, opts) => {
    dispatches++;
    queued = opts.onQueued;
    assert.equal(opts.wait, true);
    assert.equal('signal' in opts, false);
    return new Promise((resolve) => { complete = resolve; });
  });
  work.userItem('audio-1');
  const running = work.run('tool-1', JSON.stringify({ request: 'Research two more repair shops. Do not contact them.' }));
  await Promise.resolve();
  const ended = work.finish();
  queued();
  assert.equal(await ended, undefined);
  assert.equal(dispatches, 1);
  // A repeated ASR item does not create another user request.
  work.userItem('audio-1');
  complete({ delivered: true, reply: 'Found two verified options.' });
  assert.equal((await running).reply, 'Found two verified options.');
  assert.equal(await work.finish(), undefined);
});

test('repeated provider function events execute only once', async () => {
  let dispatches = 0;
  const work = new VoiceWork(async (_text, opts) => {
    dispatches++; opts.onQueued(); return { delivered: true, reply: 'Done' };
  });
  work.userItem('audio-1');
  const first = work.run('same-tool', '{"request":"Check the hours"}');
  assert.equal(work.run('same-tool', '{"request":"Check the hours"}'), first);
  assert.equal(work.run('regenerated-tool-id', '{"request":"  Check the hours  "}'), first);
  await first;
  assert.equal(dispatches, 1);
});

test('hangup retries only an explicit action whose admission failed, once', async () => {
  const dispatched: string[] = [];
  const work = new VoiceWork(async (text, opts) => {
    dispatched.push(text);
    if (opts.wait) return { delivered: false, reason: 'temporary queue failure' };
    opts.onQueued(); return { delivered: true, queued: true };
  });
  work.userItem('audio-1');
  await work.run('tool', '{"request":"Find two more options"}');
  const ended = work.finish();
  assert.equal(work.finish(), ended);
  assert.equal((await ended)?.delivered, true);
  assert.deepEqual(dispatched, ['Find two more options', 'Find two more options']);
});

test('ordinary conversation never launches a classifier or tool runner on hangup', async () => {
  let dispatches = 0;
  const work = new VoiceWork(async () => { dispatches++; return { delivered: true }; });
  work.userItem('hello'); work.userItem('goodbye');
  assert.equal(await work.finish(), undefined);
  assert.equal(dispatches, 0);
});

test('empty calls and malformed function arguments cannot launch work', async () => {
  let dispatched = 0;
  const work = new VoiceWork(async () => { dispatched++; return { delivered: true }; });
  assert.equal((await work.run('historical-only', '{"request":"Repeat an old task"}')).delivered, false);
  work.userItem('audio-1');
  assert.equal((await work.run('bad-json', '{broken')).delivered, false);
  assert.equal((await work.run('empty', '{"request":""}')).delivered, false);
  assert.equal(await work.finish(), undefined);
  assert.equal(dispatched, 0);
});
