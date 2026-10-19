import { useEffect, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';

/**
 * One-tap copy for pin text (card-be68d0, Matt, Oct 19 2026: every pin
 * readable in full and easy to copy, on desktop and iPad).
 *
 * Uses the app's standard clipboard path (navigator.clipboard.writeText,
 * same as everywhere else; no fallback shims). Both outcomes are answered:
 * a check icon plus an aria-live "Copied", or a clear failed state
 * ("Copy unavailable") instead of a silently dead tap. The button's
 * accessible name stays stable; the sibling status region carries the
 * announcement, so screen readers hear the result.
 */
export function CopyButton({ text, className = '', size = 12, title = 'Copy' }: {
  text: string;
  className?: string;
  size?: number;
  title?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const announce = (next: 'copied' | 'failed') => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), next === 'copied' ? 1400 : 2400);
  };
  return (
    <>
      <button
        type="button"
        className={`bt-iconbtn ${className}`}
        title={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy unavailable' : title}
        aria-label={title}
        onClick={() => {
          if (!navigator.clipboard?.writeText) { announce('failed'); return; }
          void navigator.clipboard.writeText(text).then(
            () => announce('copied'),
            () => announce('failed')
          );
        }}
      >
        {state === 'copied' ? <Check size={size} /> : state === 'failed' ? <X size={size} /> : <Copy size={size} />}
      </button>
      <span role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' }}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy unavailable' : ''}
      </span>
    </>
  );
}
