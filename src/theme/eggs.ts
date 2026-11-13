// Easter eggs — presentation only. Nothing in here sends, steers, stops, or
// touches the WebSocket; every trigger is a gesture or an idle timer, and the
// only persisted state is the sound preference under a NEW key.

import { useCallback, useEffect, useRef, useState } from 'react';

const EGG_PHRASES = ['mellon', 'allons-y', 'allons y', 'allonsy', 'geronimo', 'fantastic'];

/** A bare trigger phrase in the composer (trailing punctuation ignored). The
    message still sends or steers exactly as typed — the burst is a side effect. */
export function isEggPhrase(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.…?,;:\s]+$/u, '');
  return EGG_PHRASES.includes(t);
}

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

/** ↑↑↓↓←→←→BA anywhere outside a text field. */
export function useKonami(onFire: () => void): void {
  const pos = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        pos.current = 0;
        return;
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      pos.current = k === KONAMI[pos.current] ? pos.current + 1 : k === KONAMI[0] ? 1 : 0;
      if (pos.current === KONAMI.length) {
        pos.current = 0;
        onFire();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFire]);
}

/** True after `ms` with no pointer / key / wheel / touch / focus / visibility
    activity. Any activity clears it immediately. */
export function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), ms);
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const;
    events.forEach((ev) => window.addEventListener(ev, arm, { passive: true }));
    document.addEventListener('visibilitychange', arm);
    arm();
    return () => {
      window.clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, arm));
      document.removeEventListener('visibilitychange', arm);
    };
  }, [ms]);
  return idle;
}

/** Returns a tap handler; fires `onFire` on the third tap inside `windowMs`. */
export function useTripleTap(onFire: () => void, windowMs = 900): () => void {
  const taps = useRef<number[]>([]);
  return useCallback(() => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < windowMs), now];
    if (taps.current.length >= 3) {
      taps.current = [];
      onFire();
    }
  }, [onFire, windowMs]);
}

// ── sound ──────────────────────────────────────────────────────────────────
// A NEW key on purpose: never a rivendell:* key, and off unless explicitly on.
export const SOUND_KEY = 'tardis:sound';

const SOUND_EVENT = 'tardis:sound-change';
let pageSound: boolean | null = null;

export function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === 'on';
  } catch {
    return pageSound ?? false;
  }
}

export function writeSound(on: boolean): void {
  pageSound = on;
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode — the toggle still works for this page */
  }
  window.dispatchEvent(new Event(SOUND_EVENT));
}

/** The device's Sound switch, kept in step everywhere it appears. */
export function useSound(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readSound);
  useEffect(() => {
    const sync = () => setOn(readSound());
    window.addEventListener(SOUND_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(SOUND_EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);
  return [on, writeSound];
}

let ctx: AudioContext | null = null;

/** True once a gesture has created the AudioContext (browsers block audio
    before the first gesture). Lets non-gesture moments stay silent. */
export function soundUnlocked(): boolean {
  return ctx !== null && ctx.state === 'running';
}

/** The page's one AudioContext. Create it only from a gesture handler. */
export function audioContext(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** An original, synthesised "vworp". Two detuned saws + a triangle through a
    resonant low-pass; one slow LFO both sweeps the cutoff and drives a
    tremolo — that is the wheeze. ~2.6 s, quiet. Call from a gesture handler. */
export function vworp(): void {
  try {
    const ctx = audioContext();
    const t0 = ctx.currentTime;
    const dur = 2.6;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(0.22, t0 + 0.35);
    out.gain.setValueAtTime(0.22, t0 + dur - 1.1);
    out.gain.exponentialRampToValueAtTime(0.001, t0 + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 6;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 1.15;
    const sweep = ctx.createGain();
    sweep.gain.value = 260;
    lfo.connect(sweep).connect(lp.frequency);

    const trem = ctx.createGain();
    trem.gain.value = 0.6;
    const depth = ctx.createGain();
    depth.gain.value = 0.4;
    lfo.connect(depth).connect(trem.gain);

    const voices: Array<[OscillatorType, number, number]> = [
      ['sawtooth', 55, 0],
      ['sawtooth', 55, 9],
      ['triangle', 110, -5],
    ];
    for (const [type, hz, detune] of voices) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      o.detune.value = detune;
      o.connect(lp);
      o.start(t0);
      o.stop(t0 + dur);
    }
    lp.connect(trem).connect(out).connect(ctx.destination);
    lfo.start(t0);
    lfo.stop(t0 + dur);
  } catch {
    /* no audio available — the egg stays silent */
  }
}
