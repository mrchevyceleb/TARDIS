// /api/instructions — every instruction file each agent gets, editable in
// place from the Instructions room.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { InstructionEditError, instructionLayers, saveInstructionFile } from '../chat/instructionLayers.ts';

export const instructionsRouter = Router();

instructionsRouter.get('/:agentId', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.agentId) ? req.params.agentId[0] : req.params.agentId;
  const result = instructionLayers(id);
  if (!result) { res.status(404).json({ error: 'agent not found' }); return; }
  res.json({ agent: { id: result.agent.id, name: result.agent.name, engine: result.agent.engine }, layers: result.layers, assembled: result.assembled });
}));

instructionsRouter.put('/', asyncHandler(async (req, res) => {
  const { path, text, mtime } = req.body ?? {};
  if (typeof path !== 'string' || typeof text !== 'string' || typeof mtime !== 'number') {
    res.status(400).json({ error: 'path, text and mtime are required' });
    return;
  }
  try {
    res.json(saveInstructionFile(path, text, mtime));
  } catch (error) {
    if (error instanceof InstructionEditError) { res.status(error.status).json({ error: error.message }); return; }
    throw error;
  }
}));
