// Visual appearance entry points. The theme library (themes.ts) owns palettes
// and knobs; these helpers stay source-compatible with the original two-axis
// API so existing surfaces (Studio shell, sidebar toggle) keep working and now
// also re-apply the stored knobs instead of clobbering them.
import { applyAppearance, appearanceAxes, findPalette, readAppearance } from './themes';

export type ThemeName = 'dark' | 'light';
export type VisualStyle = 'console' | 'lavender';
export { type Appearance } from './themes';

export const THEME_COLORS = { dark: '#08080a', light: '#f4f1ea' } as const;

function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function readTheme(): ThemeName {
  const value = stored('rivendell:theme');
  if (value === 'light' || value === 'dark') return value;
  return import.meta.env.VITE_TARDIS_THEME === 'light' ? 'light' : 'dark';
}

export function readVisualStyle(): VisualStyle {
  const value = stored('rivendell:style');
  if (value === 'console' || value === 'lavender') return value;
  return import.meta.env.VITE_TARDIS_STYLE === 'lavender' ? 'lavender' : 'console';
}

/** The current palette mode, honoring the new theme library when it is in use. */
export function readAppearanceMode(): ThemeName {
  return appearanceAxes(readAppearance()).mode;
}

export { readAppearance, applyAppearance, findPalette, withMode, withStyle } from './themes';

/**
 * Legacy two-axis apply: keeps working, and now folds in the stored knobs
 * (palette, accent, font, size, corners, motion) so no surface resets them.
 */
export function applyTheme(theme: ThemeName, style: VisualStyle = readVisualStyle()): void {
  const current = readAppearance();
  const def = findPalette(current.palette);
  // Same mode: keep the active (possibly custom) palette, just re-apply knobs.
  if (def.mode === theme) { applyAppearance(current); return; }
  // Mode flip: map onto the nearest legacy palette that carries the asked look.
  const palette = style === 'lavender'
    ? (theme === 'light' ? 'lavender-light' : 'lavender')
    : (theme === 'light' ? 'console-light' : 'console');
  applyAppearance({ ...current, palette, style });
}
