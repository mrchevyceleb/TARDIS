/**
 * Engines that outlive a server restart (server side of scripts/lane-host.mjs).
 *
 * Every engine used to be a direct child of the server, wired to it by stdio
 * pipes and sitting in its cgroup, so a release ended every turn in flight and
 * every shell and timer running inside an engine. Now the server starts a small
 * lane host per engine, in its own systemd scope where one is available, and
 * talks to it over a unix socket. A restarting server detaches (the engine keeps
 * working, its output waits in the host); the next server attaches and reads on
 * from the exact byte the last one stopped at.
 *
 * HostedChild stands in for the ChildProcess the runners already use: pid,
 * stdin.write/end, stdout/stderr 'data', 'exit' then 'close', kill(). Output is
 * delivered synchronously, a whole chunk per 'data', and the runners consume
 * every complete line inside that call, so "everything up to the last newline
 * delivered" is exactly what this server has handled. That offset is what a
 * detach hands to the next server.
 *
 * RIVENDELL_LANE_HOSTS=off spawns engines directly, as before.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { spawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from '../config.ts';
import { defaultLaneInstanceDir, spawnLaneWorker } from './workerReap.ts';

const HOST_SCRIPT = fileURLToPath(new URL('../../scripts/lane-host.mjs', import.meta.url));
const LANE_WORKER_ENV_KEY = 'RIVENDELL_LANE_WORKER';
const CONNECT_TIMEOUT_MS = 15_000;

export function laneHostsDir(): string {
  return join(STATE_DIR, 'lane-hosts');
}

export function laneHostsEnabled(): boolean {
  const flag = (process.env.RIVENDELL_LANE_HOSTS ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(flag)) return false;
  return process.platform === 'linux' && existsSync('/proc');
}

let scopeAvailable: boolean | null = null;

/** Probe once, at boot, whether hosts can get their own systemd scope. Without
 *  one a host still outlives the server, unless the service manager kills the
 *  server's whole cgroup on stop (systemd's default), which is what the scope
 *  is for. */
export async function prepareLaneHosts(): Promise<void> {
  if (scopeAvailable !== null || !laneHostsEnabled()) return;
  scopeAvailable = await new Promise<boolean>((done) => {
    try {
      const probe = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', 'true'], { stdio: 'ignore' });
      const timer = setTimeout(() => { try { probe.kill('SIGKILL'); } catch { /* gone */ } done(false); }, 5_000);
      probe.once('error', () => { clearTimeout(timer); done(false); });
      probe.once('exit', (code) => { clearTimeout(timer); done(code === 0); });
    } catch {
      done(false);
    }
  });
  console.log(`[lane-host] engines run in lane hosts${scopeAvailable ? ', each in its own systemd scope' : ' (no systemd scope available)'}`);
}

/** The socket lives next to the host's files unless that path is too long for a unix socket. */
function socketPathFor(dir: string, id: string): string {
  const local = join(dir, 's');
  if (Buffer.byteLength(local) < 100) return local;
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  const shortDir = join(runtime, 'rivendell-lane-sockets');
  mkdirSync(shortDir, { recursive: true, mode: 0o700 });
  return join(shortDir, id);
}

function frame(type: string, payload: Buffer | string | object): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** A readable the runners can treat like a child's stdout: setEncoding, 'data',
 *  'end', 'close'. Emits synchronously so the consumed offset is exact. */
class HostedOutput extends EventEmitter {
  private decoder: StringDecoder | null = null;
  /** Byte offset of the next byte this stream will deliver. */
  offset = 0;
  /** Offset just past the last newline delivered: everything before it is handled. */
  consumed = 0;
  readable = true;
  setEncoding(encoding: BufferEncoding): this {
    this.decoder = new StringDecoder(encoding);
    return this;
  }
  deliver(chunk: Buffer): void {
    const lastNewline = chunk.lastIndexOf(0x0a);
    this.offset += chunk.length;
    if (lastNewline >= 0) this.consumed = this.offset - chunk.length + lastNewline + 1;
    const value = this.decoder ? this.decoder.write(chunk) : chunk;
    if (typeof value === 'string' ? value.length : value.length) this.emit('data', value);
  }
  finish(): void {
    if (!this.readable) return;
    this.readable = false;
    const rest = this.decoder?.end();
    if (rest) this.emit('data', rest);
    this.emit('end');
    this.emit('close');
  }
  resume(): this { return this; }
  pause(): this { return this; }
}

/** stdin for a hosted engine. Writes go out in order; anything written before
 *  the socket connects waits and is sent the moment it does. */
