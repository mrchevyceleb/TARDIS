import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Monitor, Square } from 'lucide-react';
import { fetchComputers, previewComputer, resumeComputer, selectComputer, stopComputer, type ComputerPreview, type DefaultComputer, type LinkedComputer } from '../../data/api';
import { nativeShell } from '../../native/shell';
import './computer-control.css';

/** "9:05am ET", or "Sep 28, 11:05pm ET" when it was not today (Eastern, always labeled). */
function easternTime(ms: number): string {
  const opts = { timeZone: 'America/New_York' } as const;
  const clock = new Date(ms).toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)$/i, (_m, p: string) => p.toLowerCase());
  const day = (t: number) => new Date(t).toLocaleDateString('en-US', opts);
  return day(ms) === day(Date.now())
    ? `${clock} ET`
    : `${new Date(ms).toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric' })}, ${clock} ET`;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : 'Computer unavailable.';
  try { return JSON.parse(text).error ?? text; } catch { return text; }
}
type ChipState = 'loading' | 'error' | 'none' | 'offline' | 'paused' | 'in-use' | 'automatic' | 'ask' | 'unsupported';

/** The short word next to the name. `ask` and `unsupported` stay quiet (a dot only), as the old strip did. */
const STATE_LABEL: Partial<Record<ChipState, string>> = { offline: 'Offline', paused: 'Paused', 'in-use': 'In use', automatic: 'Automatic' };
/** The plain-words state for the tooltip and the screen-reader name. */
const STATE_HINT: Record<ChipState, string> = {
  loading: 'checking', error: 'unavailable', none: 'no device set', offline: 'offline', paused: 'paused', 'in-use': 'in use',
  automatic: 'automatic', ask: 'asks for approval', unsupported: 'not supported',
};

/**
 * The Computer chip: lives in the chat header (never above the composer, where
 * a stray click or thumb lands while someone is typing). Click opens the picker
 * popover; `compact` collapses it to an icon plus a state dot, with the device
 * name in the tooltip and accessible name.
 */
