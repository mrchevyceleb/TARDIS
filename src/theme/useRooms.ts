// Rooms as a living thing: the library (Original, the built-ins, rooms Matt
// made), the room on screen (a try-on never touches the saved look), arriving
// with a little ceremony, and the quiet morning redecoration.

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteRoom, fetchRooms, imagineRoom, saveRoom, type SavedRoom } from '../data/api';
import { BUILT_IN_ROOMS, currentRoom, dailyRoom, enterRoom, lookOf, offlineRoom, sanitizeRoom, surpriseRoom, todayKey, type RoomSpec } from './rooms';
import { playRoomCue } from './roomSounds';
import type { Appearance } from './themes';

export type SyncStatus = 'loading' | 'saving' | 'saved' | 'local' | 'error';
export type Point = { x: number; y: number };
export type RoomNotice = { id: number; text: string; undo?: Appearance };
type SetAppearance = (action: SetStateAction<Appearance>) => void;

const ROOMS_KEY = ['rooms'];

export function useRoomLibrary() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ROOMS_KEY, queryFn: fetchRooms, staleTime: 30_000 });
  const rooms = useMemo(() => {
    const saved = (query.data?.rooms ?? []).map(sanitizeRoom).filter((r): r is RoomSpec => r !== null);
    return [...saved.filter((r) => r.id === 'original'), ...BUILT_IN_ROOMS, ...saved.filter((r) => r.id !== 'original')];
  }, [query.data]);
  const save = useCallback(async (room: RoomSpec): Promise<RoomSpec> => {
    const { room: raw } = await saveRoom({ name: room.name, blurb: room.blurb, look: room.look, ...(room.prompt ? { prompt: room.prompt } : {}) });
    const saved = sanitizeRoom(raw);
    if (!saved) throw new Error('The room library sent back a room it could not read.');
    client.setQueryData<{ rooms: SavedRoom[] }>(ROOMS_KEY, (old) => ({ rooms: [...(old?.rooms ?? []), raw] }));
    return saved;
  }, [client]);
  /** The library straight from the server, for decisions a stale cache must not make. */
  const refresh = useCallback(async (): Promise<RoomSpec[]> => {
    const data = await client.fetchQuery({ queryKey: ROOMS_KEY, queryFn: fetchRooms, staleTime: 0 });
    return data.rooms.map(sanitizeRoom).filter((r): r is RoomSpec => r !== null);
  }, [client]);
  const remove = useCallback(async (id: string) => {
    await deleteRoom(id);
    client.setQueryData<{ rooms: SavedRoom[] }>(ROOMS_KEY, (old) => old && { rooms: old.rooms.filter((r) => r.id !== id) });
  }, [client]);
  // `ready` means the saved rooms really arrived (an outage must never look
  // like a deleted pinned room to the morning routine).
  return { rooms, ready: query.isSuccess, save, remove, refresh };
}

/** Change rooms with a ripple from the tap. View Transitions where the
 *  browser has them and motion is welcome; an instant swap otherwise. One
 *  ripple at a time: a change made while one is still spreading (fast taps,
 *  Undo right away) lands instantly instead of stacking whole-page snapshots. */
let rippling = false;
let lastChange = 0;
export function roomTransition(change: () => void, origin?: Point): void {
  const root = document.documentElement;
  // A ripple applies its change a moment later; only the newest change may land.
  const mine = ++lastChange;
  const apply = () => { if (mine === lastChange) change(); };
  const still = rippling || !('startViewTransition' in document) || document.hidden || root.dataset.motion === 'calm'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) { change(); return; }
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.classList.add('room-moving');
  rippling = true;
  const done = () => { rippling = false; root.classList.remove('room-moving'); };
  try {
    const move = document.startViewTransition(() => { flushSync(apply); });
    move.ready.then(() => {
      root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 640, easing: 'cubic-bezier(.22, .8, .24, 1)', pseudoElement: '::view-transition-new(root)' });
    }).catch(() => { /* skipped: the change already landed */ });
    move.finished.catch(() => undefined).finally(done);
  } catch {
    done();
    apply();
  }
}

/** The look a room change replaced, restored without touching anything personal. */
const restore = (before: Appearance) => (a: Appearance): Appearance => ({ ...a, ...lookOf(before), room: before.room });

