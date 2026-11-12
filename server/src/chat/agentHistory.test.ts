// The live history writer against disposable state (Matt, Nov 12 2026: a chat
// was lost because the thread reset five minutes later and the transcript was
// only rebuilt every 30). What is said reaches the agent's transcript within a
// moment on any engine, and a reset can never erase it.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agent-history-'));
const previous = { state: process.env.RIVENDELL_STATE_DIR, owner: process.env.RIVENDELL_OWNER_NAME };
after(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previous.state === undefined) delete process.env.RIVENDELL_STATE_DIR; else process.env.RIVENDELL_STATE_DIR = previous.state;
  if (previous.owner === undefined) delete process.env.RIVENDELL_OWNER_NAME; else process.env.RIVENDELL_OWNER_NAME = previous.owner;
});
process.env.RIVENDELL_STATE_DIR = dir;
process.env.RIVENDELL_OWNER_NAME = 'Owner';
mkdirSync(join(dir, 'personas'), { recursive: true });
writeFileSync(join(dir, 'personas', 'agents.json'), JSON.stringify({ agents: [
  { id: 'ava', name: 'Ava', role: 'Personal', engine: 'claude', home: 'bot-ava', createdAt: 1 },
  { id: 'cole', name: 'Cole', role: 'Developer', engine: 'codex', home: 'bot-cole', createdAt: 2 },
  { id: 'dee', name: 'Dee', role: 'Research', engine: 'pi', home: 'bot-dee', createdAt: 3 },
] }));

const { ASSISTANT_HUB_PATH } = await import('./config.ts');
const { threadLogKey } = await import('./threadKey.ts');
const store = await import('./event-log-store.ts');
const { agentHistoryPath, recentHistory, startAgentHistory } = await import('./agentHistory.ts');
const { peekEnginePrimerWithStatus } = await import('./compaction.ts');

const ava = threadLogKey(ASSISTANT_HUB_PATH, 'bot-ava');
const cole = threadLogKey(ASSISTANT_HUB_PATH, 'bot-cole');
const dee = threadLogKey(ASSISTANT_HUB_PATH, 'bot-dee');
const event = (inner: unknown) => ({ type: 'event', event: inner }) as any;
const echo = (key: string, text: string) => store.appendEventLogSync(key, { seq: store.reserveEventLogSeq(key), at: Date.now(), ev: event({ type: '_user_echo', text }) });
const frame = (key: string, ev: any) => store.appendEventLog(key, { seq: store.reserveEventLogSeq(key), at: Date.now(), ev });
const streamed = (key: string, text: string) => {
  frame(key, event({ type: 'stream_event', event: { type: 'message_start' } }));
  frame(key, event({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }));
  for (const piece of text.match(/.{1,12}/g) ?? []) frame(key, event({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } }));
};
const turnEnd = (key: string) => frame(key, { type: 'turnEnd' });
const transcript = (id: string) => (existsSync(agentHistoryPath(id)) ? readFileSync(agentHistoryPath(id), 'utf8') : '');
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Before boot: the old transcript ends at a watermark (its frame no longer in
// the log), and the log holds an exchange the transcript never got (the server
// was down). The file is not in seq order: the owner's follow-up (5) was
// written the moment it was sent, ahead of the reply frame queued before it
// (4), which an older build logged without a time.
mkdirSync(join(dir, 'agent-notes', 'ava'), { recursive: true });
writeFileSync(agentHistoryPath('ava'), '# Ava — conversation history\n\n**Owner** (Nov 11, 2026, 9:00 AM)\nAlready written earlier.\n');
const t0 = Date.now() - 60_000;
for (const [seq, ev] of [[1, event({ type: '_user_echo', text: 'Already written earlier.' })], [2, { type: 'turnEnd' }],
  [3, event({ type: '_user_echo', text: 'Missed while the server was down?' })],
  [5, event({ type: '_user_echo', text: 'Also, is the porch light off?' })],
  [4, event({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(5000) } }, { type: 'text', text: 'Caught up after the restart.' }] } })],
  [6, event({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Yes, the porch light is off.' }] } })],
  [7, { type: 'turnEnd' }]] as const) {
  store.appendEventLogSync(ava, { seq, ...(seq === 4 ? {} : { at: t0 + seq }), ev });
}
writeFileSync(join(dir, 'agent-notes', 'ava', '.state.json'), JSON.stringify({ lanes: { [`${store.sanitizeKey(ava)}.jsonl`]: { at: t0 + 2, seq: 99 } } }));
// Dee's log holds an unwritten message, but the log cannot be read at boot.
store.appendEventLogSync(dee, { seq: 1, at: t0, ev: event({ type: '_user_echo', text: 'Book the dentist for Friday.' }) });
chmodSync(join(dir, 'event-logs', `${store.sanitizeKey(dee)}.jsonl`), 0o000);
await startAgentHistory();

test('boot resumes after the watermark without repeating what was written', () => {
  const text = transcript('ava');
  assert.equal(text.split('Already written earlier.').length - 1, 1);
  assert.match(text, /\*\*Owner\*\* \([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M\)\nMissed while the server was down\?/);
  const said = ['Missed while the server was down?', 'Caught up after the restart.', 'Also, is the porch light off?', 'Yes, the porch light is off.']
    .map((line) => text.indexOf(line));
  assert.ok(said.every((at, i) => at >= 0 && (i === 0 || at > said[i - 1])), text);
  assert.ok(!text.includes('xxxxx'), 'tool input never reaches the transcript');
});

test('a streamed reply lands within a moment of the turn ending, every message whole', async () => {
  const long = `Ship the fix? ${'Here is the next line of the stack trace. '.repeat(14000)}End of trace.`;
  echo(cole, long);
  streamed(cole, 'Merged and deployed; the fix is live.');
  turnEnd(cole);
  await until(() => transcript('cole').includes('Merged and deployed; the fix is live.'), 'streamed reply');
  assert.match(transcript('cole'), /\*\*Owner\*\* \(.+\)\nShip the fix\?/);
  assert.ok(transcript('cole').includes(`${long}\n\n**Cole** (`), 'a 588k-character message is kept whole');
  assert.deepEqual(recentHistory('cole', 2).map((entry) => entry.who), ['Owner', 'Cole'], 'and never hides what came before it');
});

test('a thread reset writes everything first, a reply cut off mid-stream included', async () => {
  echo(ava, 'Find me a charging station for the desk.');
  streamed(ava, 'The 8-port one with 240W fits best.');
  turnEnd(ava);
  echo(ava, 'this?');
  streamed(ava, 'Yes, that model has two AC outl');
  // A teammate's new-job reset lands before the debounce: nothing may be lost.
  assert.equal(await store.clearEventLog(ava), true);
  assert.equal(store.loadEventLogSync(ava).events.length, 0);
  const text = transcript('ava');
  // In the order it was said, though each owner message hit the file ahead of the queued reply frames.
  const order = ['Find me a charging station', 'The 8-port one with 240W fits best.', 'this?', 'Yes, that model has two AC outl', '**Thread reset**']
    .map((said) => text.indexOf(said));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), text);
  // The job quotes the reset marker line; it must not pass for the marker.
  const marker = transcript('ava').split('\n').find((line) => line.startsWith('**Thread reset** ('));
  const job = store.reserveEventLogSeq(ava);
  store.appendEventLogSync(ava, { seq: job, at: Date.now(), ev: event({ type: 'peer_message', from: 'Max', fromRole: 'Chief of Staff', text: `New job: clean start.\n${marker}`, deliveryId: 'd-1' }) });
  await until(() => transcript('ava').includes('New job: clean start.'), 'post-reset message');
  assert.ok(transcript('ava').indexOf('**Thread reset**') < transcript('ava').indexOf('**Max**'));
  assert.ok(recentHistory('ava', 20).some((entry) => entry.who === 'Owner' && entry.text.includes('charging station')));
});

