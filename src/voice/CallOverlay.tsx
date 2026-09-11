// CallOverlay — the iPhone-call screen for talking to a companion over the
// Grok realtime voice line (grok-voice-think-fast-2.0 via /ws/voice): full
// screen, the agent's disc, name, state, duration, live waveform bars, a
// transcript ticker, mute/end circles, and a voice picker that swaps the
// Grok voice mid-call.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Mic, MicOff, PhoneOff, ChevronUp, ChevronDown } from 'lucide-react';
import { useGrokCall, GROK_VOICES, type VoiceId } from './useGrokCall';
import { agentColor, agentAvatarUrl, type Agent } from '../grok/agents';
import './call.css';

const STATE_LABEL: Record<string, string> = {
  idle: 'Ready',
  connecting: 'Calling…',
  listening: 'Listening',
  thinking: 'Thinking',
  working: 'Working',
  speaking: 'Speaking',
  ended: 'Call ended',
  error: 'Lost the line',
};

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const VOICE_GRID_ID = 'riv-call-voice-grid';

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function CallOverlay({ agent, initialVoice, onClose }: { agent: Agent; initialVoice: string; onClose: () => void }) {
  const call = useGrokCall();
  const [voice, setVoiceState] = useState<VoiceId>((GROK_VOICES.find((v) => v.id === initialVoice)?.id) ?? 'ara');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // A ref, not state: Strict Mode replays effects before state settles, and
  // two starts would mean two microphones and two lines to Grok.
  const startedRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const voiceToggleRef = useRef<HTMLButtonElement>(null);
  const callRef = useRef(call);
  callRef.current = call;

  // Closing the picker removes the focused chip; put focus back on the toggle
  // so keyboard users stay inside the dialog.
  const closeVoicePicker = useCallback(() => {
    setVoiceOpen(false);
    voiceToggleRef.current?.focus();
  }, []);

  const hangUp = useCallback(() => {
    callRef.current.end();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    call.start(agent.id, voice).catch((e: Error) => {
      // Release whatever was already opened (mic, contexts, socket), then stay
      // on screen so the reason is readable; End closes the overlay.
      callRef.current.end();
      setStartError(e.message || 'could not start the call');
      console.error('[call] failed to start:', e.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A remote hang-up closes the overlay after a beat so "Call ended" is seen.
  useEffect(() => {
    if (call.state !== 'ended') return undefined;
    const timer = window.setTimeout(onClose, 1400);
    return () => window.clearTimeout(timer);
  }, [call.state, onClose]);

  // Modal behaviour: focus lands inside on mount and goes back where it came
  // from on unmount. Keys are handled on the dialog itself (below), so only
  // events raised inside it are affected.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const onDialogKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // First Escape closes the voice picker; the next one hangs up.
      if (voiceOpen) {
        closeVoicePicker();
        return;
      }
      hangUp();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, [closeVoicePicker, hangUp, voiceOpen]);

  const bars = useMemo(() => Array.from({ length: 5 }, (_, i) => i), []);
  const voiceLabel = GROK_VOICES.find((v) => v.id === voice)?.label ?? voice;
  const transcript = [...call.turns].slice(-3);
  const error = call.error ?? startError;

  return (
    <div ref={dialogRef} tabIndex={-1} className="riv-call" role="dialog" aria-modal="true" aria-label={`Voice call with ${agent.name}`} onKeyDown={onDialogKeyDown}>
      <div className="riv-call-top">
        <span className="riv-call-chip">
          <span className={`riv-call-dot riv-call-dot-${call.state}`} />
          <span role="status" aria-live="polite">{STATE_LABEL[call.state] ?? call.state}</span>
          <span aria-hidden="true"> · {fmt(call.durationSec)}</span>
        </span>
      </div>

      <div className="riv-call-hero">
        <div className={`riv-call-disc${call.state === 'speaking' ? ' speaking' : ''}`} style={{ background: agentColor(agent.name) }}>
          {agentAvatarUrl(agent) ? <img src={agentAvatarUrl(agent) ?? undefined} alt={agent.name} /> : agent.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="riv-call-name">{agent.name}</div>
        <div className="riv-call-sub">{agent.role}</div>

        <div className="riv-call-wave" aria-hidden="true">
          {bars.map((i) => (
            <span
              key={i}
              className="riv-call-bar"
              style={{
                animationDelay: `${i * 0.09}s`,
                animationPlayState: call.state === 'speaking' || call.state === 'listening' || call.state === 'thinking' || call.state === 'working' ? 'running' : 'paused',
                opacity: call.state === 'speaking' ? 0.55 + call.level * 0.45 : 0.25 + call.micLevel * 0.75,
              }}
            />
          ))}
        </div>

        <div className="riv-call-transcript">
          {transcript.map((t, i) => (
            <div key={i} className={`riv-call-line riv-call-line-${t.role}`}>{t.text}</div>
          ))}
          {call.liveUser ? <div className="riv-call-line riv-call-line-user">{call.liveUser}</div> : null}
        </div>
      </div>

      {call.audioBlocked ? (
        <button type="button" className="riv-call-audio-unlock" onClick={call.unlockAudio}>
          Tap to enable voice audio
        </button>
      ) : null}
      {error ? <div className="riv-call-error" role="alert">{error}</div> : null}

      <div className="riv-call-voice">
        <button ref={voiceToggleRef} type="button" className="riv-call-voicebtn" onClick={() => (voiceOpen ? closeVoicePicker() : setVoiceOpen(true))} aria-expanded={voiceOpen} aria-controls={VOICE_GRID_ID}>
          Voice · {voiceLabel} {voiceOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {voiceOpen ? (
          <div id={VOICE_GRID_ID} className="riv-call-voicegrid bt-fade" role="group" aria-label="Grok voice">
            {GROK_VOICES.map((v) => (
              <button
                type="button"
                key={v.id}
                className={`riv-call-voicechip${v.id === voice ? ' on' : ''}`}
                aria-pressed={v.id === voice}
                onClick={() => { setVoiceState(v.id); call.setVoice(v.id); closeVoicePicker(); }}
              >
                {v.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="riv-call-controls">
        <button
          type="button"
          className={`riv-call-ctl${call.muted ? ' muted' : ''}`}
          onClick={call.toggleMute}
          aria-label={call.muted ? 'Unmute' : 'Mute'}
          title={call.muted ? 'Unmute' : 'Mute'}
        >
          {call.muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button type="button" className="riv-call-ctl end" onClick={hangUp} aria-label="End call" title="End call">
          <PhoneOff size={24} />
        </button>
      </div>
    </div>
  );
}
