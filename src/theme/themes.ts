// Theme library: named palettes, appearance knobs, and persistence.
// Every custom palette is a compact set of canonical colors expanded into the
// full --r-* token map. Text-bearing colors are numerically nudged during
// expansion so body text, the composer, and accent text keep WCAG AA on every
// palette — the hand-picked hues set the character, the math keeps it readable.

export type Mode = 'dark' | 'light';
export type StyleAxis = 'console' | 'lavender';
export type FontId = 'system' | 'grotesk' | 'serif' | 'mono' | 'rounded';

export interface PaletteColors {
  bg: string; bgDeep: string; bgSoft: string; bgCard: string; bgRaised: string; bgHover: string;
  ink: string; inkSoft: string; inkMute: string; inkFaint: string; inkGhost: string;
  accent: string; emerald: string; amber: string; rose: string; violet: string;
}

export interface ThemeDef {
  id: string;
  label: string;
  mode: Mode;
  blurb: string;
  /** Legacy entries keep the stylesheet-owned look; style comes from the axis. */
  legacyStyle?: StyleAxis;
  colors: PaletteColors;
}

const legacy = (id: string, label: string, mode: Mode, legacyStyle: StyleAxis, blurb: string, colors: PaletteColors): ThemeDef =>
  ({ id, label, mode, legacyStyle, blurb, colors });

// Canonical console/lavender colors (mirror src/tokens.css) — used for swatches,
// accent-override math, and boot colors on legacy entries.
const CONSOLE_DARK: PaletteColors = {
  bg: '#08080a', bgDeep: '#050506', bgSoft: '#0f0f13', bgCard: '#15151b', bgRaised: '#1c1c24', bgHover: '#23232d',
  ink: '#ebe6da', inkSoft: '#cfc9bb', inkMute: '#a39e91', inkFaint: '#7d786c', inkGhost: '#57534a',
  accent: '#f2b95f', emerald: '#6fa887', amber: '#e08a3c', rose: '#cc4744', violet: '#9b84c9',
};
const CONSOLE_LIGHT: PaletteColors = {
  bg: '#f4f1ea', bgDeep: '#ebe7de', bgSoft: '#f9f7f2', bgCard: '#fdfcf9', bgRaised: '#ffffff', bgHover: '#eee9df',
  ink: '#1c1915', inkSoft: '#3f3a32', inkMute: '#6c665b', inkFaint: '#6f685c', inkGhost: '#c2bbae',
  accent: '#9a6118', emerald: '#3d7a5a', amber: '#b0641e', rose: '#b5403c', violet: '#5b3f8c',
};
const LAVENDER_DARK: PaletteColors = {
  bg: '#171321', bgDeep: '#100d18', bgSoft: '#1e182a', bgCard: '#241d32', bgRaised: '#2c243b', bgHover: '#392d4c',
  ink: '#f3edfc', inkSoft: '#dfd2ef', inkMute: '#baa7cd', inkFaint: '#b29ec7', inkGhost: '#746080',
  accent: '#c9a3f5', emerald: '#8bc4a7', amber: '#edb36b', rose: '#cc4744', violet: '#bd97ec',
};
const LAVENDER_LIGHT: PaletteColors = {
  bg: '#faf8ff', bgDeep: '#f0ebf8', bgSoft: '#f4effc', bgCard: '#ffffff', bgRaised: '#ffffff', bgHover: '#e9def8',
  ink: '#292035', inkSoft: '#453750', inkMute: '#695975', inkFaint: '#71607e', inkGhost: '#c0afcb',
  accent: '#7041ac', emerald: '#327252', amber: '#945414', rose: '#b13a59', violet: '#8054bc',
};

