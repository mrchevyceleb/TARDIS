// A room as a little scale model: its own colors, backdrop, arrangement, team
// view and surface, so the gallery shows how each place really differs.

import { useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { Pin, Trash2, Wand2 } from 'lucide-react';
import { BackgroundScene } from './BackgroundScene';
import { DISPLAY_FACES } from './roomParts';
import { effectiveDef, expandTokens, FONTS } from './themes';
import type { RoomLook, RoomSpec } from './rooms';
import type { Point } from './useRooms';

const BODY_FALLBACK = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

/** The face a room uses for names: its display face, else its body font. */
export function roomFace(look: RoomLook): string {
  if (look.display !== 'body') return DISPLAY_FACES.find((f) => f.id === look.display)?.stack ?? BODY_FALLBACK;
  return FONTS.find((f) => f.id === look.font)?.vars?.['--r-body'] ?? BODY_FALLBACK;
}

/** Where a tap landed (or the control's center, for a keyboard press). */
export function tapPoint(event: MouseEvent<HTMLElement>): Point {
  if (event.detail > 0) return { x: event.clientX, y: event.clientY };
  const box = event.currentTarget.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

export function RoomMini({ look }: { look: RoomLook }) {
  const { palette, paint, accent, radius } = look;
  const style = useMemo(() => ({
    ...expandTokens(effectiveDef({ palette, paint }), accent),
    '--r-round': String(radius),
  }) as CSSProperties, [palette, paint, accent, radius]);
  return (
    <span className="room-mini" data-l={look.layout} data-t={look.team} data-s={look.surface} data-bg={look.background} style={style} aria-hidden="true">
      <BackgroundScene scene={look.background} intensity={look.backgroundIntensity} speed={look.backgroundSpeed} preview />
      <span className="mini-team">{[0, 1, 2, 3, 4].map((i) => <i key={i} />)}</span>
      <span className="mini-chat"><b /><b className="is-you" /><b /></span>
      <span className="mini-pane"><b /><b /></span>
    </span>
  );
}

export function RoomCard({ room, here, pinned, onEnter, onRemix, onRemove }: {
  room: RoomSpec;
  here: boolean;
  pinned: boolean;
  onEnter: (room: RoomSpec, origin: Point) => void;
  onRemix: (room: RoomSpec, origin: Point) => void;
  onRemove?: (room: RoomSpec) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="room-card" data-here={here || undefined}>
      <button
        type="button"
        className="room-card-main"
        aria-pressed={here}
        aria-label={`${room.name}${here ? ', you are here' : ''}${pinned ? ', pinned' : ''}. ${room.blurb}`}
        onClick={(event) => onEnter(room, tapPoint(event))}
      >
        <RoomMini look={room.look} />
        <span className="room-card-name" style={{ fontFamily: roomFace(room.look) }}>{room.name}</span>
        <span className="room-card-blurb">{room.blurb}</span>
      </button>
      <span className="room-card-badges" aria-hidden="true">
        {here ? <span className="room-badge is-here">Here</span> : null}
        {pinned ? <span className="room-badge is-pin"><Pin size={11} /></span> : null}
      </span>
      <span className="room-card-tools">
        <button type="button" title={`Remix ${room.name}`} aria-label={`Remix ${room.name}`} onClick={(event) => onRemix(room, tapPoint(event))}><Wand2 size={14} /></button>
        {onRemove ? <button type="button" title={`Throw away ${room.name}`} aria-label={`Throw away ${room.name}`} onClick={() => setConfirming(true)}><Trash2 size={14} /></button> : null}
      </span>
      {confirming ? (
        <span className="room-card-confirm" role="group" aria-label={`Throw away ${room.name}?`}>
          <span>Throw away {room.name}?</span>
          <button type="button" autoFocus onClick={() => { setConfirming(false); onRemove?.(room); }}>Throw away</button>
          <button type="button" onClick={() => setConfirming(false)}>Keep</button>
        </span>
      ) : null}
    </div>
  );
}
