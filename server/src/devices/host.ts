// Optional graphical-session companion; npm run computer:host. It exposes no
// listener and carries no server credentials. All control grants live here.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WebSocket } from 'ws';
import { JsonStore } from '../lib/jsonStore.ts';
import { ComputerController, desktopIdentity, trustedComputerUrl, type ControlStatus } from '../../../desktop/native/computer.mjs';

const url = process.env.RIVENDELL_COMPUTER_SERVER_URL || 'http://127.0.0.1:8091';
if (!trustedComputerUrl(url)) throw new Error('Computer control requires HTTPS, except on loopback.');
const identity = new JsonStore<{ id: string; key: string }>('computer-host.json', []);
const saved = (await identity.list())[0] ?? await identity.create({ id: randomUUID(), key: randomBytes(32).toString('hex') });
let socket: WebSocket | null = null;
let indicator: ChildProcess | null = null;
let reconnect: NodeJS.Timeout | undefined;
let quitting = false;
const requests = new Set<string>();
let computerStartId = '';

const computer = new ComputerController({
  automatic: () => process.env.RIVENDELL_COMPUTER_UNATTENDED === 'true',
  approve: async (request, signal) => {
    return new Promise<boolean>((resolve) => {
      execFile('zenity', ['--question', '--no-markup', '--title=TARDIS computer control',
        '--ok-label=Allow for 5 minutes', '--cancel-label=No',
        `--text=${request.label} requests full desktop access for:\n${request.purpose}\n\nConnected server: ${new URL(url).origin}\nThis shares visible screens with the agent's model and permits mouse/keyboard input in any app. File restrictions do not sandbox GUI control. Approve only if you requested this.`],
      { signal, timeout: 60_000 }, error => resolve(!error));
    });
  },
  changed: (status: ControlStatus) => {
    if (!status.control) computerStartId = '';
    const previous = indicator;
    indicator = null;
    previous?.kill();
    // Dedicated autonomous desktops can stay unobstructed. The console's
    // controller indicator and Stop/Resume remain available on every client.
    if (status.control && process.env.RIVENDELL_COMPUTER_INDICATOR !== 'false') {
      const child = spawn('zenity', ['--progress', '--pulsate', '--no-markup', '--title=TARDIS computer use', '--cancel-label=Stop control',
        `--text=${status.control.label} is controlling this desktop.\n${status.control.purpose}\nClose this window or press Stop to revoke immediately.`], { stdio: ['pipe', 'ignore', 'ignore'] });
      indicator = child;
      child.stdin?.write('1\n');
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
    name: process.env.RIVENDELL_COMPUTER_NAME || hostname(), platform: process.platform, version: 'computer-2', computer: computer.status() })));
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
console.log(`[computer] ${hostname()} → ${new URL(url).origin}; ${computer.status().supported ? 'native desktop available' : computer.status().reason}`);
connect();