export const PALETTES: ThemeDef[] = [
  legacy('console', 'Console', 'dark', 'console', 'Warm brass & void', CONSOLE_DARK),
  legacy('console-light', 'Classic', 'light', 'console', '1963 white roundels', CONSOLE_LIGHT),
  legacy('lavender', 'Lavender', 'dark', 'lavender', 'Soft violet night', LAVENDER_DARK),
  legacy('lavender-light', 'Lilac', 'light', 'lavender', 'Soft violet day', LAVENDER_LIGHT),
  { id: 'midnight', label: 'Midnight', mode: 'dark', blurb: 'Deep space blue', colors: {
    bg: '#0a0f1e', bgDeep: '#070b16', bgSoft: '#0e1526', bgCard: '#131c31', bgRaised: '#1a2440', bgHover: '#223052',
    ink: '#e6ecf8', inkSoft: '#c9d5ea', inkMute: '#9aa9c6', inkFaint: '#7f8dab', inkGhost: '#55628a',
    accent: '#7fb0e0', emerald: '#78c8a2', amber: '#e6b45f', rose: '#e5737d', violet: '#a8a4e8' } },
  { id: 'nord', label: 'Nord', mode: 'dark', blurb: 'Frost & polar night', colors: {
    bg: '#2e3440', bgDeep: '#272c36', bgSoft: '#343a46', bgCard: '#3b4252', bgRaised: '#434c5e', bgHover: '#4c566a',
    ink: '#eceff4', inkSoft: '#d8dee9', inkMute: '#b6c0d4', inkFaint: '#9daabb', inkGhost: '#6d7a90',
    accent: '#88c0d0', emerald: '#a3be8c', amber: '#ebcb8b', rose: '#c57b82', violet: '#b48ead' } },
  { id: 'dracula', label: 'Dracula', mode: 'dark', blurb: 'Purple dusk & neon', colors: {
    bg: '#282a36', bgDeep: '#21222c', bgSoft: '#2f313f', bgCard: '#343746', bgRaised: '#3e4152', bgHover: '#484c5f',
    ink: '#f8f8f2', inkSoft: '#dedee6', inkMute: '#b8bacb', inkFaint: '#9da0b5', inkGhost: '#6c6f8d',
    accent: '#bd93f9', emerald: '#6fdc8f', amber: '#f1fa8c', rose: '#ff6e6e', violet: '#c39aec' } },
  { id: 'tokyo-night', label: 'Tokyo Night', mode: 'dark', blurb: 'City lights on water', colors: {
    bg: '#1a1b26', bgDeep: '#16161e', bgSoft: '#1f2233', bgCard: '#24283b', bgRaised: '#2f334d', bgHover: '#3b4261',
    ink: '#c0caf5', inkSoft: '#a9b1d6', inkMute: '#8e97bd', inkFaint: '#7a83aa', inkGhost: '#565f89',
    accent: '#7aa2f7', emerald: '#9ece6a', amber: '#e0af68', rose: '#f7768e', violet: '#bb9af7' } },
  { id: 'gruvbox', label: 'Gruvbox', mode: 'dark', blurb: 'Retro groove, warm', colors: {
    bg: '#282828', bgDeep: '#1d2021', bgSoft: '#2e2c28', bgCard: '#32302f', bgRaised: '#3c3836', bgHover: '#504945',
    ink: '#fbf1c7', inkSoft: '#ebdbb2', inkMute: '#c5ab89', inkFaint: '#b09069', inkGhost: '#7c6f64',
    accent: '#fabd2f', emerald: '#b8bb26', amber: '#fe8019', rose: '#fb4934', violet: '#d3869b' } },
  { id: 'mocha', label: 'Mocha', mode: 'dark', blurb: 'Catppuccin, gently bold', colors: {
    bg: '#1e1e2e', bgDeep: '#181825', bgSoft: '#232336', bgCard: '#262639', bgRaised: '#313244', bgHover: '#3d3e55',
    ink: '#cdd6f4', inkSoft: '#bac2de', inkMute: '#a6adc8', inkFaint: '#939ab2', inkGhost: '#6c7086',
    accent: '#cba6f7', emerald: '#a6e3a1', amber: '#f9e2af', rose: '#f38ba8', violet: '#b4befe' } },
  { id: 'rose-pine', label: 'Rosé Pine', mode: 'dark', blurb: 'Rosy forest dusk', colors: {
    bg: '#191724', bgDeep: '#14121f', bgSoft: '#1f1d2d', bgCard: '#26233a', bgRaised: '#2c2944', bgHover: '#37334f',
    ink: '#e0def4', inkSoft: '#cdc9e2', inkMute: '#a4a0c0', inkFaint: '#908caa', inkGhost: '#6e6a86',
    accent: '#c4a7e7', emerald: '#9ccfd8', amber: '#f6c177', rose: '#eb6f92', violet: '#c4a7e7' } },
  { id: 'solar-dark', label: 'Solarized Dark', mode: 'dark', blurb: 'Classic ink & cyan', colors: {
    bg: '#002b36', bgDeep: '#001f28', bgSoft: '#03303c', bgCard: '#073642', bgRaised: '#0d4450', bgHover: '#155261',
    ink: '#dbe9e2', inkSoft: '#b3c9c2', inkMute: '#93a1a1', inkFaint: '#7c8f8f', inkGhost: '#586e75',
    accent: '#46c0ba', emerald: '#9dd964', amber: '#f0d264', rose: '#ef7b78', violet: '#9d9bea' } },
  { id: 'oled', label: 'OLED Black', mode: 'dark', blurb: 'True black, electric', colors: {
    bg: '#000000', bgDeep: '#000000', bgSoft: '#0a0a0c', bgCard: '#101014', bgRaised: '#16161c', bgHover: '#1e1e26',
    ink: '#f2f2f5', inkSoft: '#d6d6dc', inkMute: '#ababb7', inkFaint: '#8d8d99', inkGhost: '#56565f',
    accent: '#54a8ff', emerald: '#5fd49b', amber: '#ffb454', rose: '#ff6b6b', violet: '#b9a3f7' } },
  { id: 'synthwave', label: 'Synthwave', mode: 'dark', blurb: 'Neon sunset grid', colors: {
    bg: '#17111f', bgDeep: '#120d19', bgSoft: '#1e1728', bgCard: '#241b31', bgRaised: '#2c213c', bgHover: '#372a4b',
    ink: '#f4eeff', inkSoft: '#ded2f2', inkMute: '#b8a8d4', inkFaint: '#a293c2', inkGhost: '#6b5c8d',
    accent: '#ff7edb', emerald: '#72f1b8', amber: '#fede5d', rose: '#fe4450', violet: '#36f9f6' } },
  { id: 'forest', label: 'Forest', mode: 'dark', blurb: 'Pine shade & moss', colors: {
    bg: '#0f1a13', bgDeep: '#0b130e', bgSoft: '#142018', bgCard: '#1a281e', bgRaised: '#223327', bgHover: '#2a3f30',
    ink: '#e8f2e6', inkSoft: '#cce0ca', inkMute: '#a3bfa4', inkFaint: '#8aa78c', inkGhost: '#5a7360',
    accent: '#8fce6f', emerald: '#8fce6f', amber: '#d9b25f', rose: '#e07676', violet: '#b095d8' } },
  { id: 'ember', label: 'Ember', mode: 'dark', blurb: 'Forge glow & ash', colors: {
    bg: '#1a0f0d', bgDeep: '#140b09', bgSoft: '#221411', bgCard: '#2a1915', bgRaised: '#33201b', bgHover: '#3e2822',
    ink: '#f7ece4', inkSoft: '#e2d0c4', inkMute: '#c4a596', inkFaint: '#a98b7d', inkGhost: '#75584e',
    accent: '#ff8a5c', emerald: '#a4cc8e', amber: '#ffc46b', rose: '#ff6b6b', violet: '#c39aec' } },
  { id: 'ocean', label: 'Ocean', mode: 'dark', blurb: 'Deep current & foam', colors: {
    bg: '#0b1622', bgDeep: '#081120', bgSoft: '#0f1d2d', bgCard: '#142436', bgRaised: '#1b2e44', bgHover: '#233a55',
    ink: '#e4eef8', inkSoft: '#c6d8ea', inkMute: '#9cb5cf', inkFaint: '#829cb6', inkGhost: '#55708c',
    accent: '#45c4e8', emerald: '#62d4a8', amber: '#f0b45f', rose: '#ef7d8e', violet: '#a4b9f2' } },
  { id: 'monokai', label: 'Monokai', mode: 'dark', blurb: 'The classic editor', colors: {
    bg: '#272822', bgDeep: '#1f201b', bgSoft: '#2d2e27', bgCard: '#34352d', bgRaised: '#3e3f35', bgHover: '#4a4b3f',
    ink: '#f8f8f2', inkSoft: '#e0e0d0', inkMute: '#c1c1a9', inkFaint: '#a5a68c', inkGhost: '#75715e',
    accent: '#a6e22e', emerald: '#a6e22e', amber: '#e6db74', rose: '#f92672', violet: '#ae81ff' } },
  { id: 'latte', label: 'Latte', mode: 'light', blurb: 'Catppuccin daylight', colors: {
    bg: '#eff1f5', bgDeep: '#e6e9ef', bgSoft: '#f4f5f9', bgCard: '#ffffff', bgRaised: '#ffffff', bgHover: '#dce0e8',
    ink: '#4c4f69', inkSoft: '#5c5f77', inkMute: '#6c6f85', inkFaint: '#7c7f93', inkGhost: '#bcc0cc',
    accent: '#1e66f5', emerald: '#1f8a3d', amber: '#b56a0e', rose: '#d20f39', violet: '#7c3aed' } },
  { id: 'dawn', label: 'Dawn', mode: 'light', blurb: 'Rosé Pine morning', colors: {
    bg: '#faf4ed', bgDeep: '#f2e9e1', bgSoft: '#fffaf3', bgCard: '#fffaf3', bgRaised: '#ffffff', bgHover: '#f2e9e1',
    ink: '#575279', inkSoft: '#635d7e', inkMute: '#797593', inkFaint: '#8b879f', inkGhost: '#c6c2d4',
    accent: '#8b6bb0', emerald: '#3f7d74', amber: '#b5762a', rose: '#b4637a', violet: '#7d6598' } },
  { id: 'daylight', label: 'Daylight', mode: 'light', blurb: 'Clean blue morning', colors: {
    bg: '#f6f8fb', bgDeep: '#eef1f6', bgSoft: '#fbfcfe', bgCard: '#ffffff', bgRaised: '#ffffff', bgHover: '#e9eef5',
    ink: '#1c2430', inkSoft: '#3a4656', inkMute: '#5c6b80', inkFaint: '#6e7d92', inkGhost: '#b6c2d2',
    accent: '#2563eb', emerald: '#178a56', amber: '#b45309', rose: '#dc2626', violet: '#7c3aed' } },
];

