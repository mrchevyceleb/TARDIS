// "My desk" in the right sidebar: the owner's Needs-you list and the board
// cards that are theirs (or waiting on their call). It reads and writes the same
// /api/desk data as the Desk room, through the same hooks, so a check-off here
// is a check-off there.

import { ArrowUpRight, Check, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chip } from '../components/Primitives';
import {
  PRIORITY_RANK,
  ageLabel,
  agoText,
  deskApi,
  dueLabel,
  focusDeskRef,
  sortOpenTodos,
  useDesk,
  useDeskSummary,
  useDeskWrite,
  type DeskCard,
  type DeskColumn,
  type DeskSnapshot,
  type DeskTodo,
} from '../data/desk';
import { showToast } from '../native/shell';
import { ActorChip, AnswerBar, AnsweredNote, answerRecipient, canAnswer, errorText, priorityClass, useDeskAgents, useTodoAnswers } from '../rooms/deskParts';
import '../rooms/desk.css';
import './myDesk.css';

/** How many rows each list shows before "N more on the Desk". */
export type MyDeskLimits = { todos: number; cards: number };

const COLUMN_RANK: Record<DeskColumn, number> = { in_progress: 0, not_started: 1, in_qa: 2, on_staging: 3, in_production: 4 };
/** How long a checked row lingers (struck through) before it leaves the list. */
const LEAVE_MS = 420;

/** Cards that are the owner's, plus any with an open Needs-you item (the
 * five-stage board's needs-Matt flag: waiting is now a card state, not a column). */
export function myCards(desk: DeskSnapshot): DeskCard[] {
  const needsMatt = new Set(desk.todos.filter((t) => t.status === 'open' && t.cardId).map((t) => t.cardId as string));
  return desk.cards
    .filter((c) => !c.archived && c.column !== 'in_production' && (c.owner.kind === 'owner' || needsMatt.has(c.id)))
    .sort((a, b) =>
      COLUMN_RANK[a.column] - COLUMN_RANK[b.column]
      || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || b.updatedAt.localeCompare(a.updatedAt));
}

