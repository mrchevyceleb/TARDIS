// Each room's little noises, synthesised on the spot (no audio files): arrive
// when you step in, send when a message leaves, done when a teammate finishes.
// The per-device Sound switch rules every cue, and nothing plays before a gesture.

import { useEffect, useRef } from 'react';
import { audioContext, readSound, soundUnlocked } from './eggs';
import type { SoundKit } from './roomParts';

export type RoomCue = 'arrive' | 'send' | 'done';

type Tone = { at: number; hz: number; to?: number; dur: number; vol: number; type?: OscillatorType; lp?: number };
type Hiss = { at: number; noise: true; dur: number; vol: number; band: number; q?: number };
type Voice = Tone | Hiss;

const tick = (at: number, vol = .07, band = 5200): Hiss => ({ at, noise: true, dur: .018, vol, band, q: 1.4 });
const run = (notes: number[], step: number, type: OscillatorType, dur: number, vol: number): Tone[] =>
  notes.map((hz, i) => ({ at: i * step, hz, dur, vol, type, lp: 3200 }));

const KITS: Record<SoundKit, Record<RoomCue, Voice[]>> = {
  console: {
    arrive: [{ at: 0, hz: 392, to: 523, dur: .5, vol: .11 }, { at: .12, hz: 784, dur: .6, vol: .05, type: 'triangle' }],
    send: [{ at: 0, hz: 880, to: 1040, dur: .09, vol: .06 }],
    done: [{ at: 0, hz: 659, dur: .35, vol: .07 }, { at: .11, hz: 988, dur: .5, vol: .06 }],
  },
  bridge: {
    arrive: [{ at: 0, hz: 1180, to: 1100, dur: 1.1, vol: .12 }, { at: .32, hz: 1180, to: 1100, dur: .8, vol: .045 }, { at: .62, hz: 1180, dur: .5, vol: .018 }],
    send: [{ at: 0, hz: 1400, dur: .05, vol: .03, type: 'square', lp: 2600 }, { at: .08, hz: 1900, dur: .05, vol: .03, type: 'square', lp: 3200 }],
    done: run([660, 880, 1320], .09, 'triangle', .16, .06),
  },
  paper: {
    arrive: [{ at: 0, noise: true, dur: .18, vol: .09, band: 3200, q: .8 }, { at: .12, noise: true, dur: .22, vol: .07, band: 2400, q: .7 }, { at: .3, noise: true, dur: .12, vol: .05, band: 4200 }],
    send: [{ at: 0, hz: 120, to: 60, dur: .14, vol: .22 }, { at: 0, noise: true, dur: .05, vol: .08, band: 1800, q: .6 }],
    done: [tick(0, .08, 5200), tick(.09, .06, 5800)],
  },
  arcade: {
    arrive: [{ at: 0, hz: 988, dur: .08, vol: .045, type: 'square', lp: 4000 }, { at: .08, hz: 1319, dur: .32, vol: .045, type: 'square', lp: 4000 }],
    send: [{ at: 0, hz: 440, to: 880, dur: .08, vol: .04, type: 'square', lp: 3000 }],
    done: run([523, 659, 784, 1047], .06, 'square', .09, .035),
  },
  cabin: {
    arrive: [
      { at: 0, hz: 190, to: 120, dur: .12, vol: .2 }, { at: 0, noise: true, dur: .04, vol: .06, band: 900 },
      { at: .22, hz: 190, to: 120, dur: .12, vol: .17 }, { at: .22, noise: true, dur: .04, vol: .05, band: 900 },
      tick(.5, .05, 3000), tick(.63, .04, 2600), tick(.71, .035, 3400),
    ],
    send: [{ at: 0, hz: 320, to: 240, dur: .08, vol: .1, type: 'triangle' }],
    done: [{ at: 0, hz: 392, dur: 1.1, vol: .065 }, { at: 0, hz: 588, dur: .9, vol: .035 }],
  },
  neon: {
    arrive: [{ at: 0, hz: 110, to: 220, dur: .7, vol: .06, type: 'sawtooth', lp: 900 }, { at: .05, hz: 165, to: 330, dur: .7, vol: .04, type: 'sawtooth', lp: 1200 }],
    send: [{ at: 0, hz: 1200, to: 300, dur: .08, vol: .035, type: 'sawtooth', lp: 2500 }],
    done: [{ at: 0, hz: 1047, dur: .6, vol: .055 }, { at: 0, hz: 1568, dur: .4, vol: .03 }],
  },
  terminal: {
    arrive: [{ at: 0, hz: 1000, dur: .12, vol: .03, type: 'square', lp: 3000 }, tick(.2), tick(.27), tick(.33), tick(.42)],
    send: [tick(0, .08, 5000)],
    done: [{ at: 0, hz: 800, dur: .07, vol: .028, type: 'square', lp: 3000 }, { at: .1, hz: 1200, dur: .09, vol: .028, type: 'square', lp: 3000 }],
  },
  garden: {
    arrive: [{ at: 0, hz: 1318, dur: 1.2, vol: .04 }, { at: .14, hz: 1760, dur: 1.1, vol: .033 }, { at: .3, hz: 2093, dur: 1, vol: .028 }, { at: .5, hz: 1568, dur: 1, vol: .028 }],
    send: [{ at: 0, hz: 1500, to: 700, dur: .1, vol: .07 }],
    done: [{ at: 0, hz: 2600, to: 3400, dur: .07, vol: .035 }, { at: .1, hz: 2800, to: 3600, dur: .07, vol: .03 }],
  },
};

