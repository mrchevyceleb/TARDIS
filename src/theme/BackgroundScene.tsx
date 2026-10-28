import { useEffect, useState, type CSSProperties } from 'react';
import './backgrounds.css';

export function BackgroundScene({ scene, intensity = .65, preview = false }: {
  scene: string; intensity?: number; preview?: boolean;
}) {
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  if (scene === 'original' || scene === 'plain') return null;
  return <span aria-hidden="true" className={`background-scene${preview ? ' is-preview' : ''}`} data-scene={scene} data-hidden={hidden || undefined}
    style={{ '--scene-intensity': intensity } as CSSProperties}>
    <i className="scene-layer scene-one" /><i className="scene-layer scene-two" /><i className="scene-layer scene-three" />
  </span>;
}
