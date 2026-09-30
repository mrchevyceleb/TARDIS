// Grok Bot left rail — THE TEAM, one list, no redundancy:
//
//   mark [+]   ·   Search
//   ────────────────────────────────────────────────
//   ○ Chief of Staff   Coordination, plans…  2:14 PM
//     Got it. Parking GHL for now.
//   ○ <your next agent> …
//   ────────────────────────────────────────────────
//   Plugins · You
//
// [+] creates a companion (name/role/engine/scope). Every row = a companion and
// its ONE persistent forever-thread. Scratch threads surface via search only.

import { useCallback, useMemo, useRef, useState, useEffect, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Bell,
  BellOff,
  Check,
  PanelLeftClose,
  Pencil,
  AppWindow,
  BookOpen,
  CalendarDays,
  ClipboardList,
  Coins,
  FolderInput,
  Gauge,
  Hammer,
  Heart,
  LayoutGrid,
  Mail,
  Moon,
  Pin,
  Plug,
  Plus,
  Scroll,
  Search,
  Sun,
  Volume2,
  VolumeX,
  Workflow,
  X,
} from 'lucide-react';
import { BotMark } from './GrokLogo';
import { MoveToGroupMenu, RailGroupSection, RailNewGroup } from './RailGroups';
import { OTHER_GROUP_ID, OTHER_GROUP_NAME } from './railGroups';
import { useRailGroups } from './useRailGroups';
import { agentMark, DISC_INK, agentColor, agentAvatarUrl, sameChatId, CHAT_COLORS, chatColorOf, type Agent, type AgentFlagPatch, type ChatColor } from './agents';
import { useLive } from '../chat/hooks/useLive';
import { useJobsSummary } from '../chat/hooks/useJobs';
import { RailJobsBadge } from '../chat/components/jobs/RailJobsBadge';
import type { HistoryItem } from './history';
import { NativeOpenHelper } from '../components/NativeOpenHelper';
import { ROOM_NAMES } from '../data/roomNames';
import { useDeploymentFlags } from '../data/deploymentFlags';
import { AppearanceSettings } from '../theme/AppearanceSettings';
import type { ThemeName, VisualStyle } from '../theme/applyTheme';
import { TIMEY_WIMEY } from '../theme/voice';
import { readSound, useIdle, useTripleTap, vworp, writeSound } from '../theme/eggs';

export type RoomEntry = { key: string; label: string; icon: React.ReactNode };

export const ROOM_ENTRIES: RoomEntry[] = [
  { key: 'integrations', label: ROOM_NAMES.integrations.name, icon: <Plug size={16} /> },
  { key: 'setup', label: ROOM_NAMES.setup.name, icon: <Plug size={16} /> },
  { key: 'content', label: ROOM_NAMES.content.name, icon: <Pencil size={16} /> },
  { key: 'desk', label: ROOM_NAMES.desk.name, icon: <ClipboardList size={16} /> },
  { key: 'council', label: ROOM_NAMES.council.name, icon: <LayoutGrid size={16} /> },
  { key: 'dashboard', label: ROOM_NAMES.dashboard.name, icon: <Gauge size={16} /> },
  { key: 'tidings', label: ROOM_NAMES.tidings.name, icon: <Mail size={16} /> },
  { key: 'calendar', label: ROOM_NAMES.calendar.name, icon: <CalendarDays size={16} /> },
  { key: 'hearth', label: ROOM_NAMES.hearth.name, icon: <Heart size={16} /> },
  { key: 'library', label: ROOM_NAMES.library.name, icon: <BookOpen size={16} /> },
  { key: 'pins', label: ROOM_NAMES.pins.name, icon: <Pin size={16} /> },
  { key: 'reckoning', label: ROOM_NAMES.reckoning.name, icon: <Coins size={16} /> },
  { key: 'forge', label: ROOM_NAMES.forge.name, icon: <Hammer size={16} /> },
  { key: 'weavings', label: ROOM_NAMES.weavings.name, icon: <Workflow size={16} /> },
  { key: 'annals', label: ROOM_NAMES.annals.name, icon: <Scroll size={16} /> },
  { key: 'scribe', label: ROOM_NAMES.scribe.name, icon: <Activity size={16} /> },
];

export type ActiveChat = { chatId: string; cli?: string; repo?: string };

export type BotRailProps = {
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  /** Desktop rail is collapsed to zero width (menu button stays outside). */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  agents: Agent[];
  /** Drag-drop reorder commit: agent ids in their new visual sequence. */
  onReorder: (ids: string[]) => void;
  items: HistoryItem[];
  hubRepo?: string;
  activeChat?: ActiveChat;
  onOpenChat: (item: HistoryItem) => void;
  onOpenAgent: (a: Agent) => void;
  onEditAgent: (a: Agent) => void;
  onPatchAgent: (a: Agent, patch: AgentFlagPatch) => void;
  onNewAgent: () => void;
  activeRoom?: string;
  onOpenRoom: (key: string) => void;
  theme: ThemeName;
  visualStyle: VisualStyle;
  onStyleChange: (style: VisualStyle) => void;
  onThemeChange: (theme: ThemeName) => void;
  onToggleTheme: () => void;
  onOpenStudio: () => void;
  onHome: () => void;
};

