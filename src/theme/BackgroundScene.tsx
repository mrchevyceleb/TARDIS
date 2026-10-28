import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import './backgrounds.css';

export function BackgroundScene({ scene, intensity = .65, speed = 1, preview = false }: {
  scene: string; intensity?: number; speed?: number; preview?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useLayoutEffect(() => {
    // Native playback rates preserve the current frame and CSS pause state.
    // No animation loops or duration changes, even while dragging the slider.
    for (const animation of ref.current?.getAnimations({ subtree: true }) ?? []) {
      animation.updatePlaybackRate(speed);
    }
  }, [scene, speed]);
  if (scene === 'original' || scene === 'plain') return null;
  return <span ref={ref} aria-hidden="true" className={`background-scene${preview ? ' is-preview' : ''}`} data-scene={scene} data-hidden={hidden || undefined}
    style={{ '--scene-intensity': intensity } as CSSProperties}>
    <i className="scene-layer scene-one" /><i className="scene-layer scene-two" /><i className="scene-layer scene-three" />
  </span>;
}
