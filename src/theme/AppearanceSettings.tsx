import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Dices, Pause, Play, RotateCcw, X } from 'lucide-react';
import {
  ACCENT_PRESETS, FONTS, PALETTES, RADIUS_STEPS, TEXT_SCALES,
  PRE_SYNC_KEY, SYNCED_KEY, defaultAppearance, readPreviousAppearance, findPalette, shuffleAppearance, type Appearance,
} from './themes';
import { BackgroundScene } from './BackgroundScene';
import { BACKGROUNDS } from './backgrounds';
import './appearance.css';

export function AppearanceSettings({ appearance, onAppearance, onClose, triggerRef, syncStatus }: {
  appearance: Appearance;
  syncStatus: 'loading' | 'saving' | 'saved' | 'local' | 'error';
  onAppearance: (next: Appearance) => void;
  onClose: (restoreFocus?: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [section, setSection] = useState<'themes' | 'backgrounds' | 'details'>('themes');
  const [filter, setFilter] = useState<'all' | 'dark' | 'light'>('all');
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [previous, setPrevious] = useState(readPreviousAppearance);
  const [undoLook, setUndoLook] = useState<Appearance | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (undoLook) undoButton.current?.focus(); }, [undoLook]);
  useEffect(() => { setPrevious(readPreviousAppearance()); }, [syncStatus]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === PRE_SYNC_KEY || event.key === null) setPrevious(readPreviousAppearance());
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  const clearPrevious = (restoreFocus = true) => {
    try { localStorage.removeItem(PRE_SYNC_KEY); localStorage.setItem(SYNCED_KEY, 'true'); } catch { /* optional backup */ }
    setPrevious(null);
    if (restoreFocus) ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  };
  const detailLabels = { accent: 'accent', font: 'font', textScale: 'text size', radius: 'corners', motion: 'motion', contrast: 'contrast', background: 'backdrop', backgroundIntensity: 'intensity', backgroundSpeed: 'speed' } as const;
  const previousDetails = previous ? (Object.keys(detailLabels) as (keyof typeof detailLabels)[])
    .filter((key) => previous[key] !== appearance[key]).map((key) => detailLabels[key]).join(', ') : '';
  const palette = findPalette(appearance.palette);
  const animatedBackdrop = BACKGROUNDS.some((b) => b.id === appearance.background && b.animated);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    const footer = triggerRef.current?.closest('.bt-rail-foot');
    if (!panel) return;
    const mobile = window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1180px)');
    const place = () => {
      panel.style.setProperty('--appearance-anchor', mobile.matches
        ? 'calc(12px + env(safe-area-inset-bottom, 0px))'
        : `${(footer?.getBoundingClientRect().height ?? 0) / appearance.textScale + 8}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    if (footer) observer.observe(footer);
    mobile.addEventListener('change', place);
    return () => { observer.disconnect(); mobile.removeEventListener('change', place); };
  }, [triggerRef, appearance.textScale]);
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

  const choose = (next: Appearance) => { setUndoLook(null); onAppearance(next); };
  const patch = (part: Partial<Appearance>) => choose({ ...appearance, ...part });
  const choices = PALETTES.filter((p) => filter === 'all' || p.mode === filter);
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
      <strong>{p.label}</strong>{appearance.palette === p.id && <Check className="appearance-selected" size={13} aria-hidden="true" />}
    </button>;
  };

  return createPortal(<div ref={ref} id="appearance-settings" className="appearance-settings" role="dialog" aria-labelledby="appearance-title" onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]')].filter((node) => node.getClientRects().length);
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (document.activeElement === edge) {
      event.preventDefault();
      onClose();
    }
  }}>
    <div className="appearance-head">
      <h2 id="appearance-title">Make it yours</h2>
      <button type="button" className="appearance-shuffle" onClick={() => choose(shuffleAppearance(appearance))} title="Shuffle theme (Alt+Shift+R)" aria-label="Shuffle theme"><Dices size={17} /></button>
      <button type="button" onClick={() => onClose()} aria-label="Close appearance settings"><X size={17} /></button>
    </div>

    {previous && Object.entries(previous).some(([key, value]) => appearance[key as keyof Appearance] !== value) && <div className="appearance-restore" role="note" aria-live="polite">
      <span>Saved look: {findPalette(previous.palette).label}{previousDetails ? ` · ${previousDetails}` : ''}</span>
      <button type="button" className="appearance-chip" onClick={() => {
        setUndoLook({ ...appearance });
        onAppearance(previous);
        clearPrevious(false);
      }}>Restore on all devices</button>
      <button type="button" className="appearance-chip" onClick={() => clearPrevious()} aria-label="Dismiss saved look"><X size={13} /></button>
    </div>}
    {undoLook && <div className="appearance-restore" role="status">
      <span>Restored your saved look.</span>
      <button ref={undoButton} type="button" className="appearance-chip" onClick={() => { onAppearance(undoLook); setUndoLook(null); ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); }}>Undo on all devices</button>
      <button type="button" className="appearance-chip" onClick={() => { setUndoLook(null); ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); }} aria-label="Dismiss undo"><X size={13} /></button>
    </div>}
    <div className="appearance-preview" data-background={appearance.background}>
      <BackgroundScene scene={appearance.background} intensity={appearance.backgroundIntensity} speed={appearance.backgroundSpeed} />
      <div className="appearance-preview-copy"><span>Your little universe</span><strong>{palette.label}</strong><small>{palette.blurb} · {FONTS.find((f) => f.id === appearance.font)?.label}</small></div>
      <div className="appearance-preview-chat"><span>Room for a bright idea.</span><b>Let’s make something.</b></div>
    </div>
    <div className="appearance-tabs" role="group" aria-label="Appearance sections">
      {(['themes', 'backgrounds', 'details'] as const).map((tab) => <button type="button" key={tab} aria-pressed={section === tab} onClick={() => setSection(tab)}>{tab === 'themes' ? 'Themes' : tab === 'backgrounds' ? 'Backdrops' : 'Fine tune'}</button>)}
    </div>
    <div className="appearance-content">
    {section === 'themes' && <>
      <div className="appearance-filter" role="group" aria-label="Theme brightness">
        {(['all', 'dark', 'light'] as const).map((mode) => <button type="button" className="appearance-chip" key={mode} aria-pressed={filter === mode} onClick={() => setFilter(mode)}>{mode === 'all' ? `All ${PALETTES.length}` : mode === 'dark' ? 'Night' : 'Day'}</button>)}
      </div>
      <div className="appearance-themes" aria-label="Color themes">{choices.map((p) => themeCard(p.id))}</div>
      <p className="appearance-tip">Pick a mood. Your accent and fine tuning come along.</p>
    </>}
    {section === 'backgrounds' && <>
      <div className="appearance-row appearance-motion"><span>Ambient motion</span><button type="button" className="appearance-chip" onClick={() => patch({ motion: !appearance.motion })}>{appearance.motion ? <Pause size={13} /> : <Play size={13} />}{appearance.motion ? 'Pause' : 'Resume'}</button></div>
      <label className="appearance-slider appearance-speed"><span>Animation speed <b>{appearance.backgroundSpeed}×</b></span>
        <input type="range" min="0.25" max="2" step="0.25" list="appearance-speed-stops" aria-describedby="appearance-motion-tip" value={appearance.backgroundSpeed} aria-valuetext={`${appearance.backgroundSpeed} times normal speed`} onChange={(e) => patch({ backgroundSpeed: Number(e.target.value) })} />
        <datalist id="appearance-speed-stops"><option value="0.25" /><option value="1" /><option value="2" /></datalist>
        <small><span>Dreamy</span><span>Lively</span></small>
      </label>
      <p className="appearance-tip" id="appearance-motion-tip">{reducedMotion ? 'Still for now. Your device has reduced motion on.' : !appearance.motion ? 'Paused. Your pace is ready when you resume.' : !animatedBackdrop ? 'This backdrop is still. Pick an animated one to try your pace.' : 'Your pace follows every animated backdrop.'}</p>
      {([true, false] as const).map((animated) => <fieldset key={String(animated)}><legend>{animated ? `Find your rhythm · ${BACKGROUNDS.filter((b) => b.animated).length} animated` : 'Set the scene · Still'}</legend>
        <div className="appearance-backgrounds">{BACKGROUNDS.filter((b) => b.animated === animated).map((b) => <button type="button" className="appearance-background" key={b.id} aria-pressed={appearance.background === b.id} onClick={() => patch({ background: b.id })} title={b.blurb}>
          <span className={`appearance-background-art scene-${b.id}`}><BackgroundScene scene={b.id} speed={appearance.backgroundSpeed} preview />{b.animated && <Play size={12} />}</span>
          <strong>{b.label}</strong>{appearance.background === b.id && <Check className="appearance-selected" size={13} aria-hidden="true" />}
        </button>)}</div>
      </fieldset>)}
      <label className="appearance-slider"><span>Backdrop intensity <b>{Math.round(appearance.backgroundIntensity * 100)}%</b></span><input type="range" min="0" max="100" step="5" value={Math.round(appearance.backgroundIntensity * 100)} onChange={(e) => patch({ backgroundIntensity: Number(e.target.value) / 100 })} /></label>
      <p className="appearance-tip">A little atmosphere, with clear reading surfaces.</p>
    </>}
    {section === 'details' && <>
    <fieldset><legend>Accent</legend><div className="appearance-dots">
      <button type="button" className="appearance-dot appearance-dot-theme" aria-pressed={appearance.accent === null} onClick={() => patch({ accent: null })} title="Theme accent">A</button>
      {ACCENT_PRESETS.map((hex) => <button type="button" key={hex} className="appearance-dot" style={{ background: hex }} aria-pressed={appearance.accent === hex} onClick={() => patch({ accent: hex })} title={hex} aria-label={`Accent ${hex}`} />)}
      <label className="appearance-dot appearance-dot-custom" title="Custom accent">
        <input type="color" value={appearance.accent ?? palette.colors.accent} onChange={(e) => patch({ accent: e.target.value })} aria-label="Custom accent color" />
      </label>
    </div></fieldset>

    <fieldset><legend>Font · {FONTS.length} voices for your words</legend><p className="appearance-tip">Tap a name to try it everywhere. Fonts load as you explore.</p><div className="appearance-fonts">
      {FONTS.map((f) => <button type="button" key={f.id} title={f.label} className="appearance-font" style={{ '--font-choice': f.vars?.['--r-body'] ?? "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" } as CSSProperties} aria-pressed={appearance.font === f.id} onClick={() => patch({ font: f.id })}><strong>{f.label}</strong><small>{f.blurb}</small>{appearance.font === f.id && <Check size={14} aria-hidden="true" />}</button>)}
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
      <div className="appearance-row"><span>Text contrast</span>
        <button type="button" className="appearance-chip" aria-pressed={appearance.contrast === 'strong'} onClick={() => patch({ contrast: appearance.contrast === 'strong' ? 'standard' : 'strong' })}>{appearance.contrast === 'strong' ? 'Extra crisp' : 'Standard'}</button>
      </div>
    </div>

    <button type="button" className="appearance-reset appearance-chip" onClick={() => choose(defaultAppearance())}><RotateCcw size={13} />Reset appearance</button>
    </>}
    </div>
    <div className="appearance-footer"><span role="status">{syncStatus === 'saved' ? 'Saved across this TARDIS’s devices' : syncStatus === 'loading' ? 'Checking your saved look…' : syncStatus === 'saving' ? 'Saving your look…' : syncStatus === 'error' ? 'That choice couldn’t sync. Try another look.' : 'Saved here. Will sync when connected.'}</span><small>Alt+Shift+T to cycle · Alt+Shift+R to shuffle</small></div>
  </div>, document.querySelector('.bot-app') ?? document.body);
}
