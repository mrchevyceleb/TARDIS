// useGrokCall — a live xAI realtime voice call with a TARDIS agent.
// Mic (16 kHz worklet) → /ws/voice → Grok; Grok's 24 kHz PCM deltas → the
// playback queue. iPhone-call semantics: barge-in, server VAD, mid-call
// voice swap, duration clock, transcript.

import { useCallback, useEffect, useRef, useState } from 'react';
import { CallPlayback, base64ToInt16Array, createMicProcessorUrl, int16ArrayToBase64 } from './audio';

export type CallState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'working' | 'speaking' | 'ended' | 'error';
export const GROK_VOICES = [
  { id: 'ara', label: 'Ara' },
  { id: 'eve', label: 'Eve' },
  { id: 'leo', label: 'Leo' },
  { id: 'rex', label: 'Rex' },
  { id: 'sal', label: 'Sal' },
  { id: 'altair', label: 'Altair' },
  { id: 'atlas', label: 'Atlas' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'carina', label: 'Carina' },
  { id: 'castor', label: 'Castor' },
  { id: 'celeste', label: 'Celeste' },
  { id: 'cosmo', label: 'Cosmo' },
  { id: 'helios', label: 'Helios' },
  { id: 'helix', label: 'Helix' },
  { id: 'iris', label: 'Iris' },
  { id: 'kepler', label: 'Kepler' },
  { id: 'liora', label: 'Liora' },
  { id: 'lumen', label: 'Lumen' },
  { id: 'luna', label: 'Luna' },
  { id: 'lux', label: 'Lux' },
  { id: 'naksh', label: 'Naksh' },
  { id: 'orion', label: 'Orion' },
  { id: 'perseus', label: 'Perseus' },
  { id: 'rigel', label: 'Rigel' },
  { id: 'sirius', label: 'Sirius' },
  { id: 'ursa', label: 'Ursa' },
  { id: 'zagan', label: 'Zagan' },
  { id: 'zenith', label: 'Zenith' },
] as const;
export type VoiceId = (typeof GROK_VOICES)[number]['id'];

export type CallTurn = { role: 'user' | 'assistant'; text: string };

