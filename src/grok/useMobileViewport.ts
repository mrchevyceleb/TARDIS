import { useLayoutEffect, type RefObject } from 'react';

/** Safari keeps the layout viewport tall when its software keyboard opens. */
export function useMobileViewport(ref: RefObject<HTMLDivElement | null>, textScale = 1) {
  useLayoutEffect(() => {
    const element = ref.current;
    const viewport = window.visualViewport;
    if (!element || !viewport) return;
    const touch = window.matchMedia('(pointer: coarse)');
    let frame = 0;
    const measure = () => {
      // Let browser pinch-zoom work normally; don't compete with its pan.
      if (!touch.matches || Math.abs(viewport.scale - 1) > 0.01) {
        element.style.removeProperty('--bt-viewport-height');
        element.style.removeProperty('--bt-viewport-top');
        return;
      }
      element.style.setProperty('--bt-viewport-height', `${viewport.height / textScale}px`);
      element.style.setProperty('--bt-viewport-top', `${viewport.offsetTop / textScale}px`);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // Re-measure before paint when text size changes, even with a keyboard open.
    measure();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      element.style.removeProperty('--bt-viewport-height');
      element.style.removeProperty('--bt-viewport-top');
    };
  }, [ref, textScale]);
}
