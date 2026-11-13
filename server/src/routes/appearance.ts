// One appearance document per office, just like the shared rail layout. Partial
// writes let a phone change its palette without clobbering a desktop's font edit.
import { Router } from 'express';
import { JsonStore } from '../lib/jsonStore.ts';
import { asyncHandler } from './helpers.ts';

type AppearanceRecord = { id: string; values: Record<string, string | number | boolean | null> };
const store = new JsonStore<AppearanceRecord>('appearance.json', []);
export const appearanceRouter = Router();

export const FONT_IDS = ['system', 'grotesk', 'serif', 'mono', 'rounded',
  'dm-sans', 'space-grotesk', 'outfit', 'nunito', 'quicksand', 'work-sans', 'sora', 'lora', 'literata', 'newsreader', 'fraunces', 'roboto-mono'] as const;
// Room parts mirror src/theme/roomParts.ts. A room only ever picks tested parts.
export const ROOM_PARTS = {
  layout: ['classic', 'mirror', 'dock', 'crew'],
  team: ['portraits', 'list', 'tiles', 'seats'],
  surface: ['soft', 'paper', 'pixel', 'hud', 'cozy', 'glass', 'terminal'],
  sounds: ['console', 'bridge', 'paper', 'arcade', 'cabin', 'neon', 'terminal', 'garden'],
  display: ['body', 'michroma', 'jost', 'silkscreen', 'courier-prime', 'fraunces', 'newsreader', 'space-grotesk', 'sora', 'quicksand', 'lora', 'roboto-mono', 'outfit', 'nunito'],
} as const;
export const PAINT_RE = /^(dark|light)( #[0-9a-f]{6}){7}$/;
const SLUG = /^[a-z0-9-]{1,48}$/;

const choices: Record<string, readonly unknown[]> = {
  style: ['console', 'lavender'], font: FONT_IDS, contrast: ['standard', 'strong'], ...ROOM_PARTS,
};
const ranges: Record<string, [number, number]> = { textScale: [.8, 1.25], radius: [0, 1.6], backgroundIntensity: [0, 1], backgroundSpeed: [.25, 4] };
export function valid(key: string, value: unknown): boolean {
  if (Object.hasOwn(choices, key)) return choices[key].includes(value);
  if (Object.hasOwn(ranges, key)) return typeof value === 'number' && Number.isFinite(value) && value >= ranges[key][0] && value <= ranges[key][1];
  if (key === 'palette' || key === 'background' || key === 'room') return typeof value === 'string' && SLUG.test(value);
  if (key === 'pin') return value === null || (typeof value === 'string' && SLUG.test(value));
  if (key === 'accent') return value === null || (typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value));
  if (key === 'paint') return value === null || (typeof value === 'string' && PAINT_RE.test(value));
  if (key === 'redecorated') return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (key === 'motion' || key === 'daily') return typeof value === 'boolean';
  return false;
}

/** The office's saved look, or null before anyone has chosen one. */
export async function savedAppearance(): Promise<Record<string, unknown> | null> {
  return (await store.list())[0]?.values ?? null;
}

/** Merge already-validated settings into the office's look. */
export async function patchAppearance(patch: Record<string, string | number | boolean | null>): Promise<AppearanceRecord['values']> {
  const records = await store.modify((items) => [{ id: 'office', values: { ...items[0]?.values, ...patch } }]);
  return records[0].values;
}

appearanceRouter.get('/', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ appearance: await savedAppearance() });
}));

appearanceRouter.put('/', asyncHandler(async (req, res) => {
  const patch = req.body?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || !Object.entries(patch).every(([key, value]) => valid(key, value))) {
    res.status(400).json({ error: 'Choose valid appearance settings.' });
    return;
  }
  const values = await patchAppearance(patch);
  res.set('Cache-Control', 'no-store');
  res.json({ appearance: values });
}));
