import test from 'node:test';
import assert from 'node:assert/strict';
import { clampReplayWindow, collapseHistoricalToolArgs, historicalDelivery, REPLAY_MAX_EVENTS, subscriptionReplayCursor } from './replayDelivery.ts';

test('a no-replay rebind never subscribes from sequence zero', () => {
  assert.equal(subscriptionReplayCursor(-1, 0), -1);
  assert.equal(subscriptionReplayCursor(-1, 900), -1);
  assert.equal(subscriptionReplayCursor(0, 40), 40);
  assert.equal(subscriptionReplayCursor(100, 40), 100);
});

test('old close/502/turn controls cannot tear down the current session during replay', () => {
  const notice = { seq: 3, ev: { type: 'event', event: { type: '_terminal_error', code: '502', message: 'Previous request failed.' } } };
  const frames = [
    { seq: 1, ev: { type: 'turnStart' } },
    { seq: 2, ev: { type: 'error', code: '502', message: 'Old transport failure' } },
    notice,
    { seq: 4, ev: { type: 'turnEnd' } },
    { seq: 5, ev: { type: 'closed', code: 0 } },
  ];
  assert.deepEqual(frames.map(historicalDelivery).filter(Boolean), [notice]);
  // A current live close is not run through historicalDelivery by the binder.
  const latest = 5;
  const live = { seq: 6, ev: { type: 'closed', code: 1 } };
  assert.equal(live.seq <= latest ? historicalDelivery(live) : live, live);
});

test('legacy Banana failures remain transcript notices, not current send failures', () => {
  const frame = { seq: 10, ev: { type: 'error', code: 'BANANA_TURN_FAILED', message: 'Past failure', retryable: true } };
  assert.deepEqual(historicalDelivery(frame), { seq: 10, ev: { type: 'event', event: {
    type: '_terminal_error', code: 'BANANA_TURN_FAILED', message: 'Past failure', retryable: true,
  } } });
});

test('replayed tool output is trimmed to what the transcript renders', () => {
  const big = `${'x'.repeat(40)}\n${'y'.repeat(20_000)}`;
  const frame = { seq: 11, ev: { type: 'event', event: { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: big }, { type: 'image', source: { data: 'AAAA' } }] },
  ] } } } };
  const out = historicalDelivery(frame) as typeof frame;
  const item = (out.ev as any).event.message.content[0];
  // Images never render in a tool card, and the text is capped well above the
  // 80-character preview, so the first line still reads identically.
  assert.deepEqual(item.content.map((c: any) => c.type), ['text']);
  assert.equal(item.content[0].text.length, 1000);
  assert.equal(item.content[0].text.split('\n')[0], 'x'.repeat(40));
  assert.equal(item.tool_use_id, 't1');
  // The durable log is shared in memory: trimming must not mutate it.
  assert.equal((frame.ev as any).event.message.content[0].content.length, 2);

  // Output already inside the budget is passed through untouched.
  const small = { seq: 12, ev: { type: 'event', event: { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'ok' }] },
  ] } } } };
  assert.equal(historicalDelivery(small), small);
});

test('a cold attach replays the newest window, never the whole forever-thread', () => {
  const total = REPLAY_MAX_EVENTS * 2;
  const frames = Array.from({ length: total }, (_, i) => ({ seq: i + 1, ev: { type: 'event', event: { type: 'x' } } }));
  const clamped = clampReplayWindow(frames, total);
  assert.equal(clamped.length, REPLAY_MAX_EVENTS);
  // The tail is what renders: the newest event must survive, the oldest must not.
  assert.equal(clamped.at(-1)?.seq, total);
  assert.equal(clamped[0].seq, total - REPLAY_MAX_EVENTS + 1);

  // A byte-heavy thread binds on the byte budget well before the count one.
  const heavy = Array.from({ length: 900 }, (_, i) => ({ seq: i + 1, ev: { text: 'z'.repeat(20_000) } }));
  assert.ok(clampReplayWindow(heavy, 900).length < 100);

  // Unseen live events are never history and are never dropped.
  const historyThrough = REPLAY_MAX_EVENTS + 500;
  const withLive = [
    ...Array.from({ length: historyThrough }, (_, i) => ({ seq: i + 1, ev: { type: 'event' } })),
    ...Array.from({ length: 30 }, (_, i) => ({ seq: historyThrough + 1 + i, ev: { type: 'event' } })),
  ];
  const mixed = clampReplayWindow(withLive, historyThrough);
  assert.equal(mixed.filter((f) => f.seq > historyThrough).length, 30);
  assert.equal(mixed.filter((f) => f.seq <= historyThrough).length, REPLAY_MAX_EVENTS);

  // A short thread is passed through by reference, not copied.
  const short = [{ seq: 1, ev: { type: 'event' } }];
  assert.equal(clampReplayWindow(short, 1), short);
});

test('replayed tool-argument streams collapse without changing what renders', () => {
  const argsDelta = (seq: number, index: number, partial_json: string) => ({
    seq, ev: { type: 'event', event: { type: 'stream_event', event: {
      type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json },
    } } },
  });
  const full = JSON.stringify({ file_path: '/tmp/a.ts', content: 'x'.repeat(40_000), limit: 12 });
  const frames = [
    { seq: 1, ev: { type: 'event', event: { type: 'stream_event', event: { type: 'content_block_start', index: 0 } } } },
    ...[...full].map((ch, i) => argsDelta(i + 2, 0, ch)),
    { seq: full.length + 2, ev: { type: 'event', event: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } } },
  ];
  const out = collapseHistoricalToolArgs(frames, full.length + 2);
  // One frame for the whole run, still bracketed by start/stop.
  assert.equal(out.length, 3);
  assert.equal((out[1].ev as any).event.event.delta.type, 'input_json_delta');
  // It lands on the run's last seq so ordering inside the block is preserved.
  assert.equal(out[1].seq, full.length + 1);
  const args = JSON.parse((out[1].ev as any).event.event.delta.partial_json);
  assert.deepEqual(Object.keys(args), ['file_path', 'content', 'limit']);
  assert.equal(args.file_path, '/tmp/a.ts');
  // The client clips every value at 60 chars, so the visible text is unchanged.
  assert.equal(args.content.slice(0, 60), 'x'.repeat(60));
  assert.equal(String(args.limit).slice(0, 60), '12');
  assert.ok(JSON.stringify(args).length < 400);

  // Runs for different blocks stay separate, and live deltas are untouched.
  const twoBlocks = [argsDelta(1, 0, '{"a":'), argsDelta(2, 0, '1}'), argsDelta(3, 1, '{"b":2}')];
  assert.equal(collapseHistoricalToolArgs(twoBlocks, 3).length, 2);
  assert.equal(collapseHistoricalToolArgs(twoBlocks, 0), twoBlocks);
});