export function useGrokCall() {
  const [state, setState] = useState<CallState>('idle');
  const [turns, setTurns] = useState<CallTurn[]>([]);
  const [liveUser, setLiveUser] = useState('');
  const [durationSec, setDurationSec] = useState(0);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const playbackRef = useRef<CallPlayback | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const mutedRef = useRef(false);
  const voiceRef = useRef('ara');
  const levelRaf = useRef(0);
  const clockRef = useRef<number | null>(null);
  // Cancellation token: bumped on teardown so late async steps (WS open,
  // mic grant, resume) can never resurrect resources after a quick hangup.
  const genRef = useRef(0);

  const teardown = useCallback(() => {
    if (clockRef.current) { window.clearInterval(clockRef.current); clockRef.current = null; }
    cancelAnimationFrame(levelRaf.current);
    try { workletRef.current?.disconnect(); } catch { /* gone */ }
    workletRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    void playbackRef.current?.close();
    playbackRef.current = null;
    try { wsRef.current?.close(); } catch { /* gone */ }
    wsRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async (agentId: string, voice: string) => {
    genRef.current += 1;
    const gen = genRef.current;
    const alive = () => gen === genRef.current;
    setError(null);
    setTurns([]);
    setLiveUser('');
    setDurationSec(0);
    setState('connecting');

    // mic + 16 kHz capture context
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      setError('microphone unavailable');
      setState('error');
      return;
    }
    if (!alive()) { stream.getTracks().forEach((t) => t.stop()); return; }
    streamRef.current = stream;
    const ctx = new AudioContext({ sampleRate: 16000 });
    ctxRef.current = ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    if (!alive()) { void ctx.close(); stream.getTracks().forEach((t) => t.stop()); return; }
    const processorUrl = createMicProcessorUrl();
    await ctx.audioWorklet.addModule(processorUrl);
    URL.revokeObjectURL(processorUrl);
    if (!alive()) { void ctx.close(); stream.getTracks().forEach((t) => t.stop()); return; }

    const playback = new CallPlayback();
    playbackRef.current = playback;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/voice`);
    wsRef.current = ws;

    voiceRef.current = voice;
    ws.onopen = () => { if (alive()) ws.send(JSON.stringify({ type: 'start', agentId, voice: voiceRef.current })); };
    ws.onmessage = (ev) => {
      if (!alive()) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === 'state') {
        const s = String(msg.state);
        if (s === 'thinking' || s === 'working' || s === 'listening' || s === 'speaking' || s === 'connecting' || s === 'ended' || s === 'error') {
          setState(s);
        }
        if (s === 'listening') playback.armComplete();
        return;
      }
      if (msg.type === 'audio') {
        void playback.play(base64ToInt16Array(String(msg.b64 ?? '')));
        return;
      }
      if (msg.type === 'transcript') {
        const role = msg.role === 'user' ? 'user' : 'assistant';
        const text = String(msg.text ?? '');
        if (!text.trim()) return;
        if (role === 'user') { setLiveUser(text); return; }
        setLiveUser('');
        setTurns((prev) => [...prev, { role, text }]);
        return;
      }
      if (msg.type === 'error') {
        setError(String(msg.message ?? 'call error'));
        setState('error');
        return;
      }
      if (msg.type === 'interrupt') {
        playbackRef.current?.clear(); // barge-in: drop queued TTS immediately
        return;
      }
      if (msg.type === 'ended') {
        setState('ended');
        teardown(); // remote hang-up: release mic/timers right away
        return;
      }
    };
    ws.onclose = () => {
      if (!alive()) return;
      setState((s) => (s === 'ended' || s === 'error' ? s : 'ended'));
      teardown();
    };
    ws.onerror = () => {
      if (!alive()) return;
      setError('connection failed');
      setState('error');
      teardown();
    };

    // mic worklet → ws (muted gates at the source)
    const worklet = new AudioWorkletNode(ctx, 'riv-call-mic');
    workletRef.current = worklet;
    worklet.port.onmessage = ({ data }) => {
      // The meter never moves while muted — a bouncing wave during mute reads
      // as "still transmitting".
      if (typeof data?.level === 'number' && !mutedRef.current) setMicLevel(data.level);
      if (data?.pcmData && wsRef.current?.readyState === WebSocket.OPEN && !mutedRef.current) {
        wsRef.current.send(JSON.stringify({ type: 'audio', b64: int16ArrayToBase64(new Int16Array(data.pcmData)) }));
      }
    };
    ctx.createMediaStreamSource(stream).connect(worklet);
    // An AudioWorkletNode with no output is NOT guaranteed to have process()
    // called — some platforms never pull the graph (the Windows dead-mic
    // bug). Route through a zero-gain sink to the destination so the node is
    // always driven, with no audible feedback.
    const micSink = ctx.createGain();
    micSink.gain.value = 0;
    worklet.connect(micSink);
    micSink.connect(ctx.destination);

    if (!alive()) return;
    // duration clock + waveform level
    clockRef.current = window.setInterval(() => setDurationSec((d) => d + 1), 1000);
    const tick = () => {
      if (!alive()) return;
      setLevel(playbackRef.current?.level() ?? 0);
      setAudioBlocked(playbackRef.current?.blocked ?? false);
      levelRaf.current = requestAnimationFrame(tick);
    };
    levelRaf.current = requestAnimationFrame(tick);

    setState('connecting');
  }, []);

  const end = useCallback(() => {
    // Invalidate the generation first so the socket's own close event cannot
    // flip the state to "ended" after a local hang-up or a failed start.
    genRef.current += 1;
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'stop' }));
    teardown();
    setState('idle');
  }, [teardown]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      mutedRef.current = !m;
      if (!m) setMicLevel(0); // muting: meter flatlines, never hints at live audio
      return !m;
    });
  }, []);

  const setVoice = useCallback((voice: string) => {
    voiceRef.current = voice;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'setVoice', voice }));
  }, []);

  /** Retry audio after a user gesture: autoplay policy can leave the output
   *  context suspended when the call started outside the click itself. */
  const unlockAudio = useCallback(() => {
    void playbackRef.current?.unlock().then((ok) => setAudioBlocked(!ok));
    if (ctxRef.current?.state === 'suspended') void ctxRef.current.resume().catch(() => {});
  }, []);

  return { state, turns, liveUser, durationSec, muted, level, micLevel, error, audioBlocked, start, end, toggleMute, setVoice, unlockAudio };
}
