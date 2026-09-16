import { useEffect, useRef, type RefObject } from 'react';
import { Moon, Sun, X } from 'lucide-react';
import type { ThemeName, VisualStyle } from './applyTheme';
import './appearance.css';

export function AppearanceSettings({ theme, visualStyle, onThemeChange, onStyleChange, onClose, triggerRef }: {
  theme: ThemeName;
  visualStyle: VisualStyle;
  onThemeChange: (theme: ThemeName) => void;
  onStyleChange: (style: VisualStyle) => void;
  onClose: (restoreFocus?: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !triggerRef.current?.contains(target)) closeRef.current(false);
    };
    const onFocus = (event: FocusEvent) => {
      if (!ref.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) closeRef.current(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [triggerRef]);
  return <div ref={ref} id="appearance-settings" className="appearance-settings" role="dialog" aria-labelledby="appearance-title">
    <div className="appearance-head"><h2 id="appearance-title">Make it yours</h2><button type="button" onClick={() => onClose()} aria-label="Close appearance settings"><X size={17} /></button></div>
    <fieldset><legend>Visual style</legend><div className="appearance-choices">
      {(['console', 'lavender'] as const).map((style) => <button type="button" key={style} className="appearance-style" aria-pressed={visualStyle === style} onClick={() => onStyleChange(style)}>
        <span className={`appearance-swatch appearance-swatch-${style}`} aria-hidden="true"><i /><i /><i /></span>
        <strong>{style === 'console' ? 'Console' : 'Lavender'}</strong>
        <small>{style === 'console' ? 'Warm & familiar' : 'Soft & spacious'}</small>
      </button>)}
    </div></fieldset>
    <fieldset><legend>Brightness</legend><div className="appearance-choices appearance-modes">
      <button type="button" aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}><Sun size={16} /> Light</button>
      <button type="button" aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}><Moon size={16} /> Dark</button>
    </div></fieldset>
    <p>Saved on this device. Your agents stay the same.</p>
  </div>;
}
