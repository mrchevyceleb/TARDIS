// /api/message-pins — per-agent chat-message pins for the Grok right pane.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { listAgents } from '../chat/agents.ts';
import {
  listMessagePins,
  toggleMessagePin,
  deleteMessagePin,
} from '../lib/messagePinStore.ts';

export const messagePinsRouter = Router();

messagePinsRouter.get('/', asyncHandler(async (req, res) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  res.json({ pins: listMessagePins(agentId) });
}));

messagePinsRouter.post('/', asyncHandler(async (req, res) => {
  const { agentId, blockId, text, ts } = req.body ?? {};
  if (typeof agentId !== 'string' || !agentId.trim() || typeof blockId !== 'string' || !blockId.trim()) {
    res.status(400).json({ error: 'agentId and blockId are required' });
    return;
  }
  if (!listAgents().some((a) => a.id === agentId)) {
    res.status(422).json({ error: 'unknown agent' });
    return;
  }
  const result = toggleMessagePin({
    agentId,
    blockId,
    text: typeof text === 'string' ? text : '',
    ts: typeof ts === 'number' ? ts : Date.now(),
  });
  res.json(result);
}));

/** An agent pins a short note to its own desk. Message pins are keyed by the
 *  browser's block id, which an agent never has, so a note gets a synthetic
 *  durable key instead. `agent` may be a name or an id. */
messagePinsRouter.post('/note', asyncHandler(async (req, res) => {
  const { agent, text } = req.body ?? {};
  const needle = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  const match = needle ? listAgents().find((a) => a.id.toLowerCase() === needle || a.name.trim().toLowerCase() === needle) : undefined;
  if (!match) { res.status(422).json({ error: 'unknown agent' }); return; }
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) { res.status(400).json({ error: 'text is required' }); return; }
  const result = toggleMessagePin({
    agentId: match.id,
    blockId: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text: body,
    ts: Date.now(),
  });
  res.json(result);
}));

messagePinsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }
  const deleted = deleteMessagePin(id);
  if (!deleted) { res.status(404).json({ error: 'pin not found' }); return; }
  res.status(204).end();
}));
