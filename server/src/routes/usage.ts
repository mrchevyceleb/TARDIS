import { Router } from 'express';
import { readAccountUsage } from '../lib/accountUsage.ts';
import { asyncHandler } from './helpers.ts';
export const usageRouter = Router();
usageRouter.get('/', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await readAccountUsage(req.query.refresh === '1'));
}));
