import { useCallback, useEffect, useRef, useState } from 'react';

// Sticky-tail scroll for the chat conversation. Pins the view to the bottom
// of `scrollRef` while content grows, and gets out of the way when the user
// explicitly takes over. Also drives the reimagined "To the latest word" jump
// pill: a 56px pin threshold, a React-exposed `pinned` flag, and an unread
// counter that completed replies increment while the user is scrolled up.
//
// Why this is its own hook (and a touch elaborate):
//  - Block-array changes alone aren't enough to detect content growth. Image
//    loads, code-block layout shifts, and font reflows all change height
//    without changing the React tree. We pin on every ResizeObserver tick.
//  - Inferring user intent from scroll position alone races against our own
//    programmatic scrolls — the auto-pin write fires onScroll, which used to
//    flip the override flag if the math was off by a pixel. We track user
//    intent from input events (wheel/touchstart/keydown) instead, and only
//    *clear* the override when the user voluntarily scrolls back to the
//    bottom (within RESUME_THRESHOLD_PX).
//  - Programmatic scrolls set a short timestamp window so the onScroll
//    handler can ignore them when deciding whether to resume sticky.
//  - The Grok shell unmounts the feed while the thread is empty, then mounts
//    it after localStorage restore / WS replay. Object refs + mount-only
//    effects miss that node. Callback refs bind observer + listeners when
//    the scroller actually appears, and treat that as a new visit (pin to
//    latest unless the user then scrolls up).

// §3.6: pinned when within 56px of the feed bottom.
const RESUME_THRESHOLD_PX = 56;
const PROGRAMMATIC_GUARD_MS = 80;
const NAV_KEYS = new Set([
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ', 'Spacebar',
]);

export function useStickyScroll() {
  const scrollNodeRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const scrollTeardownRef = useRef<(() => void) | null>(null);
  const userOverrideRef = useRef(false);
  const programmaticUntilRef = useRef(0);
  // `pinned` is the React-visible mirror of `!userOverrideRef` so the jump pill
  // can render. Kept in state; recomputed on every scroll.
  const [pinned, setPinned] = useState(true);
  // Completed replies bump this while the user is scrolled up.
  const [unread, setUnread] = useState(0);
  // True while the user is mid-drag selecting text inside the transcript, or
  // is keeping a non-collapsed selection alive after release. While set, we
  // refuse to pin — a programmatic scroll under the user's cursor collapses
  // the in-progress selection, which is exactly the failure this guard prevents.
  const selectingRef = useRef(false);

  const setOverride = useCallback((next: boolean) => {
    userOverrideRef.current = next;
    setPinned(!next);
    if (!next) setUnread(0);
  }, []);

  const pin = useCallback(() => {
    if (userOverrideRef.current) return;
    if (selectingRef.current) return;
    const el = scrollNodeRef.current;
    if (!el) return;
    programmaticUntilRef.current = Date.now() + PROGRAMMATIC_GUARD_MS;
    // Scroll the known scroller only. scrollIntoView can walk ancestors and
    // fight a layout that is still settling after history replay.
    el.scrollTop = el.scrollHeight;
  }, []);

  // §3.6: sending force-follows the feed regardless of the user's scroll
  // position, and clears the override so live appends keep auto-following.
  const forcePin = useCallback(() => {
    const el = scrollNodeRef.current;
    if (!el) return;
    programmaticUntilRef.current = Date.now() + PROGRAMMATIC_GUARD_MS;
    el.scrollTop = el.scrollHeight;
    setOverride(false);
  }, [setOverride]);

  // Smooth-scroll to the very bottom and clear the unread counter (jump pill).
  const jumpToBottom = useCallback(() => {
    const el = scrollNodeRef.current;
    if (!el) return;
    programmaticUntilRef.current = Date.now() + PROGRAMMATIC_GUARD_MS;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setOverride(false);
  }, [setOverride]);

  // A completed reply calls this; it only counts while the user is scrolled up.
  const noteUnread = useCallback(() => {
    if (!userOverrideRef.current) return;
    setUnread((n) => n + 1);
  }, []);

  const observeContent = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') {
      pin();
      return;
    }
    const observer = new ResizeObserver(() => {
      pin();
      requestAnimationFrame(pin);
    });
    observer.observe(node);
    observerRef.current = observer;
    pin();
    requestAnimationFrame(pin);
  }, [pin]);

  const contentRef = useCallback((node: HTMLDivElement | null) => {
    observeContent(node);
  }, [observeContent]);

  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    if (node === scrollNodeRef.current) return;
    const prev = scrollNodeRef.current;
    scrollTeardownRef.current?.();
    scrollTeardownRef.current = null;
    scrollNodeRef.current = node;
    selectingRef.current = false;
    if (!node) return;

    // A newly mounted scroller (prev was null) is a new visit: Grok unmounts
    // the feed while empty, then mounts it after restore/replay. Same-node
    // updates must not clear a mid-thread scroll-up.
    if (prev == null) {
      const wasOverridden = userOverrideRef.current;
      userOverrideRef.current = false;
      if (wasOverridden) {
        setPinned(true);
        setUnread(0);
      }
    }

    const isAtBottom = () =>
      node.scrollHeight - node.scrollTop - node.clientHeight <= RESUME_THRESHOLD_PX;
    const takeover = () => {
      if (isAtBottom()) return;
      setOverride(true);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) { setOverride(true); return; }
      takeover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!NAV_KEYS.has(e.key)) return;
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') {
        setOverride(true);
        return;
      }
      takeover();
    };

    const hasLiveSelection = () => {
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (!sel || sel.isCollapsed) return false;
      const anchor = sel.anchorNode;
      const focus = sel.focusNode;
      return Boolean((anchor && node.contains(anchor)) || (focus && node.contains(focus)));
    };
    const settle = () => { selectingRef.current = hasLiveSelection(); };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType !== 'touch') return;
      selectingRef.current = true;
    };

    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('touchstart', takeover, { passive: true });
    node.addEventListener('keydown', onKey);
    node.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerup', settle);
    document.addEventListener('pointercancel', settle);
    document.addEventListener('selectionchange', settle);
    window.addEventListener('blur', settle);
    document.addEventListener('visibilitychange', settle);

    // Keyboard/browser chrome and composer growth resize the viewport without
    // changing the transcript. Keep its bottom anchored only while following.
    const viewportObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(pin);
    viewportObserver?.observe(node);

    scrollTeardownRef.current = () => {
      viewportObserver?.disconnect();
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchstart', takeover);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', settle);
      document.removeEventListener('pointercancel', settle);
      document.removeEventListener('selectionchange', settle);
      window.removeEventListener('blur', settle);
      document.removeEventListener('visibilitychange', settle);
    };

    pin();
    requestAnimationFrame(pin);
  }, [pin, setOverride]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    scrollTeardownRef.current?.();
    scrollTeardownRef.current = null;
  }, []);

  // Resume sticky when the user lands at the very bottom on their own, and
  // mark takeover when the view leaves the bottom.
  const onScroll = useCallback(() => {
    const el = scrollNodeRef.current;
    if (!el) return;
    if (Date.now() < programmaticUntilRef.current) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setOverride(distanceFromBottom > RESUME_THRESHOLD_PX);
  }, [setOverride]);

  return {
    scrollRef, bottomRef, contentRef, onScroll, pin, forcePin,
    pinned, unread, noteUnread, jumpToBottom,
  };
}