export function ComputerControl({ chatId, compact = false }: { chatId: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const [devices, setDevices] = useState<LinkedComputer[]>([]);
  const [defaultDevice, setDefault] = useState<DefaultComputer | null>(null);
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ComputerPreview | null>(null);
  const revision = useRef(0);
  const previewRequest = useRef(0);
  const target = selected || defaultDevice?.id || '';
  const device = devices.find(d => d.id === target);
  const control = device?.computer?.control;
  const paused = device?.computer?.paused;
  const automatic = Boolean(device?.computer?.supported && device.computer.approvalMode === 'automatic');
  const localId = nativeShell()?.deviceId;
  const previewOwner = useRef('');
  previewOwner.current = `${target}:${control?.owner ?? ''}:${control?.expiresAt ?? ''}`;
  const applyState = (data: Awaited<ReturnType<typeof fetchComputers>>) => {
    setDevices(data.devices); setSelected(data.target || ''); setDefault(data.defaultDevice ?? null); setLoaded(true); setFailed(false);
  };

  useEffect(() => {
    const ac = new AbortController();
    revision.current++;
    setSelected(''); setDefault(null); setDevices([]); setPreview(null); setError(''); setLoaded(false); setFailed(false);
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      const rev = revision.current;
      try {
        const data = await fetchComputers(chatId, ac.signal);
        if (!ac.signal.aborted && revision.current === rev) applyState(data);
      } catch (e) { if (!ac.signal.aborted) { setError(errorText(e)); setFailed(true); } }
      finally { fetching = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { ac.abort(); clearInterval(timer); revision.current++; previewRequest.current++; };
  }, [chatId]);
  useEffect(() => { setPreview(null); previewRequest.current++; }, [target, control?.owner, control?.expiresAt]);

  const controlAction = async (resume: boolean) => {
    if (!target) return;
    const rev = ++revision.current;
    previewRequest.current++;
    setPending(true); setError(''); setPreview(null);
    try {
      await (resume ? resumeComputer(target) : stopComputer(target));
      const data = await fetchComputers(chatId);
      if (revision.current === rev) applyState(data);
    } catch (e) { if (revision.current === rev) setError(errorText(e)); }
    finally { if (revision.current === rev) { revision.current++; setPending(false); } }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (control && (event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey && event.key === 'Escape') {
        event.preventDefault(); void controlAction(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const state: ChipState = !loaded ? (failed ? 'error' : 'loading')
    : !target ? 'none'
    : !device ? 'offline'
    : paused ? 'paused'
    : control ? 'in-use'
    : automatic ? 'automatic'
    : device.computer?.supported ? 'ask'
    : 'unsupported';
  const name = state === 'loading' || state === 'error' ? 'Computer'
    : state === 'none' ? 'No device'
    : device ? (device.id === localId ? `This computer (${device.name})` : device.name)
    : selected ? 'Selected computer' : (defaultDevice?.name ?? 'Computer');
  const stateLabel = STATE_LABEL[state];
  const accessibleName = state === 'loading' || state === 'error' ? `Computer, ${STATE_HINT[state]}` : `Computer: ${name}, ${STATE_HINT[state]}`;
  const message = paused ? `${device?.computer?.pausedAt ? `Paused at ${easternTime(device.computer.pausedAt)}. ` : 'Paused. '}${device?.computer?.pausedReason ?? 'The pause time and source are unavailable.'} Resume when you want agents to use this computer again.`
    : control ? `${control.label} is controlling this desktop until ${new Date(control.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
    : state === 'error' ? 'Computers could not be loaded. Trying again every few seconds.'
    : state === 'loading' ? 'Checking computers.'
    : state === 'none' ? 'No default computer is configured. Pick one above and agents in this chat will use it.'
    : device?.computer?.reason || (automatic ? 'Agents can operate this desktop for assigned work without approval popups.' : device?.computer?.supported ? 'This computer is configured to ask for native approval.' : device ? 'This client does not support desktop control. Update the desktop app.' : 'The selected/default computer is offline. No other machine will be used automatically.');

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => chipRef.current?.focus({ preventScroll: true }));
  };

  // The popover floats through a portal so no header overflow can clip it. It
  // follows the chip and never leaves the visible viewport. On a phone the Desk
  // chat is an aria-modal sheet: the popover portals INTO it, because assistive
  // tech treats everything outside a modal as unavailable.
  useLayoutEffect(() => {
    if (!open) { setAnchor(null); return; }
    setPortalRoot((chipRef.current?.closest('[aria-modal="true"]') as HTMLElement | null) ?? document.body);
    const measure = () => { const el = chipRef.current; if (el) setAnchor(el.getBoundingClientRect()); };
    measure();
    const vv = window.visualViewport;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
    };
  }, [open, state, name]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const at = event.target as Node;
      if (panelRef.current?.contains(at) || chipRef.current?.contains(at)) return;
      setOpen(false);
    };
    // Capture phase: Escape closes only this popover, never the sheet or dock behind it.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.isComposing) { event.stopPropagation(); close(true); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  useEffect(() => { if (open && anchor && !panelRef.current?.contains(document.activeElement)) panelRef.current?.focus({ preventScroll: true }); }, [open, Boolean(anchor)]);

  // Size against what is actually visible (a phone keyboard or browser bar shrinks it).
  const vv = window.visualViewport;
  const viewLeft = vv?.offsetLeft ?? 0;
  const viewWidth = vv?.width ?? window.innerWidth;
  const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const width = Math.min(340, viewWidth - 24);
  const panelStyle: CSSProperties | undefined = anchor ? {
    top: anchor.bottom + 8,
    width,
    left: Math.min(Math.max(anchor.right - width, viewLeft + 12), viewLeft + viewWidth - 12 - width),
    maxHeight: Math.max(120, viewBottom - anchor.bottom - 20),
  } : undefined;

  return <>
    <button
      ref={chipRef}
      type="button"
      className={`computer-chip${compact ? ' is-compact' : ''}${open ? ' is-open' : ''}`}
      data-state={state}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={accessibleName}
      title={accessibleName}
      onClick={() => (open ? close(false) : setOpen(true))}
    >
      <Monitor size={compact ? 16 : 14} aria-hidden="true" />
      {!compact && <span className="computer-chip-name">{name}</span>}
      <i className="computer-chip-dot" aria-hidden="true" />
      {!compact && stateLabel && <strong className="computer-chip-state">{stateLabel}</strong>}
    </button>
    {open && anchor && portalRoot && createPortal(
      <div
        ref={panelRef}
        id={panelId}
        className="computer-pop"
        role="dialog"
        aria-label="Computer"
        tabIndex={-1}
        style={panelStyle}
        onKeyDown={event => {
          // Tabbing off either end of the popover closes it and hands focus back to the chip,
          // so keyboard order continues from the header instead of jumping to wherever the portal sits.
          if (event.key !== 'Tab') return;
          const panel = panelRef.current;
          const items = panel ? Array.from(panel.querySelectorAll<HTMLElement>('select, button, input, textarea, a[href], [tabindex]:not([tabindex="-1"])')).filter(el => !(el as HTMLButtonElement).disabled) : [];
          const at = document.activeElement;
          if (event.shiftKey ? (at === panel || at === items[0]) : (items.length === 0 || at === items[items.length - 1])) { event.preventDefault(); close(true); }
        }}
        onBlur={event => { const to = event.relatedTarget as Node | null; if (to && !panelRef.current?.contains(to) && !chipRef.current?.contains(to)) setOpen(false); }}
      >
        <div className="computer-pop-head" data-state={state}>
          <Monitor size={14} aria-hidden="true" />
          <span>Computer · {name}</span>
          <i className="computer-chip-dot" aria-hidden="true" />
          {stateLabel && <strong>{stateLabel}</strong>}
        </div>
      <label>Target computer
        <select aria-label="Target computer" value={selected} disabled={pending} onChange={async event => {
          const next = event.target.value;
          const rev = ++revision.current;
          previewRequest.current++;
          setPending(true); setError('');
          try { await selectComputer(chatId, next); if (rev === revision.current) { setSelected(next); setPreview(null); } }
          catch (e) { if (rev === revision.current) setError(errorText(e)); }
          finally { if (rev === revision.current) { revision.current++; setPending(false); } }
        }}>
          <option value="">{defaultDevice ? `Default · ${defaultDevice.name}` : 'No default configured'}</option>
          {selected && !device && <option value={selected}>Selected computer is offline</option>}
          {devices.map(d => <option key={d.id} value={d.id} disabled={!d.computer?.supported}>{d.id === localId ? `This computer · ${d.name}` : d.name}{!d.computer?.supported ? ' · unavailable' : ''}</option>)}
        </select>
      </label>
        <p>{message}</p>
      {paused && <button type="button" disabled={pending} onClick={() => void controlAction(true)}>Resume control</button>}
      {automatic && !paused && !control && <button type="button" className="computer-stop" disabled={pending} onClick={() => void controlAction(false)}><Square size={12} aria-hidden="true" /> Pause control</button>}
      {control && <div className="computer-control-actions">
        <button type="button" className="computer-stop" disabled={pending} onClick={() => void controlAction(false)}><Square size={12} aria-hidden="true" /> Stop control</button>
        <button type="button" disabled={pending} onClick={async () => {
          const request = ++previewRequest.current;
          const owner = previewOwner.current;
          setError('');
          try { const next = await previewComputer(target); if (previewRequest.current === request && previewOwner.current === owner) setPreview(next); }
          catch (e) { if (previewRequest.current === request) setError(errorText(e)); }
        }}>{preview ? 'Refresh preview' : 'Show last screenshot'}</button>
      </div>}
      {error && <p role="alert" className="computer-control-error">{error}</p>}
      {preview && control && <figure><img src={`data:image/jpeg;base64,${preview.image}`} alt={`Last agent screenshot of ${device?.name ?? 'computer'}`} /><figcaption>Last captured {new Date(preview.capturedAt).toLocaleTimeString()} · not a live feed <button type="button" onClick={() => { previewRequest.current++; setPreview(null); }}>Hide</button></figcaption></figure>}
      </div>,
      portalRoot,
    )}
  </>;
}
