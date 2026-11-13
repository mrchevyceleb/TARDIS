#!/usr/bin/env node

/**
 * Lane host: owns one engine process (claude, a codex turn) so it outlives the
 * TARDIS server that started it.
 *
 * A server restart used to end every engine with it: the engine's stdio were
 * pipes into the server, it sat in the server's cgroup, and the next boot swept
 * whatever was left. Every turn in flight, every background shell and every
 * check-in timer inside an engine died on each release. The host is the one
 * process that is not tied to a server's lifetime: the server talks to it over
 * a unix socket, and when that server goes away the next one connects to the
 * same socket and carries on from the exact byte it stopped reading.
 *
 * Deliberately small and dependency-free. It is the code that keeps running
 * across releases, so it should rarely need to change.
 *
 * argv[2] is a JSON config: { dir, socket, command, args, cwd, registryDir, relayEnv }.
 * The environment is the engine's.
 *
 * relayEnv names environment variables holding a loopback http URL the engine
 * calls on the server (its model API, through the server's proxy). The host
 * puts its own port in front of each: a connection made while the server is
 * restarting waits for it to listen again instead of being refused. A call cut
 * mid-flight is still cut; the engine's own retry then lands on the relay.
 *
 * Frames both ways: 1 type byte, 4-byte big-endian length, payload.
 *   server -> host  H {out, err}   attach; replay output from these offsets
 *                   I <bytes>       engine stdin
 *                   E               end engine stdin
 *                   A {out, err}   handled up to these offsets; frees them
 *   host -> server  S {pid, out, err}   attached; offsets replay starts from
 *                   O <bytes>       engine stdout
 *                   R <bytes>       engine stderr
 *                   X {code, signal}    engine exited (after all its output)
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';

const config = JSON.parse(process.argv[2] ?? '{}');
const { dir, socket: socketPath, command, args = [], cwd, registryDir, relayEnv = [] } = config;
if (!dir || !socketPath || !command) {
  process.stderr.write('lane-host: missing dir, socket or command\n');
  process.exit(2);
}

/** Output kept for replay. While a server reads live, older bytes are trimmed
 *  past this size; with no server attached nothing is ever dropped: past this
 *  size the engine's pipe is paused, so the engine waits instead. */
const OUT_CAP = 16 * 1024 * 1024;
const ERR_CAP = 1024 * 1024;
/** With no server attached for this long, the engine is ended: nobody is left
 *  to read it, and a forgotten engine must not run forever. */
const UNATTENDED_LIMIT_MS = Number(process.env.RIVENDELL_LANE_HOST_UNATTENDED_MS) || 30 * 60_000;
/** After the engine exits, how long its last output waits for a server. */
const EXITED_LIMIT_MS = 10 * 60_000;
/** How long a relayed connection waits for the server to come back. */
const RELAY_WAIT_MS = Number(process.env.RIVENDELL_LANE_RELAY_WAIT_MS) || 3 * 60_000;

const log = (line) => { try { process.stderr.write(`${new Date().toISOString()} ${line}\n`); } catch { /* closed */ } };

// A runaway turn must stay the kernel's preferred OOM victim, not the server.
try { writeFileSync('/proc/self/oom_score_adj', '200'); } catch { /* not Linux, or not allowed */ }

