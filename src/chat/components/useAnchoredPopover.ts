import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';

/**
 * The chat header's popover, shared by the header chips (Computer, background
 * jobs). The panel floats through a portal so no header overflow can clip it.
 * It follows its trigger, is sized against what is actually visible (a phone
 * keyboard or browser bar shrinks the visual viewport) and never leaves the
 * screen. On a phone the Desk chat is an aria-modal sheet: the panel portals
 * INTO it, because assistive tech treats everything outside a modal as
 * unavailable.
 *
 * Closing: Escape (capture phase, so it closes only this popover, never the
 * sheet or dock behind it), a pointer press outside, Tab off either end (focus
 * goes back to the trigger so keyboard order continues from the header), or
 * focus leaving for somewhere else.
 *
 * `measureKey` changes whenever the trigger's size can (its label or state), so
 * the panel re-anchors. `width` is the widest the panel gets and `maxHeight` the
 * tallest; both shrink to fit the visible viewport.
 */
export function useAnchoredPopover({ measureKey = '', width: widest = 340, maxHeight: tallest = Number.POSITIVE_INFINITY }: { measureKey?: string; width?: number; maxHeight?: number } = {}) {
  const [open, setOpen] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, []);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  useLayoutEffect(() => {
    if (!open) { setAnchor(null); return undefined; }
    setPortalRoot((triggerRef.current?.closest('[aria-modal="true"]') as HTMLElement | null) ?? document.body);
    const measure = () => { const el = triggerRef.current; if (el) setAnchor(el.getBoundingClientRect()); };
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
  }, [open, measureKey]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent) => {
      const at = event.target as Node;
      if (panelRef.current?.contains(at) || triggerRef.current?.contains(at)) return;
      setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.isComposing) { event.stopPropagation(); close(true); }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open, close]);

  const ready = open && anchor !== null && portalRoot !== null;
  useEffect(() => {
    if (ready && !panelRef.current?.contains(document.activeElement)) panelRef.current?.focus({ preventScroll: true });
  }, [ready]);

  // Size against what is actually visible.
  let panelStyle: CSSProperties | undefined;
  if (anchor) {
    const vv = window.visualViewport;
    const viewLeft = vv?.offsetLeft ?? 0;
    const viewWidth = vv?.width ?? window.innerWidth;
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const width = Math.min(widest, viewWidth - 24);
    panelStyle = {
      top: anchor.bottom + 8,
      width,
      left: Math.min(Math.max(anchor.right - width, viewLeft + 12), viewLeft + viewWidth - 12 - width),
      maxHeight: Math.min(tallest, Math.max(120, viewBottom - anchor.bottom - 20)),
    };
  }

  // Tabbing off either end of the panel closes it and hands focus back to the trigger.
  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    const items = panel ? Array.from(panel.querySelectorAll<HTMLElement>('select, button, input, textarea, a[href], [tabindex]:not([tabindex="-1"])')).filter((el) => !(el as HTMLButtonElement).disabled) : [];
    const at = document.activeElement;
    if (event.shiftKey ? (at === panel || at === items[0]) : (items.length === 0 || at === items[items.length - 1])) { event.preventDefault(); close(true); }
  };
  const onPanelBlur = (event: FocusEvent<HTMLElement>) => {
    const to = event.relatedTarget as Node | null;
    if (to && !panelRef.current?.contains(to) && !triggerRef.current?.contains(to)) setOpen(false);
  };

  return { open, setOpen, toggle, close, triggerRef, panelRef, panelId, portalRoot, ready, panelStyle, onPanelKeyDown, onPanelBlur };
}
