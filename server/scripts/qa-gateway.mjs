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
// One shared link for the whole QA team (Matt, Oct 23 2026): /?k=<key> sets
// a team cookie, and requests carrying it ride one shared board session, so
// nobody needs a personal sign-in link. Both values live outside the repo.
const TEAM_KEY = process.env.QA_TEAM_KEY || '';
const TEAM_COOKIE = 'rally_qa_team';
const hasTeamCookie = (cookie) => Boolean(TEAM_KEY) && String(cookie || '').split(';').some((c) => c.trim() === `${TEAM_COOKIE}=${TEAM_KEY}`);

// The team view is all three columns. The gateway signs in as each tester
// itself (loopback, so it may issue links) and keeps those sessions only in
// memory, then stitches the three columns into one board.
const TESTERS = ['sud', 'edgar', 'martin'];
const teamSessions = new Map();
function local(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${UPSTREAM.host}:${UPSTREAM.port}` };
    if (body) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const r = http.request({ ...UPSTREAM, method, path, headers }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });
    r.on('error', reject); r.end(body);
  });
}
async function signIn(id) {
  const links = JSON.parse((await local('GET', '/api/qa/auth/links')).data).links;
  const link = links.find((l) => l.id === id);
  if (!link) throw new Error(`no link for ${id}`);
  const q = new URL(link.path, 'http://x').searchParams;
  const ex = await local('POST', '/api/qa/auth/exchange', { body: JSON.stringify({ d: q.get('d'), s: q.get('s') }) });
  const set = [].concat(ex.headers['set-cookie'] || []).join(';');
  const m = /rivendell_qa_session=([^;]+)/.exec(set);
  if (!m) throw new Error(`sign-in failed for ${id}`);
  teamSessions.set(id, `rivendell_qa_session=${m[1]}`);
}
async function column(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!teamSessions.has(id)) await signIn(id);
    const r = await local('GET', '/api/qa', { cookie: teamSessions.get(id) });
    if (r.status === 401) { teamSessions.delete(id); continue; }
    const col = (JSON.parse(r.data).testers || []).find((t) => t.id === id);
    if (col) return col;
  }
  throw new Error(`no column for ${id}`);
}
async function teamBoard(res) {
  try {
    const testers = await Promise.all(TESTERS.map(column));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ testers }));
  } catch {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'QA board is restarting, try again in a moment.' }));
  }
}

function allowed(method, path) {
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/') return { redirect: '/qa-board' };
    if (PAGES.has(path) || STATIC.test(path)) return { path };
  }
  if (API.has(`${method === 'HEAD' ? 'GET' : method} ${path}`)) return { path };
  return null;
}

http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://gateway');
  if (TEAM_KEY && url.searchParams.get('k') === TEAM_KEY) {
    res.writeHead(302, { location: '/qa-board', 'set-cookie': `${TEAM_COOKIE}=${TEAM_KEY}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}` }).end();
    return;
  }
  const hit = allowed(req.method || 'GET', url.pathname.replace(/\/+$/, '') || '/');
  if (!hit) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
  // The app picks the bare tester page from the browser URL, so the bare
  // address redirects rather than rewriting (a rewrite would boot the shell).
  if (hit.redirect) { res.writeHead(302, { location: hit.redirect }).end(); return; }
  if (hit.path === '/api/qa' && req.method === 'GET' && hasTeamCookie(req.headers.cookie)) { void teamBoard(res); return; }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.test(k) && k !== 'host') headers[k] = v;
  if (headers.cookie) headers.cookie = String(headers.cookie).split(';').filter((c) => !c.trim().startsWith(`${TEAM_COOKIE}=`)).join(';');
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
