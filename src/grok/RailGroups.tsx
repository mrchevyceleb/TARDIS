// Left-rail group sections: the collapsible header (name, count, chevron, and a
// working/unread summary while folded shut), its options menu, and the
// "New group" button. The sidebar owns the agent rows and the drag state; this
// file only draws the frame around them.

import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Check, ChevronRight, Ellipsis, Pencil, Plus, Trash2 } from 'lucide-react';
import { RailJobsBadge } from '../chat/components/jobs/RailJobsBadge';
import { GROUP_NAME_MAX, OTHER_GROUP_NAME } from './railGroups';
import './railGroups.css';

/** A count chip that pops whenever its number changes (not on first paint). */
function PopBadge({ value, className, children }: { value: number; className: string; children: ReactNode }) {
  const seen = useRef(value);
  const [pops, setPops] = useState(0);
  useEffect(() => {
    if (seen.current === value) return;
    seen.current = value;
    setPops((n) => n + 1);
  }, [value]);
  // A new key restarts the CSS animation on the same element.
  return <span key={pops} className={`${className}${pops ? ' bt-pop' : ''}`} aria-hidden="true">{children}</span>;
}

function menuButtons(root: HTMLElement | null): HTMLButtonElement[] {
  return root ? [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] : [];
}

/** Shared popup shell: portaled into .bot-app (so theme tokens apply), kept on
 *  screen, arrow-key navigable, closed by Escape / outside press / scroll. */
function RailMenu({ x, y, restore, skipRestore, label, onClose, children }: {
  x: number;
  y: number;
  restore: HTMLElement | null;
  /** Set true to leave focus alone on close (something else took it). */
  skipRestore?: { current: boolean };
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node) {
      const left = Math.max(8, Math.min(x, window.innerWidth - node.offsetWidth - 8));
      const top = Math.max(8, Math.min(y, window.innerHeight - node.offsetHeight - 8));
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      menuButtons(node)[0]?.focus();
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
      if (!skipRestore?.current && restore?.isConnected) restore.focus();
    };
  }, [onClose, x, y, restore, skipRestore]);

  const onMenuKey = (e: ReactKeyEvent<HTMLDivElement>) => {
    const items = menuButtons(ref.current);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
    }
    if (e.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
    else if (e.key === 'Home') items[0]?.focus();
    else if (e.key === 'End') items[items.length - 1]?.focus();
    else if (e.key === 'Tab') onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className="bt-agent-ctx"
      style={{ left: x, top: y }}
      role="menu"
      aria-label={label}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onMenuKey}
    >
      {children}
    </div>,
    document.querySelector('.bot-app') ?? document.body,
  );
}

/** The non-drag way to file a companion: works on a phone (long-press the row)
 *  and from the keyboard (context-menu key), and lists every group by name. */
export function MoveToGroupMenu({ x, y, restore, agentName, choices, currentId, onPick, onClose }: {
  x: number;
  y: number;
  restore: HTMLElement | null;
  agentName: string;
  choices: { id: string; name: string }[];
  currentId: string;
  onPick: (groupId: string) => void;
  onClose: () => void;
}) {
  return (
    <RailMenu x={x} y={y} restore={restore} label={`Move ${agentName} to a group`} onClose={onClose}>
      <div className="bt-ctx-heading" aria-hidden="true">Move {agentName} to</div>
      {choices.map((g) => (
        <button
          key={g.id}
          type="button"
          role="menuitemradio"
          aria-checked={g.id === currentId}
          className="bt-plug-row"
          onClick={() => { if (g.id !== currentId) onPick(g.id); onClose(); }}
        >
          {g.id === currentId ? <Check size={16} strokeWidth={3} /> : <span className="bt-ctx-spacer" aria-hidden="true" />}
          {g.name}
        </button>
      ))}
    </RailMenu>
  );
}