test('a clear is refused while the history cannot be written, or its backlog read', async () => {
  const deeLog = join(dir, 'event-logs', `${store.sanitizeKey(dee)}.jsonl`);
  assert.equal(await store.clearEventLog(dee), false);
  chmodSync(deeLog, 0o600);
  assert.equal(await store.clearEventLog(dee), true);
  assert.ok(transcript('dee').includes('Book the dentist for Friday.'), transcript('dee'));

  echo(cole, 'Keep this one.');
  chmodSync(agentHistoryPath('cole'), 0o400);
  try {
    assert.equal(await store.clearEventLog(cole), false);
    assert.ok(store.loadEventLogSync(cole).events.length > 0, 'the old thread stays');
  } finally {
    chmodSync(agentHistoryPath('cole'), 0o600);
  }
  assert.equal(await store.clearEventLog(cole), true);
  assert.ok(transcript('cole').includes('Keep this one.'));
});

test('a fresh session is pointed at its own history, and at what came just before its reset, in one step', () => {
  const primer = peekEnginePrimerWithStatus(ava).primer;
  assert.ok(primer.includes(`tail -n 80 "${agentHistoryPath('ava')}"`));
  // The Becca case: asked about "our latest convo" after a teammate's reset,
  // the fresh thread knows who it was with and gets that conversation back.
  assert.match(primer, /Your thread was last reset on [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M, right after a conversation with Owner\./);
  const command = /`(grep -n -x -F -B [^`]+)`/.exec(primer)?.[1];
  assert.ok(command, primer);
  const before = execFileSync('bash', ['-c', command], { encoding: 'utf8' });
  assert.ok(before.includes('Find me a charging station for the desk.') && before.includes('Yes, that model has two AC outl'), before);
  assert.ok(before.trimEnd().endsWith(')') && before.includes('**Thread reset**') && !before.includes('New job: clean start.'), before);
  assert.ok(!peekEnginePrimerWithStatus(`claude|${dir}|studio-1`).primer.includes('agent-notes'));
});