export const DEFAULT_PALETTE = 'console';

export const ACCENT_PRESETS = [
  '#f2b95f', '#7fb0e0', '#88c0d0', '#bd93f9', '#ff7edb', '#a6e22e',
  '#6fcfa4', '#ff8a5c', '#f9e2af', '#e06c75',
] as const;

export const FONTS: { id: FontId; label: string; vars?: Record<'--r-body' | '--r-display' | '--r-sign' | '--r-mono', string> }[] = [
  { id: 'system', label: 'Default' },
  {
    id: 'grotesk', label: 'Grotesk',
    vars: {
      '--r-body': "'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif",
      '--r-display': "'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif",
      '--r-sign': "'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif",
      '--r-mono': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    },
  },
  {
    id: 'serif', label: 'Serif',
    vars: {
      '--r-body': "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', serif",
      '--r-display': "Georgia, 'Iowan Old Style', 'Palatino Linotype', serif",
      '--r-sign': "'Palatino Linotype', Georgia, serif",
      '--r-mono': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    },
  },
  {
    id: 'mono', label: 'Mono',
    vars: {
      '--r-body': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      '--r-display': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      '--r-sign': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      '--r-mono': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    },
  },
  {
    id: 'rounded', label: 'Rounded',
    vars: {
      '--r-body': "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', 'Segoe UI Variable Display', system-ui, sans-serif",
      '--r-display': "ui-rounded, 'SF Pro Rounded', 'Segoe UI Variable Display', system-ui, sans-serif",
      '--r-sign': "ui-rounded, 'SF Pro Rounded', 'Segoe UI Variable Display', system-ui, sans-serif",
      '--r-mono': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    },
  },
];

