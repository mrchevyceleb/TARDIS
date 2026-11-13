// Rooms: one tap changes the whole place. A room is a complete look (paint,
// type, shape, backdrop, sounds) plus a fixed arrangement of the team, chat
// and Desk. Personal choices (text size, contrast, ambient motion) belong to
// the person, so they travel with Matt from room to room.

import { DEFAULT_APPEARANCE, findPalette, mix, normalizeAppearance, type Appearance } from './themes';

export const LOOK_KEYS = [
  'palette', 'style', 'paint', 'accent', 'font', 'display', 'radius', 'background', 'backgroundIntensity', 'backgroundSpeed',
  'layout', 'team', 'surface', 'sounds',
] as const;
export type RoomLook = Pick<Appearance, typeof LOOK_KEYS[number]>;

export interface RoomSpec {
  id: string;
  name: string;
  blurb: string;
  look: RoomLook;
  /** The words a made room was built from (kept so it can be tweaked later). */
  prompt?: string;
  /** Saved in this TARDIS (made rooms and the seeded Original), not built in. */
  saved?: boolean;
}

const room = (id: string, name: string, blurb: string, look: Partial<RoomLook>): RoomSpec =>
  ({ id, name, blurb, look: { ...lookOf(DEFAULT_APPEARANCE), ...look } });

/** The rooms that ship with TARDIS. Each one changes every slot, so no two
 *  feel like recolors of each other. */
export const BUILT_IN_ROOMS: RoomSpec[] = [
  room('console', 'Console', 'The TARDIS as it ships: brass, void and roundels', {}),
  room('bridge', 'Ship’s Bridge', 'Crew stations up top, radar on the glass', {
    palette: 'midnight', paint: 'dark #06121d #dcefff #45d4ff #5ee6a8 #ffc35c #ff6b7f #9fa8ff',
    font: 'space-grotesk', display: 'michroma', radius: .35, background: 'radar', backgroundIntensity: .75,
    layout: 'crew', team: 'seats', surface: 'hud', sounds: 'bridge',
  }),
  room('paper', 'Paper Desk', 'Index cards, typed labels and a red pencil', {
    palette: 'paper-crane', paint: 'light #f2ead8 #2b2620 #b8402a #3d6b4f #96600f #b23a3a #5d4b8a',
    font: 'newsreader', display: 'courier-prime', radius: .2, background: 'ruled', backgroundIntensity: .7,
    layout: 'mirror', team: 'list', surface: 'paper', sounds: 'paper',
  }),
  room('arcade', 'Arcade', 'Insert coin. Pick your player.', {
    palette: 'arcade-fizz', paint: 'dark #140b2e #f6f0ff #c4f45d #5ef0c4 #ffd25e #ff6fa8 #8f7bff',
    font: 'outfit', display: 'silkscreen', radius: 0, background: 'synthgrid', backgroundIntensity: .8,
    layout: 'dock', team: 'tiles', surface: 'pixel', sounds: 'arcade',
  }),
  room('cabin', 'Night Cabin', 'Firelight, wool blankets, snow on the sill', {
    palette: 'campfire-club', paint: 'dark #1d130e #fbefe2 #ffaa55 #9ccc8a #f2c46d #f08a7a #c4a6e0',
    font: 'nunito', display: 'fraunces', radius: 1.45, background: 'hearth', backgroundIntensity: .75,
    layout: 'classic', team: 'seats', surface: 'cozy', sounds: 'cabin',
  }),
  room('terminal', 'Green Screen', 'A phosphor terminal, all business', {
    palette: 'oled', paint: 'dark #030b05 #c3ffd1 #3dff8b #3dff8b #ffd166 #ff7272 #8fd6ff',
    font: 'roboto-mono', display: 'roboto-mono', radius: 0, background: 'plain', backgroundIntensity: .5,
    layout: 'dock', team: 'list', surface: 'terminal', sounds: 'terminal',
  }),
  room('greenhouse', 'Greenhouse', 'Sunlight through glass, leaves everywhere', {
    palette: 'sea-glass', paint: 'light #e9f2e4 #1d3324 #2c7a48 #2c7a48 #8f5c12 #b04757 #6650a0',
    font: 'dm-sans', display: 'sora', radius: 1.25, background: 'blinds', backgroundIntensity: .4, backgroundSpeed: .75,
    layout: 'crew', team: 'tiles', surface: 'glass', sounds: 'garden',
  }),
];

export function lookOf(a: RoomLook): RoomLook {
  return Object.fromEntries(LOOK_KEYS.map((key) => [key, a[key]])) as RoomLook;
}

export function sameLook(a: RoomLook, b: RoomLook): boolean {
  return LOOK_KEYS.every((key) => a[key] === b[key]);
}

/** Step into a room. Only the room's slots change; the person's own
 *  text size, contrast, motion and routine settings stay. */
export function enterRoom(target: RoomSpec, current: Appearance): Appearance {
  return { ...current, ...target.look, room: target.id };
}

/** The room on screen right now, or null when the look is a personal mix. */
export function currentRoom(a: Appearance, rooms: RoomSpec[]): RoomSpec | null {
  return rooms.find((r) => r.id === a.room && sameLook(r.look, a)) ?? rooms.find((r) => sameLook(r.look, a)) ?? null;
}

const clean = (value: unknown, max: number): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : '';

