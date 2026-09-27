// Desk board: agent work in five columns, as a kanban or a compact list.
// Drag and drop on desktop; a column picker plus per-card Move on phones.

import { ArrowDown, ArrowUp, Archive, GripVertical, LayoutGrid, List, MessageSquare, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DragEvent, FormEvent, KeyboardEvent } from 'react';
import { Button, Chip } from '../components/Primitives';
import { useMediaQuery } from '../chat/hooks/useMediaQuery';
import {
  DESK_COLUMNS,
  PRIORITY_RANK,
  ageLabel,
  deskApi,
  hoursSince,
  useDeskWrite,
  type DeskCard,
  type DeskColumn,
  type DeskPriority,
  type DeskSnapshot,
} from '../data/desk';
import { showToast } from '../native/shell';
import type { Agent } from '../grok/agents';
import { ActorChip, PRIORITY_LABEL, errorText, priorityClass } from './deskParts';

type Props = { desk: DeskSnapshot; agents: Agent[]; onOpenCard: (id: string) => void };
type Layout = 'board' | 'list';
type Filters = { owner: string; project: string; archived: boolean };
type SortKey = 'title' | 'owner' | 'project' | 'priority' | 'comments' | 'updated';
type DragTarget = { column: DeskColumn; beforeId: string | null } | null;

const LAYOUT_KEY = 'rivendell:desk-layout';
const FILTER_KEY = 'rivendell:desk-filters';
const MOBILE_COL_KEY = 'rivendell:desk-mobile-column';
const DONE_PREVIEW = 12;
/** A card in an active column with no update for this long gets flagged. */
const STALE_HOURS = 48;

export const COLUMN_DETAIL: Record<DeskColumn, string> = {
  pipeline: 'Parked or not started',
  up_next: 'Queued to start',
  in_progress: 'Being worked now',
  waiting: 'Blocked on your call',
  done: 'Finished',
};

function readFilters(): Filters {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') as Partial<Filters>;
    return { owner: typeof raw.owner === 'string' ? raw.owner : 'all', project: typeof raw.project === 'string' ? raw.project : 'all', archived: raw.archived === true };
  } catch {
    return { owner: 'all', project: 'all', archived: false };
  }
}

export function columnTitle(desk: DeskSnapshot, column: DeskColumn): string {
  return desk.columns.find((c) => c.key === column)?.title ?? column;
}

/** The value an owner <select> uses: 'owner' for the human, else agent id. */
export function ownerKey(card: Pick<DeskCard, 'owner'>): string {
  return card.owner.kind === 'owner' ? 'owner' : card.owner.id;
}

export function ownerOptions(desk: DeskSnapshot, agents: Agent[]): Array<{ value: string; label: string }> {
  const out = new Map<string, string>([['owner', desk.owner.name]]);
  for (const agent of agents) out.set(agent.id, agent.name);
  for (const card of desk.cards) if (!out.has(ownerKey(card))) out.set(ownerKey(card), card.owner.name);
  return [...out].map(([value, label]) => ({ value, label }));
}

export function projectOptions(desk: DeskSnapshot): string[] {
  return [...new Set(desk.cards.map((c) => c.project).filter((p): p is string => Boolean(p)))].sort((a, b) => a.localeCompare(b));
}

/** Mirror of the server's placement so a drop lands instantly. */
function moveLocal(desk: DeskSnapshot, id: string, column: DeskColumn, index: number): DeskSnapshot {
  const card = desk.cards.find((c) => c.id === id);
  if (!card) return desk;
  const now = new Date().toISOString();
  const moved: DeskCard = { ...card, column, archived: undefined, updatedAt: now, columnSince: column === card.column ? card.columnSince : now };
  const others = desk.cards.filter((c) => c.id !== id);
  const peers = others.filter((c) => c.column === column && !c.archived);
  const at = Math.max(0, Math.min(index, peers.length));
  const position = !peers.length ? others.length : at >= peers.length ? others.indexOf(peers[peers.length - 1]) + 1 : others.indexOf(peers[at]);
  others.splice(position, 0, moved);
  return { ...desk, cards: others };
}

