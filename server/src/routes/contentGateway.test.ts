import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createContentGateway } from './contentGateway.ts';
import { agentsRouter } from './agents.ts';

test('content gateway requires its dedicated credential before generation and bounds concurrency', async () => {
  const before = process.env.RIVENDELL_CONTENT_TOKEN;
  process.env.RIVENDELL_CONTENT_TOKEN = 'test-content-token';
  let calls = 0;
  const release: Array<() => void> = [];
  const app = express();
  app.use('/api/agents', express.json(), agentsRouter);
  app.use('/internal/content/v1', createContentGateway(async (_request, signal) => {
    calls++;
    await new Promise<void>((resolve) => { release.push(resolve); signal.addEventListener('abort', resolve as () => void, { once: true }); });
    return { role: 'assistant', content: 'draft' };
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/internal/content/v1/chat/completions`;
  const send = (token = 'test-content-token', model = 'claude',signal?:AbortSignal) => fetch(url, { method: 'POST', signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Draft' }] }) });
  try {
    for (const method of ['POST', 'PATCH']) {
      const endpoint = `http://127.0.0.1:${address.port}/api/agents${method === 'PATCH' ? '/synthetic-agent' : ''}`;
      const invalid = await fetch(endpoint, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic', engine: 'banana-fireworks' }) });
      assert.equal(invalid.status, 400);
    }
    assert.equal((await send('wrong')).status, 401);
    assert.equal((await send('test-content-token', 'banana')).status, 400);
    assert.equal(calls, 0);
    const first = send(); const second = send();
    while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const third = send();
    const cancelled=new AbortController();
    const fourth=send('test-content-token','claude',cancelled.signal);
    const cancelledResult=assert.rejects(fourth);
    await new Promise(resolve => setTimeout(resolve,30));
    assert.equal(calls,2);
    cancelled.abort();await cancelledResult;
    await new Promise(resolve=>setTimeout(resolve,20));
    release[0]();
    while (calls < 3) await new Promise(resolve => setTimeout(resolve,5));
    release.forEach((done) => done());
    assert.equal((await third).status,200);
    assert.equal(calls,3);
    assert.equal((await first).status, 200);
    const data = await (await second).json() as { choices: Array<{ message: { content: string } }> };
    assert.equal(data.choices[0].message.content, 'draft');
  } finally {
    release.forEach((done) => done());
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (before === undefined) delete process.env.RIVENDELL_CONTENT_TOKEN;
    else process.env.RIVENDELL_CONTENT_TOKEN = before;
  }
});
