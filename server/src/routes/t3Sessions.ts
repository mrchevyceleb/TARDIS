// /api/t3-sessions — T3 Code sessions owned by TARDIS agents.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { t3Hosts } from '../lib/t3Hosts.ts';
import { liveT3Sessions, registerT3Session } from '../lib/t3Sessions.ts';

export const t3SessionsRouter = Router();

// Every owned session with a run going right now (the roster's session lines).
t3SessionsRouter.get('/', (_req, res) => {
  res.json({ configured: t3Hosts().length > 0, now: Date.now(), sessions: liveT3Sessions() });
});

// The launcher records who started a session, so its turn ends wake that agent.
t3SessionsRouter.post('/', asyncHandler(async (req, res) => {
  const { owner, host, threadId, title, link } = req.body ?? {};
  if (typeof owner !== 'string' || typeof host !== 'string' || typeof threadId !== 'string') {
    res.status(400).json({ error: 'owner, host and threadId are required' });
    return;
  }
  const result = await registerT3Session({
    owner, host, threadId,
    title: typeof title === 'string' ? title : undefined,
    link: typeof link === 'string' && /^https?:\/\//.test(link) ? link : undefined,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json({ session: result.session });
}));
