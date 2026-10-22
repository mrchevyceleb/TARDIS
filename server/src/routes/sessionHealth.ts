import { Router } from 'express';
import { nativeSessionReport, nativeSessionReportHtml } from '../chat/sessionMetrics.ts';

export const sessionHealthRouter = Router();
sessionHealthRouter.get('/', (req, res) => {
  try { res.json(nativeSessionReport(typeof req.query.date === 'string' ? req.query.date : undefined)); }
  catch { res.status(400).json({ error: 'Choose a report date in YYYY-MM-DD form.' }); }
});
sessionHealthRouter.get('/report', (req, res) => {
  try { res.type('html').send(nativeSessionReportHtml(typeof req.query.date === 'string' ? req.query.date : undefined)); }
  catch { res.status(400).send('Choose a report date in YYYY-MM-DD form.'); }
});
