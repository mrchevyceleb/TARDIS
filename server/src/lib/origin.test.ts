import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { trustedRequestOrigin, trustedWebSocketOrigin } from './origin.ts';

const request = (origin: string | undefined, host = '127.0.0.1:8091') => ({
  headers: { ...(origin ? { origin } : {}), host },
}) as IncomingMessage;

test('WebSocket origins allow loopback native clients and local Vite development', () => {
  assert.equal(trustedWebSocketOrigin(request(undefined)), true);
  assert.equal(trustedWebSocketOrigin(request('http://localhost:5173')), true);
});

test('WebSocket origins reject unrelated pages, DNS-rebinding hosts, and malformed origins', () => {
  assert.equal(trustedWebSocketOrigin(request('https://evil.example')), false);
  assert.equal(trustedWebSocketOrigin(request('https://attacker.example:8091', 'attacker.example:8091')), false);
  assert.equal(trustedWebSocketOrigin(request(undefined, 'attacker.example:8091')), false);
  assert.equal(trustedWebSocketOrigin(request('not a url')), false);
});

test('plain HTTP requests share the same Host/Origin trust rule', () => {
  assert.equal(trustedRequestOrigin({ host: '127.0.0.1:8091' }), true);
  assert.equal(trustedRequestOrigin({ host: '127.0.0.1:8091', origin: 'http://localhost:8091' }), true);
  assert.equal(trustedRequestOrigin({ host: 'attacker.example:8091' }), false);
  assert.equal(trustedRequestOrigin({ host: '127.0.0.1:8091', origin: 'https://evil.example' }), false);
  assert.equal(trustedRequestOrigin({}), false);
});
