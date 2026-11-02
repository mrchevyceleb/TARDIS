// Desk: one place for what needs the owner ("Needs you") and what every agent
// is working on (the Board). Agents write here through the team MCP; the room
// polls so their updates land without a refresh.

import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardList, ExternalLink, Inbox, LayoutGrid, MessageSquare, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent, RefObject } from 'react';
import { DesktopAlertsButton } from '../components/NeedsYouBadge';
import { Button, Chip } from '../components/Primitives';
import { RoomHeader } from '../components/RoomHeader';
import { ROOM_NAMES } from '../data/roomNames';
import {
  DESK_FIRST_OPEN,
  DESK_FOCUS_EVENT,
  ageLabel,
  agentTaskMap,
  agoText,
  clearDeskFocus,
  deskApi,
  discussOnDesk,
  dueLabel,
  isTodoOpen,
  isTodoSnoozed,
  openAgentThread,
  peekDeskFocus,
  sortOpenTodos,
  useDesk,
  useDeskCard,
  withThread,
  withHeadline,
  useDeskSummary,
  useDeskWrite,
  type DeskCard,
  type DeskPriority,
  type DeskRef,
  type DeskSnapshot,
  type DeskTodo,
  type TodoPatch,
} from '../data/desk';
import { showToast } from '../native/shell';
import type { Agent } from '../grok/agents';
import {
  ActorChip,
  AnswerBar,
  AnsweredNote,
  DiscussButton,
  PRIORITY_LABEL,
  answerRecipient,
  recipientAgent,
  canAnswer,
  errorText,
  focusTodoAnswer,
  linkLabel,
  linkifyText,
  priorityClass,
  useDeskAgents,
  useTodoAnswers,
  type TodoAnswers,
} from './deskParts';
import { SnoozedTodos, SnoozeTodoControl } from './DeskSnooze';
import { DeskBoard } from './DeskBoard';
import { DeskCardDrawer } from './DeskCardDrawer';
import { DeskTeamView } from './DeskTeamView';
import './desk.css';

type Tab = 'home' | 'board';
const TAB_KEY = 'rivendell:desk-tab';
/** The board tab's style: the team view is the default (Matt, Oct 17: one
 *  glance per team), the column board stays one click away. */
type BoardStyle = 'team' | 'columns';
const BOARD_STYLE_KEY = 'rivendell:desk-board-style';

