import { Router, json } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { completeSubscription, validateCompletionRequest } from '../chat/content-completion.ts';

/** Server-to-server only. A separate token is required even on loopback. */
export function createContentGateway(complete = completeSubscription): Router {
  const router = Router();
  let active = 0;
  router.use((req, res, next) => {
    const token = process.env.RIVENDELL_CONTENT_TOKEN?.trim();
    if (!token) { res.status(503).json({ error: { message: 'Content gateway is not configured.' } }); return; }
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.status(401).json({ error: { message: 'Content gateway authentication required.' } }); return; }
    next();
  });
  router.use(json({ limit: '2mb' }));
  router.post('/chat/completions', async (req, res) => {
    // The main app accepts larger attachment payloads and may already have
    // parsed this body; enforce this gateway's tighter bound in either case.
    if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > 2 * 1024 * 1024) {
      res.status(413).json({ error: { message: 'Content request exceeds 2 MB.' } }); return;
    }
    let request;
    try { request = validateCompletionRequest(req.body); }
    catch (error) { res.status(400).json({ error: { message: (error as Error).message } }); return; }
    if (active >= 2) { res.setHeader('Retry-After', '10'); res.status(429).json({ error: { message: 'Content generation is busy. Retry shortly.' } }); return; }
    active++;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 240_000);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    try {
      const message = await complete(request, controller.signal);
      if (!res.destroyed) res.json({
        id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model,
        choices: [{ index: 0, message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }],
      });
    } catch (error) {
      if (!res.destroyed) res.status(timedOut ? 504 : 502).json({ error: { message: timedOut ? 'Content generation timed out.' : (error as Error).message } });
    } finally {
      clearTimeout(timeout);
      res.off('close', disconnected);
      active--;
    }
  });
  return router;
}

export const contentGatewayRouter = createContentGateway();
