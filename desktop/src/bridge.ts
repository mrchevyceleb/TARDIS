// The link that lets agents use this computer. The app dials the ship (the
// ship never dials in, so nothing here listens on a port), announces the
// machine, and then answers requests. Everything a request wants to do goes
// through approvals.ts first, always on a canonical path, and files are
// opened without following a symlink so the path that was approved is the
// path that gets touched.
import { app, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  approveCommand,
  approvePath,
  bridgeEnabled,
  cancelPendingApprovals,
  isSecretPath,
} from './approvals.js';
import { getSettings, saveSettings } from './settings.js';
import { workspaceRoot } from './workspace.js';
import { computer, handleComputer, initComputerControls, onComputerState } from './computer.js';
import { desktopIdentity, trustedComputerUrl } from '../native/computer.mjs';

const computerRequests = new Set<string>();
let computerStartId = '';
onComputerState(state => {
  if (!state.control) computerStartId = '';
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'computer-state', computer: state }));
});

const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
const OUTPUT_CAP = 256 * 1024;
const FILE_CAP = 2 * 1024 * 1024;
const LS_CAP = 500;
// A compromised ship must not be able to drown this machine in work.
const MAX_INFLIGHT = 8;
const MAX_RUNNING_COMMANDS = 4;
// Symlinks are resolved before approval; refusing to follow one at the final
// step closes the gap between the check and the open.
const NOFOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);

let socket: WebSocket | null = null;
let retryTimer: NodeJS.Timeout | undefined;
let backoff = RECONNECT_MIN_MS;
let currentUrl: string | undefined;
let inflight = 0;
// Bumped every time the link is pointed somewhere new or torn down, so a
// socket that closes later cannot schedule a reconnect for a link that is
// already gone (which would otherwise loop forever).
let linkGeneration = 0;

// Commands still running, by the request that started them, so the ship can
// call one off and a shutdown does not leave any behind.
const running = new Map<string, ChildProcess>();

/** A stable id for this machine, so a reconnect replaces its own link. */
export function deviceId(): string {
  const saved = getSettings().deviceId;
  if (saved) return saved;
  const fresh = randomUUID();
  saveSettings({ deviceId: fresh });
  return fresh;
}

function registrationKey(): string {
  const saved = getSettings().registrationKey;
  if (saved) return saved;
  const key = randomBytes(32).toString('hex');
  saveSettings({ registrationKey: key });
  return key;
}

/** Resolve every symlink we can, so authorisation and the operation itself
 *  see the same real path. For a file that does not exist yet, the nearest
 *  existing parent is resolved and the rest appended. */
