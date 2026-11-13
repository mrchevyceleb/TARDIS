// The office's room library: rooms Matt made or kept, plus "Original", the
// look this office had before rooms existed, so nothing is ever taken away.
// Built-in rooms live in the web app. A room only stores tested parts (see
// appearance.ts); the web app also makes every color legible before painting.
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { JsonStore } from '../lib/jsonStore.ts';
import { asyncHandler } from './helpers.ts';
import { FONT_IDS, PAINT_RE, ROOM_PARTS, patchAppearance, savedAppearance, valid } from './appearance.ts';
import { completeSubscription, validateCompletionRequest } from '../chat/content-completion.ts';

type Look = Record<string, string | number | null>;
type RoomRecord = { id: string; createdAt?: string; updatedAt?: string; name: string; blurb: string; prompt?: string; look: Look };

const store = new JsonStore<RoomRecord>('rooms.json', []);
export const roomsRouter = Router();

const LOOK_DEFAULTS: Look = {
  palette: 'console', style: 'console', paint: null, accent: null, font: 'system', display: 'body', radius: 1,
  background: 'original', backgroundIntensity: .65, backgroundSpeed: 1,
  layout: 'classic', team: 'portraits', surface: 'soft', sounds: 'console',
};
const LOOK_KEYS = Object.keys(LOOK_DEFAULTS);
const MAX_ROOMS = 60;

// The backdrops a designer may choose from (ids match src/theme/backgrounds.ts).
const SCENES: Record<string, string> = {
  original: 'faint console roundels', plain: 'just the color', mesh: 'soft pools of color', sunrise: 'a sun on the horizon',
  topography: 'rippling contour lines', grid: 'dot-grid journal', prism: 'folded ribbons of color', orbits: 'three slow planets',
  rain: 'rain running down a window', bubbles: 'little rising bubbles', ribbons: 'silky streamers', eclipse: 'a glowing halo',
  clouds: 'drifting clouds', diamonds: 'tumbling small gems', ripples: 'rings on still water', lanterns: 'warm lanterns rising',
  blinds: 'sunlight through blinds', petals: 'falling blossoms', comets: 'comets streaking', aurora: 'northern lights',
  gradient: 'slowly shifting gradient', starfield: 'drifting stars', particles: 'fireflies rising', waves: 'slow ocean waves',
  radar: 'a radar sweep with range rings', ruled: 'ruled notebook paper', synthgrid: 'a neon grid rolling toward a sunset', hearth: 'firelight flicker with embers',
};

const text = (value: unknown, max: number): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : '';

/** Keep only valid parts, filling any gap from the default room. */
function cleanLook(value: unknown): Look | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const look: Look = { ...LOOK_DEFAULTS };
  let any = false;
  for (const key of LOOK_KEYS) {
    const raw = key === 'paint' && typeof source.paint === 'string' ? source.paint.toLowerCase() : source[key];
    if (raw !== undefined && valid(key, raw)) { look[key] = raw as string | number | null; any = true; }
  }
  return any ? look : null;
}

function cleanRoom(body: unknown): Omit<RoomRecord, 'id'> | null {
  const room = (body as { room?: unknown } | null)?.room as Record<string, unknown> | undefined;
  const look = cleanLook(room?.look);
  const name = text(room?.name, 32);
  if (!room || !look || !name) return null;
  const prompt = text(room.prompt, 200);
  return { name, blurb: text(room.blurb, 90), look, ...(prompt ? { prompt } : {}) };
}

/** Once, when rooms arrive: a look chosen before rooms existed is kept as
 *  the "Original" room, and the office's look is marked with the room it is
 *  in, so this never runs again (a later personal mix is not an Original). */
export async function migrateToRooms(): Promise<void> {
  const values = await savedAppearance();
  if (!values || Object.hasOwn(values, 'room')) return;
  const look: Look = { ...LOOK_DEFAULTS };
  for (const key of LOOK_KEYS) if (Object.hasOwn(values, key) && valid(key, values[key])) look[key] = values[key] as string | number | null;
  const custom = LOOK_KEYS.some((key) => look[key] !== LOOK_DEFAULTS[key]);
  if (custom) {
    const now = new Date().toISOString();
    await store.modify((items) => items.some((r) => r.id === 'original') ? items
      : [{ id: 'original', name: 'Original', blurb: 'Your look, exactly as you had it', look, createdAt: now, updatedAt: now }, ...items]);
  }
  await patchAppearance({ room: custom ? 'original' : 'console' });
}

roomsRouter.get('/', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ rooms: await store.list() });
}));

roomsRouter.post('/', asyncHandler(async (req, res) => {
  const room = cleanRoom(req.body);
  if (!room) { res.status(400).json({ error: 'That room is missing its name or parts.' }); return; }
  if ((await store.list()).length >= MAX_ROOMS) { res.status(409).json({ error: 'Your room library is full. Throw one away first.' }); return; }
  const slug = room.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'room';
  const saved = await store.create({ id: `made-${slug}-${randomBytes(3).toString('hex')}`, ...room });
  res.status(201).json({ room: saved });
}));

roomsRouter.delete('/:id', asyncHandler(async (req, res) => {
  if (req.params.id === 'original') { res.status(400).json({ error: 'Your Original room always stays.' }); return; }
  res.json({ deleted: await store.delete(String(req.params.id)) });
}));

