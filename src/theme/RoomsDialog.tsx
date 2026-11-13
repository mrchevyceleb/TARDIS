// Rooms: step somewhere new. A sheet beside the app (a bottom sheet on a
// phone) with the room you are in, Surprise me, Describe a room, the try-on
// (Keep, Tweak, Throw away), every room as a little model, and the routine.
// RoomBanner carries a build or a try-on once the sheet is closed.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Dices, DoorOpen, Pin, SlidersHorizontal, Sparkles, Undo2, X } from 'lucide-react';
import { BACKGROUNDS } from './backgrounds';
import { useSound } from './eggs';
import { DISPLAY_FACES, LAYOUTS, SOUND_KITS, SURFACES, TEAM_VIEWS } from './roomParts';
import { flipLight, lookOf, recolor, type RoomLook, type RoomSpec } from './rooms';
import { playRoomCue } from './roomSounds';
import { RoomCard, RoomMini, roomFace, tapPoint } from './RoomCard';
import { effectiveDef, type Appearance } from './themes';
import type { RoomStage } from './useRooms';
import './rooms.css';

const IDEAS = ['70s ski lodge', 'rainy Tokyo alley', 'lighthouse in a storm', 'grandma’s kitchen', 'submarine at dawn', 'jazz club at 2am', 'desert observatory', 'candy shop', 'castle library', 'beach shack'];
const STEPS = ['Measuring the walls…', 'Mixing the paint…', 'Choosing a typeface…', 'Hanging the backdrop…', 'Seating the team…', 'Tuning the sounds…'];
const CORNERS = [0, .35, .75, 1, 1.45];

