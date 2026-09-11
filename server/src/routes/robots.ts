// /api/robots — linked robot bodies (robot companions dialled in over
// /ws/device with kind:'robot'). Backs the robot_* tools in the
// rivendell-device MCP and the console's robot panel. Same trust model as
// /api/devices: loopback or a configured origin, no app-layer auth; the robot
// enforces its own physical limits and this side only shape-checks.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { AmbiguousDeviceError, callDevice, findRobot, listRobots } from '../devices/bridge.ts';
import {
  isRobotCommand,
  latestRobotEventSeq,
  onRobot,
  recentRobotEvents,
  robotCommandParams,
  robotCommandTimeout,
  robotEventAgent,
  ROBOT_COLORS,
  ROBOT_EXPRESSIONS,
  ROBOT_IRIS_SHAPES,
  ROBOT_LIMITS,
} from '../devices/robots.ts';

export const robotsRouter = Router();

robotsRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ robots: listRobots(), eventAgent: robotEventAgent() || null, latestEventSeq: latestRobotEventSeq() });
});

/** Static vocabulary so a UI or agent can offer valid choices without guessing. */
robotsRouter.get('/catalogue', (_req, res) => {
  res.json({ expressions: ROBOT_EXPRESSIONS, colors: ROBOT_COLORS, irisShapes: ROBOT_IRIS_SHAPES, limits: ROBOT_LIMITS });
});

robotsRouter.get('/events', (req, res) => {
  const names = String(req.query.names ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    events: recentRobotEvents({
      robot: typeof req.query.robot === 'string' ? req.query.robot : undefined,
      since: Number(req.query.since) || 0,
      limit: Number(req.query.limit) || 30,
      names,
    }),
    latestEventSeq: latestRobotEventSeq(),
  });
});

/** Live feed for the console: events, status changes and disconnects. */
robotsRouter.get('/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (kind: string, payload: unknown) => { res.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`); };
  write('robots', { robots: listRobots() });
  const offs = [
    onRobot('event', (event) => write('event', event)),
    onRobot('status', (payload) => write('status', payload)),
    onRobot('offline', (payload) => write('offline', payload)),
  ];
  const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(beat); for (const off of offs) off(); });
});

/** POST /api/robots/:op — { robot?, ...params }. `robot` may be an id, a
 *  name, or omitted when exactly one robot is linked. The reply is whatever
 *  the robot returned; a refusal or timeout is a 502 with the robot's words. */
robotsRouter.post('/:op', asyncHandler(async (req, res) => {
  const op = String(req.params.op);
  if (!isRobotCommand(op)) { res.status(400).json({ error: `Unknown robot command "${op}".` }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  let robot;
  try { robot = findRobot(String(body.robot ?? '')); }
  catch (error) {
    if (error instanceof AmbiguousDeviceError) { res.status(409).json({ error: error.message }); return; }
    throw error;
  }
  if (!robot) {
    const linked = listRobots();
    res.status(404).json({ error: linked.length
      ? `No linked robot called ${JSON.stringify(String(body.robot ?? ''))}. Linked now: ${linked.map((r) => `${r.name} (${r.id})`).join(', ')}.`
      : 'No robot is linked right now. Start the TARDIS robot companion on the robot to make it reachable.' });
    return;
  }
  let params: Record<string, unknown>;
  try { params = robotCommandParams(op, body); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const reply = await callDevice(robot.id, `robot.${op}`, params, robotCommandTimeout(op), ac.signal);
  if (ac.signal.aborted) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!reply.ok) { res.status(502).json({ error: reply.error }); return; }
  res.json({ robot: robot.id, robotName: robot.name, ...(reply.result && typeof reply.result === 'object' ? reply.result as object : { result: reply.result }) });
}));