export function useRoomStage(appearance: Appearance, setAppearance: SetAppearance, syncStatus: SyncStatus) {
  const library = useRoomLibrary();
  const [preview, setPreview] = useState<RoomSpec | null>(null);
  const [notice, setNotice] = useState<RoomNotice | null>(null);
  const latest = useRef({ appearance, rooms: library.rooms });
  latest.current = { appearance, rooms: library.rooms };

  // What is painted: the saved look, or a try-on worn over it. Personal
  // settings (text size, contrast, motion) always come from the saved look.
  const shown = useMemo<Appearance>(() => (preview ? { ...appearance, ...preview.look } : appearance), [appearance, preview]);
  const here = useMemo(() => currentRoom(appearance, library.rooms), [appearance, library.rooms]);

  const announce = useCallback((text: string, undo?: Appearance) => setNotice({ id: Date.now(), text, undo }), []);

  // Every room change the person makes counts as a move. Anything still on
  // its way when they move (a build, a Keep waiting on the server) is stale
  // and must never land over what they chose since.
  const moves = useRef(0);
  const [building, setBuilding] = useState<string | null>(null);
  const buildCtl = useRef<AbortController | null>(null);
  const cancelBuild = useCallback(() => {
    buildCtl.current?.abort();
    buildCtl.current = null;
    setBuilding(null);
  }, []);
  const move = useCallback(() => { moves.current += 1; cancelBuild(); }, [cancelBuild]);

  const enter = useCallback((room: RoomSpec, origin?: Point, how: 'tap' | 'surprise' | 'morning' = 'tap') => {
    const before = latest.current.appearance;
    move();
    roomTransition(() => {
      setPreview(null);
      setAppearance((a) => enterRoom(room, how === 'morning' ? { ...a, redecorated: todayKey() } : a));
    }, origin);
    playRoomCue(room.look.sounds, 'arrive', how !== 'morning');
    if (how === 'surprise') announce(`Surprise! Welcome to ${room.name}.`, before);
    if (how === 'morning') {
      announce(room.id === before.pin ? `Good morning. Back in ${room.name}, your pinned room.` : `Good morning. TARDIS redecorated: ${room.name}.`, before);
    }
  }, [announce, move, setAppearance]);

  const surprise = useCallback((origin?: Point) => {
    const pick = surpriseRoom(latest.current.rooms, latest.current.appearance);
    if (pick) enter(pick, origin, 'surprise');
  }, [enter]);

  const wear = useCallback((room: RoomSpec, origin?: Point) => {
    roomTransition(() => setPreview(room), origin);
    playRoomCue(room.look.sounds, 'arrive');
  }, []);
  /** Try a room on by choice (a remix): it replaces anything still building. */
  const tryOn = useCallback((room: RoomSpec, origin?: Point) => { move(); wear(room, origin); }, [move, wear]);
  const tweak = useCallback((patch: Partial<RoomSpec['look']>) => {
    moves.current += 1;
    setPreview((p) => (p ? { ...p, look: { ...p.look, ...patch } } : p));
  }, []);
  const discard = useCallback(() => { move(); roomTransition(() => setPreview(null)); }, [move]);

  // Describe a room: the designer builds it and it is tried on, never saved.
  // The build belongs to the stage, so closing Rooms never loses it. If the
  // designer is away, the words still become a room sketched on this device.
  const [landed, setLanded] = useState(0);
  const build = useCallback(async (words: string, base?: RoomSpec) => {
    moves.current += 1;
    buildCtl.current?.abort();
    const ctl = new AbortController();
    buildCtl.current = ctl;
    setBuilding(words);
    try {
      const { room } = await imagineRoom(words, base && { name: base.name, prompt: base.prompt, look: base.look }, ctl.signal);
      const made = sanitizeRoom(room);
      if (!made) throw new Error('The designer sent back a room TARDIS could not read.');
      if (ctl.signal.aborted) return;
      wear({ ...made, saved: false });
      setLanded((n) => n + 1);
    } catch (error) {
      if (ctl.signal.aborted) return;
      // Busy (another device is building) is not away: say so, sketch nothing.
      if ((error as { status?: number }).status === 429) announce('TARDIS is already building a room. Give it a moment, then try again.');
      else if (base) announce('The designer is away right now. The tweak chips still work.');
      else {
        wear(offlineRoom(words));
        setLanded((n) => n + 1);
        announce('The designer is away, so TARDIS sketched this one from your words.');
      }
    } finally {
      if (buildCtl.current === ctl) { buildCtl.current = null; setBuilding(null); }
    }
  }, [announce, wear]);
  useEffect(() => () => buildCtl.current?.abort(), []);

  /** Keep the try-on: it joins the library and becomes the room you are in.
   *  If the library cannot take it right now, the look still stays on. */
  const keep = useCallback(async (room: RoomSpec) => {
    const at = moves.current;
    try {
      const saved = await library.save(room);
      // They moved on while it saved: it still joins the library, quietly.
      if (moves.current !== at) { announce(`Saved ${saved.name} to your rooms.`); return; }
      enter(saved);
    } catch (error) {
      if (moves.current !== at) { announce(`${room.name} could not join your rooms (${(error as Error).message}).`); return; }
      move();
      setPreview(null);
      setAppearance((a) => ({ ...a, ...room.look, room: 'preview' }));
      announce(`${room.name} is on, but it could not join your rooms (${(error as Error).message}). Save it from Rooms later.`);
    }
  }, [announce, enter, library, move, setAppearance]);

  /** Save a personal mix (or a look you fine-tuned) as a room of its own. */
  const saveHere = useCallback(async (name: string) => {
    const a = latest.current.appearance;
    try {
      const saved = await library.save({ id: 'preview', name, blurb: 'A look you made your own', look: lookOf(a) });
      setAppearance((current) => ({ ...current, room: saved.id }));
      announce(`Saved ${saved.name} to your rooms.`);
    } catch (error) {
      announce((error as Error).message);
    }
  }, [announce, library, setAppearance]);

  const remove = useCallback(async (room: RoomSpec) => {
    try {
      await library.remove(room.id);
      if (latest.current.appearance.pin === room.id) setAppearance((a) => ({ ...a, pin: null }));
    } catch (error) {
      announce((error as Error).message);
    }
  }, [announce, library, setAppearance]);

  const undo = useCallback((before: Appearance) => {
    move();
    roomTransition(() => setAppearance(restore(before)));
    setNotice(null);
  }, [move, setAppearance]);

  useMorningRoom({ appearance, rooms: library.rooms, ready: library.ready, refresh: library.refresh, previewing: preview !== null, syncStatus, enter, setAppearance });

  return {
    rooms: library.rooms, ready: library.ready, here, shown, preview, notice, building, landed,
    enter, surprise, tryOn, tweak, discard, keep, saveHere, remove, undo, build, cancelBuild,
    dismissNotice: useCallback(() => setNotice(null), []),
    setDaily: useCallback((daily: boolean) => setAppearance((a) => ({ ...a, daily, redecorated: daily ? todayKey() : a.redecorated })), [setAppearance]),
    setPin: useCallback((pin: string | null) => setAppearance((a) => ({ ...a, pin })), [setAppearance]),
  };
}