export function Desk() {
  const desk = useDesk();
  const agents = useDeskAgents();
  // The shell's summary poll says whether this server takes answers yet.
  const answerable = useDeskSummary(false).data?.answerable === true;
  const [tab, setTab] = useState<Tab>(() => {
    // A desk deep link carrying ?board (e.g. ?desk=open&board) lands straight
    // on the Board tab's team view, so a shared look URL opens where the
    // reader expects instead of an unrelated chat.
    if (new URLSearchParams(window.location.search).has('board')) return 'board';
    return localStorage.getItem(TAB_KEY) === 'board' ? 'board' : 'home';
  });
  const [boardStyle, setBoardStyle] = useState<BoardStyle>(() => (localStorage.getItem(BOARD_STYLE_KEY) === 'columns' ? 'columns' : 'team'));
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; at: number } | null>(null);
  // Focus requests belong to the Desk, surviving Home/Board tab remounts.
  const handledFlash = useRef<number | null>(null);
  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);
  useEffect(() => { localStorage.setItem(BOARD_STYLE_KEY, boardStyle); }, [boardStyle]);

  const data = desk.data;

  // A chat pill asked to show a card or Needs-you item. It may arrive before
  // this room has mounted or loaded, so the request waits in peekDeskFocus.
  // A reference missing from a snapshot older than the click is re-fetched
  // before it is called gone (an agent may have just created it).
  const [focusReq, setFocusReq] = useState<{ ref: DeskRef; at: number } | null>(() => {
    // A landing link carrying ?board (e.g. ?desk=open&board) wants the
    // Board tab's team view, not the Needs-you focus: the room landing is
    // all it asks for, and the focus resolution would force the Home tab.
    if (new URLSearchParams(window.location.search).has('board')) return null;
    const ref = peekDeskFocus();
    return ref ? { ref, at: Date.now() } : null;
  });
  const drawerDirty = useRef(false);
  useEffect(() => {
    const onFocus = (event: Event) => {
      const ref = (event as CustomEvent<DeskRef>).detail;
      if (ref?.id) setFocusReq({ ref: { ...ref }, at: Date.now() });
    };
    window.addEventListener(DESK_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(DESK_FOCUS_EVENT, onFocus);
  }, []);
  const { dataUpdatedAt, errorUpdatedAt, isFetching, refetch } = desk;
  useEffect(() => {
    if (!focusReq || !data) return;
    const { ref, at } = focusReq;
    // "The top of Needs you" (the badge, a digest alert) is resolved only
    // against data fetched after the request, so it never lights an item that
    // was answered in the meantime.
    const first = ref.id === DESK_FIRST_OPEN;
    const stale = dataUpdatedAt < at && errorUpdatedAt < at;
    if (first && stale) {
      if (!isFetching) void refetch();
      return;
    }
    const todoId = first ? sortOpenTodos(data.todos.filter((t) => isTodoOpen(t)))[0]?.id : ref.id;
    const found = ref.kind === 'card' && !first ? data.cards.some((c) => c.id === ref.id) : Boolean(todoId) && data.todos.some((t) => t.id === todoId);
    if (!found && stale) {
      if (!isFetching) void refetch();
      return;
    }
    clearDeskFocus(ref);
    setFocusReq(null);
    if (!found && !first) {
      showToast(ref.kind === 'card' ? 'That card is no longer on the Desk.' : 'That item is no longer on the Desk.');
      return;
    }
    // Moving off a card with unsaved edits asks first, like closing it does.
    const leaving = openCardId && !(ref.kind === 'card' && !first && ref.id === openCardId);
    if (leaving && drawerDirty.current && !window.confirm('Discard your unsaved changes to this card?')) return;
    if (leaving) drawerDirty.current = false;
    if (ref.kind === 'card' && !first) {
      setOpenCardId(ref.id);
      return;
    }
    setOpenCardId(null);
    setTab('home');
    if (todoId && found) setFlash({ id: todoId, at: Date.now() });
  }, [focusReq, data, dataUpdatedAt, errorUpdatedAt, isFetching, refetch, openCardId]);
  const openTodos = sortOpenTodos((data?.todos ?? []).filter((t) => isTodoOpen(t)));
  const liveCards = useMemo(() => (data?.cards ?? []).filter((c) => !c.archived), [data]);
  const moving = liveCards.filter((c) => c.column === 'in_progress').length;
  const notStarted = liveCards.filter((c) => c.column === 'not_started').length;
  const cardQuery = useDeskCard(openCardId);
  const fullCard = cardQuery.data?.card;
  const cardFailed = Boolean(openCardId && cardQuery.isError && !fullCard);
  useEffect(() => {
    if (!cardFailed) return;
    showToast('That card would not open. Check your connection and tap it again.');
    setOpenCardId(null);
  }, [cardFailed]);
  const leanCard = openCardId ? data?.cards.find((c) => c.id === openCardId) ?? null : null;
  const openCard = useMemo(() => (leanCard ? withThread(leanCard, fullCard?.id === leanCard.id ? fullCard : undefined) : null), [leanCard, fullCard]);

  const subtitle = data
    ? [
        openTodos.length ? `${openTodos.length} need${openTodos.length === 1 ? 's' : ''} you` : 'Nothing needs you',
        `${moving} in motion`,
        notStarted ? `${notStarted} not started` : null,
      ].filter(Boolean).join(' · ')
    : 'Loading the desk';

  return (
    <div className="desk-room">
      <RoomHeader eyebrow={ROOM_NAMES.desk.eyebrow} title="Desk" subtitle={subtitle} actions={<DesktopAlertsButton />} />
      <div className="desk-tabs" role="tablist" aria-label="Desk view">
        <button type="button" role="tab" aria-selected={tab === 'home'} onClick={() => setTab('home')}>
          <Inbox size={15} aria-hidden="true" /> Home
          {openTodos.length ? <span className="desk-count">{openTodos.length}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'board'} onClick={() => setTab('board')}>
          <LayoutGrid size={15} aria-hidden="true" /> Board
          {liveCards.length ? <span className="desk-count is-quiet">{liveCards.filter((c) => c.column !== 'in_production').length}</span> : null}
        </button>
      </div>

      {desk.isError && !data ? (
        <div className="desk-error" role="alert">
          Could not load the desk. {(desk.error as Error)?.message?.slice(0, 200)}
          <Button tone="ghost" onClick={() => void desk.refetch()}><RotateCcw size={14} /> Retry</Button>
        </div>
      ) : null}

      {desk.isError && data ? (
        <div className="desk-error is-stale" role="status">
          Can't reach the desk right now. Showing what it looked like {agoText(new Date(desk.dataUpdatedAt).toISOString())}; it refreshes on its own when the connection is back.
        </div>
      ) : null}

      {data ? (
        tab === 'home'
          ? (
            <>
              <NeedsYou desk={data} agents={agents} onOpenCard={setOpenCardId} flash={flash} handledFlash={handledFlash} answerable={answerable} />
              <PeopleRows desk={data} agents={agents} onOpenCard={setOpenCardId} refreshedAt={Math.max(dataUpdatedAt, errorUpdatedAt)} />
            </>
          )
          : boardStyle === 'team'
            ? (
              <>
                <DeskTeamView desk={data} dataUpdatedAt={Math.max(dataUpdatedAt, errorUpdatedAt)} agents={agents} onOpenCard={setOpenCardId} onShowBoard={() => setBoardStyle('columns')} />
              </>
            )
            : (
              <>
                <div className="desk-team head-row">
                  <button type="button" className="desk-team-board" onClick={() => setBoardStyle('team')} title="Back to the team view">
                    <LayoutGrid size={13} /> Team view
                  </button>
                </div>
                <DeskBoard desk={data} agents={agents} onOpenCard={setOpenCardId} />
              </>
            )
      ) : null}

      {openCard && data ? (
        <DeskCardDrawer
          key={openCard.id}
          onDirtyChange={(dirty) => { drawerDirty.current = dirty; }}
          card={openCard}
          desk={data}
          agents={agents}
          onClose={() => { drawerDirty.current = false; setOpenCardId(null); }}
        />
      ) : null}
    </div>
  );
}