export const TEXT_SCALES = [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2] as const;
export const RADIUS_STEPS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5] as const;

/* ------------------------- contrast math (WCAG) ------------------------- */

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mix `hex` toward `target` by `amount` (0..1). */
export function mix(hex: string, target: string, amount: number): string {
  const [r1, g1, b1] = hexToRgb(hex);
  const [r2, g2, b2] = hexToRgb(target);
  return toHex(r1 + (r2 - r1) * amount, g1 + (g2 - g1) * amount, b1 + (b2 - b1) * amount);
}

const WHITE = '#ffffff';
const BLACK = '#000000';

/** Nudge `fg` (toward white on dark themes, black on light) until it reads at `min` on `bg`. */
export function ensure(fg: string, bg: string, min: number, mode: Mode): string {
  if (contrast(fg, bg) >= min) return fg;
  const target = mode === 'dark' ? WHITE : BLACK;
  let out = fg;
  for (let i = 1; i <= 16; i++) {
    out = mix(fg, target, i * 0.06);
    if (contrast(out, bg) >= min) return out;
  }
  return out;
}

/** Pick the ink that reads best on a filled accent surface. Pure black vs
 *  pure white guarantees >= 4.58:1 on ANY fill (the crossover minimum), so
 *  on-accent text is always AA even for arbitrary custom accents. */
