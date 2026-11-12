// Who may lift quiet hours (Nov 12 2026): the owner from the app (a
// same-origin browser request) or Max through his own team MCP, proven by the
// lane token TARDIS minted for his roster id (chat/teamToken.ts). A call that
// merely names Max, or carries another lane's token, changes nothing.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// A temp state dir and a synthetic roster, set before the modules load.
const state = mkdtempSync(join(tmpdir(), 'quiet-route-'));
process.env.RIVENDELL_STATE_DIR = state;
process.env.RIVENDELL_OWNER_NAME = 'Owner';
mkdirSync(join(state, 'personas'), { recursive: true });
const teammate = (id: string, name: string, order: number) => ({ id, name, role: 'Teammate', order, createdAt: order });
writeFileSync(join(state, 'personas', 'agents.json'), JSON.stringify({
  agents: [teammate('chief-of-staff', 'Max', 0), teammate('jammer', 'Jammer', 1), teammate('nova', 'Nova', 2)],
}));

const { default: express } = await import('express');
const { quietHoursRouter } = await import('./quietHours.ts');
const { teamLaneToken } = await import('../chat/teamToken.ts');

const app = express();
app.use(express.json());
app.use('/api/quiet-hours', quietHoursRouter);
let server: Server;
let base = '';
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/quiet-hours`;
});
after(() => {
  server?.close();
  rmSync(state, { recursive: true, force: true });
});

const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
/** What the app's own fetch carries: a same-origin request from TARDIS's origin. */
const fromApp = () => ({ 'sec-fetch-site': 'same-origin', origin: new URL(base).origin });

async function call(method: 'PUT' | 'DELETE', target: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/passes/${target}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as { pass?: { grantedBy?: string }; error?: string } };
}

const lifted = async () => ((await (await fetch(base)).json()) as { passes: { agentId: string }[] }).passes.map((p) => p.agentId).sort();

test('naming Max, or carrying another lane\'s token, lifts nothing', async () => {
  assert.equal((await call('PUT', 'jammer', { agent: 'chief-of-staff', until })).status, 403);
  assert.equal((await call('PUT', 'jammer', { agent: 'chief-of-staff', until }, { 'x-rivendell-team-token': teamLaneToken('jammer') })).status, 403);
  assert.equal((await call('PUT', 'jammer', { agent: 'jammer', until }, { 'x-rivendell-team-token': teamLaneToken('jammer') })).status, 403);
  assert.equal((await call('PUT', 'jammer', { until })).status, 400);
  // DNS rebinding: a hostile page is same-origin with itself, never trusted.
  assert.equal((await call('PUT', 'jammer', { until }, { 'sec-fetch-site': 'same-origin', origin: 'http://rebound.example' })).status, 400);
  assert.deepEqual(await lifted(), []);
});

test('Max\'s own MCP and the owner\'s app both lift; ending takes the same proof', async () => {
  const byMax = await call('PUT', 'jammer', { agent: 'chief-of-staff', until, reason: 'Game jam' }, { 'x-rivendell-team-token': teamLaneToken('chief-of-staff') });
  assert.equal(byMax.status, 200);
  assert.equal(byMax.body.pass?.grantedBy, 'Max');
  const byOwner = await call('PUT', 'nova', { until }, fromApp());
  assert.equal(byOwner.status, 200);
  assert.equal(byOwner.body.pass?.grantedBy, 'Owner');
  assert.deepEqual(await lifted(), ['jammer', 'nova']);

  assert.equal((await call('DELETE', 'jammer', { agent: 'chief-of-staff' })).status, 403);
  assert.deepEqual(await lifted(), ['jammer', 'nova']);
  const ended = await call('DELETE', 'nova', {}, fromApp());
  assert.equal(ended.status, 200);
  assert.deepEqual(await lifted(), ['jammer']);
});
