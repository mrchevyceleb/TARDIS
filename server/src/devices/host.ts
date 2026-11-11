// Optional graphical-session companion: npm run computer:host, or on a Mac the
// LaunchAgent that npm run computer:mac -- install sets up. It exposes no
// listener and carries no server credentials. All control grants live here.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WebSocket } from 'ws';
import { JsonStore } from '../lib/jsonStore.ts';
import { ComputerController, desktopIdentity, trustedComputerUrl, type ControlStatus } from '../../../desktop/native/computer.mjs';

const url = process.env.RIVENDELL_COMPUTER_SERVER_URL || 'http://127.0.0.1:8091';
if (!trustedComputerUrl(url)) throw new Error('Computer control requires HTTPS, except on loopback.');
const origin = new URL(url).origin;
const name = process.env.RIVENDELL_COMPUTER_NAME || hostname();
const identity = new JsonStore<{ id: string; key: string }>('computer-host.json', []);
const saved = (await identity.list())[0] ?? await identity.create({ id: randomUUID(), key: randomBytes(32).toString('hex') });
let socket: WebSocket | null = null;
let indicator: ChildProcess | null = null;
let displayHold: ChildProcess | null = null;
let reconnect: NodeJS.Timeout | undefined;
let quitting = false;
const requests = new Set<string>();
let computerStartId = '';

// A sleeping display gives black captures, so on a Mac the display stays awake
// for exactly as long as an agent holds a grant, as in TARDIS.app. caffeinate
// -w lets go by itself if this process dies.
function holdDisplayAwake(on: boolean): void {
  if (process.platform !== 'darwin') return;
  if (on && !displayHold) {
    const child = spawn('caffeinate', ['-d', '-w', String(process.pid)], { stdio: 'ignore' });
    displayHold = child;
    child.on('error', () => { if (displayHold === child) displayHold = null; });
    child.on('exit', () => { if (displayHold === child) displayHold = null; });
  } else if (!on && displayHold) {
    displayHold.kill();
    displayHold = null;
  }
}

const computer: ComputerController = new ComputerController({
  automatic: () => process.env.RIVENDELL_COMPUTER_UNATTENDED === 'true',
  approve: async (request, signal) => {
    // A Mac asks through its native helper; the GNOME/X11 host uses zenity.
    if (computer.adapter.ask) {
      return computer.adapter.ask({ title: `${request.label} wants to control this computer`,
        detail: `${request.purpose}\n\nServer: ${origin}\n\nFor ${request.minutes} minutes this shares visible screens with the agent's model and allows mouse and keyboard input in any app. GUI control is broad trust, not a sandbox: file restrictions do not protect what is on screen. Only allow a task you requested.`,
        allow: `Allow for ${request.minutes} minutes` }, signal).catch(() => false);
    }
    return new Promise<boolean>((resolve) => {
      execFile('zenity', ['--question', '--no-markup', '--title=TARDIS computer control',
        '--ok-label=Allow for 40 minutes', '--cancel-label=No',
        `--text=${request.label} requests full desktop access for:\n${request.purpose}\n\nConnected server: ${origin}\nThis shares visible screens with the agent's model and permits mouse/keyboard input in any app. File restrictions do not sandbox GUI control. Approve only if you requested this.`],
      { signal, timeout: 60_000 }, error => resolve(!error));
    });
  },
  changed: (status: ControlStatus) => {
    if (!status.control) computerStartId = '';
    holdDisplayAwake(Boolean(status.control));
    const previous = indicator;
    indicator = null;
    previous?.kill();
    // Dedicated autonomous desktops can stay unobstructed. The console's
    // controller indicator and Stop/Resume remain available on every client.
    if (status.control && process.env.RIVENDELL_COMPUTER_INDICATOR !== 'false') {
      const text = `${status.control.label} is controlling this desktop.\n${status.control.purpose}`;
      const child = computer.adapter.indicator
        ? computer.adapter.indicator(text)
        : spawn('zenity', ['--progress', '--pulsate', '--no-markup', '--title=TARDIS computer use', '--cancel-label=Stop control',
          `--text=${text}\nClose this window or press Stop to revoke immediately.`], { stdio: ['pipe', 'ignore', 'ignore'] });
      indicator = child;
      if (!computer.adapter.indicator) child.stdin?.write('1\n');
      // Stop, closing the indicator, or failing to show it at all revokes control.
      child.on('close', () => { if (indicator === child) { indicator = null; computer.stop(true); } });
      child.on('error', () => { if (indicator === child) { indicator = null; computer.stop(true); } });
    }
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'computer-state', computer: status }));
  },
});

function connect(): void {
  if (quitting) return;
  const target = new URL('/ws/device', url); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(target, { maxPayload: 64 * 1024 }); socket = ws;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', deviceId: saved.id, registrationKey: saved.key, desktopId: desktopIdentity(),
    name, platform: process.platform, version: 'computer-2', computer: computer.status() })));
  ws.on('message', raw => {
    let msg: Record<string, any>;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (msg.type === 'cancel') {
      if (requests.has(msg.id) || computerStartId === msg.id) computer.stop();
      ws.send(JSON.stringify({ type: 'cancelled', id: msg.id }));
      return;
    }
    if (msg.type !== 'request' || typeof msg.id !== 'string') return;
    const answer = (reply: object) => { if (ws === socket && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reply', id: msg.id, ...reply })); };
    if (!String(msg.op).startsWith('computer.')) { answer({ ok: false, error: 'The host companion supports desktop control only. Use server tools for host files/commands.' }); return; }
    if ((requests.size >= 4 && msg.op !== 'computer.stop' && msg.op !== 'computer.end') || requests.has(msg.id)) { answer({ ok: false, error: 'Computer request limit reached.' }); return; }
    requests.add(msg.id);
    void computer.handle(msg.op.slice(9), msg.params).then(result => {
      if (msg.op === 'computer.start' && computer.status().control) computerStartId = msg.id;
      answer({ ok: true, result });
    }, error => answer({ ok: false, error: error.message }))
      .finally(() => requests.delete(msg.id));
  });
  ws.on('close', () => {
    if (socket !== ws) return;
    socket = null; computer.stop(); requests.clear();
    if (!quitting) reconnect = setTimeout(connect, 3000);
  });
  ws.on('error', () => ws.close());
}
function quit(): void { quitting = true; clearTimeout(reconnect); computer.stop(); socket?.close(); }
process.on('SIGINT', quit); process.on('SIGTERM', quit);
const status = computer.status();
console.log(`[computer] ${name} → ${origin}; ${status.supported ? 'native desktop available' : status.reason}`);
// On a Mac, say up front whether TARDIS holds its two permissions here, so a
// fresh install shows a missing grant before an agent ever asks for control.
if (status.supported && computer.adapter.permissionStatus) {
  computer.adapter.permissionStatus().then((allowed) => {
    const missing = [allowed.screenRecording ? '' : 'Screen Recording', allowed.accessibility ? '' : 'Accessibility'].filter(Boolean);
    console.log(missing.length
      ? `[computer] macOS has not allowed TARDIS ${missing.join(' or ')} yet. At this Mac, open TARDIS and choose TARDIS > Ship > Set Up Computer Control on This Mac, switch TARDIS on under ${missing.join(' and ')} in System Settings > Privacy & Security, then restart this host.`
      : '[computer] macOS allows TARDIS Screen Recording and Accessibility here.');
  }, (error: Error) => console.warn(`[computer] could not read the macOS permissions: ${error.message}`));
}
connect();
