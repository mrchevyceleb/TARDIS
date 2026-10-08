// /api/headless: per-lane headless Chromium (backs the rivendell-headless MCP).
// Not an app login: only a TARDIS-spawned MCP holds a token, and the token is bound
// to one lane. A lane with no stable name sends the signed turn context instead.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { runHeadlessOp, validHeadlessToken } from '../headless/pool.ts';
import { readComputerContext } from '../devices/context.ts';
import { agentForChatId } from '../chat/agents.ts';

export const headlessRouter = Router();

headlessRouter.post('/:op', asyncHandler(async (req, res) => {
  const { agent: claimed, context, ...args } = req.body ?? {};
  const token = req.get('x-rivendell-headless-token');
  const named = typeof claimed === 'string' ? claimed.trim() : '';
  let agent = named;
  if (named) {
    if (!validHeadlessToken(token, named)) { res.status(403).json({ error: 'TARDIS headless MCP required.' }); return; }
  } else {
    if (!validHeadlessToken(token)) { res.status(403).json({ error: 'TARDIS headless MCP required.' }); return; }
    try {
      const turn = readComputerContext(context);
      agent = agentForChatId(turn.chatId)?.name ?? `chat-${turn.chatId}`;
    } catch (err) { res.status(403).json({ error: (err as Error).message }); return; }
  }
  try {
    res.json(await runHeadlessOp(String(req.params.op), agent, args));
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
}));
