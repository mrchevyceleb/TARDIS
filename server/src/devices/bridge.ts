// Linked computers. A TARDIS desktop app connects OUT to this server and
// offers its machine: agents can then run a command, read a file, or list a
// folder there. The PC always decides what is actually allowed — this side
// only routes requests and waits for the answer.
//
// Wire protocol (JSON over /ws/device):
//   device → server  {type:'hello', deviceId, name, platform, homeDir, workspaceRoot, version,
//                     kind?:'computer'|'robot', capabilities?:string[], robot?:{...status}}
//                    {type:'reply', id, ok, result|error}
//                    {type:'pong'}
//                    {type:'robot-state', robot:{...status}}        (robots only)
//                    {type:'event', event:{name, data}}             (robots only)
//   server → device  {type:'ready'}
//                    {type:'request', id, op, params}
//                    {type:'ping'}
//
// A robot companion (robot/) is the same link with kind:'robot': it answers
// robot.* requests and reports what its sensors notice. See devices/robots.ts.
//
// Same trust boundary as every other surface here: loopback or an origin the
// operator configured. There is no app-layer auth, so the desktop app asks its
// own user before it runs anything.

import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { trustedWebSocketOrigin } from '../lib/origin.ts';
import { JsonStore } from '../lib/jsonStore.ts';
import { loadComputerTargets } from './context.ts';
import { forgetRobot, recordRobotEvent, robotStatus, setRobotStatus, type RobotStatus } from './robots.ts';
import type { ControlStatus } from '../../../desktop/native/computer.mjs';

export type DeviceOp = 'exec' | 'read' | 'write' | 'ls' | 'open' | `computer.${string}` | `robot.${string}`;

export type DeviceKind = 'computer' | 'robot';

export type DeviceInfo = {
  id: string;
  name: string;
  platform: string;
  homeDir: string;
  workspaceRoot: string;
  version: string;
  connectedAt: string;
  kind: DeviceKind;
  capabilities?: string[];
  computer?: ControlStatus;
  desktopId?: string;
};

export type RobotInfo = DeviceInfo & { kind: 'robot'; robot?: RobotStatus };

export type DeviceReply =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

type Pending = {
  resolve: (reply: DeviceReply) => void;
  timer: NodeJS.Timeout;
  op: DeviceOp;
  cancel: (error: string) => void;
  computerOwner?: string;
};

type Device = {
  info: DeviceInfo;
  socket: WebSocket;
  pending: Map<string, Pending>;
  cancellations: Map<string, () => void>;
  lastSeen: number;
};

const devices = new Map<string, Device>();
const startingDesktops = new Map<string, string>();
const HEARTBEAT_MS = 30_000;
export const DEVICE_DEFAULT_TIMEOUT_MS = 60_000;
export const DEVICE_MAX_TIMEOUT_MS = 600_000;

