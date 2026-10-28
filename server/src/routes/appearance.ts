// One appearance document per office, just like the shared rail layout. Partial
// writes let a phone change its palette without clobbering a desktop's font edit.
import { Router } from 'express';
import { JsonStore } from '../lib/jsonStore.ts';
import { asyncHandler } from './helpers.ts';

type AppearanceRecord = { id: string; values: Record<string, string | number | boolean | null> };
const store = new JsonStore<AppearanceRecord>('appearance.json', []);
export const appearanceRouter = Router();

const choices: Record<string, readonly unknown[]> = {
  style: ['console', 'lavender'], font: ['system', 'grotesk', 'serif', 'mono', 'rounded'],
  contrast: ['standard', 'strong'],
};
const ranges: Record<string, [number, number]> = { textScale: [.8, 1.25], radius: [0, 1.6], backgroundIntensity: [0, 1] };
function valid(key: string, value: unknown): boolean {
  if (Object.hasOwn(choices, key)) return choices[key].includes(value);
  if (Object.hasOwn(ranges, key)) return typeof value === 'number' && Number.isFinite(value) && value >= ranges[key][0] && value <= ranges[key][1];
  if (key === 'palette' || key === 'background') return typeof value === 'string' && /^[a-z0-9-]{1,48}$/.test(value);
  if (key === 'accent') return value === null || (typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value));
  if (key === 'motion') return typeof value === 'boolean';
  return false;
}

appearanceRouter.get('/', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ appearance: (await store.list())[0]?.values ?? null });
}));

appearanceRouter.put('/', asyncHandler(async (req, res) => {
  const patch = req.body?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || !Object.entries(patch).every(([key, value]) => valid(key, value))) {
    res.status(400).json({ error: 'Choose valid appearance settings.' });
    return;
  }
  const records = await store.modify((items) => [{ id: 'office', values: { ...items[0]?.values, ...patch } }]);
  res.set('Cache-Control', 'no-store');
  res.json({ appearance: records[0].values });
}));
