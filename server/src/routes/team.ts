// /api/team — agent-to-agent messaging surface (backs the rivendell-team MCP).

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { deliverTeamMessage, teamRoster, teamRecent } from '../chat/teamBus.ts';

export const teamRouter = Router();

teamRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ agents: await teamRoster() });
}));

teamRouter.post('/message', asyncHandler(async (req, res) => {
  const { from, to, text, hop, wait, source } = req.body ?? {};
  if (typeof to !== 'string' || typeof text !== 'string' || typeof from !== 'string') {
    res.status(400).json({ error: 'from, to and text are required' });
    return;
  }
  if (source !== undefined && source !== 'voice') {
    res.status(400).json({ error: 'unknown message source' });
    return;
  }
  const aborter = new AbortController();
  const abortWait = () => aborter.abort();
  req.once('aborted', abortWait);
  res.once('close', abortWait);
  let result;
  try {
    result = await deliverTeamMessage({ from, to, text, hop, wait, source,
      // A voice recovery outbox item must survive the HTTP caller leaving too.
      signal: source === 'voice' ? undefined : aborter.signal,
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
