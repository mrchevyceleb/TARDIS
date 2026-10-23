#!/usr/bin/env node
// Public QA gateway (Matt, Oct 23 2026): Edgar, Martin and Sud open the QA
// board from outside the tailnet. This is the only thing the public address
// reaches. It forwards the tester page, its static assets and the tester
// API to TARDIS and refuses everything else, so no other room, lane or API
// is ever reachable from the internet. Every forwarded request is stamped
// as proxied (X-Forwarded-For) and stripped of tailnet identity headers, so
// TARDIS always treats the caller as a tester, never as the operator.
import http from 'node:http';

const PORT = Number(process.env.QA_GATEWAY_PORT || 8127);
const UPSTREAM = { host: '127.0.0.1', port: Number(process.env.QA_GATEWAY_UPSTREAM_PORT || 8091) };

const PAGES = new Set(['/qa-board', '/qa-signin']);
const STATIC = /^\/(assets\/[\w.-]+|favicon\.svg|icon-(192|512)\.png|apple-touch-icon\.png|manifest\.webmanifest)$/;
const API = new Map([
  ['GET /api/qa', true],
  ['POST /api/qa/auth/exchange', true],
  ['POST /api/qa/auth/sign-out', true],
]);
const DROP = /^(tailscale-|x-forwarded-|forwarded$|x-real-ip$|cookie2$)/i;

function allowed(method, path) {
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/') return { path: '/qa-board' };
    if (PAGES.has(path) || STATIC.test(path)) return { path };
  }
  if (API.has(`${method === 'HEAD' ? 'GET' : method} ${path}`)) return { path };
  return null;
}

http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://gateway');
  const hit = allowed(req.method || 'GET', url.pathname.replace(/\/+$/, '') || '/');
  if (!hit) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.test(k) && k !== 'host') headers[k] = v;
  headers.host = `${UPSTREAM.host}:${UPSTREAM.port}`;
  headers['x-forwarded-for'] = req.socket.remoteAddress || 'qa-gateway';
  headers['x-forwarded-proto'] = 'https';
  const up = http.request({ ...UPSTREAM, method: req.method, path: hit.path + url.search, headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('QA board is restarting, try again in a moment.'); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', () => console.log(`[qa-gateway] :${PORT} -> ${UPSTREAM.host}:${UPSTREAM.port}`));