// This host's own lane-worker token. The boot sweep spares a marked process
// whose token a live process holds; registering the host as that holder keeps
// the engine and anything it disowned safe across a restart, and frees them for
// the sweep once the host is gone.
const token = `host-${randomBytes(12).toString('hex')}`;
function registerToken() {
  if (!registryDir) return false;
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const starttime = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    if (!starttime) return false;
    mkdirSync(registryDir, { recursive: true });
    const tmp = join(registryDir, `.tmp-${token}`);
    writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, starttime })}\n`);
    renameSync(tmp, join(registryDir, token));
    return true;
  } catch {
    return false;
  }
}
const registered = registerToken();

function unregisterToken() {
  if (registered) try { unlinkSync(join(registryDir, token)); } catch { /* gone */ }
}

class Spool {
  constructor(cap) { this.cap = cap; this.chunks = []; this.start = 0; this.end = 0; }
  get size() { return this.end - this.start; }
  /** Unhandled bytes past the cap: the engine's output waits until a server catches up. */
  get full() { return this.size > this.cap; }
  push(chunk) {
    this.chunks.push(chunk);
    this.end += chunk.length;
  }
  /** Free what a server says it has handled. Only an ack frees bytes: being
   *  attached is not consuming, since a server can leave with bytes in flight. */
  ack(offset) {
    while (this.chunks.length && this.start + this.chunks[0].length <= offset) this.start += this.chunks.shift().length;
  }
  /** Bytes from `offset` on; an offset older than what is kept starts at the oldest kept byte. */
  from(offset) {
    const begin = Math.max(offset, this.start);
    if (begin >= this.end) return { begin, data: Buffer.alloc(0) };
    let at = this.start;
    const parts = [];
    for (const chunk of this.chunks) {
      const chunkEnd = at + chunk.length;
      if (chunkEnd > begin) parts.push(begin > at ? chunk.subarray(begin - at) : chunk);
      at = chunkEnd;
    }
    return { begin, data: Buffer.concat(parts) };
  }
}

const out = new Spool(OUT_CAP);
const err = new Spool(ERR_CAP);
let exitInfo = null;
let client = null;
let lastAttachedAt = Date.now();

function frame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

function send(type, payload) {
  if (!client || client.destroyed) return;
  try { client.write(frame(type, payload)); } catch { /* the reader went away */ }
}

/** Listen on a loopback port of our own and pipe each connection to `port`,
 *  retrying the connect until the server answers or RELAY_WAIT_MS passes. */
function relayTo(port) {
  const relay = createServer((inbound) => {
    inbound.pause();
    inbound.on('error', () => {});
    const deadline = Date.now() + RELAY_WAIT_MS;
    const attempt = () => {
      if (inbound.destroyed) return;
      const upstream = connect({ host: '127.0.0.1', port });
      let connected = false;
      upstream.once('connect', () => {
        connected = true;
        if (inbound.destroyed) { upstream.destroy(); return; }
        inbound.on('close', () => upstream.destroy());
        upstream.on('close', () => inbound.destroy());
        upstream.pipe(inbound);
        inbound.pipe(upstream);
        inbound.resume();
      });
      upstream.on('error', () => {
        if (connected) inbound.destroy();
        else if (Date.now() > deadline) inbound.destroy();
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
  return new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(0, '127.0.0.1', () => resolve(relay.address().port));
  });
}

const childEnv = { ...process.env, ...(registered ? { RIVENDELL_LANE_WORKER: token } : {}) };
delete childEnv.RIVENDELL_LANE_HOST_UNATTENDED_MS;
delete childEnv.RIVENDELL_LANE_RELAY_WAIT_MS;
for (const name of relayEnv) {
  let url;
  try { url = new URL(childEnv[name] ?? ''); } catch { continue; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) continue;
  try {
    url.port = String(await relayTo(Number(url.port)));
    url.hostname = '127.0.0.1';
    childEnv[name] = url.toString().replace(/\/$/, childEnv[name].endsWith('/') ? '/' : '');
  } catch (error) {
    log(`relay for ${name} failed: ${error.message}; the engine calls the server directly`);
  }
}
const child = spawn(command, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
writeFileSync(join(dir, 'host.json'), `${JSON.stringify({ hostPid: process.pid, childPid: child.pid ?? null, token, startedAt: Date.now() })}\n`);
log(`started pid=${child.pid} ${command}`);

function keep(stream, spool, type, chunk) {
  spool.push(chunk);
  send(type, chunk);
  if (spool.full) stream.pause();
}
function acknowledge(offsets) {
  out.ack(Number(offsets.out) || 0);
  err.ack(Number(offsets.err) || 0);
  if (!out.full) child.stdout.resume();
  if (!err.full) child.stderr.resume();
}
child.stdout.on('data', (chunk) => keep(child.stdout, out, 'O', chunk));
child.stderr.on('data', (chunk) => keep(child.stderr, err, 'R', chunk));
child.stdin.on('error', () => { /* the engine closed its stdin; its exit reports why */ });
child.on('error', (error) => {
  err.push(Buffer.from(`lane-host: ${error.message}\n`));
  finish(null, null, error.message);
});

// Exit is reported once the engine's stdout and stderr have both drained, so the
// exit frame always comes after the last byte of output.
let exitStatus = null;
let streamsOpen = 2;
child.stdout.on('close', () => { streamsOpen -= 1; maybeFinish(); });
child.stderr.on('close', () => { streamsOpen -= 1; maybeFinish(); });
child.on('exit', (code, signal) => { exitStatus = { code, signal }; maybeFinish(); });
function maybeFinish() {
  if (exitStatus && streamsOpen <= 0) finish(exitStatus.code, exitStatus.signal);
}

function finish(code, signal, error) {
  if (exitInfo) return;
  exitInfo = { code, signal, ...(error ? { error } : {}), at: Date.now() };
  log(`engine exited code=${code} signal=${signal ?? '-'}`);
  try { writeFileSync(join(dir, 'exit.json'), `${JSON.stringify(exitInfo)}\n`); } catch { /* best effort */ }
  send('X', exitInfo);
  unregisterToken();
  if (client) setTimeout(shutdown, 30_000).unref();
  else setTimeout(shutdown, EXITED_LIMIT_MS).unref();
}

function shutdown() {
  try { server.close(); } catch { /* closed */ }
  try { unlinkSync(socketPath); } catch { /* gone */ }
  if (exitInfo) try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}

// Only the engine decides when this host is done: a TERM aimed at the process
// group reaches the engine directly, and the host reports how it ended.
process.on('SIGTERM', () => { if (!exitInfo) try { child.kill('SIGTERM'); } catch { /* gone */ } });
process.on('SIGHUP', () => {});
process.on('SIGPIPE', () => {});

const server = createServer((socket) => {
  let buffered = Buffer.alloc(0);
  let attached = false;
  socket.on('error', () => {});
  socket.on('close', () => {
    if (client === socket) {
      client = null;
      lastAttachedAt = Date.now();
      if (exitInfo) setTimeout(shutdown, 2_000).unref();
    }
  });
  socket.on('data', (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 5) {
      const type = buffered.toString('latin1', 0, 1);
      const length = buffered.readUInt32BE(1);
      if (buffered.length < 5 + length) break;
      const body = buffered.subarray(5, 5 + length);
      buffered = buffered.subarray(5 + length);
      if (type === 'H') {
        let offsets = { out: 0, err: 0 };
        try { offsets = { out: 0, err: 0, ...JSON.parse(body.toString('utf8')) }; } catch { /* replay everything kept */ }
        // One reader at a time: a newer server replaces an older one.
        if (client && client !== socket) client.destroy();
        client = socket;
        attached = true;
        // Where this server starts is what the last one handled.
        out.ack(Number(offsets.out) || 0);
        err.ack(Number(offsets.err) || 0);
        const o = out.from(Number(offsets.out) || 0);
        const e = err.from(Number(offsets.err) || 0);
        socket.write(frame('S', { pid: child.pid ?? null, hostPid: process.pid, out: o.begin, err: e.begin }));
        if (e.data.length) socket.write(frame('R', e.data));
        if (o.data.length) socket.write(frame('O', o.data));
        if (exitInfo) socket.write(frame('X', exitInfo));
        acknowledge(offsets);
      } else if (!attached || client !== socket) {
        continue;
      } else if (type === 'A') {
        try { acknowledge(JSON.parse(body.toString('utf8'))); } catch { /* malformed ack frees nothing */ }
      } else if (type === 'I') {
        if (!exitInfo && child.stdin.writable) child.stdin.write(body);
      } else if (type === 'E') {
        try { child.stdin.end(); } catch { /* closed */ }
      }
    }
  });
});
server.on('error', (error) => { log(`socket failed: ${error.message}`); try { child.kill('SIGTERM'); } catch { /* gone */ } });
try { unlinkSync(socketPath); } catch { /* fresh */ }
server.listen(socketPath, () => {
  writeFileSync(join(dir, 'ready'), `${process.pid}\n`);
});

setInterval(() => {
  if (client || exitInfo) return;
  if (Date.now() - lastAttachedAt < UNATTENDED_LIMIT_MS) return;
  log('no server attached for too long; ending the engine');
  try { process.kill(-process.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { /* gone */ } }, 5_000).unref();
}, 30_000).unref();