const hex = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const BUILD_ROOM = {
  type: 'function' as const,
  function: {
    name: 'build_room',
    description: 'The finished room.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'blurb', 'mode', 'background_color', 'ink', 'accent', 'emerald', 'amber', 'rose', 'violet', 'font', 'display', 'layout', 'team', 'surface', 'sounds', 'background', 'radius', 'backgroundIntensity', 'backgroundSpeed'],
      properties: {
        name: { type: 'string', description: '2 to 4 words, Title Case, at most 28 characters' },
        blurb: { type: 'string', description: 'One playful line, under 70 characters, no emoji' },
        mode: { enum: ['dark', 'light'] },
        background_color: hex, ink: hex, accent: hex, emerald: hex, amber: hex, rose: hex, violet: hex,
        font: { enum: [...FONT_IDS] }, display: { enum: [...ROOM_PARTS.display] },
        layout: { enum: [...ROOM_PARTS.layout] }, team: { enum: [...ROOM_PARTS.team] },
        surface: { enum: [...ROOM_PARTS.surface] }, sounds: { enum: [...ROOM_PARTS.sounds] },
        background: { enum: Object.keys(SCENES) },
        radius: { type: 'number', minimum: 0, maximum: 1.6 },
        backgroundIntensity: { type: 'number', minimum: .3, maximum: .85 },
        backgroundSpeed: { type: 'number', minimum: .25, maximum: 2 },
      },
    },
  },
};

const DESIGNER = `You are the interior designer for TARDIS, an office app where a person works all day with a team of AI teammates. Turn a few words into a complete room that feels unmistakably like those words, yet stays easy to read for a whole workday. Call build_room exactly once.

Colors: a "dark" room needs a very dark background tinted to the mood; a "light" room needs a very light background tinted to the mood. ink is the main text color and must contrast strongly with the background. accent is the signature color: vivid and clearly different from the background. emerald, amber, rose and violet mean success, warning, danger and info; tune them to the mood but keep them distinct.

Arrangement (layout): classic = team on the left, chat in the middle, Desk on the right. mirror = Desk on the left, team on the right. dock = a slim column of faces and a wide chat. crew = the team sits across the top like stations.
Team view: portraits = big round portraits. list = compact rows. tiles = small square tiles. seats = a seating chart showing what each teammate is doing.
Surface: soft = gentle rounded cards. paper = index cards with inked edges. pixel = hard edges with chunky offset shadows. hud = thin glowing lines and cut corners. cozy = pillowy and warm. glass = frosted translucent panels. terminal = flat phosphor lines.
Sounds: console = gentle tones. bridge = sonar pings. paper = rustles and stamps. arcade = coin-op blips. cabin = wood knocks and a warm chime. neon = synth swells. terminal = key clicks and beeps. garden = wind chimes and droplets.
Type: font is for message text and must be comfortable to read; display is for names and headings and can carry more personality (silkscreen is pixel art, courier-prime is a typewriter, michroma is wide sci-fi, fraunces is storybook).
Backdrops: ${Object.entries(SCENES).map(([id, mood]) => `${id} = ${mood}`).join('; ')}.
radius runs from 0 (sharp) to 1.6 (very round).

Make bold, specific choices. Two different descriptions should never produce the same room.`;

let building = false;

roomsRouter.post('/imagine', asyncHandler(async (req, res) => {
  const words = text(req.body?.prompt, 200);
  if (!words) { res.status(400).json({ error: 'Describe the room in a few words.' }); return; }
  if (building) { res.status(429).json({ error: 'Already building a room. One moment.' }); return; }
  const base = cleanLook(req.body?.base?.look);
  const baseName = text(req.body?.base?.name, 32);
  const ask = base
    ? `Current room "${baseName || 'Untitled'}": ${JSON.stringify(base)}\nChange it like this: "${words}". Keep everything the change does not touch, including the name unless the change implies a new one.`
    : `Design this room: "${words}"`;
  building = true;
  // A cancelled build (the person closed it or typed something else) frees
  // the designer at once instead of holding the lock until the model replies.
  const gone = new AbortController();
  res.on('close', () => { if (!res.writableEnded) gone.abort(); });
  try {
    const request = validateCompletionRequest({
      model: process.env.RIVENDELL_ROOM_MODEL || 'claude/haiku',
      max_tokens: 1200,
      tools: [BUILD_ROOM],
      tool_choice: { type: 'function', function: { name: 'build_room' } },
      messages: [{ role: 'system', content: DESIGNER }, { role: 'user', content: ask }],
    });
    const result = await completeSubscription(request, AbortSignal.any([gone.signal, AbortSignal.timeout(75_000)]));
    const args = JSON.parse(result.tool_calls?.[0]?.function.arguments ?? '{}') as Record<string, unknown>;
    const colors = ['background_color', 'ink', 'accent', 'emerald', 'amber', 'rose', 'violet'].map((key) => String(args[key] ?? '').toLowerCase());
    const paint = `${args.mode === 'light' ? 'light' : 'dark'} ${colors.join(' ')}`;
    const look = cleanLook({ ...args, paint: PAINT_RE.test(paint) ? paint : null, accent: null });
    const name = text(args.name, 32);
    if (!look || !name || !PAINT_RE.test(paint)) throw new Error('The designer returned an incomplete room.');
    res.json({ room: { id: 'preview', name, blurb: text(args.blurb, 90), prompt: base ? text(req.body?.base?.prompt, 200) || words : words, look } });
  } catch (error) {
    if (gone.signal.aborted) return;
    console.warn('[rooms] imagine failed:', (error as Error).message);
    res.status(502).json({ error: 'The designer is away right now.' });
  } finally {
    building = false;
  }
}));
