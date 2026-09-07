import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ComputerController, trustedComputerUrl } from '../../../desktop/native/computer.mjs';
import { localMcpServers, localMcpBananaServers, localMcpCodexArgs } from '../chat/local-mcp.ts';
import { computerGuidance, readComputerContext } from './context.ts';

async function fixture(approve: () => Promise<boolean> = async () => true) {
  const bounds = { x: -3200, y: 0, width: 3200, height: 1600 };
  const png = await sharp({ create: { width: 3200, height: 1600, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const actions: Record<string, any>[] = [];
  const computer = new ComputerController({ approve, adapter: {
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
  assert.equal(trustedComputerUrl('http://example.test'), false);
  assert.equal(trustedComputerUrl('http://127.0.0.1:8091'), true);
  assert.equal(trustedComputerUrl('https://example.test'), true);
});
