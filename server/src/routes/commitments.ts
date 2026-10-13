// /api/commitments — agent-scoped open commitments: the always-there list
// that survives compaction by construction. Agents add and clear their own
// entries; the session seed stitches the list in (piece 2).

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { listAgents } from '../chat/agents.ts';
import { addCommitment, clearCommitment, listCommitments } from '../lib/commitmentStore.ts';

export const commitmentsRouter = Router();

/** `agent` may be an id (exact, preferred) or a name. A name that matches
 *  more than one roster entry is refused, so a duplicate display name can
 *  never reach another agent's commitments. */
function resolveAgent(agent: unknown): { id: string } | { ambiguous: string[] } | undefined {
  const needle = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  if (!needle) return undefined;
  const agents = listAgents();
  const byId = agents.filter((a) => a.id.toLowerCase() === needle);
  if (byId.length > 0) return byId[0];
  const byName = agents.filter((a) => a.name.trim().toLowerCase() === needle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return { ambiguous: byName.map((a) => a.name) };
  return undefined;
}

function agentIdOrError(agent: unknown): { id: string } | { error: string; status: number } {
  const match = resolveAgent(agent);
  if (!match) return { error: 'unknown agent', status: 422 };
  if ('ambiguous' in match) {
    return { error: `ambiguous name (${match.ambiguous.join(' and ')}); pass the agent id`, status: 422 };
  }
  return { id: match.id };
}

commitmentsRouter.get('/', asyncHandler(async (req, res) => {
  const r = agentIdOrError(req.query.agent);
  if ('error' in r) { res.status(r.status).json({ error: r.error }); return; }
  res.json({ commitments: listCommitments(r.id) });
}));

commitmentsRouter.post('/add', asyncHandler(async (req, res) => {
  const { agent, text, due } = req.body ?? {};
  const r = agentIdOrError(agent);
  if ('error' in r) { res.status(r.status).json({ error: r.error }); return; }
  const result = addCommitment(r.id, typeof text === 'string' ? text : '', typeof due === 'string' ? due : undefined);
  if (result.error) { res.status(409).json({ error: result.error }); return; }
  res.json({ commitment: result.commitment });
}));

commitmentsRouter.post('/clear', asyncHandler(async (req, res) => {
  const { agent, id } = req.body ?? {};
  const r = agentIdOrError(agent);
  if ('error' in r) { res.status(r.status).json({ error: r.error }); return; }
  if (typeof id !== 'string' || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }
  if (!clearCommitment(r.id, id)) { res.status(404).json({ error: 'commitment not found' }); return; }
  res.json({ cleared: id });
}));