export function listDevices(): DeviceInfo[] {
  return [...devices.values()]
    .map((device) => device.info)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Online robots with their latest self-reported status. */
export function listRobots(): RobotInfo[] {
  return listDevices()
    .filter((info): info is DeviceInfo & { kind: 'robot' } => info.kind === 'robot')
    .map((info) => ({ ...info, robot: robotStatus(info.id) }));
}

/** Resolve a robot by id or name. With no ref, the only online robot wins. */
export function findRobot(idOrName: string): RobotInfo | undefined {
  const robots = listRobots();
  const needle = idOrName.trim().toLowerCase();
  if (!needle) return robots.length === 1 ? robots[0] : undefined;
  const byId = robots.find((r) => r.id.toLowerCase() === needle);
  if (byId) return byId;
  const byName = robots.filter((r) => r.name.toLowerCase() === needle);
  if (byName.length > 1) throw new AmbiguousDeviceError(byName);
  return byName[0];
}

/** Resolve a device by id or (case-insensitive) name. */
export function findDevice(idOrName: string): DeviceInfo | undefined {
  const needle = idOrName.trim().toLowerCase();
  if (!needle) {
    // One linked computer is the common case: no need to name it.
    return devices.size === 1 ? [...devices.values()][0].info : undefined;
  }
  for (const device of devices.values()) {
    if (device.info.id.toLowerCase() === needle) return device.info;
  }
  // Two machines can share a hostname. Rather than guess which one runs the
  // command, say so and make the caller use the id.
  const byName = [...devices.values()].filter((device) => device.info.name.toLowerCase() === needle);
  if (byName.length === 1) return byName[0].info;
  if (byName.length > 1) throw new AmbiguousDeviceError(byName.map((device) => device.info));
  return undefined;
}

export class AmbiguousDeviceError extends Error {
  constructor(readonly matches: DeviceInfo[]) {
    super(`More than one linked computer is called ${matches[0].name}. Use its id: ${matches.map((m) => m.id).join(', ')}.`);
    this.name = 'AmbiguousDeviceError';
  }
}

/** Ask a linked computer to do something. Never throws: a refusal, a timeout,
 *  and a dropped link all come back as `{ ok: false }`. */
export function callDevice(
  idOrName: string,
  op: DeviceOp,
  params: Record<string, unknown>,
  timeoutMs = DEVICE_DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<DeviceReply> {
  if (signal?.aborted) return Promise.resolve({ ok: false, error: 'Request cancelled.' });
  let info: DeviceInfo | undefined;
  try {
    info = findDevice(idOrName);
  } catch (error) {
    return Promise.resolve({ ok: false, error: (error as Error).message });
  }
  if (!info) {
    const linked = listDevices();
    return Promise.resolve({
      ok: false,
      error: linked.length
        ? `No linked computer called ${JSON.stringify(idOrName)}. Linked now: ${linked.map((d) => d.name).join(', ')}.`
        : 'No computer is linked right now. Open the TARDIS desktop app on the machine you want to use.',
    });
  }
  const device = devices.get(info.id);
  if (!device || device.socket.readyState !== device.socket.OPEN) {
    return Promise.resolve({ ok: false, error: `${info.name} is no longer connected.` });
  }

  const desktop = info.desktopId || info.id;
  const starting = op === 'computer.start';
  const id = randomUUID();
  if (starting) {
    if (startingDesktops.has(desktop) || [...devices.values()].some(d => (d.info.desktopId || d.info.id) === desktop && d.info.computer?.control && d.info.computer.control.expiresAt > Date.now())) {
      return Promise.resolve({ ok: false, error: 'This physical desktop is already in use or awaiting approval. Wait; do not use its other client to bypass the owner.' });
    }
    startingDesktops.set(desktop, id);
  }
  const ceiling = op.startsWith('computer.') ? (starting ? 60_000 : 30_000) : DEVICE_MAX_TIMEOUT_MS;
  const budget = Math.min(Math.max(1_000, timeoutMs), ceiling);
  const deadlineAt = Date.now() + budget;
  return new Promise<DeviceReply>((done) => {
    let finished = false;
    const release = () => { if (startingDesktops.get(desktop) === id) startingDesktops.delete(desktop); };
    const finish = (reply: DeviceReply, cancelled = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); device.pending.delete(id);
      signal?.removeEventListener('abort', cancel);
      if (starting && cancelled) {
        // Caller cancellation is not yet a machine acknowledgement. Hold the
        // physical desktop until its client confirms Stop, or the wire's
        // absolute request deadline has expired on that client (+ clock margin).
        const acknowledge = () => { clearTimeout(guard); device.cancellations.delete(id); release(); };
        const guard = setTimeout(acknowledge, Math.max(0, deadlineAt + 5000 - Date.now()));
        guard.unref?.();
        device.cancellations.set(id, acknowledge);
      } else release();
      done(reply);
    };
    const cancelWithError = (error: string) => {
      if (finished) return;
      finish({ ok: false, error: op === 'computer.act'
        ? `Input may already have run. Do NOT replay it; reconnect and capture the current screen before deciding the next action. ${error}` : error }, true);
      try { device.socket.send(JSON.stringify({ type: 'cancel', id })); } catch { /* deadline remains the fail-safe */ }
    };
    const cancel = () => cancelWithError('Request cancelled.');
    const timer = setTimeout(() => cancelWithError(`${info!.name} did not answer within ${Math.round(budget / 1000)}s.`), budget + 5000);
    timer.unref?.();
    device.pending.set(id, { resolve: reply => finish(reply), cancel: cancelWithError, op, timer,
      ...(starting && typeof params.owner === 'string' ? { computerOwner: params.owner } : {}) });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      device.socket.send(JSON.stringify({ type: 'request', id, op, params: { ...params, timeoutMs: budget, deadlineAt } }));
    } catch (error) {
      cancelWithError(`Could not reach ${info.name}: ${(error as Error).message}`);
    }
  });
}

