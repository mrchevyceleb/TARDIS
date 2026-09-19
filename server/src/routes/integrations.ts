import { Router } from 'express';
import { trustedWebSocketOrigin } from '../lib/origin.ts';
import { officeMcpConfig } from '../chat/office-mcp.ts';

export const integrationsRouter = Router();
const routes: Array<[string, RegExp]> = [
  ['GET', /^\/(status|approvals)$/], ['POST', /^\/credentials$/],
  ['POST', /^\/gmail\/start$/], ['DELETE', /^\/gmail\/account$/],
  ['GET', /^\/github\/status$/], ['DELETE', /^\/github$/],
  ['POST', /^\/approvals\/[a-f0-9-]{36}$/],
];
integrationsRouter.use(async (req,res) => {
  if (!trustedWebSocketOrigin(req)) { res.status(403).json({error:'Untrusted origin'}); return; }
  if (!routes.some(([method,path]) => req.method === method && path.test(req.path))) { res.status(404).json({error:'Unknown integration action'}); return; }
  // Like Content review: protects against accidental approval by a headless
  // tool, not a hostile process running under the same local OS account.
  if (req.method !== 'GET' && (!req.headers.origin || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-dest'] !== 'empty')) {
    res.status(403).json({error:'Use the Integrations desk to manage accounts or approve actions.'}); return;
  }
  res.setHeader('Cache-Control','no-store');
  try {
    const config = officeMcpConfig();
    const token = process.env.TARDIS_OFFICE_ADMIN_TOKEN;
    if (!config || !token) {
      res.status(req.path === '/status' ? 200 : 503).json({ configured:false, error:'The private integration hub has not been configured for this installation.' }); return;
    }
    const response = await fetch(`${config.base}/admin${req.path}`, {
      method:req.method, redirect:'error', signal:AbortSignal.timeout(120000),
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      ...(req.method === 'GET' ? {} : {body:JSON.stringify(req.body ?? {})}),
    });
    res.status(response.status).json(await response.json());
  } catch { res.status(502).json({error:'The private integration hub is unavailable. For an approval, refresh its status before trying again.'}); }
});