class HostedInput extends EventEmitter {
  writable = true;
  destroyed = false;
  constructor(private readonly owner: HostedChild) { super(); }
  write(data: string | Buffer, encodingOrCb?: BufferEncoding | ((error?: Error | null) => void), cb?: (error?: Error | null) => void): boolean {
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (!this.writable) {
      const error = new Error('write after end');
      if (callback) process.nextTick(callback, error);
      return false;
    }
    this.owner.sendFrame('I', Buffer.isBuffer(data) ? data : Buffer.from(data, typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8'), callback);
    return true;
  }
  end(cb?: () => void): this {
    if (this.writable) {
      this.writable = false;
      this.owner.sendFrame('E', Buffer.alloc(0));
    }
    if (cb) process.nextTick(cb);
    return this;
  }
  destroy(): this {
    this.writable = false;
    this.destroyed = true;
    return this;
  }
}

export type HostedOffsets = { out: number; err: number };
export type HostedDetach = { hostId: string; hostPid: number; offsets: HostedOffsets };

/** What the runners see in place of a ChildProcess. */
export class HostedChild extends EventEmitter {
  readonly hostId: string;
  readonly dir: string;
  readonly socketPath: string;
  /** The host's pid. It leads the engine's process group, so a group signal
   *  reaches the engine and everything it started. */
  pid: number | undefined;
  /** The engine's own pid, once the host reports it. */
  enginePid: number | null = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin: HostedInput;
  readonly stdout = new HostedOutput();
  readonly stderr = new HostedOutput();
  private socket: Socket | null = null;
  private connected = false;
  private pending: Array<{ data: Buffer; cb?: (error?: Error | null) => void }> = [];
  private incoming: Buffer = Buffer.alloc(0);
  private detached = false;
  private exited = false;
  /** An adopting server binds its listeners after attaching: until it calls
   *  startReading(), frames after the attach reply wait here, not emitted to nobody. */
  private holding = false;
  private heldExit: [number | null, NodeJS.Signals | null] | null = null;

  constructor(hostId: string, dir: string, socketPath: string, pid: number | undefined, offsets: HostedOffsets = { out: 0, err: 0 }) {
    super();
    this.hostId = hostId;
    this.dir = dir;
    this.socketPath = socketPath;
    this.pid = pid;
    this.stdin = new HostedInput(this);
    this.stdout.offset = this.stdout.consumed = offsets.out;
    this.stderr.offset = this.stderr.consumed = offsets.err;
  }

  sendFrame(type: string, body: Buffer, cb?: (error?: Error | null) => void): void {
    const data = frame(type, body);
    if (this.exited || this.detached) {
      if (cb) process.nextTick(cb, new Error('the engine is no longer attached'));
      return;
    }
    if (!this.connected || !this.socket) {
      this.pending.push({ data, cb });
      return;
    }
    this.socket.write(data, (error) => cb?.(error ?? null));
  }

  /** Connect to the host, retrying while it starts. Resolves once attached.
   *  With `hold`, replayed output waits for startReading(). */
  attach(timeoutMs = CONNECT_TIMEOUT_MS, hold = false): Promise<boolean> {
    this.holding = hold;
    const deadline = Date.now() + timeoutMs;
    return new Promise<boolean>((done) => {
      const tryConnect = () => {
        if (this.detached || this.exited) { done(false); return; }
        const socket = connect(this.socketPath);
        let opened = false;
        socket.once('connect', () => {
          opened = true;
          this.socket = socket;
          socket.write(frame('H', { out: this.stdout.consumed, err: this.stderr.consumed }));
        });
        socket.on('data', (chunk) => this.onData(chunk, () => done(true)));
        socket.on('error', () => {});
        socket.once('close', () => {
          if (!opened) {
            if (Date.now() < deadline && this.hostAlive()) { setTimeout(tryConnect, 50); return; }
            this.fail(new Error('the lane host did not start'));
            done(false);
            return;
          }
          if (this.socket === socket) this.socket = null;
          this.connected = false;
          // The host went away without reporting an exit. Make sure nothing it
          // ran is still going before this lane can start another engine.
          if (!this.detached && !this.exited) {
            this.kill('SIGKILL');
            this.reportExit(null, 'SIGKILL');
          }
        });
      };
      tryConnect();
    });
  }

  /** Deliver output held since attach; call once the engine's listeners are bound. */
  startReading(): void {
    if (!this.holding) return;
    this.holding = false;
    this.drain(() => {});
    if (this.heldExit) this.reportExit(...this.heldExit);
  }

  private onData(chunk: Buffer, attached: () => void): void {
    this.incoming = this.incoming.length ? Buffer.concat([this.incoming, chunk]) : chunk;
    this.drain(attached);
  }

  private drain(attached: () => void): void {
    while (this.incoming.length >= 5 && !(this.holding && this.connected)) {
      const type = this.incoming.toString('latin1', 0, 1);
      const length = this.incoming.readUInt32BE(1);
      if (this.incoming.length < 5 + length) return;
      const body = this.incoming.subarray(5, 5 + length);
      this.incoming = this.incoming.subarray(5 + length);
      if (this.detached) return;
      if (type === 'S') {
        let info: { pid?: number | null; hostPid?: number; out?: number; err?: number } = {};
        try { info = JSON.parse(body.toString('utf8')); } catch { /* keep defaults */ }
        this.enginePid = info.pid ?? null;
        if (typeof info.hostPid === 'number') this.pid = info.hostPid;
        // Bytes older than the host kept are gone; say so instead of pretending.
        if (typeof info.out === 'number' && info.out > this.stdout.consumed) {
          console.warn(`[lane-host] ${this.hostId}: ${info.out - this.stdout.consumed} byte(s) of engine output were no longer kept`);
          this.stdout.offset = this.stdout.consumed = info.out;
        } else this.stdout.offset = this.stdout.consumed;
        if (typeof info.err === 'number' && info.err > this.stderr.consumed) this.stderr.offset = this.stderr.consumed = info.err;
        else this.stderr.offset = this.stderr.consumed;
        this.connected = true;
        const queued = this.pending.splice(0);
        for (const item of queued) this.socket!.write(item.data, (error) => item.cb?.(error ?? null));
        this.emit('spawn');
        attached();
      } else if (type === 'O') {
        this.stdout.deliver(body);
        this.scheduleAck();
      } else if (type === 'R') {
        this.stderr.deliver(body);
        this.scheduleAck();
      } else if (type === 'X') {
        let info: { code?: number | null; signal?: NodeJS.Signals | null } = {};
        try { info = JSON.parse(body.toString('utf8')); } catch { /* unknown */ }
        this.reportExit(info.code ?? null, info.signal ?? null);
      }
    }
  }

  private ackTimer: NodeJS.Timeout | null = null;
  /** Tell the host what this server has handled so it can free those bytes
   *  (and let a paused engine write again). Batched: one ack per 100ms at most. */
  private scheduleAck(): void {
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (!this.connected || this.detached || !this.socket) return;
      this.socket.write(frame('A', { out: this.stdout.consumed, err: this.stderr.consumed }));
    }, 100);
    this.ackTimer.unref();
  }

