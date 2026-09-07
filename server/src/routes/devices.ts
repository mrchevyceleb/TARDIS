import { Router } from 'express';
import {
  DEVICE_DEFAULT_TIMEOUT_MS,
  DEVICE_MAX_TIMEOUT_MS,
  callDevice,
  listDevices,
  findDevice,
  type DeviceOp,
} from '../devices/bridge.ts';
import { asyncHandler } from './helpers.ts';
import { computerTarget, readComputerContext, setComputerTarget, validComputerMcpToken } from '../devices/context.ts';
import { computerVision } from '../chat/vision-adapter.ts';

// Linked computers: the machines running the TARDIS desktop app. The device
// itself enforces what is allowed (its own user approves commands), so this
// surface only relays. Same tailnet-only trust model as the rest of /api.

export const devicesRouter = Router();

devicesRouter.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ devices: listDevices(), target: computerTarget(String(req.query.chatId ?? '')) });
});

devicesRouter.put('/target', asyncHandler(async (req, res) => {
  const { chatId, device } = req.body ?? {};
  if (typeof chatId !== 'string' || !chatId || chatId.length > 200 || typeof device !== 'string' || device.length > 100) {
    res.status(400).json({ error: 'chatId and explicit device id required' }); return;
  }
  if (device && findDevice(device)?.id !== device) { res.status(400).json({ error: 'Device is offline; no target was changed.' }); return; }
  await setComputerTarget(chatId, device);
  res.json({ target: device });
}));

// The trusted console may revoke control or see an already-granted preview.
// It cannot grant itself access or forge the identity displayed on the device.
for (const op of ['stop', 'preview'] as const) {
  devicesRouter.post(`/:id/computer/${op}`, asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (findDevice(id)?.id !== id) { res.status(404).json({ error: 'Computer offline.' }); return; }
    const reply = await callDevice(id, `computer.${op}`, {}, 10_000);
    res.setHeader('Cache-Control', 'no-store');
    res.status(reply.ok ? 200 : 409).json(reply.ok ? reply.result : { error: reply.error });
  }));
}

devicesRouter.post('/computer/:op', asyncHandler(async (req, res) => {
  if (!validComputerMcpToken(req.get('x-rivendell-computer-token'))) { res.status(403).json({ error: 'TARDIS computer MCP required.' }); return; }
  const op = String(req.params.op);
  if (!['start', 'inspect', 'capture', 'act', 'step', 'stop'].includes(op)) { res.status(400).json({ error: 'Unknown computer operation.' }); return; }
  const body = req.body ?? {};
  const device = typeof body.device === 'string' ? body.device : '';
  const info = device ? findDevice(device) : undefined;
  if (!info || info.id !== device || !info.computer) { res.status(400).json({ error: 'Explicit online computer id required. Call device_list; never switch targets implicitly.' }); return; }
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const call = async (operation: string, params: Record<string, unknown>) => {
    const result = await callDevice(device, `computer.${operation}`, params, operation === 'start' ? 60_000 : 30_000, ac.signal);
    if (!result.ok) throw new Error(result.error);
    return result.result as Record<string, any>;
  };
  try {
    let result;
    if (op === 'start') {
      const context = readComputerContext(body.context);
      const selected = computerTarget(context.owner);
      if (selected && selected !== device) throw new Error('This is not the computer selected for this thread. Change the selection explicitly; never fall back to another machine.');
      result = await call('start', { ...context, purpose: body.purpose });
    } else if (op === 'step') {
      if (typeof body.goal !== 'string' || !body.goal.trim() || body.goal.length > 1500) throw new Error('A short, single-step goal is required.');
      const frame = await call('capture', { session: body.session, display: body.display });
      const grounded = await computerVision(frame.image, frame.width, frame.height, body.goal, false, ac.signal);
      if (grounded.action === null) {
        result = { acted: false, observation: String(grounded.summary ?? '').slice(0, 4000) };
      } else {
        let actionFrame = frame;
        if (Date.now() - Number(frame.capturedAt) > 25_000) {
          actionFrame = await call('capture', { session: body.session, display: frame.displayId });
          if (actionFrame.image !== frame.image || JSON.stringify(actionFrame.bounds) !== JSON.stringify(frame.bounds)) {
            throw new Error('Screen changed during vision grounding. No action taken; inspect the current screen.');
          }
        }
        const after = await call('act', { ...grounded, session: body.session, frame: actionFrame.id });
        // Observation failure is NOT input failure; never encourage a replay.
        let observation: string;
        try { observation = String((await computerVision(after.image, after.width, after.height, body.goal, true, ac.signal)).summary ?? ''); }
        catch { observation = 'Input completed, but post-action vision is unavailable. Inspect before deciding what to do next; do not repeat the action.'; }
        result = { acted: true, observation: observation.slice(0, 4000), capturedAt: after.capturedAt };
      }
    } else {
      result = await call(op === 'stop' ? 'end' : op, body);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Computer refused.' });
  }
}));

function timeoutOf(value: unknown): number {
  const asked = Number(value);
  if (!Number.isFinite(asked) || asked <= 0) return DEVICE_DEFAULT_TIMEOUT_MS;
  return Math.min(asked, DEVICE_MAX_TIMEOUT_MS);
}

/** POST /api/devices/:op — { device?, ...params }. `device` may be an id, a
 *  name, or omitted when exactly one computer is linked. */
function relay(op: DeviceOp, pick: (body: Record<string, unknown>) => Record<string, unknown> | string) {
  return asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = pick(body);
    if (typeof params === 'string') {
      res.status(400).json({ error: params });
      return;
    }
    const reply = await callDevice(String(body.device ?? ''), op, params, timeoutOf(body.timeoutMs));
    if (!reply.ok) {
      res.status(502).json({ error: reply.error });
      return;
    }
    res.json(reply.result);
  });
}

devicesRouter.post('/exec', relay('exec', (body) => {
  const command = String(body.command ?? '').trim();
  if (!command) return 'command is required';
  return { command, cwd: body.cwd ? String(body.cwd) : undefined };
}));

devicesRouter.post('/read', relay('read', (body) => {
  const path = String(body.path ?? '').trim();
  if (!path) return 'path is required';
  return { path, maxBytes: body.maxBytes };
}));

devicesRouter.post('/write', relay('write', (body) => {
  const path = String(body.path ?? '').trim();
  if (!path) return 'path is required';
  if (typeof body.content !== 'string') return 'content (string) is required';
  return { path, content: body.content };
}));

devicesRouter.post('/ls', relay('ls', (body) => {
  const path = String(body.path ?? '').trim();
  if (!path) return 'path is required';
  return { path };
}));

devicesRouter.post('/open', relay('open', (body) => {
  const path = String(body.path ?? '').trim();
  if (!path) return 'path is required';
  return { path };
}));