export function pickOn(accent: string): string {
  return contrast(accent, BLACK) >= contrast(accent, WHITE) ? BLACK : WHITE;
}

/* --------------------------- token expansion --------------------------- */

function cm(color: string, pct: number, alphaTail = 'transparent'): string {
  return `color-mix(in srgb, ${color} ${pct}%, ${alphaTail})`;
}

function roundelSvg(mode: Mode, accent: string, bgDeep: string, line: string): string {
  const a = accent.replace('#', '%23');
  if (mode === 'dark') {
    return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'><circle cx='48' cy='48' r='31' fill='none' stroke='${a}' stroke-opacity='0.055' stroke-width='1'/><circle cx='48' cy='48' r='24' fill='none' stroke='${a}' stroke-opacity='0.03' stroke-width='0.8'/></svg>")`;
  }
  const d = bgDeep.replace('#', '%23');
  const l = mix(line.replace('rgba(', '#').slice(0, 7), bgDeep, 0).replace('#', '%23'); // line var unused for light; keep simple
  void l;
  return `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'><circle cx='48' cy='48' r='31' fill='${d}' fill-opacity='0.55'/><circle cx='48' cy='48' r='31' fill='none' stroke='${d}' stroke-width='1'/><circle cx='48' cy='48' r='24' fill='none' stroke='${a}' stroke-opacity='0.25' stroke-width='0.8'/></svg>")`;
}

/**
 * Expand a palette (+ optional accent override) into the full --r-* token map.
 * All text-bearing colors are contrast-ensured: ink family ≥ 4.5 on bg/card/raised,
 * accent-text/gold/semantic colors ≥ 4.5 on card, mute ≥ 4.5, faint ≥ 3 on card.
 */
