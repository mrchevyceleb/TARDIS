import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = mkdtempSync(join(tmpdir(), 'voice-thread-'));
process.env.RIVENDELL_STATE_DIR = state;
const { formatCallContext, recordVoiceTranscript, VoiceTranscriptQueue, callThreadContext } = await import('./threadBridge.ts');
const { appendEventLog, loadEventLogSync, reserveEventLogSeq, flushAllEventChains } = await import('../chat/event-log-store.ts');
const { conversationGuidanceForTurn } = await import('../chat/conversation-guidance.ts');
const { extractVisibleTurns } = await import('../chat/threadWindow.ts');
const { lastEngineOf } = await import('../chat/threadKey.ts');
after(async () => { await flushAllEventChains(); rmSync(state, { recursive: true, force: true }); });

test('call context is bounded and continues the recent text conversation', () => {
  assert.equal(formatCallContext([]), '');
  const turns = Array.from({ length: 24 }, (_, i) => ({ role: 'user' as const, text: `topic-${i} ${'x'.repeat(2000)}`, seq: i + 1 }));
  const context = formatCallContext(turns, 'Earlier decision');
  assert.match(context, /SAME conversation/);
  assert.match(context, /Earlier decision/);
  assert.ok(context.length < 44000);
  assert.match(formatCallContext([{ role: 'user', text: 'Continue fixing the calendar', seq: 1 }]), /fixing the calendar/);
});

test('ASR arriving after the answer preserves user/answer order and dedupes user events', () => {
  const seen: string[] = [];
  const queue = new VoiceTranscriptQueue((role, text) => seen.push(`${role}:${text}`));
  queue.committed('audio-1');
  queue.assistant('The calendar is fixed');
  assert.deepEqual(seen, []);
  queue.user('audio-1', 'How is the calendar?');
  queue.user('audio-1', 'How is the calendar?');
  assert.deepEqual(seen, ['user:How is the calendar?', 'assistant:The calendar is fixed']);
  queue.committed('audio-2');
  queue.assistant('Please repeat that');
  queue.finish();
  assert.deepEqual(seen.slice(-2), ['user:[Voice message could not be transcribed]', 'assistant:Please repeat that']);
});

test('spoken turns persist, publish, and reach a warm native text continuation without switching engines', async () => {
  const key = 'thread|/synthetic-workspace|bot-test';
  appendEventLog(key, { seq: reserveEventLogSeq(key), eng: 'xai', ev: { type: 'event', event: { type: '_user_echo', text: 'Fix the calendar' } } });
  const published: number[] = [];
  const first = recordVoiceTranscript(key, 'user', 'Also move it to Friday', (event) => published.push(event.seq));
  const second = recordVoiceTranscript(key, 'assistant', 'Friday, understood', (event) => published.push(event.seq));
  await Promise.all([first, second]);
  const events = loadEventLogSync(key).events;
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(published, [2, 3]);
  assert.equal(lastEngineOf(events), 'xai');
  assert.deepEqual(extractVisibleTurns(events).map(({ role, text }) => [role, text]), [
    ['user', 'Fix the calendar'], ['user', 'Also move it to Friday'], ['assistant', 'Friday, understood'],
  ]);
  assert.match(callThreadContext(key), /Friday, understood/);
  assert.match(conversationGuidanceForTurn({ chatId: 'bot-test', logKey: key, historyThroughSeq: 3 }), /Also move it to Friday/);
  assert.doesNotMatch(conversationGuidanceForTurn({ chatId: 'bot-test', logKey: key, historyThroughSeq: 1 }), /Friday/);
});

test('voice does not reveal a concurrent hidden automation response', () => {
  const events = [
    { seq: 1, ev: { type: 'event', event: { type: 'peer_message', from: 'Automation', fromRole: 'automation', text: 'Routine' } } },
    { seq: 2, ev: { type: 'event', event: { type: '_voice_transcript', role: 'user', text: 'Hello from voice' } } },
    { seq: 3, ev: { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'NO_UPDATE' }] } } } },
  ];
  assert.deepEqual(extractVisibleTurns(events).map(({ text }) => text), ['Hello from voice']);
});


test('text streamed around voice keeps chronology without repeating the canonical prefix', () => {
  const stream = (seq: number, event: object) => ({ seq, ev: { type: 'event', event: { type: 'stream_event', event } } });
  const events = [
    stream(1, { type: 'message_start' }),
    stream(2, { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    stream(3, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Before voice. ' } }),
    { seq: 4, ev: { type: 'event', event: { type: '_voice_transcript', role: 'user', text: 'Spoken question' } } },
    stream(5, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'After voice.' } }),
    { seq: 6, ev: { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Before voice. After voice.' }] } } } },
  ];
  assert.deepEqual(extractVisibleTurns(events).map(({ text }) => text), ['Before voice.', 'Spoken question', 'After voice.']);
});
