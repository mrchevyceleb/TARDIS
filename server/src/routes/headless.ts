// /api/headless: per-lane headless Chromium (backs the rivendell-headless MCP).
// Not an app login: only the TARDIS-spawned MCP holds the token.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { runHeadlessOp, validHeadlessToken } from '../headless/pool.ts';

export const headlessRouter = Router();

headlessRouter.use((req, res, next) => {
  if (!validHeadlessToken(req.get('x-rivendell-headless-token'))) { res.status(403).json({ error: 'TARDIS headless MCP required.' }); return; }
  next();
});

headlessRouter.post('/:op', asyncHandler(async (req, res) => {
  const { agent, ...args } = req.body ?? {};
  try {
    res.json(await runHeadlessOp(String(req.params.op), typeof agent === 'string' ? agent : '', args));
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
}));