type GroupMenuProps = {
  x: number;
  y: number;
  restore: HTMLElement | null;
  name: string;
  /** Everyone assigned to the group (pinned ones too) who would move to "Other" if it is deleted. */
  memberCount: number;
  canUp: boolean;
  canDown: boolean;
  onRename: () => void;
  onDelete: () => void;
  onShift: (by: -1 | 1) => void;
  onClose: () => void;
};

function GroupMenu({ x, y, restore, name, memberCount, canUp, canDown, onRename, onDelete, onShift, onClose }: GroupMenuProps) {
  // Renaming hands focus to the name field, so the menu must not pull it back.
  const skipRestore = useRef(false);
  // An empty group goes at once; one with members asks for a second click.
  const [confirming, setConfirming] = useState(false);

  return (
    <RailMenu x={x} y={y} restore={restore} skipRestore={skipRestore} label={`${name} group actions`} onClose={onClose}>
      <button type="button" role="menuitem" className="bt-plug-row" onClick={() => { skipRestore.current = true; onRename(); onClose(); }}>
        <Pencil size={16} />
        Rename
      </button>
      <button type="button" role="menuitem" className="bt-plug-row" disabled={!canUp} onClick={() => { onShift(-1); onClose(); }}>
        <ArrowUp size={16} />
        Move up
      </button>
      <button type="button" role="menuitem" className="bt-plug-row" disabled={!canDown} onClick={() => { onShift(1); onClose(); }}>
        <ArrowDown size={16} />
        Move down
      </button>
      <div className="bt-ctx-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className={`bt-plug-row is-danger${confirming ? ' is-armed' : ''}`}
        onClick={() => {
          if (memberCount > 0 && !confirming) { setConfirming(true); return; }
          skipRestore.current = true;
          onDelete();
          onClose();
        }}
      >
        <Trash2 size={16} />
        {confirming ? `Confirm: ${memberCount} move to ${OTHER_GROUP_NAME}` : 'Delete group'}
      </button>
    </RailMenu>
  );
}

export type RailGroupSectionProps = {
  id: string;
  name: string;
  isOther: boolean;
  /** Companions listed in this group (pinned ones live in the strip above). */
  count: number;
  /** Members shown in the pinned strip instead, so an empty list is not empty. */
  pinned: number;
  /** Listed companions mid-turn right now. */
  working: number;
  /** Listed companions running background jobs. Counted on their own, so one can also be mid-turn. */
  jobs: number;
  /** Unread replies across listed companions (muted ones already count zero). */
  unread: number;
  collapsed: boolean;
  /** First / last real group, so Move up / Move down can disable. */
  first: boolean;
  last: boolean;
  /** An agent row is being dragged somewhere in the rail. */
  dragging: boolean;
  /** That drag is hovering this group's header or empty slot. */
  dropping: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onShift: (by: -1 | 1) => void;
  /** The dragged row is over the header / empty slot: append to this group. */
  onDropOver: () => void;
  onDropHere: () => void;
  children: ReactNode;
};