  private reportExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    if (this.holding) { this.heldExit ??= [code, signal]; return; }
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdin.writable = false;
    for (const item of this.pending.splice(0)) item.cb?.(new Error('the engine exited'));
    this.emit('exit', code, signal);
    this.stdout.finish();
    this.stderr.finish();
    this.emit('close', code, signal);
    try { this.socket?.end(); } catch { /* closed */ }
  }

  private fail(error: Error): void {
    if (this.exited) return;
    // During adoption nobody listens yet; the caller learns from attach() instead.
    if (this.listenerCount('error')) this.emit('error', error);
    this.reportExit(1, null);
  }

  private hostAlive(): boolean {
    if (!this.pid) return true; // not reported yet: still starting
    try { process.kill(this.pid, 0); return true; } catch { return false; }
  }

  /** True while the engine runs and this server is reading it. */
  isAttached(): boolean {
    return this.connected && !this.detached && !this.exited;
  }

  /** Stop reading without touching the engine. The host keeps everything after
   *  `offsets` for whichever server attaches next. */
  detach(): HostedDetach | null {
    if (this.exited || this.detached || !this.pid) return null;
    this.detached = true;
    const offsets = { out: this.stdout.consumed, err: this.stderr.consumed };
    try { this.socket?.end(); } catch { /* closed */ }
    this.socket = null;
    this.connected = false;
    return { hostId: this.hostId, hostPid: this.pid, offsets };
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (!this.pid || this.pid <= 1 || this.exited) return false;
    try { process.kill(-this.pid, signal); return true; } catch { /* not a group leader yet */ }
    try { process.kill(this.pid, signal); return true; } catch { return false; }
  }

  ref(): this { return this; }
  unref(): this { return this; }
}