/** Whatever arrives (server, model, an old cache), only known parts survive.
 *  Colors are made legible later by paintDef/expandTokens; here every slot is
 *  forced onto a tested part and the backdrop is kept quiet behind text. */
export function sanitizeLook(raw: unknown, base: RoomLook = BUILT_IN_ROOMS[0].look): RoomLook {
  const source = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  if (typeof source.paint === 'string') source.paint = source.paint.toLowerCase();
  const look = lookOf(normalizeAppearance(source, { ...DEFAULT_APPEARANCE, ...base }));
  look.backgroundIntensity = Math.min(look.backgroundIntensity, .85);
  return look;
}

export function sanitizeRoom(raw: unknown): RoomSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(r.id)) return null;
  const prompt = clean(r.prompt, 200);
  return { id: r.id, name: clean(r.name, 32) || 'Untitled room', blurb: clean(r.blurb, 90), look: sanitizeLook(r.look), saved: true, ...(prompt ? { prompt } : {}) };
}

/** Surprise me: any other room, never the one you are standing in. */
export function surpriseRoom(rooms: RoomSpec[], a: Appearance): RoomSpec | null {
  const others = rooms.filter((r) => r.id !== a.room && !sameLook(r.look, a));
  return others.length ? others[Math.floor(Math.random() * others.length)] : null;
}

export function todayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The morning pick is a pure function of the date and the room list, so two
 *  devices waking up on the same morning always land in the same room. */
export function dailyRoom(date: string, rooms: RoomSpec[], a: Appearance): RoomSpec | null {
  const others = rooms.filter((r) => r.id !== a.room && !sameLook(r.look, a)).sort((x, y) => x.id.localeCompare(y.id));
  return others.length ? others[hash(date) % others.length] : null;
}

const MOODS: Array<[RegExp, string]> = [
  [/space|ship|star|galax|bridge|rocket|orbit|moon|mars|sci.?fi|submarine|cockpit/i, 'bridge'],
  [/paper|book|librar|desk|office|study|letter|typewriter|ink|newsroom|school|journal/i, 'paper'],
  [/arcade|game|pixel|retro|8.?bit|80s|disco|vapor|pinball|candy/i, 'arcade'],
  [/cabin|lodge|ski|snow|fire|cozy|wood|winter|mountain|camp|chalet|70s|autumn|hygge/i, 'cabin'],
  [/terminal|hacker|matrix|code|crt|computer|cyber|server|tokyo|neon|alley|night city/i, 'terminal'],
  [/garden|green|plant|forest|spring|botanic|jungle|leaf|tea|zen|meadow|beach|ocean|sea/i, 'greenhouse'],
];

const ACCENTS = ['#ff7a59', '#ffb347', '#ffd23f', '#9be15d', '#3dd6c6', '#4fb3ff', '#8c7bff', '#ff6fb5', '#f25f5c', '#2ec4b6'];

function titleCase(text: string): string {
  // Only a word's first letter: "keeper's" stays "Keeper's", never "Keeper'S".
  return text.replace(/(^|[\s-])(\p{Ll})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase());
}

/** When the designer cannot be reached, still build something from the words:
 *  the closest built-in room, wearing an accent picked from the description. */
export function offlineRoom(prompt: string): RoomSpec {
  const words = clean(prompt, 80) || 'Somewhere new';
  const base = BUILT_IN_ROOMS.find((r) => r.id === MOODS.find(([re]) => re.test(words))?.[1])
    ?? BUILT_IN_ROOMS[1 + (hash(words) % (BUILT_IN_ROOMS.length - 1))];
  const accent = ACCENTS[hash(words.toLowerCase()) % ACCENTS.length];
  const paint = base.look.paint?.split(' ');
  if (paint) paint[3] = accent;
  return {
    id: 'preview', name: titleCase(words).slice(0, 32), blurb: `Sketched from “${words.slice(0, 60)}”`, prompt: words,
    look: sanitizeLook({ ...base.look, paint: paint?.join(' ') ?? base.look.paint, accent: paint ? null : accent }),
  };
}

/** A look's colors as a paint string, so any room (built-in palettes too) can be recolored. */
export function paintOf(look: RoomLook): string {
  if (look.paint) return look.paint;
  const def = findPalette(look.palette);
  const c = def.colors;
  return `${def.mode} ${[c.bg, c.ink, look.accent ?? c.accent, c.emerald, c.amber, c.rose, c.violet].map((h) => mix(h, h, 0)).join(' ')}`;
}

/** Tweak: the next signature color on the wheel. */
export function recolor(look: RoomLook): Partial<RoomLook> {
  const parts = paintOf(look).split(' ');
  parts[3] = ACCENTS[(ACCENTS.indexOf(parts[3]) + 1) % ACCENTS.length];
  return { paint: parts.join(' '), accent: null };
}

/** Tweak: the same room by day or by night. The new background is a tint of
 *  the accent and the new ink a shade of the old background; paintDef then
 *  holds both inside the readable bands. */
export function flipLight(look: RoomLook): Partial<RoomLook> {
  const [mode, bg, , accent, ...rest] = paintOf(look).split(' ');
  const toLight = mode === 'dark';
  const nextBg = mix(accent, toLight ? '#ffffff' : '#000000', toLight ? .9 : .88);
  const nextInk = mix(bg, toLight ? '#000000' : '#ffffff', .35);
  return { paint: [toLight ? 'light' : 'dark', nextBg, nextInk, accent, ...rest].join(' '), accent: null };
}