export function RailGroupSection(props: RailGroupSectionProps) {
  const { id, name, isOther, count, working, jobs, unread, collapsed, dragging, dropping } = props;
  const bodyId = useId();
  const [menu, setMenu] = useState<{ x: number; y: number; restore: HTMLElement | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const settled = useRef(false);
  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenuAt = (x: number, y: number, restore: HTMLElement | null) => setMenu({ x, y, restore });
  const startRename = () => { settled.current = false; setDraft(name); setEditing(true); };
  const finishRename = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    if (commit && draft.trim() && draft.trim() !== name) props.onRename(draft);
  };

  const summary = [
    `${name}, ${count} ${count === 1 ? 'companion' : 'companions'}`,
    working ? `${working} working` : '',
    jobs ? `${jobs} on background jobs` : '',
    unread ? `${unread} unread` : '',
  ].filter(Boolean).join(', ');

  const dropProps = {
    onDragOver: (e: DragEvent) => { if (!dragging) return; e.preventDefault(); props.onDropOver(); },
    onDrop: (e: DragEvent) => { if (!dragging) return; e.preventDefault(); props.onDropHere(); },
  };

  return (
    <section className={`bt-group${collapsed ? ' is-collapsed' : ''}${dropping ? ' is-drop' : ''}`} data-group={id}>
      <div
        className="bt-group-head"
        {...dropProps}
        onContextMenu={isOther ? undefined : (e: MouseEvent) => { e.preventDefault(); openMenuAt(e.clientX, e.clientY, e.currentTarget instanceof HTMLElement ? e.currentTarget : null); }}
      >
        {editing ? (
          <div className="bt-group-toggle is-editing">
            <ChevronRight className="bt-group-chev" size={15} aria-hidden="true" />
            <input
              className="bt-group-input"
              autoFocus
              value={draft}
              maxLength={GROUP_NAME_MAX}
              aria-label={`Rename ${name}`}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => finishRename(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishRename(false); }
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className="bt-group-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={summary}
            title={summary}
            onClick={props.onToggle}
          >
            <ChevronRight className="bt-group-chev" size={15} aria-hidden="true" />
            <span className="bt-group-name" aria-hidden="true">{name}</span>
            <span className="bt-group-count" aria-hidden="true">{count}</span>
            {collapsed && (working > 0 || jobs > 0 || unread > 0) ? (
              <span className="bt-group-chips">
                {working > 0 ? <PopBadge value={working} className="bt-group-working"><span className="bt-group-dot" />{working} working</PopBadge> : null}
                {jobs > 0 ? <PopBadge value={jobs} className="bt-group-jobs"><RailJobsBadge running={jobs} label={`${jobs} on jobs`} /></PopBadge> : null}
                {unread > 0 ? <PopBadge value={unread} className="bt-unread">{unread > 9 ? '9+' : unread}</PopBadge> : null}
              </span>
            ) : null}
          </button>
        )}
        {isOther ? null : (
          <button
            type="button"
            className="bt-group-more"
            aria-label={`${name} group options`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              openMenuAt(rect.right - 256, rect.bottom + 4, e.currentTarget);
            }}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <div id={bodyId} className="bt-group-body" role="group" aria-label={name} inert={collapsed}>
        <div className="bt-group-body-inner">
          {props.children}
          {count === 0 ? (
            <div className={`bt-group-empty${dropping ? ' on' : ''}`} {...dropProps}>
              {props.pinned > 0 ? 'Everyone here is pinned up top.' : 'Empty. Drag a companion here, or use Move to group.'}
            </div>
          ) : null}
        </div>
      </div>
      {menu ? (
        <GroupMenu
          x={menu.x}
          y={menu.y}
          restore={menu.restore}
          name={name}
          memberCount={count + props.pinned}
          canUp={!props.first}
          canDown={!props.last}
          onRename={startRename}
          onDelete={props.onDelete}
          onShift={props.onShift}
          onClose={closeMenu}
        />
      ) : null}
    </section>
  );
}

/** "New group" at the foot of the list: a button that opens a one-line name field. */
export function RailNewGroup({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const settled = useRef(false);
  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setOpen(false);
    if (commit && draft.trim()) onCreate(draft);
    setDraft('');
  };
  if (!open) {
    return (
      <button type="button" className="bt-group-new" onClick={() => { settled.current = false; setOpen(true); }}>
        <Plus size={14} aria-hidden="true" />
        New group
      </button>
    );
  }
  return (
    <form className="bt-group-new is-editing" onSubmit={(e) => { e.preventDefault(); finish(true); }}>
      <Plus size={14} aria-hidden="true" />
      <input
        className="bt-group-input"
        autoFocus
        value={draft}
        maxLength={GROUP_NAME_MAX}
        placeholder="Group name"
        aria-label="New group name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } }}
      />
    </form>
  );
}