export function expandTokens(def: ThemeDef, accentOverride?: string | null): Record<string, string> {
  const c = def.colors;
  const accent = accentOverride ?? c.accent;
  const card = c.bgCard;
  const m = def.mode;

  const goldText = ensure(accent, card, 4.5, m);
  const accentText = ensure(accent, card, 4.5, m);
  let accentFill = ensure(accent, card, 3, m);
  const goldDim = mix(goldText, c.bg, 0.45);
  // The ink on an accent-filled button must read at AA too: if neither plain ink
  // reaches 4.5, deepen the fill toward the far pole until its best ink does.
  let on = pickOn(accentFill);
  if (contrast(on, accentFill) < 4.5) {
    const pole = on === '#ffffff' ? BLACK : WHITE;
    for (let i = 1; i <= 16; i++) {
      const candidate = mix(accentFill, pole, i * 0.06);
      if (contrast(pickOn(candidate), candidate) >= 4.5 && contrast(candidate, card) >= 3) {
        accentFill = candidate;
        on = pickOn(candidate);
        break;
      }
    }
  }
  const emerald = ensure(c.emerald, card, 4.5, m);
  const amber = ensure(c.amber, card, 4.5, m);
  const rose = ensure(c.rose, card, 4.5, m);
  const violet = ensure(c.violet, card, 4.5, m);
  const mute = ensure(c.inkMute, card, 4.5, m);
  const faint = ensure(c.inkFaint, card, 3, m);

  const tokens: Record<string, string> = {
    '--r-bg': c.bg, '--r-bg-deep': c.bgDeep, '--r-bg-soft': c.bgSoft,
    '--r-bg-card': c.bgCard, '--r-bg-raised': c.bgRaised, '--r-bg-hover': c.bgHover,
    '--r-line': cm(goldText, 12), '--r-line-strong': cm(goldText, 18), '--r-line-gold': cm(goldText, 32),
    '--r-ink': c.ink, '--r-ink-soft': c.inkSoft, '--r-ink-mute': mute,
    '--r-ink-faint': faint, '--r-ink-ghost': c.inkGhost,
    '--r-silver': mute, '--r-silver-soft': faint,
    '--r-star': c.ink,
    '--r-elf-blue': accentFill, '--r-elf-glow': accentText, '--r-on-accent': on,
    '--r-deep-blue': goldDim, '--r-gold': goldText, '--r-gold-soft': goldDim,
    '--r-emerald': emerald, '--r-amber': amber, '--r-rose': rose,
    '--r-blood': mix(rose, c.bg, 0.3),
    '--r-brass': goldText, '--r-brass-soft': goldDim,
    '--r-tardis': mix(accentFill, c.bg, 0.55), '--r-tardis-lit': accentFill, '--r-tardis-hi': accentText,
    '--r-violet': violet,
    '--r-vortex-1': violet, '--r-vortex-2': emerald, '--r-vortex-3': accentFill,
    '--r-glow-brass': `0 0 18px ${cm(accentFill, 26)}, 0 0 42px ${cm(accentFill, 10)}`,
    '--r-glow-tardis': `0 0 0 3px ${cm(accentFill, 26)}, 0 0 18px ${cm(accentFill, 20)}`,
    '--r-glow-elf': `0 0 20px ${cm(accentFill, 20)}, 0 0 40px ${cm(accentFill, 10)}`,
    '--r-glow-gold': `0 0 18px ${cm(goldText, 24)}, 0 0 42px ${cm(goldText, 9)}`,
    '--r-glow-soft': `0 0 30px ${cm(accentFill, 6)}`,
    '--r-page-glow-1': cm(violet, m === 'dark' ? 9 : 6),
    '--r-page-glow-2': cm(accentFill, m === 'dark' ? 6 : 5),
    '--r-page-glow-3': cm(emerald, 5),
    '--r-star-color': accentText,
    '--r-star-show': m === 'dark' ? '1' : '0',
    '--r-sidebar-grad-1': cm(c.bgSoft, 92), '--r-sidebar-grad-2': cm(c.bg, 97),
    '--r-rail-grad-1': cm(c.bgSoft, 60), '--r-rail-grad-2': cm(c.bg, 82),
    '--r-roundel': roundelSvg(m, accentFill, c.bgDeep, ''),
    '--r-roundel-page': m === 'dark' ? 'none' : roundelSvg(m, accentFill, c.bgDeep, ''),
  };
  return tokens;
}