// ---- Needs you ----------------------------------------------------------------------

type TodoDraft = { title: string; detail: string; due: string; priority: DeskPriority; link: string };
const emptyTodo: TodoDraft = { title: '', detail: '', due: '', priority: 'normal', link: '' };

function NeedsYou({ desk, agents, onOpenCard, flash, handledFlash, answerable }: {
  desk: DeskSnapshot;
  agents: Agent[];
  onOpenCard: (id: string) => void;
  flash: { id: string; at: number } | null;
  handledFlash: RefObject<number | null>;
  answerable: boolean;
}) {
  const write = useDeskWrite();
  const answers = useTodoAnswers(desk.todos);
  const needsRef = useRef<HTMLElement>(null);
  const doneRef = useRef<HTMLDetailsElement>(null);
  const [lit, setLit] = useState<{ id: string; at: number } | null>(null);
  const [draft, setDraft] = useState<TodoDraft>(emptyTodo);
  const [more, setMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Rows opened to read in full. Kept here (by todo id) so a row stays open
  // through the poll refresh, an edit, and a move between Needs you and Done.
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const toggleOpen = (id: string) => setOpenIds((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  // Forget ids whose todo is gone or lost its details, so the set cannot grow
  // for ever and a detail added later does not spring open by itself.
  useEffect(() => {
    setOpenIds((prev) => {
      if (!prev.size) return prev;
      const readable = new Set(desk.todos.filter((t) => t.detail).map((t) => t.id));
      const kept = [...prev].filter((id) => readable.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [desk.todos]);
  const [justDone, setJustDone] = useState<string | null>(null);
  const cardsById = useMemo(() => new Map(desk.cards.map((c) => [c.id, c])), [desk.cards]);
  // A row being answered stays where it was (showing the answer) until the
  // server confirms, then leaves for Done like a check-off.
  const answering = answers.pending;
  const open = sortOpenTodos(desk.todos.filter((t) => isTodoOpen(t) || answering.has(t.id)));
  const done = useMemo(
    () => desk.todos
      .filter((t) => t.status === 'done' && !answering.has(t.id))
      .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt)),
    [desk.todos, answering],
  );

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title || adding) return;
    setAdding(true);
    const payload = { title, detail: draft.detail, due: draft.due, priority: draft.priority, link: draft.link };
    try {
      await write(() => deskApi.addTodo(payload), (d) => ({
        ...d,
        todos: [{
          id: `pending-${Date.now()}`, title, detail: draft.detail.trim() || undefined, due: draft.due || undefined,
          priority: draft.priority, link: draft.link.trim() || undefined, from: d.owner, status: 'open',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, ...d.todos],
      }));
      setDraft(emptyTodo);
      setMore(false);
    } catch (error) {
      showToast(`Could not add it: ${errorText(error)}`);
    } finally {
      setAdding(false);
    }
  };

  const setStatus = async (todo: DeskTodo, status: 'open' | 'done') => {
    // A stale row can ask for the status the item already has. Leave the
    // record (its timestamp and any saved answer) exactly as it is.
    if (todo.status === status) return;
    if (status === 'done') {
      setJustDone(todo.id);
      window.setTimeout(() => setJustDone((id) => (id === todo.id ? null : id)), 700);
    }
    const now = new Date().toISOString();
    try {
      await write(
        () => (status === 'done' ? deskApi.completeTodo(todo.id, todo.from.kind === 'owner' ? 'Completed on the Desk' : undefined) : deskApi.reopenTodo(todo.id)),
        (d) => ({
          ...d,
          todos: d.todos.map((t) => {
            if (t.id !== todo.id || t.status === status) return t;
            const next = { ...t, status, updatedAt: now };
            if (status === 'done') next.completedAt = now;
            else {
              delete next.completedAt;
              delete next.answer;
              delete next.resolution;
            }
            return next;
          }),
        }),
      );
    } catch (error) {
      showToast(`Could not update it: ${errorText(error)}`);
    }
  };

  const remove = async (todo: DeskTodo) => {
    try {
      await write(() => deskApi.deleteTodo(todo.id), (d) => ({ ...d, todos: d.todos.filter((t) => t.id !== todo.id) }));
    } catch (error) {
      showToast(`Could not delete it: ${errorText(error)}`);
    }
  };

  const save = async (todo: DeskTodo, next: TodoDraft) => {
    const title = next.title.trim();
    if (!title) return;
    // Only the fields edited here; an agent may have changed the others.
    const before: TodoDraft = { title: todo.title, detail: todo.detail ?? '', due: todo.due ?? '', priority: todo.priority, link: todo.link ?? '' };
    const patch: TodoPatch = {};
    if (title !== before.title) patch.title = title;
    if (next.detail !== before.detail) patch.detail = next.detail;
    if (next.due !== before.due) patch.due = next.due;
    if (next.priority !== before.priority) patch.priority = next.priority;
    if (next.link.trim() !== before.link) patch.link = next.link.trim();
    if (!Object.keys(patch).length) { setEditingId(null); return; }
    try {
      await write(() => deskApi.updateTodo(todo.id, patch), (d) => ({
        ...d,
        todos: d.todos.map((t) => (t.id === todo.id
          ? {
              ...t,
              ...(patch.title !== undefined ? { title } : {}),
              ...(patch.detail !== undefined ? { detail: next.detail.trim() || undefined } : {}),
              ...(patch.due !== undefined ? { due: next.due || undefined } : {}),
              ...(patch.priority !== undefined ? { priority: next.priority } : {}),
              ...(patch.link !== undefined ? { link: patch.link || undefined } : {}),
            }
          : t)),
      }));
      setEditingId(null);
    } catch (error) {
      showToast(`Could not save it: ${errorText(error)}`);
    }
  };

  // Scroll to a Needs-you item a chat pill pointed at and light it up. Done
  // items live in the folded list, so open it first.
  const flashDone = Boolean(flash && done.some((t) => t.id === flash.id));
  useEffect(() => {
    if (!flash || handledFlash.current === flash.at) return;
    const target = desk.todos.find((todo) => todo.id === flash.id);
    if (!target || isTodoSnoozed(target)) return;
    if (flashDone && doneRef.current) doneRef.current.open = true;
    const raf = window.requestAnimationFrame(() => {
      // Target the actual item, including one beyond the latest Done rows.
      // The Done heading stays visible while its list scrolls underneath.
      const row = needsRef.current?.querySelector<HTMLElement>(`[data-todo-id="${CSS.escape(flash.id)}"]`);
      row?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      // A repeated reference to the same item renews its existing animation.
      for (const animation of row?.getAnimations() ?? []) {
        if ('animationName' in animation && animation.animationName === 'desk-lit') {
          animation.currentTime = 0;
          animation.play();
        }
      }
      handledFlash.current = flash.at;
    });
    setLit(flash);
    return () => window.cancelAnimationFrame(raf);
  }, [flash, flashDone, desk.todos, handledFlash]);
  useEffect(() => {
    if (!lit) return;
    const timer = window.setTimeout(() => setLit(null), 2400);
    return () => window.clearTimeout(timer);
  }, [lit]);
  const doneShown = useMemo(() => {
    const shown = done.slice(0, 60);
    const extra = flash && !shown.some((t) => t.id === flash.id) ? done.find((t) => t.id === flash.id) : undefined;
    return extra ? [...shown, extra] : shown;
  }, [done, flash]);

  const rowProps = { agents, cardsById, onOpenCard, onStatus: setStatus, onDelete: remove, openIds, onToggleOpen: toggleOpen, answers, answerable };

  return (
    <section ref={needsRef} className="desk-needs" aria-label="Needs you">
      <form className="desk-add" onSubmit={add}>
        <div className="desk-add-row">
          <Plus size={16} aria-hidden="true" className="desk-add-icon" />
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="What needs you?"
            aria-label="New item"
            maxLength={200}
          />
          <button type="button" className={`desk-mini-btn${more ? ' is-on' : ''}`} onClick={() => setMore((m) => !m)} aria-expanded={more} title="Details, due date, priority">
            <ChevronDown size={15} aria-hidden="true" />
            <span className="desk-hide-sm">Details</span>
          </button>
          <Button tone="gold" type="submit" disabled={!draft.title.trim() || adding}>Add</Button>
        </div>
        {more ? <TodoFields draft={draft} onChange={setDraft} /> : null}
      </form>

      {open.length ? (
        <ul className="desk-todo-list">
          {open.map((todo) => (
            editingId === todo.id
              ? <TodoEditor key={todo.id} todo={todo} onCancel={() => setEditingId(null)} onSave={(next) => save(todo, next)} />
              : <TodoRow key={todo.id} todo={todo} {...rowProps} popping={justDone === todo.id} lit={lit?.at === flash?.at && lit?.id === todo.id} onEdit={answering.has(todo.id) ? undefined : () => setEditingId(todo.id)} />
          ))}
        </ul>
      ) : (
        <div className="desk-empty">
          <Check size={20} aria-hidden="true" />
          <div>
            <strong>All clear.</strong>
            <span>Nothing needs you right now. Agents add items here when only you can unblock them.</span>
          </div>
        </div>
      )}

      <SnoozedTodos todos={desk.todos} focus={flash} handledFocus={handledFlash} />
      {done.length ? (
        <details className="desk-done" ref={doneRef}>
          <summary>
            <ChevronDown size={15} aria-hidden="true" /> Done <span className="desk-count is-quiet">{done.length}</span>
          </summary>
          <ul className="desk-todo-list is-done">
            {doneShown.map((todo) => (
              <TodoRow key={todo.id} todo={todo} {...rowProps} lit={lit?.at === flash?.at && lit?.id === todo.id} onEdit={undefined} />
            ))}
          </ul>
          {done.length > 60 ? <p className="desk-muted">Showing the latest 60 of {done.length}{doneShown.length > 60 ? ", plus the item you opened." : "."}</p> : null}
        </details>
      ) : null}
    </section>
  );
}

function TodoFields({ draft, onChange }: { draft: TodoDraft; onChange: (next: TodoDraft) => void }) {
  return (
    <div className="desk-fields">
      <label className="is-wide">
        Details
        <textarea value={draft.detail} onChange={(e) => onChange({ ...draft, detail: e.target.value })} rows={2} maxLength={4000} placeholder="Context, what is needed back" />
      </label>
      <label>
        Due
        <input type="date" value={draft.due} onChange={(e) => onChange({ ...draft, due: e.target.value })} />
      </label>
      <label>
        Priority
        <select value={draft.priority} onChange={(e) => onChange({ ...draft, priority: e.target.value as DeskPriority })}>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
      </label>
      <label className="is-wide">
        Link
        <input value={draft.link} onChange={(e) => onChange({ ...draft, link: e.target.value })} placeholder="https://… or thread:agent-id" maxLength={2000} />
      </label>
    </div>
  );
}

function TodoEditor({ todo, onCancel, onSave }: { todo: DeskTodo; onCancel: () => void; onSave: (next: TodoDraft) => Promise<void> }) {
  const [draft, setDraft] = useState<TodoDraft>({
    title: todo.title, detail: todo.detail ?? '', due: todo.due ?? '', priority: todo.priority, link: todo.link ?? '',
  });
  const [saving, setSaving] = useState(false);
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  };
  return (
    <li className="desk-todo is-editing" onKeyDown={onKey}>
      <form onSubmit={(e) => void submit(e)}>
        <input className="desk-edit-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Title" maxLength={200} />
        <TodoFields draft={draft} onChange={setDraft} />
        <div className="desk-edit-actions">
          <Button tone="ghost" type="button" onClick={onCancel}><X size={14} /> Cancel</Button>
          <Button tone="gold" type="submit" disabled={!draft.title.trim() || saving}><Check size={14} /> {saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </li>
  );
}

function TodoRow({
  todo, agents, cardsById, onOpenCard, onStatus, onDelete, onEdit, popping, lit, openIds, onToggleOpen, answers, answerable,
}: {
  todo: DeskTodo;
  agents: Agent[];
  cardsById: Map<string, DeskCard>;
  onOpenCard: (id: string) => void;
  onStatus: (todo: DeskTodo, status: 'open' | 'done') => void;
  onDelete: (todo: DeskTodo) => void;
  onEdit?: () => void;
  popping?: boolean;
  lit?: boolean;
  openIds: Set<string>;
  onToggleOpen: (id: string) => void;
  answers: TodoAnswers;
  answerable: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Just answered here: shown as answered in place until it leaves the list.
  const pending = answers.pending.get(todo.id);
  const isDone = todo.status === 'done' && !pending;
  const due = isDone || pending ? null : dueLabel(todo.due);
  const card = todo.cardId ? cardsById.get(todo.cardId) : undefined;
  const threadId = todo.link?.startsWith('thread:') ? todo.link.slice('thread:'.length) : null;
  const recipient = () => answerRecipient(todo, card, agents);
  const answerSlot = pending ? (
    <AnsweredNote
      answer={pending}
      phase={pending.phase}
      to={pending.to ?? recipient()}
      error={pending.error}
      onDismiss={pending.phase === 'undelivered' || pending.phase === 'conflict' || pending.phase === 'rejected' ? () => answers.dismiss(todo.id) : undefined}
    />
  ) : todo.answer ? (
    <AnsweredNote answer={todo.answer} phase={todo.answer.delivery === 'failed' ? 'failed' : undefined} to={recipient()} />
  ) : todo.resolution && (todo.from.kind !== 'owner' || Boolean(todo.choices?.length)) ? (
    <div className="desk-answered"><p className="desk-answered-line"><Check size={13} className="desk-answered-icon" aria-hidden="true" /><span className="desk-answered-text">Resolved by {todo.resolution.by.name}: <strong>{todo.resolution.note}</strong></span></p></div>
  ) : answerable && canAnswer(todo) ? (
    <AnswerBar todo={todo} answers={answers} recipient={recipient()} />
  ) : null;

  // A row with details opens in place to read them in full. Clicking the title,
  // the details, or empty space toggles it; the checkbox, chips, links, and
  // buttons keep their own jobs, a drag-select never toggles, and clicking the
  // open details (to select or copy) leaves them open.
  const hasDetail = Boolean(todo.detail);
  const open = hasDetail && openIds.has(todo.id);
  const detailId = `desk-todo-detail-${todo.id}`;
  const onBodyClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!hasDetail) return;
    const target = event.target as HTMLElement;
    const control = target.closest('a, button, input, select, textarea');
    if (control && !control.classList.contains('desk-todo-text')) return;
    const meta = target.closest('.desk-todo-meta');
    if (meta && target !== meta) return;
    if (open && target.closest('.desk-todo-detail')) return;
    // A click that ends a drag-select inside this row must not toggle it. A
    // keyboard press on the title (detail 0) always does, and a selection made
    // elsewhere on the page is not this row's business.
    if (event.detail !== 0) {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString() && event.currentTarget.contains(selection.anchorNode)) return;
    }
    onToggleOpen(todo.id);
  };

  const askDelete = () => {
    if (confirmDelete) { onDelete(todo); return; }
    setConfirmDelete(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setConfirmDelete(false), 3000);
  };

  return (
    <li data-todo-id={todo.id} className={`desk-todo ${priorityClass(todo.priority)}${isDone ? ' is-done' : ''}${pending ? ` is-answered is-${pending.phase}` : ''}${popping ? ' is-popping' : ''}${lit ? ' is-lit' : ''}${hasDetail ? ' has-detail' : ''}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className={`desk-check${canAnswer(todo) ? ' is-question' : ''}`}
        onClick={(event) => {
          if (isDone) {
            if (!confirmReopen) {
              setConfirmReopen(true);
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setConfirmReopen(false), 4000);
            } else { setConfirmReopen(false); onStatus(todo, 'open'); }
          }
          else if (canAnswer(todo)) focusTodoAnswer(event.currentTarget);
          else onStatus(todo, 'done');
        }}
        disabled={Boolean(pending) || (!isDone && canAnswer(todo) && !answerable)}
        aria-label={pending ? `${todo.title} ${pending.phase === 'rejected' ? 'answer was not saved' : 'is answered'}` : isDone ? `${confirmReopen ? 'Confirm reopen' : 'Reopen'} ${todo.title}` : canAnswer(todo) ? `Answer ${todo.title}` : `Mark ${todo.title} done`}
        title={pending ? (pending.phase === 'rejected' ? 'Answer was not saved' : 'Answered') : isDone ? (confirmReopen ? 'Tap again to clear the saved answer and reopen' : 'Reopen') : canAnswer(todo) ? 'Choose an answer' : 'Done'}
      >
        {pending?.phase === 'rejected' ? <AlertTriangle size={14} aria-hidden="true" /> : canAnswer(todo) ? <MessageSquare size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
      </button>
      <div className="desk-todo-body" onClick={onBodyClick}>
        {confirmReopen ? <p className="desk-answer-error" role="status">Clear this saved answer and ask again? Tap the check once more.</p> : null}
        <div className="desk-todo-title">
          <span className="priority-dot" title={`${PRIORITY_LABEL[todo.priority]} priority`} />
          {hasDetail ? (
            <button
              type="button"
              className="desk-todo-text"
              aria-expanded={open}
              aria-controls={open ? detailId : undefined}
              title={open ? 'Hide details' : 'Show details'}
            >
              <ChevronRight size={14} aria-hidden="true" className="desk-todo-chev" />
              {todo.title}
            </button>
          ) : (
            <span className="desk-todo-text">{todo.title}</span>
          )}
        </div>
        {hasDetail ? (open ? (
          <p id={detailId} className="desk-todo-detail is-open">{linkifyText(todo.detail!)}</p>
        ) : (
          // The clamped preview is for eyes only; the disclosure button announces
          // the state, and the full text is read once the row is open.
          <p className="desk-todo-detail" aria-hidden="true">{todo.detail}</p>
        )) : null}
        {open && onEdit ? (
          <button type="button" className="desk-mini-btn desk-todo-edit" onClick={onEdit}>
            <Pencil size={13} aria-hidden="true" />
            <span>Edit</span>
          </button>
        ) : null}
        <div className="desk-todo-meta">
          <ActorChip actor={todo.from} prefix="from" />
          {due ? <Chip tone={due.tone}>{due.text}</Chip> : null}
          {todo.cardId ? (
            <button type="button" className="desk-link-chip" onClick={() => onOpenCard(todo.cardId!)} disabled={!card} title={card ? 'Open the card' : 'That card is gone'}>
              <ClipboardList size={12} aria-hidden="true" />
              <span>{card ? card.title : 'card removed'}</span>
            </button>
          ) : null}
          {threadId ? (
            <button type="button" className="desk-link-chip" onClick={() => openAgentThread(threadId)} title="Open the thread">
              <MessageSquare size={12} aria-hidden="true" />
              <span>{linkLabel(todo.link!, agents)}</span>
            </button>
          ) : todo.link ? (
            <a className="desk-link-chip" href={todo.link} target="_blank" rel="noreferrer noopener" title={todo.link}>
              <ExternalLink size={12} aria-hidden="true" />
              <span>{linkLabel(todo.link, agents)}</span>
            </a>
          ) : null}
          {!isDone && !pending ? <SnoozeTodoControl todo={todo} /> : null}
          <span className="desk-age" title={new Date(isDone ? todo.completedAt ?? todo.updatedAt : todo.createdAt).toLocaleString()}>
            {isDone ? `${todo.answer ? 'answered' : 'done'} ${agoText(todo.completedAt ?? todo.updatedAt)}` : ageLabel(todo.createdAt)}
          </span>
        </div>
      </div>
      <div className="desk-todo-actions">
        <DiscussButton subject={todo.title} onClick={() => {
          const agent = recipientAgent(todo.from, card, agents);
          discussOnDesk({ kind: 'todo', id: todo.id, title: todo.title, agentId: agent?.id, agentName: agent?.name });
        }} />
        {onEdit ? (
          <button type="button" className="desk-icon-btn desk-edit-btn" onClick={onEdit} aria-label="Edit" title="Edit"><Pencil size={14} /></button>
        ) : null}
        <button
          type="button"
          className={`desk-icon-btn is-danger${confirmDelete ? ' is-confirm' : ''}`}
          onClick={askDelete}
          aria-label={confirmDelete ? 'Tap again to delete' : 'Delete'}
          title={confirmDelete ? 'Tap again to delete' : 'Delete'}
        >
          <Trash2 size={14} />
          {confirmDelete ? <span>Delete?</span> : null}
        </button>
      </div>
      {/* Its own grid row under the body and the actions, so the choices get
          the full width on a phone. */}
      {answerSlot ? <div className="desk-todo-answer">{answerSlot}</div> : null}
    </li>
  );
}


// ---- People ---------------------------------------------------------------------------

const PR_STATE_LABEL: Record<string, string> = { draft: 'draft', ci: 'CI', merged: 'merged to staging', open: 'open' };

/** One row per teammate: their current task in plain words first (the card
 *  says what they are on), then their open PRs, else idle. PR owners that
 *  match no teammate (an unmapped branch prefix renders under its GitHub
 *  login) still get their own row, so real work never vanishes behind a
 *  false idle. */
function PeopleRows({ desk, agents, onOpenCard, refreshedAt }: { desk: DeskSnapshot; agents: Agent[]; onOpenCard: (id: string) => void; refreshedAt: number }) {
  const taskMap = useMemo(() => agentTaskMap(desk.cards, agents), [desk.cards, agents, refreshedAt]);
  const prs = desk.prs ?? [];
  const known = new Set(agents.map((a) => a.name));
  const unmatchedOwners = [...new Set(prs.map((p) => p.owner).filter((owner) => !known.has(owner)))];
  const renderPrs = (mine: typeof prs) => (
    <ul className="desk-person-prs">
      {mine.map((p) => (
        <li key={`${p.repo}#${p.number}`}>
          <a href={p.url} target="_blank" rel="noreferrer">{p.repo.split('/')[1]} #{p.number}</a>
          <span className="desk-pr-state">{p.reviewer ? `with ${p.reviewer}` : (PR_STATE_LABEL[p.state] ?? p.state)}</span>
          <span className="desk-pr-title">{p.title}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="desk-people" aria-label="What each teammate has open">
      <h3 className="desk-people-title">What everyone has open{desk.prsStale ? <span className="desk-pr-stale"> · PR data stale</span> : null}</h3>
      <ul className="desk-people-list">
        {agents.map((a) => {
          const mine = prs.filter((p) => p.owner === a.name);
          const slot = taskMap.get(a.id) ?? {};
          const task = withHeadline(slot);
          const leadCard = slot.current ?? slot.waiting ?? slot.next;
          return (
            <li key={a.id} className="desk-person">
              <span className="desk-person-name">{a.name}</span>
              {slot.current
                ? <>
                    <button type="button" className="desk-person-on" onClick={() => onOpenCard(slot.current!.id)}>{slot.current.title}</button>
                    {mine.length ? renderPrs(mine) : null}
                  </>
                : mine.length
                ? <>
                    {renderPrs(mine)}
                    {leadCard ? <button type="button" className="desk-person-on is-quiet" onClick={() => onOpenCard(leadCard.id)}>{task.headline}</button> : null}
                  </>
                : leadCard
                ? <button type="button" className="desk-person-on" onClick={() => onOpenCard(leadCard.id)}>{task.headline}</button>
                : desk.prsPending ? <span className="desk-person-on is-quiet">checking PRs…</span>
                : desk.prsStale && desk.prsUnknown ? <span className="desk-person-on is-quiet">PR status unavailable</span>
                : <span className="desk-person-on is-quiet">No current task</span>}
            </li>
          );
        })}
        {unmatchedOwners.map((owner) => (
          <li key={`owner:${owner}`} className="desk-person">
            <span className="desk-person-name">{owner}</span>
            {renderPrs(prs.filter((p) => p.owner === owner))}
          </li>
        ))}
      </ul>
    </section>
  );
}
