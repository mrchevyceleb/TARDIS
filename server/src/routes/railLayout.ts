// /api/rail-layout — named agent groups in the left rail, synced across devices.
// The client works without this route (it keeps its own copy); this only adds sync.

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { normalizeRailLayout, readRailLayout, saveRailLayout } from '../lib/railLayoutStore.ts';

export const railLayoutRouter = Router();

railLayoutRouter.get('/', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ layout: readRailLayout() });
}));

railLayoutRouter.put('/', asyncHandler(async (req, res) => {
  const incoming = normalizeRailLayout(req.body?.layout);
  if (!incoming) {
    res.status(400).json({ error: 'layout is required' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json(saveRailLayout(incoming));
}));