export function MyDeskPane({ limits, onOpenDesk }: { limits: MyDeskLimits; onOpenDesk: () => void }) {
  const desk = useDesk();
  const write = useDeskWrite();
  const answers = useTodoAnswers(desk.data?.todos);
  const agents = useDeskAgents();
  // Reads the shell's summary poll: answers only once the server takes them.
  const answerable = useDeskSummary(false).data?.answerable === true;
  const data = desk.data;
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const [announce, setAnnounce] = useState('');
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Where keyboard focus goes once a checked row has left the list. */
  const refocus = useRef<{ id: string; index: number } | null>(null);

  // A row being answered keeps its place (showing the answer) until it leaves.
  const answering = answers.pending;
  const todos = useMemo(
    () => sortOpenTodos((data?.todos ?? []).filter((t) => t.status === 'open' || answering.has(t.id))),
    [data, answering],
  );
  const cardsById = useMemo(() => new Map((data?.cards ?? []).map((c) => [c.id, c])), [data]);
  const cards = useMemo(() => (data ? myCards(data) : []), [data]);
  const openCount = todos.filter((t) => t.status === 'open' && !answering.has(t.id)).length;
  const shownTodos = todos.slice(0, limits.todos);
  const shownCards = cards.slice(0, limits.cards);
  const hidden = todos.length - shownTodos.length + (cards.length - shownCards.length);
  const columnTitle = (key: DeskColumn) => data?.columns.find((c) => c.key === key)?.title ?? key;

  // A checked row lingers (struck through) for LEAVE_MS, then the write goes out
  // and the row leaves. The timer is deliberately not cancelled on unmount: the
  // write needs nothing from this component, and closing the pane a beat after a
  // check must still save it.
  const complete = (todo: DeskTodo, index: number) => {
    if (leaving.has(todo.id)) return;
    setLeaving((prev) => new Set(prev).add(todo.id));
    refocus.current = { id: todo.id, index };
    window.setTimeout(() => {
      const now = new Date().toISOString();
      void write(
        () => deskApi.completeTodo(todo.id),
        (d) => ({ ...d, todos: d.todos.map((t) => (t.id === todo.id ? { ...t, status: 'done', completedAt: now, updatedAt: now } : t)) }),
      )
        .then(() => setAnnounce(`Marked ${todo.title} done`))
        .catch((error) => showToast(`Could not update it: ${errorText(error)}`))
        .finally(() => {
          if (refocus.current?.id === todo.id) refocus.current = null;
          setLeaving((prev) => { const next = new Set(prev); next.delete(todo.id); return next; });
        });
    }, LEAVE_MS);
  };

  // The checked button is gone with its row, so hand focus to the next check
  // (or the Desk link when the list is empty) instead of dropping it on the page.
  useEffect(() => {
    const target = refocus.current;
    if (!target || shownTodos.some((t) => t.id === target.id)) return;
    refocus.current = null;
    const checks = listRef.current?.querySelectorAll<HTMLButtonElement>('.md-check:not(:disabled)');
    const next = checks?.length ? checks[Math.min(target.index, checks.length - 1)] : sectionRef.current?.querySelector<HTMLButtonElement>('.md-open');
    next?.focus({ preventScroll: true });
  }, [shownTodos]);

  return (
    <section className="bt-pane-col bt-pane-mine" aria-label="My desk" ref={sectionRef}>
      <div className="bt-pane-sec">
        <div className="md-sr" role="status" aria-live="polite">{announce}</div>
        <div className="bt-pane-title-row">
          <div className="bt-pane-title">My desk</div>
          <button type="button" className="md-open" onClick={onOpenDesk} title="Open the full Desk">
            Desk <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        </div>

        {!data && desk.isError ? (
          <div className="md-note is-error" role="alert">
            Could not load the desk.
            <button type="button" className="md-retry" onClick={() => void desk.refetch()}><RotateCcw size={12} aria-hidden="true" /> Retry</button>
          </div>
        ) : null}
        {!data && !desk.isError ? (
          <div className="md-skeleton" aria-busy="true" aria-label="Loading the desk">
            <i /><i /><i />
          </div>
        ) : null}
        {data && desk.isError ? (
          <div className="md-note" role="status">
            Can&apos;t reach the desk. Showing it as of {agoText(new Date(desk.dataUpdatedAt).toISOString())}.
          </div>
        ) : null}

        {data ? (
          <>
            <div className="md-sub">
              Needs you
              {openCount ? <span className="desk-count">{openCount}</span> : null}
            </div>
            {shownTodos.length ? (
              <ul className="md-list" ref={listRef}>
                {shownTodos.map((todo, index) => {
                  const due = dueLabel(todo.due);
                  const going = leaving.has(todo.id);
                  const pending = answers.pending.get(todo.id);
                  return (
                    <li key={todo.id} className={`md-todo ${priorityClass(todo.priority)}${going ? ' is-leaving' : ''}${pending ? ` is-answered is-${pending.phase}` : ''}`}>
                      <button
                        type="button"
                        className="md-check"
                        onClick={() => complete(todo, index)}
                        disabled={going || Boolean(pending)}
                        aria-label={pending ? `${todo.title} is answered` : `Mark ${todo.title} done`}
                        title={pending ? 'Answered' : 'Done'}
                      >
                        <Check size={13} aria-hidden="true" />
                      </button>
                      <div className="md-todo-main">
                        <button
                          type="button"
                          className="md-row-main"
                          onClick={() => focusDeskRef({ kind: 'todo', id: todo.id })}
                          title="Open on the Desk"
                        >
                          <span className="md-row-title">{todo.title}</span>
                          <span className="md-meta">
                            <ActorChip actor={todo.from} compact />
                            {due ? <Chip tone={due.tone}>{due.text}</Chip> : null}
                            <span className="md-age">{ageLabel(todo.createdAt)}</span>
                          </span>
                        </button>
                        {pending ? (
                          <AnsweredNote
                            answer={pending}
                            phase={pending.phase}
                            to={pending.to ?? answerRecipient(todo, todo.cardId ? cardsById.get(todo.cardId) : undefined, agents)}
                            onDismiss={pending.phase === 'undelivered' ? () => answers.dismiss(todo.id) : undefined}
                          />
                        ) : answerable && canAnswer(todo) && !going ? (
                          <AnswerBar todo={todo} answers={answers} compact />
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="md-empty">
                <Check size={16} aria-hidden="true" />
                <span><strong>All clear.</strong> Nothing needs you right now.</span>
              </div>
            )}

            <div className="md-sub">
              My cards
              {cards.length ? <span className="desk-count is-quiet">{cards.length}</span> : null}
            </div>
            {shownCards.length ? (
              <ul className="md-list">
                {shownCards.map((card) => (
                  <li key={card.id}>
                    <button
                      type="button"
                      className="md-card"
                      data-col={card.column}
                      onClick={() => focusDeskRef({ kind: 'card', id: card.id })}
                      title={`Open on the Desk: ${card.title}`}
                    >
                      <span className="md-card-dot" aria-hidden="true" />
                      <span className="md-row-main">
                        <span className="md-row-title">{card.title}</span>
                        <span className="md-meta">
                          <span className="md-col-chip">{columnTitle(card.column)}</span>
                          {card.owner.kind === 'agent' ? <ActorChip actor={card.owner} compact /> : null}
                          {card.project ? <span className="desk-project">{card.project}</span> : null}
                          <span className="md-age">{ageLabel(card.updatedAt)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="md-empty is-quiet">
                <span>No cards are yours or waiting on you.</span>
              </div>
            )}

            {hidden > 0 ? (
              <button type="button" className="md-more" onClick={onOpenDesk}>
                {hidden} more on the Desk <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