export async function stopComputersForOwner(owner: string): Promise<void> {
  await Promise.all([...devices.values()].filter(d => d.info.computer?.control?.owner === owner || [...d.pending.values()].some(p => p.computerOwner === owner))
    .map(d => callDevice(d.info.id, 'computer.stop', {}, 3000)));
}

function settleAll(device: Device, error: string): void {
  for (const pending of [...device.pending.values()]) pending.cancel(error);
  device.pending.clear();
}

function computerStatus(value: unknown): ControlStatus {
  const v = value && typeof value === 'object' ? value as Record<string, any> : {};
  const c = v.control;
  return { supported: v.supported === true, reason: typeof v.reason === 'string' ? v.reason.slice(0, 500) : undefined,
    approvalMode: v.approvalMode === 'automatic' ? 'automatic' : 'ask', paused: v.paused === true,
    control: c && typeof c.owner === 'string' && typeof c.label === 'string' && Number.isFinite(c.expiresAt)
      ? { owner: c.owner.slice(0, 200), label: c.label.slice(0, 100), purpose: String(c.purpose ?? '').slice(0, 500), expiresAt: c.expiresAt } : null };
}

export function registerDeviceBridge(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  // TOFU pin of a device-generated registration key. Never returned by the API.
  // A device without the key cannot replace a paired machine, even if it knows
  // the public device id. First use still requires native per-task consent.
  const store = new JsonStore<{ id: string; hash: string }>('device-pairings.json', []);
  const paired = new Map<string, string>();
  const ready = Promise.all([store.list().then(rows => { for (const row of rows) paired.set(row.id, row.hash); }), loadComputerTargets()]);
  void ready.catch(error => console.error('[devices] pairing state unavailable:', error));
  let pairing: Promise<unknown> = Promise.resolve();
  const pin = (id: string, key: unknown) => {
    const work = pairing.then(async () => {
      await ready;
      const hash = typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) ? createHash('sha256').update(key).digest('hex') : '';
      if (paired.has(id) && paired.get(id) !== hash) throw new Error('Device pairing key does not match.');
      if (hash && !paired.has(id)) {
        const next = [...paired].map(([id, hash]) => ({ id, hash }));
        await store.replace([...next, { id, hash }]);
        paired.set(id, hash);
      }
      return Boolean(hash);
    });
    pairing = work.catch(() => {}); // one bad client must not poison later registrations
    return work;
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws/device') return;
    if (!trustedWebSocketOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      let registered: Device | null = null;
      let registering = false;

      let lastSeen = Date.now();
      const beat = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return;
        // Two silent intervals means the far end is gone even though the
        // socket never closed: drop it rather than list a machine that will
        // never answer.
        if (Date.now() - lastSeen > HEARTBEAT_MS * 2.5) {
          ws.terminate();
          return;
        }
        ws.send(JSON.stringify({ type: 'ping' }));
      }, HEARTBEAT_MS);
      beat.unref?.();

      ws.on('message', async (raw) => {
        lastSeen = Date.now();
        if (registered) registered.lastSeen = lastSeen;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === 'hello') {
          if (registered || registering) {
            // One machine per link. Anything else is a client bug or an
            // attempt to hold several registry slots on one socket.
            ws.send(JSON.stringify({ type: 'error', message: 'already registered' }));
            return;
          }
          const id = String(msg.deviceId ?? '').trim();
          if (!id || id.length > 100) {
            ws.send(JSON.stringify({ type: 'error', message: 'valid deviceId is required' }));
            ws.close();
            return;
          }
          registering = true;
          let hasKey = false;
          try { hasKey = await pin(id, msg.registrationKey); }
          catch { ws.close(1008, 'Device pairing failed'); return; }
          if (ws.readyState !== ws.OPEN) return;
          // A reconnect replaces the old link for the same machine.
          const previous = devices.get(id);
          if (previous && previous.socket !== ws) {
            settleAll(previous, 'The link to this computer was replaced.');
            try { previous.socket.close(); } catch { /* already gone */ }
          }
          // A robot must prove it holds its pairing key: an unpaired socket
          // may not impersonate a body that agents will move and speak through.
          const kind: DeviceKind = msg.kind === 'robot' && hasKey ? 'robot' : 'computer';
          const capabilities = Array.isArray(msg.capabilities)
            ? msg.capabilities.filter((c: unknown): c is string => typeof c === 'string' && c.length <= 40).slice(0, 64)
            : undefined;
          const info: DeviceInfo = {
            id,
            name: String(msg.name ?? '').trim().slice(0, 60) || id,
            platform: String(msg.platform ?? 'unknown'),
            homeDir: String(msg.homeDir ?? ''),
            workspaceRoot: String(msg.workspaceRoot ?? ''),
            version: String(msg.version ?? ''),
            connectedAt: new Date().toISOString(),
            kind,
            ...(capabilities?.length ? { capabilities } : {}),
            ...(kind === 'computer' && hasKey && msg.computer ? { computer: computerStatus(msg.computer), desktopId: typeof msg.desktopId === 'string' && /^[a-f0-9]{64}$/.test(msg.desktopId) ? msg.desktopId : id } : {}),
          };
          registered = { info, socket: ws, pending: new Map(), cancellations: new Map(), lastSeen: Date.now() };
          devices.set(id, registered);
          if (kind === 'robot') setRobotStatus(info, msg.robot);
          ws.send(JSON.stringify({ type: 'ready' }));
          console.log(`[tardis] linked ${kind} ${info.name} (${info.platform})`);
          return;
        }

        if (msg.type === 'computer-state' && registered?.info.computer) {
          registered.info.computer = computerStatus(msg.computer);
          return;
        }
        if (msg.type === 'robot-state' && registered?.info.kind === 'robot') {
          setRobotStatus(registered.info, msg.robot);
          return;
        }
        if (msg.type === 'event' && registered?.info.kind === 'robot') {
          recordRobotEvent(registered.info, msg.event);
          return;
        }
        if (msg.type === 'cancelled' && registered) {
          registered.cancellations.get(String(msg.id ?? ''))?.();
          return;
        }
        if (msg.type === 'reply' && registered) {
          const pending = registered.pending.get(String(msg.id ?? ''));
          if (!pending) return;
          registered.pending.delete(String(msg.id));
          clearTimeout(pending.timer);
          pending.resolve(
            msg.ok === true
              ? { ok: true, result: msg.result }
              : { ok: false, error: String(msg.error ?? 'the computer refused') },
          );
        }
      });

      const drop = () => {
        clearInterval(beat);
        if (!registered) return;
        settleAll(registered, `${registered.info.name} disconnected.`);
        if (devices.get(registered.info.id)?.socket === ws) {
          devices.delete(registered.info.id);
          if (registered.info.kind === 'robot') forgetRobot(registered.info.id);
          console.log(`[tardis] unlinked ${registered.info.kind} ${registered.info.name}`);
        }
        registered = null;
      };
      ws.on('close', drop);
      ws.on('error', drop);
    });
  });
}
