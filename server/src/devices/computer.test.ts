import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ComputerController, trustedComputerUrl } from '../../../desktop/native/computer.mjs';
import { localMcpServers, localMcpBananaServers, localMcpCodexArgs } from '../chat/local-mcp.ts';
import { computerGuidance, readComputerContext } from './context.ts';
import { ComputerStepJournal } from './stepJournal.ts';

async function fixture(approve: () => Promise<boolean> = async () => true, automatic: () => boolean = () => false) {
  const bounds = { x: -3200, y: 0, width: 3200, height: 1600 };
  const png = await sharp({ create: { width: 3200, height: 1600, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const actions: Record<string, any>[] = [];
  const computer = new ComputerController({ approve, automatic, adapter: {
    capability: { supported: true },
    inspect: async () => ({ displays: [{ id: 'left', bounds }], windows: [] }),
    capture: async () => ({ png, bounds }),
    act: async action => { actions.push(action); }, release: async () => {},
  } });
  return { computer, actions };
}
const task = { owner: 'agent:test', label: 'Test agent', purpose: 'Use a synthetic test window.' };

test('native grant is required, exclusive, scoped to its session and revocable', async t => {
  const { computer } = await fixture(); t.after(() => computer.stop());
  await assert.rejects(computer.handle('start', { ...task, deadlineAt: Date.now() - 1000 }), /expired/);
  await assert.rejects(computer.handle('capture', { session: 'invented' }), /No active/);
  const grant = await computer.handle('start', task);
  await assert.rejects(computer.handle('start', { ...task, owner: 'other' }), /in use/);
  await assert.rejects(computer.handle('inspect', { session: 'other' }), /No active/);
  await assert.rejects(computer.handle('end', { session: 'other' }), /No active/);
  await computer.handle('end', { session: grant.session });
  await assert.rejects(computer.handle('capture', { session: grant.session }), /No active/);
  assert.equal(computer.status().control, null);
});

test('denial and Stop during a pending approval cannot create a grant', async () => {
  const denied = await fixture(async () => false);
  await assert.rejects(denied.computer.handle('start', task), /declined/);
  let answer!: (value: boolean) => void;
  const pending = await fixture(() => new Promise(resolve => { answer = resolve; }));
  const promise = pending.computer.handle('start', task);
  await new Promise(resolve => setImmediate(resolve));
  pending.computer.stop(); answer(true);
  await assert.rejects(promise, /stopped/);
  assert.equal(pending.computer.status().control, null);
});

test('resized monitor coordinates map to negative OS bounds; frames are one-use', async t => {
  const { computer, actions } = await fixture(); t.after(() => computer.stop());
  const { session } = await computer.handle('start', task);
  const frame = await computer.handle('capture', { session });
  assert.equal(frame.width, 1600); assert.equal(frame.height, 800);
  await assert.rejects(computer.handle('act', { session, frame: frame.id, action: 'click', x: 1600, y: 10 }), /inside/);
  await computer.handle('act', { session, frame: frame.id, action: 'click', x: 800, y: 400 });
  assert.deepEqual(actions[0], { action: 'click', x: -1600, y: 800 });
  await assert.rejects(computer.handle('act', { session, frame: frame.id, action: 'click', x: 1, y: 1 }), /stale/);
  assert.equal(actions.length, 1);
});

test('all runner configurations include identical reserved device tools; turn identity is signed', () => {
  const env = localMcpServers('Test')['rivendell-device'].env;
  assert.deepEqual(localMcpBananaServers()['rivendell-device'].environment, env);
  assert.ok(localMcpCodexArgs('Test').some(arg => arg.includes('mcp_servers.rivendell-device.args=')));
  const prompt = computerGuidance('agent:test', 'Test', true);
  const token = prompt.match(/do not echo\): ([\w.-]+)/)![1];
  assert.deepEqual(readComputerContext(token), { owner: 'agent:test', label: 'Test', human: true });
  assert.throws(() => readComputerContext(token + 'tampered'));
  const peer = computerGuidance('agent:test', 'Test', false).match(/do not echo\): ([\w.-]+)/)![1];
  assert.throws(() => readComputerContext(token), /superseded/);
  assert.equal(readComputerContext(peer).human, false);
  assert.equal(trustedComputerUrl('http://example.test'), false);
  assert.equal(trustedComputerUrl('http://127.0.0.1:8091'), true);
  assert.equal(trustedComputerUrl('https://example.test'), true);
});

test('operator automatic mode never asks, but explicit Stop cannot be auto-reacquired', async t => {
  let asked = 0;
  const { computer } = await fixture(async () => { asked++; return false; }, () => true);
  t.after(() => computer.stop());
  const first = await computer.handle('start', task);
  assert.equal(first.approvalMode, 'automatic');
  await computer.handle('end', { session: first.session });
  assert.equal(computer.status().paused, false);
  await computer.handle('start', task);
  await computer.handle('stop');
  assert.equal(computer.status().paused, true);
  await assert.rejects(computer.handle('start', { ...task, owner: 'another' }), /paused by the user/);
  computer.stop(); // link reconnect cannot clear a human pause
  await assert.rejects(computer.handle('start', task), /paused by the user/);
  await computer.handle('resume');
  await computer.handle('start', task);
  assert.equal(asked, 0);
});

test('vision-step retries preserve committed outcomes and reject changed arguments', async () => {
  const journal = new ComputerStepJournal();
  journal.beginGrant('device', 'session');
  let inputs = 0;
  const first = await journal.run('device', 'session', 'click-1', 'goal', async mark => {
    mark(); inputs++;
    mark({ acted: true, observation: 'Input completed; inspect before continuing.' });
    throw new Error('connection lost during post-action vision');
  });
  assert.equal(first.acted, true);
  const retry = await journal.run('device', 'session', 'click-1', 'goal', async () => { inputs++; return { acted: true, observation: 'wrong' }; });
  assert.equal(retry.replayed, true); assert.equal(inputs, 1);
  await assert.rejects(journal.run('device', 'session', 'click-1', 'different', async () => first), /different goal/);
  await assert.rejects(journal.run('device', 'session', 'pre-input', 'goal', async () => { throw new Error('vision offline'); }), /vision offline/);
  const recovered = await journal.run('device', 'session', 'pre-input', 'goal', async () => ({ acted: false, observation: 'Already complete.' }));
  assert.equal(recovered.acted, false);
  journal.beginGrant('device', 'new-session');
  await assert.rejects(journal.run('device', 'session', 'click-2', 'goal', async () => first), /Start a desktop grant/);
});
