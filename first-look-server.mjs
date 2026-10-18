// First-look server for the Desk team view: serves the worktree's built
// client dist statically and proxies /api to the live service on :8091, with
// no file watchers (the box's inotify budget is spent) and no dependencies.
import http from 'node:http';
import net from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
// Hardcoded on purpose: the job runner's environment carries PORT=8091 (the
// live service), which must never be overridden by the env fallback.
const PORT = 5199;
const UPSTREAM_HOST = 'localhost';
const UPSTREAM_PORT = 8091;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/api/')) {
    const upstream = http.request({
      host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: url, headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    upstream.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`upstream error: ${err?.message ?? err}`);
    });
    req.pipe(upstream);
    return;
  }
  let path = normalize(url).replace(/^(\.\.[/])+/, '');
  if (path === '/' || path === '') path = '/index.html';
  const file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    // SPA: unknown routes get the shell.
    const index = join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    createReadStream(index).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});

server.on('upgrade', (req, socket, head) => {
  // Raw pipe for websockets (/api/ws — the live line): rebuild the upgrade
  // request and relay bytes both ways. Without it the client shows the
  // "line went quiet" banner on the look (Max, Oct 17).
  const up = net.connect(UPSTREAM_PORT, '127.0.0.1');
  const fail = () => socket.destroy();
  up.on('error', fail);
  socket.on('error', () => up.destroy());
  up.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(req.headers)) {
      lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('close', fail);
});

// Loopback bind, fronted by `tailscale serve --https=5199` (Max, Oct 17):
// plain HTTP on a tailnet IP is not a secure context (crypto.randomUUID is
// undefined there, so the app blank-screens), and a direct bind would expose
// the /api proxy to the LAN. The serve proxy terminates HTTPS on the tailnet
// cert and forwards to this loopback listener; the URL stays
// https://moria.tail16eb08.ts.net:5199/.
server.listen(PORT, '127.0.0.1', () => console.log(`FIRST_LOOK_READY loopback:${PORT} (fronted by tailscale serve, dist ${DIST}, /api -> :${UPSTREAM_PORT})`));
