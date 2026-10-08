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
import { computerOwnerTurnRunning, loadComputerTargets, revokeComputerContext } from './context.ts';
import { forgetRobot, recordRobotEvent, robotStatus, safeRobotName, setRobotStatus, type RobotStatus } from './robots.ts';
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
  computer?: ComputerState;
  desktopId?: string;
};

/** What the desktop reports, plus when and why the server first saw it paused
 *  (the desktop only says paused or not). */
export type ComputerState = ControlStatus & { pausedAt?: number; pausedReason?: string };

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
const startingDesktops = new Map<string, { id: string; owner?: string }>();
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
export async function callDevice(
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
    // The device-reported control owner is capped at 200 characters, so a
    // longer identity could never match its own lease anywhere. Fail closed
    // here with an honest error instead of a silently degraded takeover.
    if (typeof params.owner === 'string' && params.owner.length > 200) {
      return Promise.resolve({ ok: false, error: `Desktop lease owner identity is ${params.owner.length} characters; the limit is 200. Use a shorter workspace path.` });
    }
    if (startingDesktops.has(desktop)) {
      return Promise.resolve({ ok: false, error: `This physical desktop is already in use or awaiting approval.${desktopHolderNote(desktop)} Wait; do not use its other client to bypass the owner.` });
    }
    // Reserve the desktop before anything async, so two starts can never both
    // pass this gate while a stale lease is being ended.
    startingDesktops.set(desktop, { id, ...(typeof params.owner === 'string' ? { owner: params.owner } : {}) });
    // Who holds the desktop right now. A live lease held by another lane is
    // never taken. The same lane replacing itself is always safe, and a holder
    // whose turn is gone left the lease behind when it died (a failed compact
    // once killed a live turn, and its 40-minute grant then refused that same
    // lane and pushed other work off the machine): let it go and start cleanly.
    let heldBy: { device: Device; owner: string } | null = null;
    for (const d of devices.values()) {
      const c = (d.info.desktopId || d.info.id) === desktop ? d.info.computer?.control : undefined;
      if (c && c.expiresAt > Date.now()) { heldBy = { device: d, owner: c.owner }; break; }
    }
    if (heldBy) {
      const sameLane = typeof params.owner === 'string' && params.owner === heldBy.owner;
      if (!sameLane && computerOwnerTurnRunning(heldBy.owner)) {
        if (startingDesktops.get(desktop)?.id === id) startingDesktops.delete(desktop);
        return Promise.resolve({ ok: false, error: `This physical desktop is already in use or awaiting approval.${desktopHolderNote(desktop)} Wait; do not use its other client to bypass the owner.` });
      }
      await releaseHeldControl(heldBy.device);
      // The abort listener registers only inside the promise below, and an
      // AbortSignal never replays an abort that fired while that await ran,
      // so a cancelled turn could still take a fresh lease: re-check here.
      if (signal?.aborted) {
        if (startingDesktops.get(desktop)?.id === id) startingDesktops.delete(desktop);
        return { ok: false, error: 'Request cancelled.' };
      }
    }
  }
  const ceiling = op.startsWith('computer.') ? (starting ? 60_000 : 30_000) : DEVICE_MAX_TIMEOUT_MS;
  const budget = Math.min(Math.max(1_000, timeoutMs), ceiling);
  const deadlineAt = Date.now() + budget;
  return new Promise<DeviceReply>((done) => {
    let finished = false;
    const release = () => { if (startingDesktops.get(desktop)?.id === id) startingDesktops.delete(desktop); };
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

// The live grant per computer, remembered when a start succeeds. The desktop
// only lets a grant's own session end it without pausing, so an interrupt needs
// it. A stale entry is harmless: ending with a dead session just fails.
const grants = new Map<string, { owner: string; session: string }>();

export function rememberComputerGrant(deviceId: string, owner: string, session: string): void {
  grants.set(deviceId, { owner, session });
}

/** Forget the remembered grant. With a session, only if it is still that one,
 *  so a late cleanup never drops a newer grant. */
export function forgetComputerGrant(deviceId: string, session?: string): void {
  if (session === undefined || grants.get(deviceId)?.session === session) grants.delete(deviceId);
}

/** End a control its holder cannot use anymore: the same lane starting again
 *  (it replaces itself), or a holder whose turn is gone and died without
 *  releasing. Only the remembered session can end a grant without pausing, so
 *  a control with no matching record (the server restarted since it was made)
 *  is left to the device's own expiry while the fresh start supersedes it. */
async function releaseHeldControl(device: Device): Promise<void> {
  const control = device.info.computer?.control;
  const grant = grants.get(device.info.id);
  if (!control || !grant || grant.owner !== control.owner) return;
  const ended = await callDevice(device.info.id, 'computer.end', { session: grant.session }, 3000);
  if (ended.ok) forgetComputerGrant(device.info.id, grant.session);
}

// When each owner's turn was last interrupted, so a start that lands after the
// interrupt can be ended at once instead of leaving a 40-minute grant behind.
const interruptedAt = new Map<string, number>();
const INTERRUPT_MEMORY_MS = 10 * 60_000;

export function wasInterruptedSince(owner: string, since: number): boolean {
  return (interruptedAt.get(owner) ?? 0) >= since;
}

// Console Stop presses, so a pause the desktop reports right after one can say
// it came from the console rather than the PC. Consumed by the first pause that
// follows, cleared when the press did not reach the computer, and dropped when
// it disconnects.
const consoleStops = new Map<string, number>();
const CONSOLE_STOP_WINDOW_MS = 15_000;

export function noteConsoleStop(deviceId: string): void {
  consoleStops.set(deviceId, Date.now());
}

export function clearConsoleStop(deviceId: string): void {
  consoleStops.delete(deviceId);
}

function takePauseReason(deviceId: string): string {
  const at = consoleStops.get(deviceId);
  consoleStops.delete(deviceId);
  return at !== undefined && Date.now() - at < CONSOLE_STOP_WINDOW_MS
    ? 'Stop control was pressed in the TARDIS console.'
    : 'Stop was pressed on the PC (the control indicator, its keyboard shortcut, or by closing it).';
}

/** An agent's turn was interrupted: end the grant it holds and cancel its input.
 *  This is NOT the person pressing Stop, so it must never pause the computer.
 *  The desktop treats its `stop` op as the person's Stop (and pauses in
 *  automatic mode), so an interrupt never sends it. A start still in flight is
 *  cancelled (the desktop closes its approval prompt, or drops a grant it had
 *  just made, without pausing), and a grant already held is ended with its own
 *  session. With no session on record the grant lapses on its own rather than
 *  risk a pause nobody asked for. */
export async function stopComputersForOwner(owner: string): Promise<void> {
  // First, and synchronously: from here the interrupted turn's context no
  // longer opens a grant, whatever tool call it still has in flight.
  revokeComputerContext(owner);
  const now = Date.now();
  for (const [name, at] of interruptedAt) if (now - at > INTERRUPT_MEMORY_MS) interruptedAt.delete(name);
  interruptedAt.set(owner, now);
  await Promise.all([...devices.values()].map(async (d) => {
    for (const pending of [...d.pending.values()]) if (pending.computerOwner === owner) pending.cancel('Interrupted.');
    const grant = grants.get(d.info.id);
    if (grant?.owner !== owner) return;
    const ended = await callDevice(d.info.id, 'computer.end', { session: grant.session }, 3000);
    // Forget it only once the computer confirmed; a failed end can be retried.
    if (ended.ok) forgetComputerGrant(d.info.id, grant.session);
  }));
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

/** A lane or desktop name quoted into another agent's tool error: one plain line. */
function holderName(value: string): string {
  return value.replace(/^bot-/, '').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ._@-]/gu, '').trim().slice(0, 40).trim();
}

/** Who has a physical desktop right now, for the refusal a second starter gets.
 *  A live lease names its holder and the minutes left; a start still waiting on
 *  approval names the lane that asked (kept with the reservation, so it survives a
 *  cancelled start). What the holder is doing (its purpose) is deliberately left
 *  out: it is another agent's free text. Empty when nothing is known. */
function desktopHolderNote(desktop: string): string {
  const now = Date.now();
  for (const d of devices.values()) {
    if ((d.info.desktopId || d.info.id) !== desktop) continue;
    const c = d.info.computer?.control;
    const who = c ? holderName(c.label) : '';
    if (!c || c.expiresAt <= now || !who) continue;
    return ` Held by ${who}; the lease ends in about ${Math.max(1, Math.ceil((c.expiresAt - now) / 60_000))} min.`;
  }
  const who = holderName(startingDesktops.get(desktop)?.owner ?? '');
  return who ? ` ${who} is starting a session on it now, waiting for approval.` : '';
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
            ? msg.capabilities.filter((c: unknown): c is string => typeof c === 'string' && /^[a-z0-9_-]{1,40}$/i.test(c)).slice(0, 64)
            : undefined;
          const info: DeviceInfo = {
            id,
            // A robot's name is quoted into agent prompts; keep it one plain line.
            name: kind === 'robot' ? safeRobotName(msg.name, id) : String(msg.name ?? '').trim() || id,
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
          const before = registered.info.computer;
          const next: ComputerState = computerStatus(msg.computer);
          if (next.paused) {
            // The first sighting stamps when and why; later updates keep it.
            next.pausedAt = before.paused && before.pausedAt ? before.pausedAt : Date.now();
            next.pausedReason = before.paused && before.pausedReason ? before.pausedReason : takePauseReason(registered.info.id);
          }
          registered.info.computer = next;
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
          grants.delete(registered.info.id);
          consoleStops.delete(registered.info.id);
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