/* ---------------------------- appearance store ---------------------------- */

export interface Appearance {
  palette: string;            // ThemeDef id
  style: StyleAxis;           // legacy console/lavender axis (typography/radius on custom palettes)
  accent: string | null;      // custom accent hex, null = theme default
  font: FontId;
  textScale: number;          // page zoom, 1 = native
  radius: number;             // corner multiplier, 1 = native
  motion: boolean;            // ambient animation
}

const APPEARANCE_KEY = 'rivendell:appearance';
export const BOOT_BG_KEY = 'rivendell:boot-bg';

export const DEFAULT_APPEARANCE: Appearance = {
  palette: DEFAULT_PALETTE, style: 'console', accent: null,
  font: 'system', textScale: 1, radius: 1, motion: true,
};

export function findPalette(id: string): ThemeDef {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

/** Mode/style this appearance will apply to <html> datasets. */
export function appearanceAxes(a: Appearance): { mode: Mode; style: StyleAxis } {
  const def = findPalette(a.palette);
  return { mode: def.mode, style: def.legacyStyle ?? a.style };
}

function readStored(): string | null {
  try { return localStorage.getItem(APPEARANCE_KEY); } catch { return null; }
}

export function readAppearance(): Appearance {
  const a: Appearance = { ...DEFAULT_APPEARANCE };
  // Deployment defaults apply only before this browser has chosen its own
  // appearance — same contract as the original two-axis code.
  if (import.meta.env.VITE_TARDIS_THEME === 'light' || import.meta.env.VITE_TARDIS_STYLE === 'lavender') {
    if (import.meta.env.VITE_TARDIS_STYLE === 'lavender') a.style = 'lavender';
    const wantLight = import.meta.env.VITE_TARDIS_THEME === 'light';
    a.palette = a.style === 'lavender'
      ? (wantLight ? 'lavender-light' : 'lavender')
      : (wantLight ? 'console-light' : 'console');
  }
  try {
    const legacyTheme = localStorage.getItem('rivendell:theme');
    const legacyStyle = localStorage.getItem('rivendell:style');
    if (legacyStyle === 'lavender') a.style = 'lavender';
    if (legacyTheme === 'light' || legacyStyle === 'lavender') {
      // migrate the old two-axis choice onto the nearest palette
      const wantLight = legacyTheme === 'light';
      a.palette = a.style === 'lavender' ? (wantLight ? 'lavender-light' : 'lavender') : (wantLight ? 'console-light' : 'console');
    }
    const raw = readStored();
    if (raw) {
      const v = JSON.parse(raw) as Partial<Appearance>;
      if (v && typeof v === 'object') {
        if (typeof v.palette === 'string' && PALETTES.some((p) => p.id === v.palette)) a.palette = v.palette;
        if (v.style === 'lavender' || v.style === 'console') a.style = v.style;
        a.accent = typeof v.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.accent) ? v.accent : null;
        if (typeof v.font === 'string' && FONTS.some((f) => f.id === v.font)) a.font = v.font as FontId;
        if (typeof v.textScale === 'number' && v.textScale >= 0.8 && v.textScale <= 1.25) a.textScale = v.textScale;
        if (typeof v.radius === 'number' && v.radius >= 0 && v.radius <= 1.6) a.radius = v.radius;
        if (typeof v.motion === 'boolean') a.motion = v.motion;
      }
    }
  } catch { /* storage unavailable: defaults still work */ }
  return a;
}

export function writeAppearance(a: Appearance): void {
  const { mode, style } = appearanceAxes(a);
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a));
    // keep the legacy keys coherent for the boot script and older surfaces
    localStorage.setItem('rivendell:theme', mode);
    localStorage.setItem('rivendell:style', style);
    localStorage.setItem(BOOT_BG_KEY, findPalette(a.palette).colors.bg);
  } catch { /* the controls still work without storage */ }
}

