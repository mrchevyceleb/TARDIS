import { useEffect, useRef, type RefObject } from 'react';
import { Dices, X } from 'lucide-react';
import {
  ACCENT_PRESETS, FONTS, PALETTES, RADIUS_STEPS, TEXT_SCALES,
  shuffleAppearance, type Appearance,
} from './themes';
import './appearance.css';

export function AppearanceSettings({ appearance, onAppearance, onClose, triggerRef }: {
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
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

  const patch = (part: Partial<Appearance>) => onAppearance({ ...appearance, ...part });
  const night = PALETTES.filter((p) => p.mode === 'dark');
  const day = PALETTES.filter((p) => p.mode === 'light');
  const stepIdx = (list: readonly number[], value: number) => {
    let best = 0;
    list.forEach((v, i) => { if (Math.abs(v - value) <= Math.abs(list[best] - value)) best = i; });
    return best;
  };
  const sizeIdx = stepIdx(TEXT_SCALES, appearance.textScale);
  const radiusIdx = stepIdx(RADIUS_STEPS, appearance.radius);

  const themeCard = (id: string) => {
    const p = PALETTES.find((t) => t.id === id)!;
    return <button type="button" key={p.id} className="appearance-theme" aria-pressed={appearance.palette === p.id} onClick={() => patch({ palette: p.id, style: p.legacyStyle ?? appearance.style })} title={p.blurb}>
      <span className="appearance-theme-swatch" aria-hidden="true">
        <i style={{ background: p.colors.bg }} /><i style={{ background: p.colors.bgCard }} /><i style={{ background: appearance.accent ?? p.colors.accent }} /><i style={{ background: p.colors.ink }} />
      </span>
      <strong>{p.label}</strong>
    </button>;
  };

  return <div ref={ref} id="appearance-settings" className="appearance-settings" role="dialog" aria-labelledby="appearance-title">
    <div className="appearance-head">
      <h2 id="appearance-title">Make it yours</h2>
      <button type="button" className="appearance-shuffle" onClick={() => onAppearance(shuffleAppearance(appearance))} title="Shuffle theme (Alt+Shift+R)" aria-label="Shuffle theme"><Dices size={17} /></button>
      <button type="button" onClick={() => onClose()} aria-label="Close appearance settings"><X size={17} /></button>
    </div>

    <fieldset><legend>Theme · Night</legend><div className="appearance-themes">{night.map((p) => themeCard(p.id))}</div></fieldset>
    <fieldset><legend>Theme · Day</legend><div className="appearance-themes">{day.map((p) => themeCard(p.id))}</div></fieldset>

    <fieldset><legend>Accent</legend><div className="appearance-dots">
      <button type="button" className="appearance-dot appearance-dot-theme" aria-pressed={appearance.accent === null} onClick={() => patch({ accent: null })} title="Theme accent">A</button>
      {ACCENT_PRESETS.map((hex) => <button type="button" key={hex} className="appearance-dot" style={{ background: hex }} aria-pressed={appearance.accent === hex} onClick={() => patch({ accent: hex })} title={hex} aria-label={`Accent ${hex}`} />)}
      <label className="appearance-dot appearance-dot-custom" title="Custom accent">
        <input type="color" value={appearance.accent ?? '#f2b95f'} onChange={(e) => patch({ accent: e.target.value })} aria-label="Custom accent color" />
      </label>
    </div></fieldset>

    <fieldset><legend>Font</legend><div className="appearance-dots appearance-fonts">
      {FONTS.map((f) => <button type="button" key={f.id} className="appearance-chip" aria-pressed={appearance.font === f.id} onClick={() => patch({ font: f.id })}>{f.label}</button>)}
    </div></fieldset>

    <div className="appearance-rows">
      <div className="appearance-row"><span>Text size</span>
        <span className="appearance-stepper">
          <button type="button" disabled={sizeIdx === 0} onClick={() => patch({ textScale: TEXT_SCALES[sizeIdx - 1] })} aria-label="Smaller text">−</button>
          <b>{Math.round(appearance.textScale * 100)}%</b>
          <button type="button" disabled={sizeIdx === TEXT_SCALES.length - 1} onClick={() => patch({ textScale: TEXT_SCALES[sizeIdx + 1] })} aria-label="Larger text">+</button>
        </span>
      </div>
      <div className="appearance-row"><span>Corners</span>
        <span className="appearance-stepper">
          <button type="button" disabled={radiusIdx === 0} onClick={() => patch({ radius: RADIUS_STEPS[radiusIdx - 1] })} aria-label="Sharper corners">−</button>
          <b>{appearance.radius === 0 ? 'sharp' : `${Math.round(appearance.radius * 100)}%`}</b>
          <button type="button" disabled={radiusIdx === RADIUS_STEPS.length - 1} onClick={() => patch({ radius: RADIUS_STEPS[radiusIdx + 1] })} aria-label="Rounder corners">+</button>
        </span>
      </div>
      <div className="appearance-row"><span>Ambient motion</span>
        <button type="button" className="appearance-chip" aria-pressed={appearance.motion} onClick={() => patch({ motion: !appearance.motion })}>{appearance.motion ? 'On' : 'Calm'}</button>
      </div>
    </div>

    <p>Saved on this device. Alt+Shift+T cycles themes, Alt+Shift+R shuffles. Your agents stay the same.</p>
  </div>;
}
