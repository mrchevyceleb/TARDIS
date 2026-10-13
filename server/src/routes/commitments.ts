// /api/commitments — agent-scoped open commitments: the always-there list
// that survives compaction by construction. Agents add and clear their own
// entries; the session seed stitches the list in (piece 2).

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { listAgents } from '../chat/agents.ts';
import { addCommitment, clearCommitment, listCommitments } from '../lib/commitmentStore.ts';

export const commitmentsRouter = Router();

/** `agent` may be a name or an id; the list is keyed by the roster id. */
function resolveAgent(agent: unknown) {
  const needle = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  return needle
    ? listAgents().find((a) => a.id.toLowerCase() === needle || a.name.trim().toLowerCase() === needle)
    : undefined;
}

commitmentsRouter.get('/', asyncHandler(async (req, res) => {
  const match = resolveAgent(req.query.agent);
  if (!match) { res.status(422).json({ error: 'unknown agent' }); return; }
  res.json({ commitments: listCommitments(match.id) });
}));

commitmentsRouter.post('/add', asyncHandler(async (req, res) => {
  const { agent, text, due } = req.body ?? {};
  const match = resolveAgent(agent);
  if (!match) { res.status(422).json({ error: 'unknown agent' }); return; }
  const result = addCommitment(match.id, typeof text === 'string' ? text : '', typeof due === 'string' ? due : undefined);
  if (result.error) { res.status(409).json({ error: result.error }); return; }
  res.json({ commitment: result.commitment });
}));

commitmentsRouter.post('/clear', asyncHandler(async (req, res) => {
  const { agent, id } = req.body ?? {};
  const match = resolveAgent(agent);
  if (!match) { res.status(422).json({ error: 'unknown agent' }); return; }
  if (typeof id !== 'string' || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }
  if (!clearCommitment(match.id, id)) { res.status(404).json({ error: 'commitment not found' }); return; }
  res.json({ cleared: id });
}));