/** Every inline custom property applyAppearance may set (so it can clear stale ones). */
export const APPLIED_PROP_KEYS = [
  ...Object.keys(expandTokens(PALETTES[0])),
  '--r-body', '--r-display', '--r-sign', '--r-mono',
  '--r-radius-sm', '--r-radius', '--r-radius-lg', '--r-radius-xl',
];

const RADIUS_BASE = { sm: 4, r: 8, lg: 14, xl: 20 } as const;

export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement): void {
  const def = findPalette(a.palette);
  const { mode, style } = appearanceAxes(a);
  root.dataset.theme = mode;
  root.dataset.style = style;
  if (a.motion) delete root.dataset.motion;
  else root.dataset.motion = 'calm';

  for (const key of APPLIED_PROP_KEYS) root.style.removeProperty(key);

  const custom = !def.legacyStyle;
  if (custom || a.accent) {
    const tokens = expandTokens(def, a.accent);
    for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  }

  const font = FONTS.find((f) => f.id === a.font);
  if (font?.vars) for (const [k, v] of Object.entries(font.vars)) root.style.setProperty(k, v);

  if (a.radius !== 1) {
    root.style.setProperty('--r-radius-sm', `${Math.round(RADIUS_BASE.sm * a.radius)}px`);
    root.style.setProperty('--r-radius', `${Math.round(RADIUS_BASE.r * a.radius)}px`);
    root.style.setProperty('--r-radius-lg', `${Math.round(RADIUS_BASE.lg * a.radius)}px`);
    root.style.setProperty('--r-radius-xl', `${Math.round(RADIUS_BASE.xl * a.radius)}px`);
  }

  root.style.zoom = a.textScale !== 1 ? String(a.textScale) : '';

  const bg = def.colors.bg;
  root.style.setProperty('--boot-bg', bg);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);

  writeAppearance(a);
}

export function paletteIndex(a: Appearance): number {
  return PALETTES.findIndex((p) => p.id === a.palette);
}

export function cycleAppearance(a: Appearance): Appearance {
  const next = PALETTES[(paletteIndex(a) + 1) % PALETTES.length];
  return { ...a, palette: next.id, style: next.legacyStyle ?? a.style };
}

/** Switch the light/dark axis, keeping the style axis (console/lavender) look. */
export function withMode(a: Appearance, mode: Mode): Appearance {
  const def = findPalette(a.palette);
  if (def.mode === mode) return a;
  const style = def.legacyStyle ?? a.style;
  const palette = style === 'lavender'
    ? (mode === 'light' ? 'lavender-light' : 'lavender')
    : (mode === 'light' ? 'console-light' : 'console');
  return { ...a, palette, style };
}

/** Switch the console/lavender axis; legacy palettes follow their look. */
export function withStyle(a: Appearance, style: StyleAxis): Appearance {
  const def = findPalette(a.palette);
  if (def.legacyStyle && def.legacyStyle !== style) {
    const palette = style === 'lavender'
      ? (def.mode === 'light' ? 'lavender-light' : 'lavender')
      : (def.mode === 'light' ? 'console-light' : 'console');
    return { ...a, style, palette };
  }
  return { ...a, style };
}

export function shuffleAppearance(a: Appearance): Appearance {
  const others = PALETTES.filter((p) => p.id !== a.palette);
  const pick = others[Math.floor(Math.random() * others.length)];
  return { ...a, palette: pick.id, style: pick.legacyStyle ?? a.style };
}

/** Cycle/shuffle from storage, for surfaces that do not hold React state. */
export function cycleThemeFromStorage(): Appearance {
  const next = cycleAppearance(readAppearance());
  applyAppearance(next);
  return next;
}

export function shuffleThemeFromStorage(): Appearance {
  const next = shuffleAppearance(readAppearance());
  applyAppearance(next);
  return next;
}