function canonical(target: string): string {
  let head = target;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.normalize(target);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function resolveOnThisMachine(raw: string): string {
  const target = raw.trim();
  if (!target) throw new Error('path is required');
  const base = workspaceRoot() ?? os.homedir();
  return canonical(path.isAbsolute(target) ? target : path.resolve(base, target));
}

/** Approval happened a moment ago and the disk can move underneath it. Check
 *  the path still resolves where it did before acting on it. */
function stillTheSamePath(approved: string): void {
  if (canonical(approved) !== approved) {
    throw new Error('That path changed while it was being approved; nothing was done.');
  }
  if (isSecretPath(approved)) throw new Error('That path holds credentials; this computer never shares it.');
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  // The child leads its own process group, so this reaches what it started.
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function cancelRequest(id: string): void {
  if (computerRequests.has(id) || computerStartId === id) computer.stop();
  const child = running.get(id);
  if (!child) return;
  running.delete(id);
  killTree(child);
}

async function runCommand(id: string, command: string, cwd: string, timeoutMs: number): Promise<unknown> {
  if (running.size >= MAX_RUNNING_COMMANDS) {
    throw new Error('That computer is already running as many commands as it will take at once.');
  }
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
    : [process.env.SHELL || '/bin/bash', ['-lc', command]];

  return new Promise((resolve, reject) => {
    const child = spawn(file, args as string[], {
      cwd,
      windowsHide: true,
      env: process.env,
      // Its own process group, so a timeout can take the whole tree with it.
      detached: process.platform !== 'win32',
    });
    running.set(id, child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (current: string, chunk: Buffer) =>
      current.length >= OUTPUT_CAP ? current : (current + chunk.toString('utf8')).slice(0, OUTPUT_CAP);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => { stdout = cap(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = cap(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      running.delete(id);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(id);
      resolve({
        code: code ?? (timedOut ? 124 : 0),
        stdout,
        stderr,
        timedOut,
        cwd,
        truncated: stdout.length >= OUTPUT_CAP || stderr.length >= OUTPUT_CAP,
      });
    });
  });
}

async function handle(id: string, op: string, params: Record<string, unknown>): Promise<unknown> {
  if (!bridgeEnabled()) throw new Error('This computer is not accepting agent requests (Ship menu → Allow Agents on This Computer).');
  if (op.startsWith('computer.')) {
    if (!currentUrl || !trustedComputerUrl(currentUrl)) throw new Error('Desktop control requires HTTPS, except on loopback.');
    computerRequests.add(id);
    try {
      const result = await handleComputer(op.slice(9), params);
      if (op === 'computer.start' && computer.status().control) computerStartId = id;
      return result;
    }
    finally { computerRequests.delete(id); }
  }
  const budget = Number(params.timeoutMs) || 60_000;
  const deadline = Date.now() + budget;
  const root = workspaceRoot();

  if (op === 'exec') {
    const command = String(params.command ?? '').trim();
    if (!command) throw new Error('command is required');
    const cwd = params.cwd ? resolveOnThisMachine(String(params.cwd)) : (root ?? os.homedir());
    if (await approveCommand(command, cwd, deadline) === 'deny') {
      throw new Error('The person at that computer declined to run this.');
    }
    // Time spent waiting for that answer comes out of the command's budget,
    // so nothing keeps running after the ship has stopped listening.
    const remaining = deadline - Date.now();
    if (remaining < 1_000) throw new Error('Approval came too late to start this command.');
    return runCommand(id, command, cwd, remaining);
  }

  const target = resolveOnThisMachine(String(params.path ?? ''));
  if (isSecretPath(target)) throw new Error('That path holds credentials; this computer never shares it.');

  if (op === 'read') {
    if (await approvePath(target, 'read', root, deadline) === 'deny') {
      throw new Error('The person at that computer declined to share this file.');
    }
    stillTheSamePath(target);
    const file = await open(target, fsConstants.O_RDONLY | NOFOLLOW);
    try {
      const info = await file.stat();
      // A pipe or device would block for ever, and a file that grows after
      // its size was read would sail past the cap.
      if (!info.isFile()) throw new Error('That path is not a regular file.');
      if (info.size > FILE_CAP) throw new Error(`That file is ${Math.round(info.size / 1024)} KB; too large to read over the link.`);
      const buffer = Buffer.alloc(FILE_CAP + 1);
      const { bytesRead } = await file.read(buffer, 0, FILE_CAP + 1, 0);
      if (bytesRead > FILE_CAP) throw new Error('That file grew past the size this link will carry.');
      const content = buffer.subarray(0, bytesRead);
      if (looksBinary(content)) throw new Error('That file is not text.');
      return { path: target, size: bytesRead, content: content.toString('utf8') };
    } finally {
      await file.close();
    }
  }

  if (op === 'write') {
    const content = String(params.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > FILE_CAP) throw new Error('That is too much to write over the link.');
    if (await approvePath(target, 'write', root, deadline) === 'deny') {
      throw new Error('The person at that computer declined to write this file.');
    }
    stillTheSamePath(target);
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink()) throw new Error('That path is a link; this computer will not write through it.');
      if (existing.isFile() && existing.nlink > 1) throw new Error('That file has more than one name on disk; refusing to overwrite it.');
      if (existing.isDirectory()) throw new Error('That path is a folder.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Write beside it and swap, so a failure never leaves a half-written or
    // truncated file where the original was.
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.tardis-${randomUUID()}.part`);
    const file = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    const info = await stat(target);
    return { path: target, size: info.size };
  }

  if (op === 'ls') {
    if (await approvePath(target, 'read', root, deadline) === 'deny') {
      throw new Error('The person at that computer declined to list this folder.');
    }
    stillTheSamePath(target);
    const entries = [];
    let truncated = false;
    const dir = await opendir(target);
    for await (const entry of dir) {
      if (entries.length >= LS_CAP) {
        truncated = true;
        break;
      }
      let size: number | undefined;
      let modifiedAt: string | undefined;
      try {
        const info = await lstat(path.join(target, entry.name));
        size = info.isFile() ? info.size : undefined;
        modifiedAt = info.mtime.toISOString();
      } catch { /* vanished or unreadable */ }
      entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size, modifiedAt });
    }
    return { path: target, entries, truncated };
  }

  if (op === 'open') {
    if (await approvePath(target, 'open', root, deadline) === 'deny') {
      throw new Error('The person at that computer declined to open this, or it is a file the computer would run.');
    }
    stillTheSamePath(target);
    const problem = await shell.openPath(target);
    if (problem) throw new Error(problem);
    return { path: target };
  }

  throw new Error(`unknown operation: ${op}`);
}

function wsUrl(serverUrl: string): string {
  const url = new URL('/ws/device', serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function connect(generation: number): void {
  if (generation !== linkGeneration || !currentUrl) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(currentUrl));
  } catch (error) {
    console.error('[tardis] device link failed to open:', error);
    scheduleReconnect(generation);
    return;
  }
  socket = ws;

  ws.addEventListener('open', () => {
    if (generation !== linkGeneration) {
      try { ws.close(); } catch { /* already closing */ }
      return;
    }
    backoff = RECONNECT_MIN_MS;
    console.log(`[tardis] offering this computer to ${currentUrl}`);
    ws.send(JSON.stringify({
      type: 'hello',
      deviceId: deviceId(),
      ...(currentUrl && trustedComputerUrl(currentUrl) ? {
        registrationKey: registrationKey(), desktopId: desktopIdentity(), computer: computer.status(),
      } : {}), // Never transmit the pairing proof over non-loopback plaintext.
      name: os.hostname(),
      platform: process.platform,
      homeDir: os.homedir(),
      workspaceRoot: workspaceRoot() ?? '',
      version: app.getVersion(),
    }));
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    if (generation !== linkGeneration) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (msg.type === 'cancel') {
      cancelRequest(String(msg.id ?? ''));
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancelled', id: msg.id }));
      return;
    }
    if (msg.type !== 'request') return;
    const id = String(msg.id ?? '');
    const op = String(msg.op ?? '');
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const answer = (payload: Record<string, unknown>) => {
      if (generation === linkGeneration && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'reply', id, ...payload }));
      }
    };
    if (inflight >= MAX_INFLIGHT && op !== 'computer.stop' && op !== 'computer.end') {
      answer({ ok: false, error: 'That computer is already handling as many requests as it will take at once.' });
      return;
    }
    inflight += 1;
    void handle(id, op, params)
      .then(
        (result) => answer({ ok: true, result }),
        (error: unknown) => answer({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => { inflight -= 1; });
  });

  ws.addEventListener('close', () => {
    if (socket === ws) socket = null;
    // Only the socket that still owns the link may ask for another one.
    if (generation !== linkGeneration) return;
    console.log(`[tardis] device link closed; retrying in ${Math.round(backoff / 1000)}s`);
    stopEverything();
    scheduleReconnect(generation);
  });
  ws.addEventListener('error', () => {
    try { ws.close(); } catch { /* already closing */ }
  });
}

/** Nobody is listening any more: drop the dialogs and the work. */
function stopEverything(): void {
  computer.stop();
  cancelPendingApprovals();
  for (const id of [...running.keys()]) cancelRequest(id);
}

function scheduleReconnect(generation: number): void {
  if (generation !== linkGeneration || !currentUrl) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => connect(generation), backoff);
  retryTimer.unref?.();
  backoff = Math.min(RECONNECT_MAX_MS, Math.round(backoff * 1.7));
}

/** Point the link at a ship (or move it to a different one). Refuses while
 *  the master switch is off, so a computer that is not offering itself never
 *  announces its name and paths. */
export function startDeviceBridge(serverUrl: string | undefined): void {
  if (!bridgeEnabled()) {
    stopDeviceBridge();
    return;
  }
  if (currentUrl === serverUrl && socket) return;
  teardown();
  currentUrl = serverUrl;
  if (!serverUrl) return;
  initComputerControls(new URL(serverUrl).origin);
  backoff = RECONNECT_MIN_MS;
  connect(linkGeneration);
}

/** Re-announce this machine (its workspace folder just changed). */
export function refreshDeviceBridge(): void {
  const url = currentUrl;
  if (!url || !bridgeEnabled()) return;
  teardown();
  currentUrl = url;
  backoff = RECONNECT_MIN_MS;
  connect(linkGeneration);
}

function teardown(): void {
  // A new generation orphans every callback belonging to the old link.
  linkGeneration += 1;
  clearTimeout(retryTimer);
  stopEverything();
  const ws = socket;
  socket = null;
  if (ws) {
    try { ws.close(); } catch { /* already gone */ }
  }
}

export function stopDeviceBridge(): void {
  teardown();
  currentUrl = undefined;
}

export function deviceLinkState(): 'off' | 'linked' | 'connecting' {
  if (!bridgeEnabled()) return 'off';
  return socket?.readyState === WebSocket.OPEN ? 'linked' : 'connecting';
}