export type RoomStage = ReturnType<typeof useRoomStage>;

/** Each morning (from 5am, once this device has the office's saved look),
 *  step into a new room, or back into the pinned one. The pick depends only
 *  on the date and the library, so every device lands in the same room. */
function useMorningRoom({ appearance, rooms, ready, refresh, previewing, syncStatus, enter, setAppearance }: {
  appearance: Appearance; rooms: RoomSpec[]; ready: boolean; refresh: () => Promise<RoomSpec[]>; previewing: boolean; syncStatus: SyncStatus;
  enter: (room: RoomSpec, origin: undefined, how: 'morning') => void; setAppearance: SetAppearance;
}) {
  const latest = useRef({ appearance, rooms, previewing, enter, refresh });
  latest.current = { appearance, rooms, previewing, enter, refresh };
  const checkingPin = useRef<string | null>(null);
  const settled = ready && syncStatus !== 'loading' && syncStatus !== 'saving';
  useEffect(() => {
    if (!settled || !appearance.daily) return;
    const check = () => {
      const { appearance: a, rooms: list, previewing: trying, enter: arrive, refresh: reload } = latest.current;
      const today = todayKey();
      if (!a.daily || a.redecorated === today || new Date().getHours() < 5 || document.hidden || trying) return;
      // Never repaint under someone mid-sentence; the next check catches up.
      if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return;
      const pinned = a.pin ? list.find((r) => r.id === a.pin) : undefined;
      if (a.pin && !pinned) {
        // A pin this device has not seen may be a room made elsewhere a moment
        // ago. Ask the server before letting it go; the fresh library re-runs this.
        const pin = a.pin;
        if (checkingPin.current === pin) return;
        checkingPin.current = pin;
        void reload().then((fresh) => {
          if (!fresh.some((r) => r.id === pin)) setAppearance((current) => (current.pin === pin ? { ...current, pin: null } : current));
        }).catch(() => undefined).finally(() => { checkingPin.current = null; });
        return;
      }
      const target = pinned ?? dailyRoom(today, list, a);
      if (!target || currentRoom(a, list)?.id === target.id) {
        setAppearance((current) => ({ ...current, redecorated: today }));
        return;
      }
      arrive(target, undefined, 'morning');
    };
    check();
    const timer = window.setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [settled, appearance.daily, appearance.pin, rooms, setAppearance]);
}
