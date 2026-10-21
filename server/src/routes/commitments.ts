// /api/commitments — agent-scoped open commitments: the always-there list
// that survives compaction by construction. Agents add and clear their own
// entries; the session seed stitches the list in (piece 2).

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { listAgents } from '../chat/agents.ts';
import { addCommitment, clearCommitment, listCommitments } from '../lib/commitmentStore.ts';
import { parseDue } from '../lib/promiseScan.ts';

export const commitmentsRouter = Router();

/** `agent` may be an id (exact, preferred) or a name. A name that matches
 *  more than one roster entry is refused, and so is a needle that matches
 *  one agent's id AND a different agent's display name (names are freely
 *  editable, so a display name can equal another agent's id): neither match
 *  is trustworthy, so no request can reach another agent's commitments. */
function resolveAgent(agent: unknown): { id: string } | { ambiguous: string[] } | undefined {
  const needle = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  if (!needle) return undefined;
  const agents = listAgents();
  const byId = agents.filter((a) => a.id.toLowerCase() === needle);
  const byName = agents.filter((a) => a.name.trim().toLowerCase() === needle);
  if (byId.length > 0) {
    const other = byName.find((a) => a.id !== byId[0].id);
    if (other) return { ambiguous: [byId[0].name, other.name] };
    return byId[0];
  }
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

/** Owner-scoped MUTATIONS resolve BY ID ONLY. Names are freely editable, so
 *  name fallback would let a stale process from a deleted agent act on a
 *  same-display-name replacement (the exact crossover the retired-id
 *  tombstone prevents for ids). Reads keep name resolution; the list output
 *  shows each id so a lane can pass it for add/clear. */
function agentIdForMutation(agent: unknown): { id: string } | { error: string; status: number } {
  const needle = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  if (!needle) return { error: 'unknown agent', status: 422 };
  const byId = listAgents().filter((a) => a.id.toLowerCase() === needle);
  if (byId.length === 1) return { id: byId[0].id };
  return { error: 'add/clear need the agent id (the list action shows it); a display name is not owner-proof', status: 422 };
}

commitmentsRouter.get('/', asyncHandler(async (req, res) => {
  const r = agentIdOrError(req.query.agent);
  if ('error' in r) { res.status(r.status).json({ error: r.error }); return; }
  // agentId rides every list response: a lane that listed by name (banana's
  // shared MCP has no identity env) learns the stable id its id-only
  // add/clear calls need, so the first add never dead-ends on a display name.
  res.json({ agentId: r.id, commitments: listCommitments(r.id) });
}));

commitmentsRouter.post('/add', asyncHandler(async (req, res) => {
  const { agent, text, due } = req.body ?? {};
  const r = agentIdForMutation(agent);
  if ('error' in r) { res.status(r.status).json({ error: r.error }); return; }
  const dueText = typeof due === 'string' && due.trim() ? due : undefined;
  // Store the instant once; the shared write guard refuses unclear or distant
  // work times before any commitment is saved.
  const parsedAt = dueText ? parseDue(dueText) : undefined;
  const dueAt = parsedAt ?? undefined;
  const result = addCommitment(r.id, typeof text === 'string' ? text : '', dueText, { dueAt });
  if (result.error) { res.status(409).json({ error: result.error }); return; }
  res.json({
    commitment: result.commitment,
    ...(dueText && parsedAt === undefined ? {
      monitorable: false,
      note: 'The due text could not be parsed to a time, so the past-due sweep cannot raise it. Restate as a clock form like "6:40pm ET today" or "Wed Oct 14 10:00am ET", or clear and re-add it.',
    } : {}),
  });
}));

commitmentsRouter.post('/clear', asyncHandler(async (req, res) => {
  const { agent, id } = req.body ?? {};
  const r = agentIdForMutation(agent);
  if ('error' in r) { res.status(r.status).json({ error: r.error }); return; }
  if (typeof id !== 'string' || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }
  if (!clearCommitment(r.id, id)) { res.status(404).json({ error: 'commitment not found' }); return; }
  res.json({ cleared: id });
}));