type AgentMenuState = { x: number; y: number; id: string; restore: HTMLElement | null };

function clampMenu(x: number, y: number, w = 256, h = 220): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  };
}

function menuItems(root: HTMLElement | null): HTMLButtonElement[] {
  return root ? [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')] : [];
}

function swatchItems(root: HTMLElement | null): HTMLButtonElement[] {
  return menuItems(root).filter((b) => b.dataset.swatch !== undefined);
}

/** Up/Down stops: every row, with the swatch strip counted once (its
 *  checked swatch). Left/Right move along the strip itself. */
function menuStops(root: HTMLElement | null): HTMLButtonElement[] {
  const swatches = swatchItems(root);
  const lead = swatches.find((b) => b.getAttribute('aria-checked') === 'true') ?? swatches[0];
  return menuItems(root).filter((b) => b.dataset.swatch === undefined || b === lead);
}

/** ", red label" for tooltips and screen readers; empty when uncolored. */
function colorLabel(a: Agent): string {
  const key = chatColorOf(a);
  const label = key ? CHAT_COLORS.find((c) => c.key === key)?.label : undefined;
  return label ? `, ${label.toLowerCase()} label` : '';
}

/** Touch has no right-click, so holding a row this long opens the same menu. */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;

function AgentContextMenu({
  menu,
  agent,
  onMute,
  onPin,
  onColor,
  onEdit,
  onMoveToGroup,
  onClose,
  swallowPressRelease,
}: {
  menu: AgentMenuState;
  agent: Agent;
  onMute: (a: Agent) => void;
  onPin: (a: Agent) => void;
  onColor: (a: Agent, color: ChatColor | null) => void;
  onEdit: (a: Agent) => void;
  /** Opens the group picker at the menu's spot. Absent while no groups exist. */
  onMoveToGroup?: (a: Agent) => void;
  onClose: () => void;
  /** True when this click is the finger lifting from the long-press that
   *  opened the menu (it can land on an item under the finger). */
  swallowPressRelease: (e: MouseEvent) => boolean;
}) {
  const current = chatColorOf(agent);
  const pickColor = (color: ChatColor | null) => {
    if ((color ?? undefined) !== current) onColor(agent, color);
    onClose();
  };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node) {
      // Layout size, not getBoundingClientRect: the open animation scales the box.
      const left = Math.max(8, Math.min(menu.x, window.innerWidth - node.offsetWidth - 8));
      const top = Math.max(8, Math.min(menu.y, window.innerHeight - node.offsetHeight - 8));
      if (left !== menu.x) node.style.left = `${left}px`;
      if (top !== menu.y) node.style.top = `${top}px`;
      menuItems(node)[0]?.focus();
    }
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onViewport = () => onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onViewport);
    document.addEventListener('scroll', onViewport, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onViewport);
      document.removeEventListener('scroll', onViewport, true);
      if (menu.restore?.isConnected) menu.restore.focus();
    };
  }, [onClose, menu.x, menu.y, menu.restore]);

  const onMenuKey = (e: ReactKeyEvent<HTMLDivElement>) => {
    const focused = document.activeElement as HTMLButtonElement;
    const swatches = swatchItems(ref.current);
    const onSwatch = swatches.includes(focused);
    if (onSwatch && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      swatches[(swatches.indexOf(focused) + step + swatches.length) % swatches.length]?.focus();
      return;
    }
    const items = menuStops(ref.current);
    if (!items.length) return;
    const at = onSwatch ? items.findIndex((b) => b.dataset.swatch !== undefined) : items.indexOf(focused);
    const i = Math.max(0, at);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
    }
    if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
    else if (e.key === 'Home') items[0]?.focus();
    else if (e.key === 'End') items[items.length - 1]?.focus();
    else if (e.key === 'Tab') onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className="bt-agent-ctx"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      aria-label={`${agent.name} actions`}
      onContextMenu={(e) => e.preventDefault()}
      onClickCapture={(e) => {
        if (!swallowPressRelease(e)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={onMenuKey}
    >
      <button type="button" role="menuitem" className="bt-plug-row" onClick={() => { onMute(agent); onClose(); }}>
        {agent.muted ? <Bell size={16} /> : <BellOff size={16} />}
        {agent.muted ? 'Unmute notifications' : 'Mute notifications'}
      </button>
      <button type="button" role="menuitem" className="bt-plug-row" onClick={() => { onPin(agent); onClose(); }}>
        <Pin size={16} />
        {agent.pinned ? 'Unpin from top' : 'Pin to top'}
      </button>
      <button type="button" role="menuitem" className="bt-plug-row" onClick={() => { onEdit(agent); onClose(); }}>
        <Pencil size={16} />
        Edit
      </button>
      {onMoveToGroup ? (
        <button type="button" role="menuitem" className="bt-plug-row" onClick={() => { onMoveToGroup(agent); onClose(); }}>
          <FolderInput size={16} />
          Move to group
        </button>
      ) : null}
      <div className="bt-ctx-sep" role="separator" />
      <div className="bt-ctx-colors" role="group" aria-label="Color label">
        <span className="bt-ctx-colors-h" aria-hidden="true">Color</span>
        <div className="bt-ctx-swatches">
          {CHAT_COLORS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="menuitemradio"
              aria-checked={current === c.key}
              aria-label={c.label}
              title={c.label}
              className="bt-swatch"
              data-swatch=""
              data-chat-color={c.key}
              onClick={() => pickColor(c.key)}
            >
              {current === c.key ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : null}
            </button>
          ))}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!current}
            aria-label="No color"
            title="No color"
            className="bt-swatch bt-swatch-none"
            data-swatch=""
            onClick={() => pickColor(null)}
          />
        </div>
      </div>
    </div>,
    document.querySelector('.bot-app') ?? document.body,
  );
}

function dayStamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (now.getTime() - d.getTime() < 7 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Drop target meaning "after the last pinned bubble". */
const PINS_END = '__pins_end__';

type AgentRow = { kind: 'agent'; a: Agent; item?: HistoryItem; ts: number };
type Row = AgentRow | { kind: 'adhoc'; item: HistoryItem; ts: number };
/** Where a dragged row would land in group mode. `head` = dropped on a group's
 *  header or empty slot (append); otherwise before `before` (null = at the end). */
type GroupDrop = { group: string; before: string | null; head?: boolean };
/** A row's place in its group: which group, and who sits right below it. */
type RowSlot = { group: string; next: string | null };

// Desktop rail width, dragged from its right edge and kept per browser.
const RAIL_WIDTH_KEY = 'rivendell:rail-width';
const RAIL_MIN = 280;
const RAIL_MAX = 560;
const RAIL_DEFAULT = 350;
const RAIL_KEY_STEP = 16;

function clampRailWidth(width: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(width)));
}

function storedRailWidth(): number {
  try {
    const saved = Number(localStorage.getItem(RAIL_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampRailWidth(saved) : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

export function BotRail(props: BotRailProps) {
  const flags = useDeploymentFlags();
  const [query, setQuery] = useState('');
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearanceTrigger = useRef<HTMLButtonElement>(null);
  const [agentMenu, setAgentMenu] = useState<AgentMenuState | null>(null);
  // Manual order drag-and-drop: the dragged agent id + where it would land.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const pluginsRef = useRef<HTMLDivElement | null>(null);
  const live = useLive();
  const menuAgent = agentMenu ? props.agents.find((a) => a.id === agentMenu.id) : undefined;
  const openAgentMenu = (e: MouseEvent, a: Agent) => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = clampMenu(e.clientX, e.clientY);
    setAgentMenu({ x, y, id: a.id, restore: e.currentTarget instanceof HTMLElement ? e.currentTarget : null });
  };
  const closeAgentMenu = useCallback(() => setAgentMenu(null), []);

  // Long-press (touch and pen) opens the same menu. The tap that ends the
  // press must not also open the chat, and must not start a reorder drag.
  const pressRef = useRef<{ timer: number; x: number; y: number; pointer: number } | null>(null);
  const pressOpened = useRef(false);
  const cancelPress = useCallback(() => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);
  // The opening press ends at the next pointerdown, wherever it lands.
  useEffect(() => {
    if (!agentMenu) return;
    const reset = () => { pressOpened.current = false; };
    document.addEventListener('pointerdown', reset, true);
    return () => document.removeEventListener('pointerdown', reset, true);
  }, [agentMenu]);
  const pressProps = (a: Agent) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      cancelPress();
      pressOpened.current = false;
      const target = e.currentTarget;
      // Native drag stays mouse-only. On touch (iOS Safari especially) a held
      // draggable row lifts into a drag before the menu timer can fire.
      target.draggable = e.pointerType === 'mouse';
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      const { clientX: x, clientY: y, pointerId } = e;
      const timer = window.setTimeout(() => {
        pressRef.current = null;
        pressOpened.current = true;
        setAgentMenu({ ...clampMenu(x, y), id: a.id, restore: target });
        try { navigator.vibrate?.(8); } catch { /* haptics are optional */ }
      }, LONG_PRESS_MS);
      pressRef.current = { timer, x, y, pointer: pointerId };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const p = pressRef.current;
      if (p && p.pointer === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) cancelPress();
    },
    onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => { cancelPress(); e.currentTarget.draggable = true; },
    onPointerCancel: (e: ReactPointerEvent<HTMLButtonElement>) => { cancelPress(); e.currentTarget.draggable = true; },
  });
  /** True (once) when this click is the release of a long-press. Keyboard
   *  clicks (detail 0) always go through. */
  const swallowPressClick = (e: MouseEvent) => {
    const swallow = pressOpened.current && e.detail !== 0;
    pressOpened.current = false;
    return swallow;
  };

  // Easter eggs — presentation only. "Don't blink." after ten idle minutes
  // (never while any lane is busy), a lamp flash on a triple tap of the mark,
  // and an opt-in synthesised vworp. None of these touch a turn.
  const idle = useIdle(600_000);
  const anyBusy = live.some((s) => s.busy);
  const [sound, setSound] = useState(readSound);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const [lampFlash, setLampFlash] = useState(false);
  const lampTimer = useRef(0);
  const onLampTap = useTripleTap(useCallback(() => {
    window.clearTimeout(lampTimer.current);
    setLampFlash(true);
    lampTimer.current = window.setTimeout(() => setLampFlash(false), 900);
    if (soundRef.current) vworp();
  }, []));
  useEffect(() => () => window.clearTimeout(lampTimer.current), []);

  useEffect(() => {
    if (!pluginsOpen) return;
    const onDown = (e: PointerEvent) => {
      if (pluginsRef.current && !pluginsRef.current.contains(e.target as Node)) setPluginsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPluginsOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pluginsOpen]);

  // Agent home threads, looked up in the history index — identity is the
  // FACE (home chatId + repo), engine-agnostic.
  const homeById = useMemo(() => {
    const map = new Map<string, HistoryItem>();
    for (const a of props.agents) {
      const hit = props.items.find((i) => (!i.repo || !props.hubRepo || i.repo === props.hubRepo) && sameChatId(i.chatId, a.home));
      if (hit) map.set(a.id, hit);
    }
    return map;
  }, [props.items, props.hubRepo, props.agents]);

  const liveAgents = useMemo(() => {
    const set = new Set<string>();
    for (const s of live) {
      const a = props.agents.find((aa) => sameChatId(s.chatId, aa.home)
        && (!props.hubRepo || s.cwd === props.hubRepo));
      if (a) set.add(a.id);
    }
    return set;
  }, [live, props.agents, props.hubRepo]);
  // Same match, but only lanes mid-turn: the "working" count on a folded group
  // and the ring on a row's presence lamp.
  const busyAgents = useMemo(() => {
    const set = new Set<string>();
    for (const s of live) {
      if (!s.busy) continue;
      const a = props.agents.find((aa) => sameChatId(s.chatId, aa.home)
        && (!props.hubRepo || s.cwd === props.hubRepo));
      if (a) set.add(a.id);
    }
    return set;
  }, [live, props.agents, props.hubRepo]);
  // Running background jobs per agent (one request for the whole rail). A job
  // is not a turn: an agent on jobs is busy but free to talk, so it gets its
  // own outlined badge and never the working lamp.
  const jobsByAgent = useJobsSummary();

  // Named, collapsible groups (layout + sync live in useRailGroups). Group
  // mode replaces the flat list unless a search is running.
  const railGroups = useRailGroups(props.agents);
  const [groupDrop, setGroupDrop] = useState<GroupDrop | null>(null);
  const [moveMenu, setMoveMenu] = useState<AgentMenuState | null>(null);
  const closeMoveMenu = useCallback(() => setMoveMenu(null), []);

  const railRef = useRef<HTMLElement | null>(null);
  const [railWidth, setRailWidth] = useState(storedRailWidth);
  const [resizingRail, setResizingRail] = useState(false);
  // Save once a drag settles, not on every pointer move.
  useEffect(() => {
    if (resizingRail) return;
    try { localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth)); } catch { /* private mode */ }
  }, [railWidth, resizingRail]);
  useEffect(() => {
    document.body.classList.toggle('bt-rail-resizing', resizingRail);
    return () => document.body.classList.remove('bt-rail-resizing');
  }, [resizingRail]);
  // A drag in progress when the rail unmounts still drops its listeners.
  const endRailResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endRailResizeRef.current?.(), []);
  const startRailResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (e.button !== 0 || !rail) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const left = rail.getBoundingClientRect().left;
    const move = (ev: PointerEvent) => setRailWidth(clampRailWidth(ev.clientX - left));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) handle.removeEventListener(type, end);
      endRailResizeRef.current = null;
      setResizingRail(false);
    };
    endRailResizeRef.current = end;
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) handle.addEventListener(type, end);
    setResizingRail(true);
  };

  // Pinned bubble strip (manual, user-pinned; order follows the drag order).
  const pins = useMemo(
    () => props.agents.filter((a) => a.pinned),
    [props.agents],
  );

  // Drag-to-reorder inside the bubble strip. Pins share the global `order`
  // sequence with the list, so a pin drop moves the agent to the target
  // bubble's position in the FULL order (list rows keep their relative order).
  const [pinDrag, setPinDrag] = useState<string | null>(null);
  const [pinDropBefore, setPinDropBefore] = useState<string | null>(null);
  // The strip wraps into rows, so a bubble's right half means "before the
  // next pin" (PINS_END after the last one), which makes every slot reachable.
  const pinDropTarget = (index: number, e: React.DragEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX < rect.left + rect.width / 2) return pins[index].id;
    return pins[index + 1]?.id ?? PINS_END;
  };
  const commitPinReorder = () => {
    if (!pinDrag || !pinDropBefore || pinDrag === pinDropBefore) {
      setPinDrag(null); setPinDropBefore(null); return;
    }
    const next = [...agentIds];
    const from = next.indexOf(pinDrag);
    const lastPin = pins.at(-1);
    const to = pinDropBefore === PINS_END
      ? (lastPin ? next.indexOf(lastPin.id) + 1 : -1)
      : next.indexOf(pinDropBefore);
    if (from < 0 || to < 0) { setPinDrag(null); setPinDropBefore(null); return; }
    next.splice(from, 1);
    next.splice(from < to ? to - 1 : to, 0, pinDrag);
    setPinDrag(null);
    setPinDropBefore(null);
    props.onReorder(next);
  };

  // ONE list: agents in their FIXED manual order. Scratch threads join only in search.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // FIXED manual order (drag-and-drop persisted). Only search results are
    // recency-sorted; the agents themselves never move on their own. Pinned
    // agents live in the bubble strip, so the list holds the rest.
    const out: Row[] = props.agents.filter((a) => !a.pinned).map((a) => ({ kind: 'agent', a, item: homeById.get(a.id), ts: homeById.get(a.id)?.updatedAt ?? a.createdAt }));
    if (q) {
      const adhoc: Row[] = [];
      for (const it of props.items) {
        if (props.agents.some((a) => (!it.repo || !props.hubRepo || it.repo === props.hubRepo) && sameChatId(it.chatId, a.home))) continue;
        adhoc.push({ kind: 'adhoc', item: it, ts: it.updatedAt });
      }
      adhoc.sort((a, b) => b.ts - a.ts);
      const all = [...props.agents.map((a) => ({ kind: 'agent' as const, a, item: homeById.get(a.id), ts: homeById.get(a.id)?.updatedAt ?? a.createdAt })), ...adhoc];
      return all.filter((r) => {
        const hay = r.kind === 'agent'
          ? `${r.a.name} ${r.a.role} ${r.item?.title ?? ''} ${r.item?.preview ?? ''}`
          : `${r.item!.title} ${r.item!.preview ?? ''}`;
        return hay.toLowerCase().includes(q);
      });
    }
    return out;
  }, [props.agents, props.items, homeById, query, props.hubRepo]);

  const agentIds = props.agents.map((a) => a.id);
  /** Put `id` before `before` ('__end__' = last) in the global manual order. */
  const reorderBefore = (id: string, before: string) => {
    const from = agentIds.indexOf(id);
    let to = before === '__end__' ? agentIds.length : agentIds.indexOf(before);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...agentIds];
    next.splice(from, 1);
    if (from < to) to -= 1; // removal shifted the target up one slot
    next.splice(to, 0, id);
    props.onReorder(next);
  };
  const commitReorder = () => {
    const id = dragId;
    const before = dropBefore;
    setDragId(null);
    setDropBefore(null);
    if (id && before !== null) reorderBefore(id, before);
  };

  // Group mode: sections of rows. Pinned agents stay in the strip, so each
  // section lists only its unpinned members (`rows` already leaves pins out).
  const groupsOn = railGroups.grouped && props.agents.length > 0 && !query.trim();
  const sections = useMemo(() => {
    if (!groupsOn) return [];
    const byId = new Map<string, AgentRow>();
    for (const r of rows) if (r.kind === 'agent') byId.set(r.a.id, r);
    return railGroups.groups.map((g) => {
      const listed = g.agents.map((a) => byId.get(a.id)).filter((r): r is AgentRow => Boolean(r));
      return {
        g,
        rows: listed,
        pinned: g.agents.length - listed.length,
        working: listed.filter((r) => busyAgents.has(r.a.id)).length,
        // On jobs but not mid-turn, so it never doubles the working count.
        jobs: listed.filter((r) => jobsByAgent.has(r.a.id) && !busyAgents.has(r.a.id)).length,
        unread: listed.reduce((sum, r) => sum + (r.a.muted ? 0 : r.a.unread ?? 0), 0),
      };
      // "Other" only earns a header when someone is actually listed in it.
    }).filter((sec) => !sec.g.isOther || sec.rows.length > 0);
  }, [groupsOn, rows, railGroups.groups, busyAgents, jobsByAgent]);
  const realGroupCount = railGroups.groups.filter((g) => !g.isOther).length;

  const overGroup = (next: GroupDrop | null) => setGroupDrop((prev) => (
    prev?.group === next?.group && prev?.before === next?.before && prev?.head === next?.head ? prev : next
  ));
  // The landing spot is passed in by the drop itself, not read from state: a
  // fast drop can arrive before the last dragover has re-rendered.
  const commitGroupDrop = (to: GroupDrop) => {
    const id = dragId;
    setDragId(null);
    setGroupDrop(null);
    if (!id) return;
    // "Other" is ordered by the shared manual order, so a drop there releases the
    // agent from its group (if it had one) and then takes the landing spot in
    // that shared order; everything else is a layout edit.
    if (to.group === OTHER_GROUP_ID) {
      if (railGroups.groupIdOf(id) !== OTHER_GROUP_ID) railGroups.move(id, OTHER_GROUP_ID, null);
      reorderBefore(id, to.before ?? '__end__');
    } else railGroups.move(id, to.group, to.before);
  };
  const moveChoices = useMemo(() => [
    ...railGroups.groups.filter((g) => !g.isOther).map((g) => ({ id: g.id, name: g.name })),
    { id: OTHER_GROUP_ID, name: OTHER_GROUP_NAME },
  ], [railGroups.groups]);
  const moveAgentTarget = moveMenu ? props.agents.find((a) => a.id === moveMenu.id) : undefined;

  /** Where a drag over this row would land: upper half = before it, lower half
   *  = before the row below (null = end of the group). Landing where the row
   *  already sits is no target at all. */
  const rowDropTarget = (e: DragEvent, a: Agent, slot: RowSlot): GroupDrop | null => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2 ? a.id : slot.next;
    return before === dragId ? null : { group: slot.group, before };
  };

  // One agent row. `slot` is set in group mode (its group and the row below it).
  const renderRow = (r: Row, slot?: RowSlot) => {
    if (r.kind === 'agent') {
      const a = r.a;
      const isActive = props.activeChat && sameChatId(props.activeChat.chatId, a.home);
      const onJobs = jobsByAgent.get(a.id);
      // Group mode marks the landing line from `groupDrop`; the flat list from `dropBefore`.
      const landing = slot && dragId && dragId !== a.id && groupDrop && !groupDrop.head && groupDrop.group === slot.group ? groupDrop : null;
      const dropAbove = slot ? landing?.before === a.id : dropBefore === a.id && dragId && dragId !== a.id;
      const dropBelow = Boolean(landing && landing.before === null && slot?.next === null);
      return (
        <button
          key={`agent:${a.id}`}
          className={`bt-conv${isActive ? ' on' : ''}${a.muted ? ' muted' : ''}${dragId === a.id ? ' dragging' : ''}${dropAbove ? ' drop-above' : ''}${dropBelow ? ' drop-below' : ''}`}
          data-chat-color={chatColorOf(a)}
          onClick={(e) => { if (!swallowPressClick(e)) props.onOpenAgent(a); }}
          onContextMenu={(e) => openAgentMenu(e, a)}
          {...pressProps(a)}
          aria-haspopup="menu"
          aria-expanded={agentMenu?.id === a.id}
          title={`${a.name} · ${a.role}${colorLabel(a)}${a.muted ? ' · muted' : ''} (right-click or long-press to mute, pin, color, or edit)`}
          draggable
          onDragStart={(e) => {
            if (pressOpened.current) { e.preventDefault(); return; }
            cancelPress();
            setDragId(a.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.id);
          }}
          onDragOver={(e) => {
            if (!dragId || dragId === a.id) return;
            e.preventDefault();
            if (slot) { overGroup(rowDropTarget(e, a, slot)); return; }
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setDropBefore(e.clientY < rect.top + rect.height / 2 ? a.id : null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (!slot) { commitReorder(); return; }
            const to = rowDropTarget(e, a, slot);
            if (to) commitGroupDrop(to);
            else { setDragId(null); setGroupDrop(null); }
          }}
          onDragEnd={() => { setDragId(null); setDropBefore(null); setGroupDrop(null); }}
        >
          <span className="bt-disc bt-has-presence" style={{ color: DISC_INK, background: agentColor(a.name) }}>
            {agentAvatarUrl(a) ? <img className="bt-disc-img" src={agentAvatarUrl(a) ?? undefined} alt={a.name} /> : agentMark(a)}
            {liveAgents.has(a.id) ? <span className={`bt-presence${busyAgents.has(a.id) ? ' is-busy' : ''}`} aria-label={busyAgents.has(a.id) ? 'working now' : 'online now'} /> : null}
          </span>
          <span className="bt-conv-main">
            <span className="bt-conv-top">
              <span className="bt-conv-title">
                {a.name} <span className="bt-role-chip">{a.role}</span>
              </span>
              {onJobs ? <RailJobsBadge running={onJobs.running} latest={onJobs.latest} latestLine={onJobs.latestLine} /> : null}
              {a.muted ? <span className="bt-conv-mute" title="Notifications muted"><BellOff size={13} /></span> : a.unread ? <span className="bt-unread" title={`${a.unread} waiting`}>{a.unread > 9 ? '9+' : a.unread}</span> : null}
              {r.item ? <span className="bt-conv-day" title={`${new Date(r.item.updatedAt).toLocaleString()} · ${TIMEY_WIMEY}`}>{dayStamp(r.item.updatedAt)}</span> : null}
              <span
                className="bt-row-edit"
                role="button"
                tabIndex={-1}
                aria-label={`Edit ${a.name}`}
                title={`Edit ${a.name}`}
                onClick={(e) => { e.stopPropagation(); props.onEditAgent(a); }}
              >
                <Pencil size={12} />
              </span>
            </span>
            <span className="bt-conv-sub">{r.item?.preview ?? 'No work yet — give them something real.'}</span>
            {chatColorOf(a) ? <span className="bt-sr">{colorLabel(a)}</span> : null}
          </span>
        </button>
      );
    }
    const it = r.item!;
    const isActive = props.activeChat
      && sameChatId(it.chatId, props.activeChat.chatId)
      && (!props.activeChat.cli || it.cli === props.activeChat.cli)
      && (!props.activeChat.repo || it.repo === props.activeChat.repo);
    return (
      <button
        key={`${it.cli}:${it.repo}:${it.chatId}`}
        className={`bt-conv${isActive ? ' on' : ''}`}
        onClick={() => props.onOpenChat(it)}
        title={it.title}
      >
        <span className="bt-disc">{it.cli.slice(0, 1).toUpperCase()}</span>
        <span className="bt-conv-main">
          <span className="bt-conv-top">
            <span className="bt-conv-title">{it.title}</span>
            <span className="bt-conv-day" title={`${new Date(it.updatedAt).toLocaleString()} · ${TIMEY_WIMEY}`}>{dayStamp(it.updatedAt)}</span>
          </span>
          <span className="bt-conv-sub">{it.preview ?? it.cli}</span>
        </span>
      </button>
    );
  };

  return (
    <aside className={`bt-rail${props.drawerOpen ? ' drawer-open' : ''}`} ref={railRef} style={{ '--bt-rail-w': `${railWidth}px` } as CSSProperties}>
      <div className="bt-rail-head">
        <button className={`bt-mark-btn${lampFlash ? ' flash' : ''}`} onClick={() => { props.onHome(); onLampTap(); }} title="TARDIS home" aria-label="TARDIS home">
          <BotMark size={26} />
        </button>
        <div style={{ display: 'flex', gap: 4 }}>
          {props.onToggleCollapse ? (
            <button className="bt-iconbtn bt-rail-collapse" onClick={props.onToggleCollapse} title="Collapse sidebar" aria-label="Collapse sidebar">
              <PanelLeftClose size={17} />
            </button>
          ) : null}
          {props.drawerOpen ? (
            <button className="bt-iconbtn" onClick={props.onCloseDrawer} title="Close sidebar" aria-label="Close sidebar">
              <X size={17} />
            </button>
          ) : null}
          <button className="bt-iconbtn" onClick={props.onNewAgent} title="New companion" aria-label="New companion">
            <Plus size={18} />
          </button>
        </div>
      </div>

      <div className="bt-search">
        <div className="bt-search-box">
          <Search size={14} />
          <input
            value={query}
            placeholder="Search"
            aria-label="Search companions and chats"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          />
        </div>
      </div>

      <div className="bt-rail-scroll">
        {pins.length && !query.trim() ? (
          <div className="bt-pins" role="group" aria-label="Pinned companions">
            {pins.map((a, index) => {
              const isActive = props.activeChat && sameChatId(props.activeChat.chatId, a.home);
              const url = agentAvatarUrl(a);
              const dropHere = pinDrag && pinDrag !== a.id;
              const dropLeft = dropHere && pinDropBefore === a.id;
              const dropRight = dropHere && pinDropBefore === PINS_END && index === pins.length - 1;
              return (
                <button
                  key={`pin:${a.id}`}
                  className={`bt-pin${isActive ? ' on' : ''}${a.muted ? ' muted' : ''}${pinDrag === a.id ? ' dragging' : ''}${dropLeft ? ' drop-left' : ''}${dropRight ? ' drop-right' : ''}`}
                  data-chat-color={chatColorOf(a)}
                  onClick={(e) => { if (!swallowPressClick(e)) props.onOpenAgent(a); }}
                  onContextMenu={(e) => openAgentMenu(e, a)}
                  {...pressProps(a)}
                  aria-haspopup="menu"
                  aria-expanded={agentMenu?.id === a.id}
                  title={`${a.name} · ${a.role}${colorLabel(a)}${a.muted ? ' · muted' : ''} (right-click or long-press to mute, pin, color, or edit)`}
                  draggable
                  onDragStart={(e) => {
                    if (pressOpened.current) { e.preventDefault(); return; }
                    cancelPress();
                    setPinDrag(a.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.id);
                  }}
                  onDragOver={(e) => {
                    if (!pinDrag || pinDrag === a.id) return;
                    e.preventDefault();
                    const target = pinDropTarget(index, e);
                    // Dropping right beside itself changes nothing.
                    setPinDropBefore(target === pinDrag ? null : target);
                  }}
                  onDrop={(e) => { e.preventDefault(); commitPinReorder(); }}
                  onDragEnd={() => { setPinDrag(null); setPinDropBefore(null); }}
                >
                  <span className={`bt-pin-disc${liveAgents.has(a.id) ? ' has-presence' : ''}`} style={url ? undefined : { background: agentColor(a.name) }}>
                    {url ? <img src={url} alt={a.name} /> : agentMark(a)}
                    {a.muted ? <span className="bt-pin-mute" title="Notifications muted"><BellOff size={10} /></span> : a.unread ? <span className="bt-pin-unread">{a.unread > 9 ? '9+' : a.unread}</span> : null}
                  </span>
                  <span className="bt-pin-name">{a.name}</span>
                  <span className="bt-pin-role">{a.role}</span>
                  {chatColorOf(a) ? <span className="bt-sr">{colorLabel(a)}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {groupsOn ? (
          <div className="bt-groups">
            {sections.map((sec, i) => (
              <RailGroupSection
                key={sec.g.id}
                id={sec.g.id}
                name={sec.g.name}
                isOther={sec.g.isOther}
                count={sec.rows.length}
                pinned={sec.pinned}
                working={sec.working}
                jobs={sec.jobs}
                unread={sec.unread}
                collapsed={sec.g.collapsed}
                first={i === 0}
                last={i === realGroupCount - 1}
                dragging={dragId !== null}
                dropping={Boolean(groupDrop?.head && groupDrop.group === sec.g.id)}
                onToggle={() => railGroups.toggle(sec.g.id)}
                onRename={(name) => railGroups.rename(sec.g.id, name)}
                onDelete={() => railGroups.remove(sec.g.id)}
                onShift={(by) => railGroups.shift(sec.g.id, by)}
                onDropOver={() => overGroup({ group: sec.g.id, before: null, head: true })}
                onDropHere={() => commitGroupDrop({ group: sec.g.id, before: null, head: true })}
              >
                {sec.rows.map((r, at) => renderRow(r, { group: sec.g.id, next: sec.rows[at + 1]?.a.id ?? null }))}
              </RailGroupSection>
            ))}
          </div>
        ) : rows.map((r) => renderRow(r))}
        {!rows.length && !groupsOn ? (
          <div className="bt-pane-empty">
            {query ? 'No matches.' : pins.length ? 'Everyone is pinned up top — drag them back anytime.' : 'No companions yet — add one with +.'}
          </div>
        ) : null}
        {dragId && props.agents.length && !groupsOn ? (
          <div
            className={`bt-dropzone${dropBefore === '__end__' ? ' on' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDropBefore('__end__'); }}
            onDrop={(e) => { e.preventDefault(); commitReorder(); }}
          />
        ) : null}
        {props.agents.length && !query.trim() ? <RailNewGroup onCreate={railGroups.create} /> : null}
      </div>

      <div className="bt-rail-foot" style={{ position: 'relative' }} ref={pluginsRef}>
        {pluginsOpen ? (
          <div className="bt-plugins-pop" role="menu">
            <div className="bt-plug-h">Rooms</div>
            {ROOM_ENTRIES.filter((r) => (r.key !== 'content' || flags.contentRoom) && (r.key !== 'desk' || flags.deskRoom)).map((r) => (
              <button key={r.key} className="bt-plug-row" onClick={() => { props.onOpenRoom(r.key); setPluginsOpen(false); }}>
                {r.icon} {r.label}
              </button>
            ))}
            <div className="bt-plug-h">System</div>
            <button className="bt-plug-row" onClick={() => { props.onOpenStudio(); setPluginsOpen(false); }}>
              <AppWindow size={16} /> Studio IDE
            </button>
            <button className="bt-plug-row" onClick={() => { props.onToggleTheme(); setPluginsOpen(false); }}>
              {props.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />} {props.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            </button>
            <button className="bt-plug-row" onClick={() => { const next = !sound; setSound(next); writeSound(next); if (next) vworp(); }} aria-pressed={sound}>
              {sound ? <Volume2 size={16} /> : <VolumeX size={16} />} Sound {sound ? 'on' : 'off'}
            </button>
            <NativeOpenHelper />
          </div>
        ) : null}
        <button className="bt-foot-row" onClick={() => { setAppearanceOpen(false); setPluginsOpen((o) => !o); }} aria-haspopup="menu" aria-expanded={pluginsOpen}>
          <Plug size={17} /> Plugins
        </button>
        <button ref={appearanceTrigger} className="bt-foot-row" title="Your appearance settings" onClick={() => { setPluginsOpen(false); setAppearanceOpen((open) => !open); }} aria-haspopup="dialog" aria-expanded={appearanceOpen} aria-controls={appearanceOpen ? 'appearance-settings' : undefined}>
          <span className="bt-disc">Y</span> You
        </button>
        {appearanceOpen ? <AppearanceSettings
          theme={props.theme}
          visualStyle={props.visualStyle}
          onThemeChange={props.onThemeChange}
          onStyleChange={props.onStyleChange}
          onClose={(restoreFocus = true) => { setAppearanceOpen(false); if (restoreFocus) appearanceTrigger.current?.focus(); }}
          triggerRef={appearanceTrigger}
        /> : null}
        {idle && !anyBusy && !props.drawerOpen ? <div className="tardis-blink" aria-hidden="true">Don't blink.</div> : null}
      </div>
      {agentMenu && menuAgent ? (
        <AgentContextMenu
          menu={agentMenu}
          agent={menuAgent}
          onMute={(a) => props.onPatchAgent(a, { muted: !a.muted })}
          onPin={(a) => props.onPatchAgent(a, { pinned: !a.pinned })}
          onColor={(a, color) => props.onPatchAgent(a, { color })}
          onEdit={props.onEditAgent}
          onMoveToGroup={railGroups.grouped ? (a) => setMoveMenu({ ...agentMenu, id: a.id }) : undefined}
          onClose={closeAgentMenu}
          swallowPressRelease={swallowPressClick}
        />
      ) : null}
      {moveMenu && moveAgentTarget ? (
        <MoveToGroupMenu
          x={moveMenu.x}
          y={moveMenu.y}
          restore={moveMenu.restore}
          agentName={moveAgentTarget.name}
          choices={moveChoices}
          currentId={railGroups.groupIdOf(moveAgentTarget.id)}
          onPick={(groupId) => railGroups.move(moveAgentTarget.id, groupId, null)}
          onClose={closeMoveMenu}
        />
      ) : null}
      <div
        className={`bt-rail-resize${resizingRail ? ' on' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={RAIL_MIN}
        aria-valuemax={RAIL_MAX}
        aria-valuenow={railWidth}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onPointerDown={startRailResize}
        onDoubleClick={() => setRailWidth(RAIL_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          setRailWidth((w) => clampRailWidth(w + (e.key === 'ArrowRight' ? RAIL_KEY_STEP : -RAIL_KEY_STEP)));
        }}
      />
    </aside>
  );
}