let noiseBuffer: AudioBuffer | null = null;
function noise(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer?.sampleRate === ctx.sampleRate) return noiseBuffer;
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

function play(ctx: AudioContext, out: AudioNode, t0: number, v: Voice): void {
  const start = t0 + v.at;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(v.vol, start + Math.min(.012, v.dur / 3));
  env.gain.exponentialRampToValueAtTime(0.0001, start + v.dur);
  env.connect(out);
  if ('noise' in v) {
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = v.band;
    band.Q.value = v.q ?? 1;
    src.connect(band).connect(env);
    src.start(start, Math.random() * .5);
    src.stop(start + v.dur + .02);
    return;
  }
  const osc = ctx.createOscillator();
  osc.type = v.type ?? 'sine';
  osc.frequency.setValueAtTime(v.hz, start);
  if (v.to) osc.frequency.exponentialRampToValueAtTime(v.to, start + v.dur);
  if (v.lp) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = v.lp;
    osc.connect(lp).connect(env);
  } else osc.connect(env);
  osc.start(start);
  osc.stop(start + v.dur + .02);
}

/** Play one cue from a kit. `fromGesture` cues may wake the audio context;
 *  ambient cues (a teammate finishing) stay silent until a gesture has. */
export function playRoomCue(kit: SoundKit, cue: RoomCue, fromGesture = true): void {
  if (!readSound() || (!fromGesture && !soundUnlocked())) return;
  try {
    const ctx = audioContext();
    for (const v of KITS[kit][cue]) play(ctx, ctx.destination, ctx.currentTime + .01, v);
  } catch { /* no audio available: rooms stay silent */ }
}

/** A cue from whichever room is on screen (paintAppearance marks <html>). */
export function playScreenCue(cue: RoomCue): void {
  const kit = document.documentElement.dataset.sounds;
  playRoomCue(kit && Object.hasOwn(KITS, kit) ? kit as SoundKit : 'console', cue);
}

/** A soft "done" from the room's kit when a teammate finishes a turn. */
export function useRoomChimes(busy: ReadonlySet<string>, kit: SoundKit): void {
  const previous = useRef<ReadonlySet<string>>(busy);
  const last = useRef(0);
  useEffect(() => {
    const finished = [...previous.current].some((id) => !busy.has(id));
    previous.current = busy;
    if (!finished || Date.now() - last.current < 2500) return;
    last.current = Date.now();
    playRoomCue(kit, 'done', false);
  }, [busy, kit]);
}