export function useCardMover() {
  const write = useDeskWrite();
  return async (desk: DeskSnapshot, id: string, column: DeskColumn, beforeId: string | null = null) => {
    const peers = desk.cards.filter((c) => c.column === column && !c.archived && c.id !== id);
    const found = beforeId ? peers.findIndex((c) => c.id === beforeId) : -1;
    const index = found >= 0 ? found : beforeId === null && column !== 'done' ? peers.length : 0;
    try {
      await write(() => deskApi.moveCard(id, column, index), (d) => moveLocal(d, id, column, index));
    } catch (error) {
      showToast(`Could not move the card: ${errorText(error)}`);
    }
  };
}

export function DeskBoard({ desk, agents, onOpenCard }: Props) {
  const isMobile = useMediaQuery('(max-width: 760px)');
  const move = useCardMover();
  const [layout, setLayout] = useState<Layout>(() => (localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'board'));
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [creating, setCreating] = useState<DeskColumn | null>(null);
  const [mobileColumn, setMobileColumn] = useState<DeskColumn>(() => {
    const saved = localStorage.getItem(MOBILE_COL_KEY) as DeskColumn | null;
    return saved && (DESK_COLUMNS as readonly string[]).includes(saved) ? saved : 'in_progress';
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);

  useEffect(() => { localStorage.setItem(LAYOUT_KEY, layout); }, [layout]);
  useEffect(() => { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); }, [filters]);
  useEffect(() => { localStorage.setItem(MOBILE_COL_KEY, mobileColumn); }, [mobileColumn]);

  const owners = useMemo(() => ownerOptions(desk, agents), [desk, agents]);
  const projects = useMemo(() => projectOptions(desk), [desk]);
  const openTodoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of desk.todos) if (t.status === 'open' && t.cardId) counts.set(t.cardId, (counts.get(t.cardId) ?? 0) + 1);
    return counts;
  }, [desk.todos]);

  const visible = useMemo(() => desk.cards.filter((c) =>
    (filters.archived || !c.archived)
    && (filters.owner === 'all' || ownerKey(c) === filters.owner)
    && (filters.project === 'all' || (c.project ?? '') === filters.project)), [desk.cards, filters]);
  const byColumn = useMemo(() => {
    const map = new Map<DeskColumn, DeskCard[]>(DESK_COLUMNS.map((col) => [col, []]));
    for (const card of visible) map.get(card.column)?.push(card);
    return map;
  }, [visible]);
  const filtered = filters.owner !== 'all' || filters.project !== 'all';
  const archivedCount = desk.cards.filter((c) => c.archived).length;

  const onDrop = (column: DeskColumn, beforeId: string | null, event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    setDragTarget(null);
    if (!id || id === beforeId) return;
    void move(desk, id, column, beforeId);
  };

  const cardProps = (card: DeskCard) => ({
    card,
    desk,
    needsYou: openTodoCounts.get(card.id) ?? 0,
    draggable: !isMobile,
    dragging: dragId === card.id,
    showMove: isMobile,
    onOpen: () => onOpenCard(card.id),
    onMove: (column: DeskColumn) => void move(desk, card.id, column, null),
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', card.id);
      setDragId(card.id);
    },
    onDragEnd: () => { setDragId(null); setDragTarget(null); },
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (dragTarget?.beforeId !== card.id) setDragTarget({ column: card.column, beforeId: card.id });
    },
    onDrop: (event: DragEvent) => onDrop(card.column, card.id, event),
  });

  const renderColumnCards = (column: DeskColumn) => {
    const cards = byColumn.get(column) ?? [];
    const shown = column === 'done' && !showAllDone ? cards.slice(0, DONE_PREVIEW) : cards;
    return (
      <>
        {shown.length ? shown.map((card) => (
          <div key={card.id} className={`desk-slot${dragTarget?.beforeId === card.id && dragId !== card.id ? ' is-before' : ''}`}>
            <BoardCard {...cardProps(card)} />
          </div>
        )) : (
          <div className="column-empty desk-col-empty">{emptyCopy(column, filtered)}</div>
        )}
        {column === 'done' && cards.length > DONE_PREVIEW ? (
          <button type="button" className="desk-more" onClick={() => setShowAllDone((v) => !v)}>
            {showAllDone ? 'Show fewer' : `Show all ${cards.length}`}
          </button>
        ) : null}
      </>
    );
  };

  return (
    <section className="desk-board-wrap" aria-label="Board">
      <div className="desk-toolbar">
        <div className="desk-seg" role="group" aria-label="Board layout">
          <button type="button" aria-pressed={layout === 'board'} onClick={() => setLayout('board')}><LayoutGrid size={14} aria-hidden="true" /> Board</button>
          <button type="button" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={14} aria-hidden="true" /> List</button>
        </div>
        <label className="desk-filter">
          <span>Owner</span>
          <select value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })}>
            <option value="all">Everyone</option>
            {owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="desk-filter">
          <span>Project</span>
          <select value={filters.project} onChange={(e) => setFilters({ ...filters, project: e.target.value })}>
            <option value="all">All projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        {archivedCount ? (
          <label className="desk-toggle">
            <input type="checkbox" checked={filters.archived} onChange={(e) => setFilters({ ...filters, archived: e.target.checked })} />
            <Archive size={13} aria-hidden="true" /> Archived ({archivedCount})
          </label>
        ) : null}
        {filtered ? (
          <button type="button" className="desk-mini-btn" onClick={() => setFilters({ ...filters, owner: 'all', project: 'all' })}>
            <X size={13} aria-hidden="true" /> Clear
          </button>
        ) : null}
        <Button tone="gold" className="desk-new-btn" onClick={() => setCreating((c) => (c ? null : isMobile ? mobileColumn : 'up_next'))}>
          <Plus size={15} /> New card
        </Button>
      </div>

      {creating ? (
        <NewCardForm
          desk={desk}
          owners={owners}
          projects={projects}
          column={creating}
          onDone={() => setCreating(null)}
        />
      ) : null}

      {layout === 'list' ? (
        <CardList desk={desk} byColumn={byColumn} sort={sort} onSort={setSort} onOpen={onOpenCard} needsYou={openTodoCounts} />
      ) : isMobile ? (
        <div className="desk-mobile">
          <div className="desk-colpick" role="tablist" aria-label="Column">
            {DESK_COLUMNS.map((col) => (
              <button key={col} type="button" role="tab" data-col={col} aria-selected={mobileColumn === col} onClick={() => setMobileColumn(col)}>
                {columnTitle(desk, col)} <span className="desk-count is-quiet">{byColumn.get(col)?.length ?? 0}</span>
              </button>
            ))}
          </div>
          <section className="kanban-column desk-col is-single" data-col={mobileColumn}>
            <header>
              <div>
                <h2>{columnTitle(desk, mobileColumn)}</h2>
                <span>{COLUMN_DETAIL[mobileColumn]}</span>
              </div>
              <button type="button" className="desk-icon-btn" onClick={() => setCreating(mobileColumn)} aria-label={`Add a card to ${columnTitle(desk, mobileColumn)}`}><Plus size={15} /></button>
            </header>
            <div className="kanban-stack desk-stack">{renderColumnCards(mobileColumn)}</div>
          </section>
        </div>
      ) : (
        <div className="desk-board">
          {DESK_COLUMNS.map((col) => {
            const count = byColumn.get(col)?.length ?? 0;
            return (
              <section
                key={col}
                className={`kanban-column desk-col${dragTarget?.column === col ? ' is-drop-target' : ''}`}
                data-col={col}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (dragTarget?.column !== col || dragTarget.beforeId !== null) setDragTarget({ column: col, beforeId: null });
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragTarget((t) => (t?.column === col ? null : t));
                }}
                onDrop={(event) => onDrop(col, null, event)}
              >
                <header>
                  <div>
                    <h2>{columnTitle(desk, col)}</h2>
                    <span>{COLUMN_DETAIL[col]}</span>
                  </div>
                  <div className="desk-col-actions">
                    <code>{count}</code>
                    <button type="button" className="desk-icon-btn" onClick={() => setCreating(col)} aria-label={`Add a card to ${columnTitle(desk, col)}`} title="Add a card here"><Plus size={14} /></button>
                  </div>
                </header>
                <div className="kanban-stack desk-stack">{renderColumnCards(col)}</div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function emptyCopy(column: DeskColumn, filtered: boolean): string {
  if (filtered) return 'Nothing here for this filter.';
  switch (column) {
    case 'pipeline': return 'Nothing parked. Paused work lands here so it is not forgotten.';
    case 'up_next': return 'Nothing queued.';
    case 'in_progress': return 'No one is on a card right now.';
    case 'waiting': return 'Nothing is waiting on you.';
    default: return 'Nothing finished yet.';
  }
}

export function cardAge(card: DeskCard): { text: string; short: string; stale: boolean; title: string } {
  if (card.column === 'pipeline') {
    const short = ageLabel(card.columnSince);
    return { text: `parked ${short}`, short, stale: hoursSince(card.columnSince) > 24 * 7, title: `In Pipeline since ${new Date(card.columnSince).toLocaleString()}` };
  }
  const quiet = hoursSince(card.updatedAt);
  const active = card.column === 'up_next' || card.column === 'in_progress' || card.column === 'waiting';
  const stale = active && !card.archived && quiet > STALE_HOURS;
  return {
    text: ageLabel(card.updatedAt),
    short: ageLabel(card.updatedAt),
    stale,
    title: stale ? `No update for ${ageLabel(card.updatedAt)}` : `Updated ${new Date(card.updatedAt).toLocaleString()}`,
  };
}

function BoardCard({
  card, desk, needsYou, draggable, dragging, showMove, onOpen, onMove, onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  card: DeskCard;
  desk: DeskSnapshot;
  needsYou: number;
  draggable: boolean;
  dragging: boolean;
  showMove: boolean;
  onOpen: () => void;
  onMove: (column: DeskColumn) => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}) {
  const age = cardAge(card);
  const onKey = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); }
  };
  return (
    <article
      className={`task-card desk-card ${priorityClass(card.priority)}${dragging ? ' is-dragging' : ''}${card.archived ? ' is-archived' : ''}${age.stale ? ' is-stale' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={`${card.title}, ${columnTitle(desk, card.column)}, owner ${card.owner.name}`}
      draggable={draggable}
      onClick={(event) => { if (!(event.target as HTMLElement).closest('select, label, a')) onOpen(); }}
      onKeyDown={onKey}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="desk-card-head">
        {draggable ? <GripVertical size={14} aria-hidden="true" className="desk-grip" /> : null}
        <strong>{card.title}</strong>
      </div>
      <div className="desk-card-meta">
        <ActorChip actor={card.owner} />
        {card.project ? <span className="desk-project">{card.project}</span> : null}
        {card.priority !== 'normal' ? <Chip tone={card.priority === 'high' ? 'rose' : 'emerald'}>{PRIORITY_LABEL[card.priority]}</Chip> : null}
        {needsYou ? <span className="desk-needs-pill" title="Open Needs-you items for this card">needs you</span> : null}
        {card.comments.length ? (
          <span className="desk-comments" title={`${card.comments.length} comment${card.comments.length === 1 ? '' : 's'}`}>
            <MessageSquare size={11} aria-hidden="true" />{card.comments.length}
          </span>
        ) : null}
        {card.archived ? <span className="desk-project">archived</span> : null}
        <span className={`desk-age${age.stale ? ' is-stale' : ''}`} title={age.title}>{age.text}</span>
      </div>
      {showMove ? (
        <label className="task-status-select desk-move" onClick={(e) => e.stopPropagation()}>
          <span>Move</span>
          <select value="" aria-label={`Move ${card.title}`} onChange={(e) => { if (e.target.value) onMove(e.target.value as DeskColumn); }}>
            <option value="" disabled>Move to…</option>
            {DESK_COLUMNS.filter((col) => col !== card.column).map((col) => <option key={col} value={col}>{columnTitle(desk, col)}</option>)}
          </select>
        </label>
      ) : null}
    </article>
  );
}

// ---- list view -------------------------------------------------------------------------

function sortCards(cards: DeskCard[], sort: { key: SortKey; dir: 1 | -1 } | null): DeskCard[] {
  if (!sort) return cards;
  const value = (c: DeskCard): string | number => {
    switch (sort.key) {
      case 'title': return c.title.toLowerCase();
      case 'owner': return c.owner.name.toLowerCase();
      case 'project': return (c.project ?? '￿').toLowerCase();
      case 'priority': return PRIORITY_RANK[c.priority];
      case 'comments': return c.comments.length;
      default: return -Date.parse(c.updatedAt);
    }
  };
  return [...cards].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
  });
}

function CardList({
  desk, byColumn, sort, onSort, onOpen, needsYou,
}: {
  desk: DeskSnapshot;
  byColumn: Map<DeskColumn, DeskCard[]>;
  sort: { key: SortKey; dir: 1 | -1 } | null;
  onSort: (next: { key: SortKey; dir: 1 | -1 } | null) => void;
  onOpen: (id: string) => void;
  needsYou: Map<string, number>;
}) {
  const header = (key: SortKey, label: string, className?: string) => {
    const active = sort?.key === key;
    return (
      <th className={className} aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          onClick={() => onSort(!active ? { key, dir: 1 } : sort!.dir === 1 ? { key, dir: -1 } : null)}
          title={active ? 'Click to change sort' : `Sort by ${label.toLowerCase()}`}
        >
          {label}
          {active ? (sort!.dir === 1 ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" />) : null}
        </button>
      </th>
    );
  };
  const any = DESK_COLUMNS.some((col) => byColumn.get(col)?.length);
  if (!any) return <div className="column-empty desk-list-empty">No cards yet. Agents add cards as they pick up real work.</div>;
  return (
    <div className="desk-list">
      {DESK_COLUMNS.map((col) => {
        const cards = sortCards(byColumn.get(col) ?? [], sort);
        if (!cards.length) return null;
        return (
          <section key={col} className="desk-list-group" data-col={col}>
            <h3>{columnTitle(desk, col)} <code>{cards.length}</code></h3>
            <table className="desk-table">
              <thead>
                <tr>
                  {header('title', 'Card')}
                  {header('owner', 'Owner')}
                  {header('project', 'Project', 'desk-hide-sm')}
                  {header('priority', 'Priority', 'desk-hide-sm')}
                  {header('comments', 'Notes', 'desk-hide-sm')}
                  {header('updated', 'Updated')}
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => {
                  const age = cardAge(card);
                  return (
                    <tr
                      key={card.id}
                      tabIndex={0}
                      className={`${card.archived ? 'is-archived' : ''}${age.stale ? ' is-stale' : ''}`}
                      onClick={() => onOpen(card.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(card.id); } }}
                    >
                      <td>
                        <span className={`priority-dot ${priorityClass(card.priority)}`} aria-hidden="true" />
                        <span className="desk-table-title">{card.title}</span>
                        {needsYou.get(card.id) ? <span className="desk-needs-pill">needs you</span> : null}
                      </td>
                      <td><ActorChip actor={card.owner} /></td>
                      <td className="desk-hide-sm">{card.project ?? ''}</td>
                      <td className="desk-hide-sm">{PRIORITY_LABEL[card.priority]}</td>
                      <td className="desk-hide-sm">{card.comments.length || ''}</td>
                      <td><span className={`desk-age${age.stale ? ' is-stale' : ''}`} title={age.title}>{age.short}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

// ---- new card ---------------------------------------------------------------------------

function NewCardForm({
  desk, owners, projects, column, onDone,
}: {
  desk: DeskSnapshot;
  owners: Array<{ value: string; label: string }>;
  projects: string[];
  column: DeskColumn;
  onDone: () => void;
}) {
  const write = useDeskWrite();
  const [draft, setDraft] = useState({ title: '', description: '', owner: 'owner', project: '', priority: 'normal' as DeskPriority, column });
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft((d) => ({ ...d, column })); }, [column]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title || saving) return;
    setSaving(true);
    try {
      await write(() => deskApi.createCard({
        title,
        description: draft.description,
        owner: draft.owner,
        project: draft.project,
        priority: draft.priority,
        column: draft.column,
        index: 0,
      }));
      onDone();
    } catch (error) {
      showToast(`Could not create the card: ${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="desk-new-card" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') onDone(); }}>
      <div className="desk-fields">
        <label className="is-wide">
          Card
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="What is the work?" maxLength={200} autoFocus />
        </label>
        <label className="is-wide">
          Description
          <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} maxLength={8000} placeholder="Goal, scope, anything a teammate needs" />
        </label>
        <label>
          Owner
          <select value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })}>
            {owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label>
          Project
          <input value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} list="desk-projects" placeholder="Operly, Studio, TARDIS…" maxLength={60} />
          <datalist id="desk-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
        </label>
        <label>
          Column
          <select value={draft.column} onChange={(e) => setDraft({ ...draft, column: e.target.value as DeskColumn })}>
            {DESK_COLUMNS.map((col) => <option key={col} value={col}>{columnTitle(desk, col)}</option>)}
          </select>
        </label>
        <label>
          Priority
          <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as DeskPriority })}>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
      </div>
      <div className="desk-edit-actions">
        <Button tone="ghost" type="button" onClick={onDone}><X size={14} /> Cancel</Button>
        <Button tone="gold" type="submit" disabled={!draft.title.trim() || saving}><Plus size={14} /> Add card</Button>
      </div>
    </form>
  );
}