/** Start an engine inside a new lane host. Same arguments as spawn(). */
export function spawnHostedWorker(command: string, args: readonly string[], options: SpawnOptions): HostedChild {
  const id = randomBytes(6).toString('hex');
  const dir = join(laneHostsDir(), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = socketPathFor(dir, id);
  const cwd = typeof options.cwd === 'string' ? options.cwd : options.cwd ? fileURLToPath(options.cwd) : process.cwd();
  const env = { ...(options.env ?? process.env) };
  // The host stamps the engine with its own token; the server's must not ride along.
  delete env[LANE_WORKER_ENV_KEY];
  // The engine's model API runs through this server's proxy; the host relays it
  // so a call made during a restart waits for the next server, not refused.
  const config = JSON.stringify({ dir, socket: socketPath, command, args, cwd, registryDir: defaultLaneInstanceDir(), relayEnv: ['ANTHROPIC_BASE_URL'] });
  const hostArgs = [HOST_SCRIPT, config];
  const log = openSync(join(dir, 'host.log'), 'a', 0o600);
  const hostOptions: SpawnOptions = { cwd, env, detached: true, stdio: ['ignore', 'ignore', log] };
  const proc = scopeAvailable
    ? spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', '--unit', `tardis-lane-${id}`, process.execPath, ...hostArgs], hostOptions)
    : spawn(process.execPath, hostArgs, hostOptions);
  closeSync(log);
  proc.unref();
  const child = new HostedChild(id, dir, socketPath, proc.pid);
  proc.once('error', (error) => child.emit('error', error));
  void child.attach();
  return child;
}

export type EngineProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** Start an engine the way every runner does: in a lane host when enabled, so
 *  it survives a restart, otherwise directly as before. */
export function spawnEngineProcess(command: string, args: readonly string[], options: Omit<SpawnOptions, 'stdio' | 'detached'>): EngineProcess {
  if (laneHostsEnabled()) return spawnHostedWorker(command, args, options) as unknown as EngineProcess;
  return spawnLaneWorker(command, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) as EngineProcess;
}

/** The lane host behind an engine process, if it runs in one. */
export function hostedChildOf(child: unknown): HostedChild | null {
  return child instanceof HostedChild ? child : null;
}

/** Re-attach to a host a previous server detached from. Null when it is gone. */
export async function attachHostedWorker(detach: HostedDetach): Promise<HostedChild | null> {
  const dir = join(laneHostsDir(), detach.hostId);
  let socketPath: string;
  try {
    socketPath = socketPathFor(dir, detach.hostId);
    process.kill(detach.hostPid, 0);
  } catch {
    return null;
  }
  const child = new HostedChild(detach.hostId, dir, socketPath, detach.hostPid, detach.offsets);
  return (await child.attach(5_000, true)) ? child : null;
}

/** End every lane host no server claimed: a crash left them without a handoff,
 *  so nothing can read them, and a lane with two engines would fork its thread. */
export async function endUnclaimedLaneHosts(claimed: ReadonlySet<string>): Promise<number> {
  let names: string[];
  try { names = readdirSync(laneHostsDir()); } catch { return 0; }
  const ending: Promise<boolean>[] = [];
  for (const id of names) {
    if (claimed.has(id)) continue;
    const dir = join(laneHostsDir(), id);
    let hostPid = 0;
    try { hostPid = Number(JSON.parse(readFileSync(join(dir, 'host.json'), 'utf8')).hostPid) || 0; } catch { /* never started */ }
    // The host removes its own directory once the engine has exited.
    if (hostPid > 1 && isLaneHostPid(hostPid)) ending.push(endHostGroup(id, hostPid));
    else try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  // Returns only once they are gone: the lane may start a new engine right after.
  const ended = await Promise.all(ending);
  const stuck = ended.filter((gone) => !gone).length;
  if (stuck) console.error(`[lane-host] ${stuck} unclaimed lane host(s) did not end; their engines may still be running`);
  return ended.length - stuck;
}

/** TERM a host's process group, KILL it and its whole scope if it lingers, and
 *  confirm the group is empty (the engine leads nothing once its host is gone). */
async function endHostGroup(hostId: string, hostPid: number): Promise<boolean> {
  const groupAlive = () => { try { process.kill(-hostPid, 0); return true; } catch { return false; } };
  const waitGone = async (ms: number) => {
    for (const until = Date.now() + ms; groupAlive() && Date.now() < until;) await delay(100);
    return !groupAlive();
  };
  try { process.kill(-hostPid, 'SIGTERM'); } catch { /* gone */ }
  if (await waitGone(3_000)) return true;
  // The scope's cgroup also holds anything that left the process group.
  spawn('systemctl', ['--user', 'kill', '--signal=SIGKILL', `tardis-lane-${hostId}.scope`], { stdio: 'ignore' }).on('error', () => {});
  try { process.kill(-hostPid, 'SIGKILL'); } catch { /* gone */ }
  return waitGone(2_000);
}

/** Only ever signal a pid that is still a lane host (pids are reused). */
function isLaneHostPid(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(resolve(HOST_SCRIPT));
  } catch {
    return false;
  }
}

/** For tests and the proof script: is anything still running in this host? */
export function laneHostRunning(hostId: string): boolean {
  try {
    const hostPid = Number(JSON.parse(readFileSync(join(laneHostsDir(), hostId, 'host.json'), 'utf8')).hostPid);
    return hostPid > 1 && isLaneHostPid(hostPid);
  } catch {
    return false;
  }
}
