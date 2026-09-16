import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { contentEngineRequest, contentBrainForAgent, ContentEngineError } from '../lib/contentEngine.ts';
import { trustedWebSocketOrigin } from '../lib/origin.ts';

export const contentRouter = Router();
// Browser review intents are ephemeral and scoped to the exact saved revision.
// They keep headless tools from invoking human review actions by accident; this
// is not isolation against a hostile process running with the same OS account.
const reviewIntents = new Map<string, { path: string; version: number; expires: number }>();
contentRouter.post('/review-intent', (req, res) => {
  if (!trustedWebSocketOrigin(req) || !req.headers.origin || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-dest'] !== 'empty') {
    res.status(403).json({ error: 'Open the Content desk to approve or publish this draft.' }); return;
  }
  const { path, version } = req.body ?? {};
  if (typeof path !== 'string' || !/^\/drafts\/[a-zA-Z0-9-]+\/(approve|publish)$/.test(path) || !Number.isSafeInteger(version) || version < 1) {
    res.status(400).json({ error: 'Choose a saved draft to review.' }); return;
  }
  for (const [key, intent] of reviewIntents) if (intent.expires < Date.now()) reviewIntents.delete(key);
  if (reviewIntents.size >= 256) { res.status(429).json({ error: 'Too many review requests. Try again shortly.' }); return; }
  const token = randomBytes(32).toString('hex');
  reviewIntents.set(token, { path, version, expires: Date.now() + 60_000 });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token });
});
const routes = [
  ['GET', /^\/(?:status|drafts|jobs)$/],
  ['GET', /^\/drafts\/[a-zA-Z0-9-]+$/],
  ['PATCH', /^\/drafts\/[a-zA-Z0-9-]+$/],
  ['POST', /^\/generate$/],
  ['POST', /^\/drafts\/[a-zA-Z0-9-]+\/(?:revise|approve|publish)$/],
  ['POST', /^\/jobs\/[a-zA-Z0-9-]+\/(?:retry|cancel)$/],
  ['GET', /^\/connections\/(?:operly|r-link)$/],
  ['PUT', /^\/connections\/(?:operly|r-link)$/],
  ['POST', /^\/connections\/(?:operly|r-link)\/connect$/],
] as const;

contentRouter.use(async (req, res) => {
  if (!trustedWebSocketOrigin(req)) { res.status(403).json({ error: 'Untrusted request origin.' }); return; }
  if (!routes.some(([method, path]) => method === req.method && path.test(req.path))) {
    res.status(404).json({ error: 'Unknown content action.' }); return;
  }
  if (req.method === 'POST' && /\/(approve|publish)$/.test(req.path)) {
    const token = req.get('X-Content-Review') ?? '';
    const intent = reviewIntents.get(token);
    reviewIntents.delete(token);
    if (!intent || intent.expires < Date.now() || intent.path !== req.path || intent.version !== req.body?.version) {
      res.status(403).json({ error: 'Review this saved version in the Content desk before publishing.' }); return;
    }
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    let body = req.method === 'GET' ? undefined : req.body;
    if (body?.agent && (req.path === '/generate' || req.path.endsWith('/revise'))) {
      body = { ...body, ...contentBrainForAgent(String(body.agent)) };
      delete body.agent;
    }
    const query = new URLSearchParams();
    if (typeof req.query.brand === 'string') query.set('brand', req.query.brand);
    const path = req.path + (query.size ? `?${query}` : '');
    const data = await contentEngineRequest(path, req.method, body, controller.signal);
    if (!res.destroyed) res.json(data);
  } catch (error) {
    if (res.destroyed) return;
    const status = error instanceof ContentEngineError ? error.status : 502;
    const message = error instanceof ContentEngineError ? error.message : 'The content engine is unavailable. Your saved drafts are safe; try again.';
    res.status(status).json({ error: message });
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
});
