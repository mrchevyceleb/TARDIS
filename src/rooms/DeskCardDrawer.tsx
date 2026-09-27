// Card drawer: edit a board card, read and add to its comment thread, move or
// archive it, and see the Needs-you items that point at it.

import { Archive, ArchiveRestore, Check, Copy, ExternalLink, Link2, MessageSquare, Plus, Send, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button } from '../components/Primitives';
import {
  DESK_COLUMNS,
  ageLabel,
  agoText,
  deskApi,
  dueLabel,
  openAgentThread,
  useDeskWrite,
  type DeskCard,
  type DeskColumn,
  type DeskPriority,
  type DeskSnapshot,
} from '../data/desk';
import { showToast } from '../native/shell';
import type { Agent } from '../grok/agents';
import { ActorChip, errorText, linkLabel, priorityClass } from './deskParts';
import { columnTitle, ownerKey, ownerOptions, projectOptions, useCardMover } from './DeskBoard';

type Draft = { title: string; description: string; owner: string; project: string; priority: DeskPriority; links: string[] };

function toDraft(card: DeskCard): Draft {
  return {
    title: card.title,
    description: card.description ?? '',
    owner: ownerKey(card),
    project: card.project ?? '',
    priority: card.priority,
    links: [...card.links],
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Plain text with bare URLs made clickable. */
function Linkified({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<a key={start} href={match[0]} target="_blank" rel="noreferrer noopener">{match[0]}</a>);
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function DeskCardDrawer({
  card, desk, agents, onClose,
}: {
  card: DeskCard;
  desk: DeskSnapshot;
  agents: Agent[];
  onClose: () => void;
}) {
  const write = useDeskWrite();
  const move = useCardMover();
  const current = useMemo(() => toDraft(card), [card]);
  const [base, setBase] = useState<Draft>(current);
  const [draft, setDraft] = useState<Draft>(current);
  const [linkInput, setLinkInput] = useState('');
  const [comment, setComment] = useState('');
  const [todoTitle, setTodoTitle] = useState('');
  const [busy, setBusy] = useState<'save' | 'comment' | 'todo' | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const threadRef = useRef<HTMLOListElement>(null);
  const dirty = !sameDraft(draft, base);

  // Agents keep writing while the drawer is open. Follow their edits unless
  // the owner has unsaved changes of their own.
  useEffect(() => {
    if (sameDraft(draft, base) && !sameDraft(current, base)) {
      setBase(current);
      setDraft(current);
    }
  }, [current, base, draft]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  const commentCount = card.comments.length;
  useEffect(() => {
    const list = threadRef.current;
    if (list) list.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [commentCount]);

  const requestClose = () => {
    if (dirty && !window.confirm('Discard your unsaved changes to this card?')) return;
    onClose();
  };

  // Escape closes the drawer wherever focus is (a save or move can drop focus
  // to <body>). Capture phase keeps the shell's Escape (collapse the rail)
  // from also firing while the drawer is open.
  const closeRequest = useRef(requestClose);
  closeRequest.current = requestClose;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeRequest.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const owners = useMemo(() => ownerOptions(desk, agents), [desk, agents]);
  const projects = useMemo(() => projectOptions(desk), [desk]);
  const linkedTodos = desk.todos.filter((t) => t.cardId === card.id);

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!dirty || busy) return;
    const title = draft.title.trim();
    if (!title) { showToast('A card needs a title.'); return; }
    setBusy('save');
    const ownerChanged = draft.owner !== base.owner;
    try {
      const ownerLabel = owners.find((o) => o.value === draft.owner)?.label ?? card.owner.name;
      const { card: saved } = await write(() => deskApi.updateCard(card.id, {
        title,
        description: draft.description,
        project: draft.project,
        priority: draft.priority,
        links: draft.links,
        ...(ownerChanged ? { owner: draft.owner } : {}),
      }), (d) => ({
        ...d,
        cards: d.cards.map((c) => (c.id === card.id ? {
          ...c,
          title,
          description: draft.description.trim() || undefined,
          project: draft.project.trim() || undefined,
          priority: draft.priority,
          links: draft.links,
          owner: ownerChanged
            ? (draft.owner === 'owner' ? d.owner : { kind: 'agent', id: draft.owner, name: ownerLabel })
            : c.owner,
        } : c)),
      }));
      const next = toDraft(saved);
      setBase(next);
      setDraft(next);
    } catch (error) {
      showToast(`Could not save: ${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const addLink = () => {
    const value = linkInput.trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value) && !/^thread:[a-z0-9][a-z0-9_-]*$/i.test(value)) {
      showToast('Links need to start with http:// or https:// (or thread:agent-id).');
      return;
    }
    if (!draft.links.includes(value)) setDraft({ ...draft, links: [...draft.links, value].slice(0, 20) });
    setLinkInput('');
  };

  const sendComment = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = comment.trim();
    if (!text || busy) return;
    setBusy('comment');
    try {
      await write(() => deskApi.comment(card.id, text), (d) => ({
        ...d,
        cards: d.cards.map((c) => (c.id === card.id
          ? { ...c, comments: [...c.comments, { id: `pending-${Date.now()}`, author: d.owner, text, at: new Date().toISOString() }] }
          : c)),
      }));
      setComment('');
    } catch (error) {
      showToast(`Could not post the comment: ${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const removeComment = async (commentId: string) => {
    if (!window.confirm('Delete this comment?')) return;
    try {
      await write(() => deskApi.deleteComment(card.id, commentId), (d) => ({
        ...d,
        cards: d.cards.map((c) => (c.id === card.id ? { ...c, comments: c.comments.filter((m) => m.id !== commentId) } : c)),
      }));
    } catch (error) {
      showToast(`Could not delete the comment: ${errorText(error)}`);
    }
  };

  const setArchived = async (archived: boolean) => {
    try {
      await write(() => deskApi.archiveCard(card.id, archived), (d) => ({
        ...d,
        cards: d.cards.map((c) => (c.id === card.id ? { ...c, archived: archived || undefined } : c)),
      }));
      if (archived) onClose();
    } catch (error) {
      showToast(`Could not ${archived ? 'archive' : 'restore'} the card: ${errorText(error)}`);
    }
  };

  const addTodo = async (event: FormEvent) => {
    event.preventDefault();
    const title = todoTitle.trim();
    if (!title || busy) return;
    setBusy('todo');
    try {
      await write(() => deskApi.addTodo({ title, cardId: card.id }));
      setTodoTitle('');
    } catch (error) {
      showToast(`Could not add it: ${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleTodo = async (id: string, done: boolean) => {
    const now = new Date().toISOString();
    try {
      await write(
        () => (done ? deskApi.completeTodo(id) : deskApi.reopenTodo(id)),
        (d) => ({ ...d, todos: d.todos.map((t) => (t.id === id ? { ...t, status: done ? 'done' : 'open', completedAt: done ? now : undefined } : t)) }),
      );
    } catch (error) {
      showToast(`Could not update it: ${errorText(error)}`);
    }
  };

  const copyId = () => {
    void navigator.clipboard?.writeText(card.id).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }, () => showToast(card.id));
  };

  return (
    <div className="desk-drawer-layer">
      <button type="button" className="desk-drawer-scrim" aria-label="Close card" tabIndex={-1} onClick={requestClose} />
      <aside className={`desk-drawer ${priorityClass(card.priority)}`} role="dialog" aria-modal="true" aria-label={`Card: ${card.title}`} data-col={card.column}>
        <header className="desk-drawer-head">
          <div>
            <p className="r-eyebrow-gold">
              {columnTitle(desk, card.column)} · {ageLabel(card.columnSince) === 'now' ? 'just moved here' : `here ${ageLabel(card.columnSince)}`}{card.archived ? ' · archived' : ''}
            </p>
            <h2>{card.title}</h2>
          </div>
          <button ref={closeRef} type="button" className="desk-icon-btn" onClick={requestClose} aria-label="Close"><X size={17} /></button>
        </header>

        <div className="desk-drawer-body">
          <div className="desk-drawer-status">
            <label className="desk-filter">
              <span>Column</span>
              <select value={card.column} onChange={(e) => void move(desk, card.id, e.target.value as DeskColumn, null)}>
                {DESK_COLUMNS.map((col) => <option key={col} value={col}>{columnTitle(desk, col)}</option>)}
              </select>
            </label>
            <ActorChip actor={card.owner} prefix="Owner" />
            <button type="button" className="desk-mini-btn" onClick={copyId} title="Copy the card id (agents use it)">
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              <code>{card.id}</code>
            </button>
          </div>

          <form className="desk-fields desk-drawer-fields" onSubmit={save}>
            <label className="is-wide">
              Title
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={200} />
            </label>
            <label className="is-wide">
              Description
              <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={4} maxLength={8000} placeholder="Goal, scope, context" />
            </label>
            <label>
              Owner
              <select value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })}>
                {owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
            <label className="is-wide">
              Project
              <input value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })} list="desk-drawer-projects" maxLength={60} placeholder="Operly, Studio, TARDIS…" />
              <datalist id="desk-drawer-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
            </label>
            <div className="is-wide desk-links">
              <span className="desk-field-label">Links</span>
              {draft.links.length ? (
                <ul>
                  {draft.links.map((link) => (
                    <li key={link}>
                      {link.startsWith('thread:') ? (
                        <button type="button" className="desk-link-chip" onClick={() => openAgentThread(link.slice(7))}>
                          <MessageSquare size={12} aria-hidden="true" /><span>{linkLabel(link, agents)}</span>
                        </button>
                      ) : (
                        <a className="desk-link-chip" href={link} target="_blank" rel="noreferrer noopener" title={link}>
                          <ExternalLink size={12} aria-hidden="true" /><span>{linkLabel(link, agents)}</span>
                        </a>
                      )}
                      <button type="button" className="desk-icon-btn is-danger" aria-label="Remove link" onClick={() => setDraft({ ...draft, links: draft.links.filter((l) => l !== link) })}>
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="desk-inline-add">
                <Link2 size={14} aria-hidden="true" />
                <input
                  value={linkInput}
                  onChange={(e) => setLinkInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }}
                  placeholder="Paste a PR or doc link"
                  aria-label="Add a link"
                  maxLength={2000}
                />
                <button type="button" className="desk-mini-btn" onClick={addLink} disabled={!linkInput.trim()}><Plus size={13} /> Add</button>
              </div>
            </div>
            {dirty ? (
              <div className="is-wide desk-savebar">
                <span>Unsaved changes</span>
                <Button tone="ghost" type="button" onClick={() => setDraft(base)}>Discard</Button>
                <Button tone="gold" type="submit" disabled={busy === 'save'}><Check size={14} /> Save</Button>
              </div>
            ) : null}
          </form>

          <section className="desk-drawer-section">
            <h3>Needs you <span className="desk-count is-quiet">{linkedTodos.filter((t) => t.status === 'open').length}</span></h3>
            {linkedTodos.length ? (
              <ul className="desk-mini-todos">
                {linkedTodos.map((todo) => {
                  const due = todo.status === 'open' ? dueLabel(todo.due) : null;
                  return (
                    <li key={todo.id} className={`${priorityClass(todo.priority)}${todo.status === 'done' ? ' is-done' : ''}`}>
                      <button
                        type="button"
                        className="desk-check"
                        onClick={() => void toggleTodo(todo.id, todo.status === 'open')}
                        aria-label={todo.status === 'open' ? `Mark ${todo.title} done` : `Reopen ${todo.title}`}
                      >
                        <Check size={13} aria-hidden="true" />
                      </button>
                      <span className="desk-mini-todo-text">{todo.title}</span>
                      {due ? <span className={`desk-due is-${due.tone}`}>{due.text}</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <form className="desk-inline-add" onSubmit={addTodo}>
              <Plus size={14} aria-hidden="true" />
              <input value={todoTitle} onChange={(e) => setTodoTitle(e.target.value)} placeholder="Add a Needs-you item for this card" aria-label="New Needs-you item" maxLength={200} />
              <button type="submit" className="desk-mini-btn" disabled={!todoTitle.trim() || busy === 'todo'}>Add</button>
            </form>
          </section>

          <section className="desk-drawer-section">
            <h3>Comments <span className="desk-count is-quiet">{card.comments.length}</span></h3>
            {card.comments.length ? (
              <ol className="desk-thread" ref={threadRef}>
                {card.comments.map((c) => (
                  <li key={c.id} className={c.author.kind === 'owner' ? 'is-owner' : ''}>
                    <div className="desk-thread-head">
                      <ActorChip actor={c.author} />
                      <time dateTime={c.at} title={new Date(c.at).toLocaleString()}>{ageLabel(c.at)}</time>
                      {!c.id.startsWith('pending-') ? (
                        <button type="button" className="desk-icon-btn is-danger desk-thread-del" aria-label="Delete comment" onClick={() => void removeComment(c.id)}>
                          <Trash2 size={12} />
                        </button>
                      ) : null}
                    </div>
                    <p><Linkified text={c.text} /></p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="desk-muted">No comments yet. Agents post short progress notes here.</p>
            )}
            <form className="desk-composer" onSubmit={sendComment}>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendComment(); } }}
                rows={2}
                maxLength={4000}
                placeholder="Leave a note for whoever picks this up"
                aria-label="New comment"
              />
              <Button tone="gold" type="submit" disabled={!comment.trim() || busy === 'comment'} aria-label="Post comment">
                <Send size={14} />
              </Button>
            </form>
          </section>
        </div>

        <footer className="desk-drawer-foot">
          <span className="desk-muted">
            {card.createdBy ? `Created by ${card.createdBy.name}` : 'Created'} {agoText(card.createdAt)}
          </span>
          {card.archived ? (
            <Button tone="ghost" onClick={() => void setArchived(false)}><ArchiveRestore size={14} /> Restore</Button>
          ) : (
            <Button tone="ghost" onClick={() => void setArchived(true)}><Archive size={14} /> Archive</Button>
          )}
        </footer>
      </aside>
    </div>
  );
}
