// /api/routines — agent-scoped automations (schedule + prompt → agent thread).

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { createRoutine, updateRoutine, deleteRoutine, runRoutine, routinesWithAgents } from '../chat/routines.ts';

export const routinesRouter = Router();

routinesRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ routines: routinesWithAgents() });
}));

routinesRouter.post('/', asyncHandler(async (req, res) => {
  const { name, agentId, schedule, prompt } = req.body ?? {};
  if (typeof agentId !== 'string' || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'agentId and prompt are required' });
    return;
  }
  const routine = createRoutine({ name: String(name ?? 'Routine'), agentId, schedule: String(schedule ?? 'daily:09:00'), prompt });
  if (!routine) { res.status(422).json({ error: 'could not create routine (bad agent or empty prompt)' }); return; }
  res.status(201).json({ routine });
}));

routinesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { name, schedule, prompt, paused } = req.body ?? {};
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
