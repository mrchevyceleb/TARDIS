import { Router, raw } from 'express';
import sharp from 'sharp';
import { randomBytes,createHash } from 'node:crypto';
import { transcriptionReady,transcribeContent } from '../lib/contentTranscription.ts';
import { contentEngineRequest, contentBrainForAgent, ContentEngineError } from '../lib/contentEngine.ts';
import { trustedWebSocketOrigin } from '../lib/origin.ts';

export const contentRouter = Router();
// Browser review intents are ephemeral and scoped to the exact saved revision.
// They keep headless tools from invoking human review actions by accident; this
// is not isolation against a hostile process running with the same OS account.
const reviewIntents = new Map<string, { path: string; version: number; digest?:string; expires: number }>();
contentRouter.post('/review-intent', (req, res) => {
  if (!trustedWebSocketOrigin(req) || !req.headers.origin || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-dest'] !== 'empty') {
    res.status(403).json({ error: 'Open the Content desk to approve or publish this draft.' }); return;
  }
  const { path, version,plan } = req.body ?? {};
  const packageReview=typeof path==='string'&&/^\/packages\/[a-zA-Z0-9-]+\/(schedule|resume)$/.test(path)&&plan&&(Array.isArray(plan.entries)||typeof plan.planId==='string');
  if (!packageReview&&(typeof path !== 'string' || !/^\/drafts\/[a-zA-Z0-9-]+\/(approve|publish)$/.test(path) || !Number.isSafeInteger(version) || version < 1)) {
    res.status(400).json({ error: 'Choose a saved draft to review.' }); return;
  }
  for (const [key, intent] of reviewIntents) if (intent.expires < Date.now()) reviewIntents.delete(key);
  if (reviewIntents.size >= 256) { res.status(429).json({ error: 'Too many review requests. Try again shortly.' }); return; }
  const token = randomBytes(32).toString('hex');
  reviewIntents.set(token, { path, version, ...(packageReview?{digest:createHash('sha256').update(JSON.stringify(plan)).digest('hex')} : {}),expires: Date.now() + 60_000 });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token });
});
const routes = [
  ['GET', /^\/packages$/],
  ['POST', /^\/packages\/[a-zA-Z0-9-]+\/(?:schedule|resume|release)$/],
  ['POST', /^\/ideas\/[a-zA-Z0-9-]+\/decision$/],
  ['GET', /^\/connections\/(?:operly|r-link|kim-garst)\/email(?:\/contacts)?$/],
  ['PUT', /^\/connections\/(?:operly|r-link|kim-garst)\/email$/],
  ['GET', /^\/media\/settings$/],
  ['PUT', /^\/media\/settings$/],
  ['GET', /^\/(?:status|drafts|jobs|ideas|scanner)$/],
  ['POST', /^\/scan$/],
  ['POST', /^\/ideas\/[a-zA-Z0-9-]+\/generate$/],
  ['GET', /^\/drafts\/[a-zA-Z0-9-]+$/],
  ['PATCH', /^\/drafts\/[a-zA-Z0-9-]+$/],
  ['POST', /^\/generate$/],
  ['POST', /^\/drafts\/[a-zA-Z0-9-]+\/(?:revise|approve|publish|recover|images)$/],
  ['POST', /^\/jobs\/[a-zA-Z0-9-]+\/(?:retry|cancel)$/],
  ['GET', /^\/connections\/(?:operly|r-link|kim-garst)$/],
  ['PUT', /^\/connections\/(?:operly|r-link|kim-garst)$/],
  ['POST', /^\/connections\/(?:operly|r-link|kim-garst)\/connect$/],
  ['GET', /^\/connections\/(?:operly|r-link|kim-garst)\/ayrshare$/],
  ['PUT', /^\/connections\/(?:operly|r-link|kim-garst)\/ayrshare$/],
  ['POST', /^\/connections\/(?:operly|r-link|kim-garst)\/ayrshare\/(?:profile|connect)$/],
] as const;

contentRouter.get('/dictation',(_req,res)=>res.json({available:transcriptionReady()}));
contentRouter.post('/dictation',raw({type:'application/octet-stream',limit:'12mb'}),async(req,res)=>{
  if(!trustedWebSocketOrigin(req)||!req.headers.origin||req.headers['sec-fetch-site']!=='same-origin'){res.status(403).json({error:'Use Content to dictate changes.'});return;}
  if(!Buffer.isBuffer(req.body)||req.body.length<50){res.status(400).json({error:'Record something first.'});return;}
  try{res.json(await transcribeContent(req.body));}catch(error){res.status((error as {status?:number}).status??502).json({error:(error as {status?:number}).status?(error as Error).message:'Could not transcribe this recording. Try again or type your changes.'});}
});

contentRouter.post('/media/upload', raw({ type: 'application/octet-stream', limit: '10mb' }), async (req,res) => {
  if (!trustedWebSocketOrigin(req) || req.headers['sec-fetch-site'] !== 'same-origin' || !req.headers.origin) { res.status(403).json({error:'Use the Content desk to upload images.'}); return; }
  if (!Buffer.isBuffer(req.body)) { res.status(415).json({error:'Choose a JPEG, PNG or WebP image.'}); return; }
  let bytes:Buffer;
  try {
    const input = sharp(req.body,{limitInputPixels:25_000_000,animated:false});
    const metadata = await input.metadata();
    if (!['jpeg','png','webp'].includes(metadata.format ?? '')) { res.status(415).json({error:'Choose a JPEG, PNG or WebP image.'}); return; }
    bytes = await input.rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).webp({quality:90}).toBuffer();
  } catch { res.status(400).json({error:'This image could not be decoded. Choose a JPEG, PNG or WebP under 10 MB and 25 megapixels.'});return; }
  try {
    res.json(await contentEngineRequest('/media/upload','POST',{data:bytes.toString('base64')},AbortSignal.timeout(60000)));
  } catch { res.status(502).json({error:'Could not upload this image. Check the content connection and storage, then try again.'}); }
});

contentRouter.use(async (req, res) => {
  if (!trustedWebSocketOrigin(req)) { res.status(403).json({ error: 'Untrusted request origin.' }); return; }
  if (req.method === 'PUT' && req.path === '/media/settings' && (!req.headers.origin || req.headers['sec-fetch-site'] !== 'same-origin')) { res.status(403).json({error:'Use Start here to configure media.'}); return; }
  if (!routes.some(([method, path]) => method === req.method && path.test(req.path))) {
    res.status(404).json({ error: 'Unknown content action.' }); return;
  }
  if (req.method === 'POST' && /\/(approve|publish|schedule|resume)$/.test(req.path)) {
    const token = req.get('X-Content-Review') ?? '';
    const intent = reviewIntents.get(token);
    reviewIntents.delete(token);
    if (!intent || intent.expires < Date.now() || intent.path !== req.path || (intent.digest?intent.digest!==createHash('sha256').update(JSON.stringify(req.body)).digest('hex'):intent.version !== req.body?.version)) {
      res.status(403).json({ error: 'Review this saved version in the Content desk before publishing.' }); return;
    }
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    let body = req.method === 'GET' ? undefined : req.body;
    if (body?.agent && (req.path.endsWith('/generate') || req.path.endsWith('/revise'))) {
      body = { ...body, ...contentBrainForAgent(String(body.agent)) };
      delete body.agent;
    }
    const query = new URLSearchParams();
    if (typeof req.query.brand === 'string') query.set('brand', req.query.brand);
    if (typeof req.query.query === 'string') query.set('query',req.query.query.slice(0,200));
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
