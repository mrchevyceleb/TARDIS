// Small shared pieces for the Desk room (Needs you + Board + card drawer).

import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Check, MessageCircle, SendHorizontal, X } from 'lucide-react';
import { apiJson } from '../data/api';
import { deskApi, useDeskWrite, type DeskActor, type DeskCard, type DeskPriority, type DeskTodo, type TodoAnswerInput } from '../data/desk';
import { agentColor, DISC_INK, type Agent } from '../grok/agents';

/** Agents for owner pickers and name lookups. The sidebar already polls the
 *  roster; a minute of staleness is fine for a picker. */
export function useDeskAgents(): Agent[] {
  const query = useQuery({
    queryKey: ['desk-agents'],
    queryFn: () => apiJson<{ agents: Agent[] }>('/api/agents'),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  return query.data?.agents ?? [];
}

const URL_RUN = /https?:\/\/[^\s<>]+/g;

/** Plain text with http(s) URLs turned into links that open in a new tab.
 *  Nothing but text and anchors is produced (no HTML), and trailing sentence
 *  punctuation (and an unmatched closing bracket) stays outside the link. */
export function linkifyText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RUN)) {
    let url = match[0];
    for (;;) {
      const tail = url[url.length - 1];
      const unmatched = tail === ')' ? (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)
        : tail === ']' ? (url.match(/\]/g)?.length ?? 0) > (url.match(/\[/g)?.length ?? 0)
        : false;
      if (unmatched || /[.,;:!?'"}]/.test(tail ?? '')) url = url.slice(0, -1); else break;
    }
    if (!/^https?:\/\/[^/.]/.test(url)) continue;
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a key={`${at}-${url}`} className="desk-detail-link" href={url} target="_blank" rel="noreferrer noopener">{url}</a>,
    );
    last = at + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const PRIORITY_LABEL: Record<DeskPriority, string> = { high: 'High', normal: 'Normal', low: 'Low' };

/** Maps Desk priority onto the shared priority color classes. */
export function priorityClass(priority: DeskPriority): string {
  return priority === 'high' ? 'priority-high' : priority === 'low' ? 'priority-low' : 'priority-medium';
}

export function ActorChip({ actor, prefix, compact }: { actor: DeskActor; prefix?: string; compact?: boolean }) {
  const owner = actor.kind === 'owner';
  return (
    <span className={`desk-actor${owner ? ' is-owner' : ''}${compact ? ' is-compact' : ''}`} title={`${prefix ? `${prefix} ` : ''}${actor.name}`}>
      <span
        className="desk-actor-disc"
        aria-hidden="true"
        style={owner ? undefined : { background: agentColor(actor.name), color: DISC_INK }}
      >
        {actor.name.trim().slice(0, 1).toUpperCase() || '?'}
      </span>
      {compact ? null : <span className="desk-actor-name">{prefix ? `${prefix} ` : ''}{actor.name}</span>}
    </span>
  );
}

/** Pretty label for a stored link. */
export function linkLabel(link: string, agents: Agent[]): string {
  if (link.startsWith('thread:')) {
    const id = link.slice('thread:'.length);
    const agent = agents.find((a) => a.id === id);
    return `${agent?.name ?? id} thread`;
  }
  try {
    const url = new URL(link);
    const pr = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (url.hostname === 'github.com' && pr) return `${pr[2]} #${pr[3]}`;
    return url.hostname.replace(/^www\./, '') + (url.pathname.length > 1 ? url.pathname.slice(0, 24) : '');
  } catch {
    return link;
  }
}

/** Server errors arrive as JSON text; show just the message. */
export function errorText(error: unknown): string {
  const raw = (error as Error)?.message ?? String(error);
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch { /* plain text */ }
  return raw.slice(0, 200);
}

/** Opens the Desk chat with this card or item as a reference chip. */
export function DiscussButton({ onClick, subject, label }: { onClick: () => void; subject: string; label?: string }) {
  return (
    <button
      type="button"
      className={`desk-icon-btn desk-discuss-btn${label ? ' has-label' : ''}`}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      aria-label={`Discuss ${subject} in chat`}
      title="Discuss in chat"
    >
      <MessageCircle size={14} aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </button>
  );
}

/** True while the Desk chat is open beside the room. The card drawer stops
 *  acting as a modal then, so the chat stays usable. */
export const DeskChatOpenContext = createContext(false);
export function useDeskChatOpen(): boolean {
  return useContext(DeskChatOpenContext);
}

// ---- one-tap answers ------------------------------------------------------------------

/** The buttons an item offers: the agent's own choices, else Yes / No. */
export function answerChoices(todo: Pick<DeskTodo, 'choices'>): string[] {
  const list = [...new Set((todo.choices ?? []).map((c) => c.trim()).filter(Boolean))].slice(0, 4);
  return list.length ? list : ['Yes', 'No'];
}

/** Every open Needs-you item takes an answer (the server decides who hears it;
 *  the owner's own items may have nobody to tell). */
export function canAnswer(todo: DeskTodo): boolean {
  return todo.status === 'open';
}

/** Who hears the answer: the agent who asked, else the card's agent owner, else
 *  the Chief of Staff. Mirrors the server's routing; used for labels only. */
export function answerRecipient(todo: DeskTodo, card: DeskCard | undefined, agents: Agent[]): string {
  if (todo.from.kind === 'agent') return todo.from.name;
  if (card?.owner.kind === 'agent') return card.owner.name;
  return agents.find((a) => a.id === 'chief-of-staff')?.name ?? 'your Chief of Staff';
}

export type PendingAnswer = TodoAnswerInput & { phase: 'sending' | 'sent' | 'undelivered'; to?: string };

/** How long an answered row stays in the open list before it leaves. */
const ANSWER_LINGER_MS = 1100;

type IdMap<V> = ReadonlyMap<string, V>;
function withEntry<V>(prev: IdMap<V>, id: string, value: V | undefined): IdMap<V> {
  if (value === undefined ? !prev.has(id) : prev.get(id) === value) return prev;
  const next = new Map(prev);
  if (value === undefined) next.delete(id); else next.set(id, value);
  return next;
}

/** Answering Needs-you items, shared by the Desk room and My desk. The row shows
 *  the answer at once (the item is marked done in the cache), stays in place
 *  until the server confirms, then leaves like a check-off. A failed save rolls
 *  back and keeps the typed words; a save the agent was not told about stays on
 *  screen until it is dismissed. */
export function useTodoAnswers(todos: DeskTodo[] | undefined) {
  const write = useDeskWrite();
  const [pending, setPending] = useState<IdMap<PendingAnswer>>(() => new Map());
  const [drafts, setDrafts] = useState<IdMap<string>>(() => new Map());
  const [errors, setErrors] = useState<IdMap<string>>(() => new Map());
  const timers = useRef(new Map<string, number>());
  const inflight = useRef(new Set<string>());
  useEffect(() => {
    const live = timers.current;
    return () => { for (const t of live.values()) window.clearTimeout(t); };
  }, []);
  // The server keeps retrying a delivery that failed. Once the poll says the
  // agent was told (or the item is gone), the warning row stops claiming
  // otherwise and leaves for Done.
  useEffect(() => {
    if (!todos) return;
    setPending((prev) => {
      let next = prev;
      for (const [id, entry] of prev) {
        if (entry.phase !== 'undelivered') continue;
        const todo = todos.find((t) => t.id === id);
        if (!todo || todo.answer?.delivery === 'sent') next = withEntry(next, id, undefined);
      }
      return next;
    });
  }, [todos]);

  const setDraft = useCallback((id: string, text: string) => setDrafts((prev) => withEntry(prev, id, text || undefined)), []);
  const dismiss = useCallback((id: string) => setPending((prev) => withEntry(prev, id, undefined)), []);

  const answer = useCallback(async (todo: DeskTodo, input: TodoAnswerInput) => {
    const choice = input.choice?.trim() || undefined;
    const text = input.text?.trim().slice(0, 1000) || undefined;
    if ((!choice && !text) || inflight.current.has(todo.id)) return;
    inflight.current.add(todo.id);
    window.clearTimeout(timers.current.get(todo.id));
    setErrors((prev) => withEntry(prev, todo.id, undefined));
    setPending((prev) => withEntry(prev, todo.id, { choice, text, phase: 'sending' }));
    const now = new Date().toISOString();
    try {
      const result = await write(
        () => deskApi.answerTodo(todo.id, { ...(choice ? { choice } : {}), ...(text ? { text } : {}) }),
        (d) => ({
          ...d,
          todos: d.todos.map((t) => (t.id === todo.id
            ? { ...t, status: 'done' as const, completedAt: now, updatedAt: now, answer: { choice, text, at: now, delivery: t.from.kind === 'owner' ? 'none' as const : 'sent' as const } }
            : t)),
        }),
      );
      const saved = result?.todo?.answer;
      const delivery = saved?.delivery ?? (result?.notified && !result.notified.delivered ? 'failed' : 'sent');
      const shown = saved ? { choice: saved.choice, text: saved.text } : { choice, text };
      setDrafts((prev) => withEntry(prev, todo.id, undefined));
      if (delivery === 'failed') {
        setPending((prev) => withEntry(prev, todo.id, { ...shown, phase: 'undelivered', to: result?.notified?.to }));
      } else {
        setPending((prev) => withEntry(prev, todo.id, { ...shown, phase: 'sent' }));
        timers.current.set(todo.id, window.setTimeout(() => {
          timers.current.delete(todo.id);
          setPending((prev) => withEntry(prev, todo.id, undefined));
        }, ANSWER_LINGER_MS));
      }
    } catch (error) {
      setPending((prev) => withEntry(prev, todo.id, undefined));
      setErrors((prev) => withEntry(prev, todo.id, `Could not send it: ${errorText(error)}`));
    } finally {
      inflight.current.delete(todo.id);
    }
  }, [write]);

  return { pending, drafts, errors, answer, setDraft, dismiss };
}
export type TodoAnswers = ReturnType<typeof useTodoAnswers>;

const YES = /^(yes|yep|approve|approved|go|ship it)$/i;
const NO = /^(no|nope|hold|stop|reject)$/i;

/** One button per choice plus a short write-in. Tapping a choice sends it with
 *  whatever is typed in the box; Send sends the words alone. */
export function AnswerBar({ todo, answers, compact }: { todo: DeskTodo; answers: TodoAnswers; compact?: boolean }) {
  const draft = answers.drafts.get(todo.id) ?? '';
  const error = answers.errors.get(todo.id);
  const text = draft.trim();
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (text) void answers.answer(todo, { text });
  };
  return (
    <div className={`desk-answer${compact ? ' is-compact' : ''}`} role="group" aria-label={`Answer ${todo.title}`}>
      <div className="desk-answer-choices">
        {answerChoices(todo).map((choice) => (
          <button
            key={choice}
            type="button"
            className="desk-answer-choice"
            data-tone={YES.test(choice) ? 'yes' : NO.test(choice) ? 'no' : undefined}
            onClick={() => void answers.answer(todo, { choice, text })}
            aria-label={text ? `Answer ${choice} with your note` : `Answer ${choice}`}
            title={text ? `Answer ${choice} with your note` : `Answer ${choice}`}
          >
            {choice}
          </button>
        ))}
      </div>
      <form className="desk-answer-write" onSubmit={send}>
        <input
          value={draft}
          onChange={(event) => answers.setDraft(todo.id, event.target.value)}
          placeholder="Write an answer"
          aria-label={`Write an answer to ${todo.title}`}
          maxLength={1000}
          enterKeyHint="send"
        />
        <button type="submit" className="desk-answer-send" disabled={!text} aria-label="Send answer" title="Send">
          <SendHorizontal size={14} aria-hidden="true" />
          <span>Send</span>
        </button>
      </form>
      {error ? <p className="desk-answer-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** What was answered, on a row that is leaving or in the Done list. */
export function AnsweredNote({ answer, phase, to, onDismiss }: {
  answer: TodoAnswerInput;
  phase?: PendingAnswer['phase'] | 'failed';
  to: string;
  onDismiss?: () => void;
}) {
  const warn = phase === 'undelivered' || phase === 'failed';
  return (
    <div className={`desk-answered${phase ? ` is-${phase}` : ''}`} role={phase && phase !== 'failed' ? 'status' : undefined}>
      <p className="desk-answered-line">
        <Check size={13} aria-hidden="true" className="desk-answered-icon" />
        <span className="desk-answered-text">
          Answered: {answer.choice ? <strong>{answer.choice}</strong> : null}
          {answer.choice && answer.text ? <span aria-hidden="true"> · </span> : null}
          {answer.text ? <q>{answer.text}</q> : null}
        </span>
        {phase === 'sending' ? <span className="desk-answered-sending">Sending</span> : null}
      </p>
      {warn ? (
        <p className="desk-answered-warn">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>Saved, but {to} was not told.</span>
          {onDismiss ? (
            <button type="button" className="desk-answered-ok" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
