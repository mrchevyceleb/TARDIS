// /api/routines — agent-scoped automations (schedule + prompt → agent thread).

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { createRoutine, updateRoutine, deleteRoutine, runRoutine, routinesWithAgents, parseSchedule } from '../chat/routines.ts';

const SCHEDULE_HELP = 'schedule must be every:30m, every:2h, daily:09:00, weekdays:09:00, or cron:<minute hour day month weekday> (server-local time)';
const CRON_BOUNDS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const MAX_EVERY_MINUTES = 31 * 24 * 60;

function cronFieldOk(field: string, [min, max]: [number, number]): boolean {
  return field.split(',').every((part) => {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return false;
    if (m[4] !== undefined && parseInt(m[4], 10) < 1) return false;
    if (m[1] === '*') return true;
    const lo = parseInt(m[2], 10);
    const hi = m[3] !== undefined ? parseInt(m[3], 10) : lo;
    return lo >= min && hi <= max && lo <= hi;
  });
}

/** A bad schedule used to fall back to daily 9am without a word. Agents now
 *  create routines through team-mcp, so reject it and say what fits. Stricter
 *  than parseSchedule, which stays lenient so existing routines keep running. */
function badSchedule(schedule: unknown): boolean {
  if (schedule === undefined) return false;
  if (typeof schedule !== 'string' || !parseSchedule(schedule)) return true;
  const s = schedule.trim().toLowerCase();
  const every = /^every:(\d+)(m|min|h|hr)$/.exec(s);
  if (every) {
    const minutes = parseInt(every[1], 10) * (every[2].startsWith('h') ? 60 : 1);
    return minutes < 1 || minutes > MAX_EVERY_MINUTES;
  }
  if (s.startsWith('cron:')) {
    const fields = schedule.trim().slice(5).trim().split(/\s+/);
    return fields.length !== CRON_BOUNDS.length || !fields.every((f, i) => cronFieldOk(f, CRON_BOUNDS[i]));
  }
  return false;
}

export const routinesRouter = Router();

routinesRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ routines: routinesWithAgents() });
}));

routinesRouter.post('/', asyncHandler(async (req, res) => {
  const { name, agentId, schedule, prompt, paused } = req.body ?? {};
  if (typeof agentId !== 'string' || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'agentId and prompt are required' });
    return;
  }
  if (badSchedule(schedule)) { res.status(400).json({ error: SCHEDULE_HELP }); return; }
  const routine = createRoutine({ name: String(name ?? 'Routine'), agentId, schedule: String(schedule ?? 'daily:09:00'), prompt, paused: paused === true });
  if (!routine) { res.status(422).json({ error: 'could not create routine (bad agent or empty prompt)' }); return; }
  res.status(201).json({ routine });
}));

routinesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { name, schedule, prompt, paused } = req.body ?? {};
  if (badSchedule(schedule)) { res.status(400).json({ error: SCHEDULE_HELP }); return; }
  const routine = updateRoutine(id, { name, schedule, prompt, paused });
  if (!routine) { res.status(404).json({ error: 'routine not found' }); return; }
  res.json({ routine });
}));

routinesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  res.json({ deleted: deleteRoutine(id) });
}));

routinesRouter.post('/:id/run', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  res.json(await runRoutine(id, { manual: true }));
}));
