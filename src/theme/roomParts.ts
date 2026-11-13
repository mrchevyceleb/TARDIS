// The building blocks every room is assembled from. A room never carries
// free-form CSS: it picks one tested part per slot, so any combination,
// including one a model invents, renders on every screen size.

export type LayoutId = 'classic' | 'mirror' | 'dock' | 'crew';
export type TeamView = 'portraits' | 'list' | 'tiles' | 'seats';
export type SurfaceId = 'soft' | 'paper' | 'pixel' | 'hud' | 'cozy' | 'glass' | 'terminal';
export type SoundKit = 'console' | 'bridge' | 'paper' | 'arcade' | 'cabin' | 'neon' | 'terminal' | 'garden';
export type DisplayId = 'body' | 'michroma' | 'jost' | 'silkscreen' | 'courier-prime' | 'fraunces' | 'newsreader'
  | 'space-grotesk' | 'sora' | 'quicksand' | 'lora' | 'roboto-mono' | 'outfit' | 'nunito';

export const LAYOUTS: { id: LayoutId; label: string; blurb: string }[] = [
  { id: 'classic', label: 'Classic', blurb: 'Team on the left, chat in the middle, Desk on the right' },
  { id: 'mirror', label: 'Mirror', blurb: 'Desk on the left, team on the right' },
  { id: 'dock', label: 'Dock', blurb: 'A slim column of faces and a wide chat' },
  { id: 'crew', label: 'Crew', blurb: 'The team sits across the top like stations' },
];

export const TEAM_VIEWS: { id: TeamView; label: string }[] = [
  { id: 'portraits', label: 'Portraits' },
  { id: 'list', label: 'List' },
  { id: 'tiles', label: 'Tiles' },
  { id: 'seats', label: 'Seating chart' },
];

export const SURFACES: { id: SurfaceId; label: string }[] = [
  { id: 'soft', label: 'Soft' },
  { id: 'paper', label: 'Paper' },
  { id: 'pixel', label: 'Pixel' },
  { id: 'hud', label: 'Heads-up' },
  { id: 'cozy', label: 'Cozy' },
  { id: 'glass', label: 'Glass' },
  { id: 'terminal', label: 'Terminal' },
];

export const SOUND_KITS: { id: SoundKit; label: string }[] = [
  { id: 'console', label: 'Console hum' },
  { id: 'bridge', label: 'Sonar' },
  { id: 'paper', label: 'Paper & stamp' },
  { id: 'arcade', label: 'Coin-op' },
  { id: 'cabin', label: 'Woodstove' },
  { id: 'neon', label: 'Neon synth' },
  { id: 'terminal', label: 'Keyclick' },
  { id: 'garden', label: 'Wind chimes' },
];

const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Faces for names, labels and headings. Message text keeps the body font. */
export const DISPLAY_FACES: { id: DisplayId; label: string; stack: string }[] = [
  { id: 'body', label: 'Same as text', stack: 'var(--r-body)' },
  { id: 'michroma', label: 'Michroma', stack: "'Michroma', 'Eurostile', 'Bank Gothic', sans-serif" },
  { id: 'jost', label: 'Jost', stack: "'Jost', 'Futura', 'Century Gothic', sans-serif" },
  { id: 'silkscreen', label: 'Silkscreen', stack: `'Silkscreen', ${MONO}` },
  { id: 'courier-prime', label: 'Courier Prime', stack: "'Courier Prime', 'Courier New', Courier, monospace" },
  { id: 'fraunces', label: 'Fraunces', stack: "'Fraunces', Georgia, serif" },
  { id: 'newsreader', label: 'Newsreader', stack: "'Newsreader', Georgia, serif" },
  { id: 'space-grotesk', label: 'Space Grotesk', stack: "'Space Grotesk', system-ui, sans-serif" },
  { id: 'sora', label: 'Sora', stack: "'Sora', system-ui, sans-serif" },
  { id: 'quicksand', label: 'Quicksand', stack: "'Quicksand', system-ui, sans-serif" },
  { id: 'lora', label: 'Lora', stack: "'Lora', Georgia, serif" },
  { id: 'roboto-mono', label: 'Roboto Mono', stack: "'Roboto Mono', ui-monospace, monospace" },
  { id: 'outfit', label: 'Outfit', stack: "'Outfit', system-ui, sans-serif" },
  { id: 'nunito', label: 'Nunito', stack: "'Nunito', system-ui, sans-serif" },
];

/** A made room's own colors: "<dark|light> bg ink accent emerald amber rose violet". */
export const PAINT_RE = /^(dark|light)( #[0-9a-f]{6}){7}$/;
