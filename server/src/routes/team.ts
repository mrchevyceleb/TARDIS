// /api/team — agent-to-agent messaging surface (backs the rivendell-team MCP).

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { deliverTeamMessage, teamRoster, teamRecent } from '../chat/teamBus.ts';
import { createJobWatch, deleteJobWatch, jobWatchesWithAgents } from '../chat/jobWatches.ts';

export const teamRouter = Router();

teamRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ agents: await teamRoster() });
}));

teamRouter.post('/message', asyncHandler(async (req, res) => {
  const { from, to, text, hop, wait, source, lane, priority } = req.body ?? {};
  if (typeof to !== 'string' || typeof text !== 'string' || typeof from !== 'string') {
    res.status(400).json({ error: 'from, to and text are required' });
    return;
  }
  if (source !== undefined && source !== 'voice' && source !== 'slack') {
    res.status(400).json({ error: 'unknown message source' });
    return;
  }
  if (priority !== undefined && typeof priority !== 'boolean') {
    res.status(400).json({ error: 'priority must be a boolean' });
    return;
  }
  const aborter = new AbortController();
  const abortWait = () => aborter.abort();
  req.once('aborted', abortWait);
  res.once('close', abortWait);
  let result;
  try {
    result = await deliverTeamMessage({ from, to, text, hop, wait, source, priority,
      fromLane: lane === 'bg' ? 'bg' : 'main',
      // A voice recovery outbox item and a Slack bridge post must both survive
      // the HTTP caller leaving: the durable record is the delivery, and the
      // bridge's connection can drop mid-wait (review 2026-10-20). Without
      // this, an aborted request deletes the queued Slack message.
      signal: source === 'voice' || source === 'slack' ? undefined : aborter.signal,
    });
  } finally {
    req.off('aborted', abortWait);
    res.off('close', abortWait);
  }
  if (res.destroyed || res.writableEnded) return;
  res.status(result.delivered ? 200 : 422).json(result);
}));

teamRouter.get('/recent', asyncHandler(async (req, res) => {
  const name = String(req.query.name ?? '');
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 8));
  res.json({ messages: await teamRecent(name, limit) });
}));

// /watch — background job watches (watch_job tool): the server watches a
// pid / file / command and wakes the calling agent's own thread when it
// resolves or times out. Same delivery path as a routine.
teamRouter.get('/watch', asyncHandler(async (_req, res) => {
  res.json({ watches: await jobWatchesWithAgents() });
}));

teamRouter.post('/watch', asyncHandler(async (req, res) => {
  const { agentId, note, pid, file, command, timeoutMin, lane } = req.body ?? {};
  if (typeof agentId !== 'string' || !agentId.trim()) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  try {
    const watch = await createJobWatch({ agentId, lane, note, pid, file, command, timeoutMin });
    res.status(201).json({ watch });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}));

teamRouter.delete('/watch/:id', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  res.json({ deleted: await deleteJobWatch(id) });
}));

// /fresh — give an agent a clean, empty chat before a task (card-8d427d).
// Matt, Kip, Max and Riley only; the lane keeps its persona, memory,
// commitments and cards. Refuses while the lane has a live turn. Caller
// identity comes only from the server-stamped MCP header
// (x-rivendell-agent-id, set from RIVENDELL_AGENT_ID); a caller/caller-id
// in the body is ignored, never an identity.
teamRouter.post('/fresh', asyncHandler(async (req, res) => {
  const { agent } = req.body ?? {};
  if (typeof agent !== 'string' || !agent.trim()) {
    res.status(400).json({ error: 'agent is required' });
    return;
  }
  const stamped = req.get('x-rivendell-agent-id')?.trim() ?? '';
  const { freshCallerFromAgentId, freshChatByName } = await import('../chat/freshChat.ts');
  const caller = stamped ? freshCallerFromAgentId(stamped) : null;
  if (!caller) {
    res.status(403).json({ error: 'only Matt, Kip, Max and Riley can fresh a chat' });
    return;
  }
  const result = await freshChatByName(agent, caller);
  if (!result.ok) {
    res.status(422).json({ error: result.reason });
    return;
  }
  res.json({ ok: true, agent: result.agent, agentId: result.agentId });
}));
