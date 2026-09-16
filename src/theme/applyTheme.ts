// Visual style and brightness are independent local preferences. Deployment
// defaults only apply before this browser has chosen its own appearance.
export const THEME_COLORS = { dark: '#08080a', light: '#f4f1ea' } as const;
const LAVENDER_COLORS = { dark: '#171321', light: '#faf8ff' } as const;
export type ThemeName = keyof typeof THEME_COLORS;
export type VisualStyle = 'console' | 'lavender';

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

export function applyTheme(theme: ThemeName, style: VisualStyle = readVisualStyle()): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.style = style;
  try {
    localStorage.setItem('rivendell:theme', theme);
    localStorage.setItem('rivendell:style', style);
  } catch { /* The controls still work when browser storage is unavailable. */ }
  const colors = style === 'lavender' ? LAVENDER_COLORS : THEME_COLORS;
  document.documentElement.style.setProperty('--boot-bg', colors[theme]);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors[theme]);
}