const next = <T,>(list: readonly T[], value: T): T => list[(list.indexOf(value) + 1) % list.length];
const named = (list: readonly { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? id;
const cycle = <K extends keyof RoomLook>(key: K, list: readonly { id: string; label: string }[]) => ({
  value: (look: RoomLook) => named(list, String(look[key])),
  change: (look: RoomLook) => ({ [key]: next(list.map((x) => x.id), String(look[key])) }) as Partial<RoomLook>,
});

/** Every slot can be turned like a dial. Each part is a tested one, so any
 *  combination still reads and fits every screen. */
const TWEAKS: { id: string; name: string; value: (look: RoomLook) => string; change: (look: RoomLook) => Partial<RoomLook> }[] = [
  { id: 'colors', name: 'Colors', value: () => 'Shuffle', change: recolor },
  { id: 'light', name: 'Light', value: (look) => (effectiveDef(look).mode === 'dark' ? 'Night' : 'Day'), change: flipLight },
  { id: 'layout', name: 'Layout', ...cycle('layout', LAYOUTS) },
  { id: 'team', name: 'Team', ...cycle('team', TEAM_VIEWS) },
  { id: 'type', name: 'Type', ...cycle('display', DISPLAY_FACES) },
  { id: 'surface', name: 'Surface', ...cycle('surface', SURFACES) },
  { id: 'backdrop', name: 'Backdrop', ...cycle('background', BACKGROUNDS) },
  {
    id: 'corners', name: 'Corners',
    value: (look) => (look.radius === 0 ? 'Sharp' : look.radius < .6 ? 'Crisp' : look.radius <= 1 ? 'Soft' : 'Round'),
    change: (look) => ({ radius: CORNERS[(CORNERS.findIndex((c) => c >= look.radius - .01) + 1) % CORNERS.length] }),
  },
  { id: 'sounds', name: 'Sounds', ...cycle('sounds', SOUND_KITS) },
];

function pickIdeas(): string[] {
  return [...IDEAS].sort(() => Math.random() - .5).slice(0, 4);
}

export function RoomsDialog({ stage, appearance, isMobile, startTweaking = false, onClose }: {
  stage: RoomStage;
  appearance: Appearance;
  isMobile: boolean;
  startTweaking?: boolean;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [words, setWords] = useState('');
  const [change, setChange] = useState('');
  const [tweaking, setTweaking] = useState(startTweaking);
  const [naming, setNaming] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [ideas] = useState(pickIdeas);
  const [step, setStep] = useState(0);
  const [sound, setSound] = useSound();
  const { preview, here, building } = stage;
  const pinned = stage.rooms.find((r) => r.id === appearance.pin);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    // Outside the sheet, a tap still reaches the app (the room stays live
    // behind it); only the button that opened Rooms keeps it open.
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!sheet.current?.contains(target) && !target.closest?.('[data-rooms-trigger]')) closeRef.current(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  useEffect(() => {
    if (!building) return;
    setStep(0);
    const timer = window.setInterval(() => setStep((s) => (s + 1) % STEPS.length), 1900);
    return () => window.clearInterval(timer);
  }, [building]);

  // A freshly built room lands as a try-on. On a phone the sheet steps aside
  // so the whole room shows; the banner up top keeps Keep, Tweak, Throw away.
  const landed = useRef(stage.landed);
  useEffect(() => {
    if (stage.landed === landed.current) return;
    landed.current = stage.landed;
    if (isMobile) closeRef.current(false);
    else body.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [stage.landed, isMobile]);

  const describe = (event: FormEvent) => {
    event.preventDefault();
    const text = words.trim();
    if (!text) return;
    setWords('');
    setTweaking(false);
    void stage.build(text);
  };
  const remake = (event: FormEvent) => {
    event.preventDefault();
    const text = change.trim();
    if (!text || !preview) return;
    setChange('');
    void stage.build(text, preview);
  };
  const keep = async (room: RoomSpec) => {
    setKeeping(true);
    try { await stage.keep(room); } finally { setKeeping(false); setTweaking(false); }
  };
  const saveMix = async (event: FormEvent) => {
    event.preventDefault();
    const name = naming?.trim();
    if (!name) return;
    await stage.saveHere(name);
    setNaming(null);
  };

  return (
    <>
      {isMobile ? <div className="rooms-scrim" aria-hidden="true" /> : null}
      <div
        ref={sheet}
        className={`rooms-sheet${isMobile ? ' is-phone' : ''}`}
        role="dialog"
        aria-modal={isMobile || undefined}
        aria-labelledby="rooms-title"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')].filter((node) => node.getClientRects().length);
          const edge = event.shiftKey ? items[0] : items.at(-1);
          if (document.activeElement !== edge) return;
          event.preventDefault();
          (event.shiftKey ? items.at(-1) : items[0])?.focus();
        }}
      >
        <header className="rooms-head">
          <span className="rooms-door" aria-hidden="true"><DoorOpen size={18} /></span>
          <span className="rooms-title"><h2 id="rooms-title">Rooms</h2><small>Chats, the Desk and your team come along.</small></span>
          <button type="button" className="rooms-close" onClick={() => onClose()} aria-label="Close rooms"><X size={18} /></button>
        </header>

        <div className="rooms-body" ref={body}>
          {preview ? (
            <section className="rooms-tryon" aria-label={`Trying on ${preview.name}`}>
              <span className="rooms-kicker"><Sparkles size={13} aria-hidden="true" /> Trying on</span>
              <strong className="rooms-tryon-name" style={{ fontFamily: roomFace(preview.look) }}>{preview.name}</strong>
              {preview.blurb ? <span className="rooms-tryon-blurb">{preview.blurb}</span> : null}
              <div className="rooms-tryon-actions">
                <button type="button" className="rooms-btn is-primary" disabled={keeping} onClick={() => void keep(preview)}><Check size={15} /> Keep it</button>
                <button type="button" className="rooms-btn" aria-expanded={tweaking} onClick={() => setTweaking((t) => !t)}><SlidersHorizontal size={15} /> Tweak</button>
                <button type="button" className="rooms-btn" onClick={() => { setTweaking(false); stage.discard(); }}><X size={15} /> Throw away</button>
              </div>
              {tweaking ? (
                <div className="rooms-tweaks">
                  <div className="rooms-dials" role="group" aria-label="Turn a dial">
                    {TWEAKS.map((t) => (
                      <button
                        type="button"
                        key={t.id}
                        className="rooms-dial"
                        aria-label={`${t.name}: ${t.value(preview.look)}. Change`}
                        onClick={() => {
                          const patch = t.change(preview.look);
                          stage.tweak(patch);
                          if (patch.sounds) playRoomCue(patch.sounds, 'arrive');
                        }}
                      >
                        <span>{t.name}</span><b>{t.value(preview.look)}</b>
                      </button>
                    ))}
                  </div>
                  <form className="rooms-describe is-small" onSubmit={remake}>
                    <input value={change} onChange={(e) => setChange(e.target.value)} maxLength={200} enterKeyHint="go"
                      placeholder="Make it… cozier, by the sea, more purple" aria-label={`Change ${preview.name} with words`} disabled={Boolean(building)} />
                    <button type="submit" className="rooms-btn" disabled={!change.trim() || Boolean(building)}>Go</button>
                  </form>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="rooms-here" aria-label="Where you are">
            <RoomMini look={lookOf(appearance)} />
            <span className="rooms-here-text">
              <small>{preview ? 'Your room' : 'You’re in'}</small>
              <strong style={{ fontFamily: roomFace(lookOf(appearance)) }}>{here ? here.name : 'Your own mix'}</strong>
              <span>{here ? here.blurb : 'A look you fine-tuned yourself'}</span>
            </span>
            {here ? (
              <button
                type="button"
                className="rooms-btn rooms-pin"
                aria-pressed={appearance.pin === here.id}
                title={appearance.pin === here.id ? 'Unpin this room' : 'Pin this room: it stays when TARDIS redecorates'}
                onClick={() => stage.setPin(appearance.pin === here.id ? null : here.id)}
              >
                <Pin size={14} />{appearance.pin === here.id ? 'Pinned' : 'Pin'}
              </button>
            ) : naming === null ? (
              <button type="button" className="rooms-btn" onClick={() => setNaming('My room')}>Save as a room</button>
            ) : null}
            {naming !== null && !here ? (
              <form className="rooms-describe is-small rooms-name" onSubmit={(e) => void saveMix(e)}>
                <input value={naming} autoFocus maxLength={32} onChange={(e) => setNaming(e.target.value)} aria-label="Name this room" />
                <button type="submit" className="rooms-btn is-primary" disabled={!naming.trim()}>Save</button>
                <button type="button" className="rooms-btn" onClick={() => setNaming(null)} aria-label="Cancel naming"><X size={14} /></button>
              </form>
            ) : null}
          </section>

          <section className="rooms-make" aria-label="Find a new room">
            <button type="button" className="rooms-surprise" data-autofocus onClick={(e) => stage.surprise(tapPoint(e))}>
              <Dices size={20} aria-hidden="true" /><span><strong>Surprise me</strong><small>Any room but this one</small></span>
            </button>
            {building ? (
              <div className="rooms-building" role="status">
                <span className="rooms-swatches" aria-hidden="true"><i /><i /><i /><i /></span>
                <span className="rooms-building-text"><strong>Building “{building}”</strong><small>{STEPS[step]}</small></span>
                <button type="button" className="rooms-btn" onClick={stage.cancelBuild}>Cancel</button>
              </div>
            ) : (
              <>
                <form className="rooms-describe" onSubmit={describe}>
                  <Sparkles size={17} aria-hidden="true" />
                  <input value={words} onChange={(e) => setWords(e.target.value)} maxLength={200} enterKeyHint="go"
                    placeholder="Describe a room…" aria-label="Describe a room for TARDIS to build" />
                  <button type="submit" className="rooms-btn is-primary" disabled={!words.trim()}>Build</button>
                </form>
                <div className="rooms-ideas" role="group" aria-label="Ideas">
                  {ideas.map((idea) => <button type="button" key={idea} onClick={() => { setTweaking(false); void stage.build(idea); }}>{idea}</button>)}
                </div>
              </>
            )}
          </section>

          <section className="rooms-gallery" aria-labelledby="rooms-gallery-title">
            <h3 id="rooms-gallery-title">Every room <small>{stage.rooms.length}</small></h3>
            <div className="rooms-grid">
              {stage.rooms.map((room) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  here={here?.id === room.id}
                  pinned={appearance.pin === room.id}
                  onEnter={(r, origin) => { setTweaking(false); stage.enter(r, origin); }}
                  onRemix={(r, origin) => {
                    stage.tryOn({ ...r, id: 'preview', name: `${r.name} Remix`.slice(0, 32), saved: false }, origin);
                    setTweaking(true);
                    body.current?.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  onRemove={room.saved && room.id !== 'original' ? (r) => void stage.remove(r) : undefined}
                />
              ))}
            </div>
          </section>

          <section className="rooms-routine" aria-label="Routine">
            <button type="button" role="switch" aria-checked={appearance.daily} className="rooms-switch" onClick={() => stage.setDaily(!appearance.daily)}>
              <span><strong>Redecorate each morning</strong>
                <small>{!appearance.daily ? 'A new room greets you each day.' : pinned ? `${pinned.name} is pinned, so it stays.` : 'Starting tomorrow from 5am.'}</small></span>
              <i aria-hidden="true" />
            </button>
            <button type="button" role="switch" aria-checked={sound} className="rooms-switch" onClick={() => {
              setSound(!sound);
              if (!sound) playRoomCue(stage.shown.sounds, 'arrive');
            }}>
              <span><strong>Room sounds</strong><small>Little noises on this device</small></span>
              <i aria-hidden="true" />
            </button>
            {!isMobile ? <p className="rooms-hint">Alt+Shift+R surprises you from anywhere.</p> : null}
          </section>
        </div>
      </div>
    </>
  );
}

/** A build or a try-on, once the sheet is closed: a slim bar under the top
 *  bar, in the flow, so it never covers a message or the composer. */
export function RoomBanner({ stage, onTweak }: { stage: RoomStage; onTweak: () => void }) {
  const { preview, building } = stage;
  const [keeping, setKeeping] = useState(false);
  if (!building && !preview) return null;
  return (
    <div className="room-banner" role="region" aria-label="Room try-on">
      {building ? (
        <>
          <span className="room-banner-text" role="status"><Sparkles size={15} aria-hidden="true" className="room-banner-spark" />Building <b>“{building}”</b>…</span>
          <button type="button" className="rooms-btn" onClick={stage.cancelBuild}>Cancel</button>
        </>
      ) : preview ? (
        <>
          <span className="room-banner-text"><Sparkles size={15} aria-hidden="true" />Trying on <b style={{ fontFamily: roomFace(preview.look) }}>{preview.name}</b></span>
          <button type="button" className="rooms-btn is-primary" disabled={keeping} onClick={() => {
            setKeeping(true);
            void stage.keep(preview).finally(() => setKeeping(false));
          }}><Check size={14} />Keep</button>
          <button type="button" className="rooms-btn" onClick={onTweak}><SlidersHorizontal size={14} />Tweak</button>
          <button type="button" className="rooms-btn" onClick={stage.discard} aria-label={`Throw away ${preview.name}`}><X size={14} /><span className="room-banner-long">Throw away</span></button>
        </>
      ) : null}
    </div>
  );
}

/** "Surprise!" and "Good morning", with Undo. Short-lived, near the bottom
 *  like every other TARDIS notice. */
export function RoomNotice({ stage }: { stage: RoomStage }) {
  const { notice, dismissNotice, undo } = stage;
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(dismissNotice, notice.undo ? 8000 : 5000);
    return () => window.clearTimeout(timer);
  }, [notice, dismissNotice]);
  if (!notice) return null;
  return (
    <div className="room-notice" role="status" key={notice.id}>
      <span>{notice.text}</span>
      {notice.undo ? <button type="button" className="rooms-btn" onClick={() => undo(notice.undo!)}><Undo2 size={14} />Undo</button> : null}
      <button type="button" className="room-notice-x" onClick={dismissNotice} aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}
