// Client for /api/desk: the owner's "Needs you" list and the agent work board.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { apiJson } from './api';

export const DESK_COLUMNS = ['not_started', 'in_progress', 'in_qa', 'on_staging', 'in_production'] as const;
export type DeskColumn = (typeof DESK_COLUMNS)[number];
export type DeskPriority = 'low' | 'normal' | 'high';
export type DeskActor = { kind: 'owner' | 'agent'; id: string; name: string };

/** The owner's answer to a Needs-you item. `delivery` says whether the agent
 *  who asked was told ('none' when the item was the owner's own). */
export type DeskAnswer = { choice?: string; text?: string; at: string; delivery: 'sent' | 'failed' | 'none' };

export type DeskTodo = {
  id: string;
  title: string;
  detail?: string;
  from: DeskActor;
  createdAt: string;
  updatedAt: string;
  due?: string;
  priority: DeskPriority;
  link?: string;
  status: 'open' | 'done';
  completedAt?: string;
  cardId?: string;
  /** Up to four one-tap answers the agent offered (Yes / No when absent). */
  choices?: string[];
  answer?: DeskAnswer;
};

export type DeskComment = { id: string; author: DeskActor; text: string; at: string };

export type DeskCard = {
  id: string;
  title: string;
  description?: string;
  owner: DeskActor;
  column: DeskColumn;
  priority: DeskPriority;
  project?: string;
  links: string[];
  comments: DeskComment[];
  createdAt: string;
  updatedAt: string;
  columnSince: string;
  createdBy?: DeskActor;
  archived?: boolean;
};

export type DeskSnapshot = {
  rev: number;
  owner: DeskActor;
  columns: Array<{ key: DeskColumn; title: string }>;
  todos: DeskTodo[];
  cards: DeskCard[];
};

/** An open high-priority item, as the summary poll lists it (newest first). */
export type DeskHighItem = { id: string; title: string; createdAt: string; from: string };

export type DeskSummary = {
  rev: number;
  openTodos: number;
  highTodos: number;
  waitingCards: number;
  /** Present once the server can take answers. The answer UI and desktop
   *  alerts stay off without it, so a client shipped first degrades cleanly. */
  answerable?: boolean;
  high?: DeskHighItem[];
  /** True while a high item should not raise a desktop alert (the server's
   *  quiet hours). */
  quiet?: boolean;
};

/** Opens an agent's home thread from anywhere in the shell. */
export const OPEN_AGENT_EVENT = 'rivendell:open-agent';
export function openAgentThread(agentId: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_AGENT_EVENT, { detail: agentId }));
}

// ---- references from chat ------------------------------------------------------------
// A chat message points at the Desk with a plain-text token, `[desk:card-15a412]`
// or `[desk:todo-71aaeb]`. Agents read it as text and resolve it with
// board_card_get / desk_todos; the chat renders it as a live pill.

export type DeskRefKind = 'card' | 'todo';
export type DeskRef = { kind: DeskRefKind; id: string };
/** A reference waiting in the composer, with the title it had when picked. */
export type DeskChip = DeskRef & { title: string };

const DESK_REF_SOURCE = String.raw`\[desk:((card|todo)-[a-z0-9][a-z0-9_-]{0,78})\]`;
/** Fresh global regex each call, so callers never share lastIndex. */
export function deskRefPattern(): RegExp {
  return new RegExp(DESK_REF_SOURCE, 'gi');
}

export function deskRefToken(ref: Pick<DeskRef, 'id'>): string {
  return `[desk:${ref.id}]`;
}

/** Text or a reference, in order, for rendering a message. */
export function splitDeskRefs(text: string): Array<string | DeskRef> {
  const out: Array<string | DeskRef> = [];
  let last = 0;
  for (const match of text.matchAll(deskRefPattern())) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push({ kind: match[2].toLowerCase() as DeskRefKind, id: match[1] });
    last = start + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function hasDeskRef(text: string): boolean {
  return deskRefPattern().test(text);
}

/** The message as sent: reference tokens on the first line, then the question. */
export function composeDeskMessage(chips: Array<Pick<DeskRef, 'id'>>, text: string): string {
  const body = text.trim();
  if (!chips.length) return body;
  const tokens = chips.map(deskRefToken).join(' ');
  return body ? `${tokens}\n${body}` : tokens;
}

/** "Discuss" on a card or Needs-you row: open the Desk chat with a chip. */
export const DESK_DISCUSS_EVENT = 'rivendell:desk-discuss';
export function discussOnDesk(chip: DeskChip): void {
  window.dispatchEvent(new CustomEvent<DeskChip>(DESK_DISCUSS_EVENT, { detail: chip }));
}

/** Clicking a pill: open the Desk on that card or Needs-you item. The request
 *  waits here until the Desk has mounted and loaded its data. */
export const DESK_FOCUS_EVENT = 'rivendell:desk-focus';
let pendingFocus: DeskRef | null = null;
export function focusDeskRef(ref: DeskRef): void {
  pendingFocus = ref;
  window.dispatchEvent(new CustomEvent<DeskRef>(DESK_FOCUS_EVENT, { detail: ref }));
}
export function peekDeskFocus(): DeskRef | null {
  return pendingFocus;
}
export function clearDeskFocus(ref: DeskRef): void {
  if (pendingFocus && pendingFocus.id === ref.id) pendingFocus = null;
}

/** A focus request for "whatever is at the top of Needs you" (the Needs-you
 *  badge, a coalesced alert, `?desk=open`). The Desk resolves it against its
 *  own sort once it has fresh data. */
export const DESK_FIRST_OPEN = '*first-open';
export const FIRST_OPEN_REF: DeskRef = { kind: 'todo', id: DESK_FIRST_OPEN };

const DEEP_LINK_ID = /^(card|todo)-[a-z0-9][a-z0-9_-]{0,78}$/i;

/** `?desk=<todoId>` or `?desk=open` (a phone push opens these). Anything that
 *  is not a Desk id just opens the Desk. */
export function parseDeskDeepLink(url: URL): DeskRef | null {
  const raw = url.searchParams.get('desk');
  if (raw === null) return null;
  const value = raw.trim();
  if (!DEEP_LINK_ID.test(value)) return FIRST_OPEN_REF;
  return { kind: value.toLowerCase().startsWith('card-') ? 'card' : 'todo', id: value };
}

/** The page's own deep link, with the param stripped so a reload or a copied
 *  URL does not repeat it. */
export function takeDeskDeepLink(): DeskRef | null {
  let url: URL;
  try { url = new URL(window.location.href); } catch { return null; }
  const ref = parseDeskDeepLink(url);
  if (!ref) return null;
  url.searchParams.delete('desk');
  try { window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`); } catch { /* sandboxed */ }
  return ref;
}

/** Handles Desk deep links for a shell: on load, on history navigation, and
 *  when an installed web app is relaunched into this window with a new URL
 *  (the first launch call repeats the boot URL, handled on load). */
export function useDeskDeepLinks(open: (ref: DeskRef) => void): void {
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => {
    const bootHref = window.location.href;
    const handle = () => {
      const ref = takeDeskDeepLink();
      if (ref) openRef.current(ref);
    };
    handle();
    window.addEventListener('popstate', handle);
    type LaunchQueue = { setConsumer: (consumer: (params: { targetURL?: string }) => void) => void };
    const launchQueue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
    let first = true;
    launchQueue?.setConsumer((params) => {
      const boot = first && params.targetURL === bootHref;
      first = false;
      if (boot || !params.targetURL) return;
      try {
        const ref = parseDeskDeepLink(new URL(params.targetURL, window.location.href));
        if (ref) openRef.current(ref);
      } catch { /* not a URL we know */ }
    });
    return () => window.removeEventListener('popstate', handle);
  }, []);
}

export function hasDeskDeepLink(): boolean {
  try { return new URLSearchParams(window.location.search).has('desk'); } catch { return false; }
}

/** The URL that opens the Desk on an item from anywhere (another route, a push). */
export function deskDeepLinkUrl(ref: DeskRef): string {
  return `/?desk=${ref.id === DESK_FIRST_OPEN ? 'open' : encodeURIComponent(ref.id)}`;
}

const DESK_KEY = ['desk'] as const;
const SUMMARY_KEY = ['desk-summary'] as const;
const fetchDesk = ({ signal }: { signal: AbortSignal }) => apiJson<DeskSnapshot>('/api/desk', { signal, cache: 'no-store' });

/** Full desk, polled while the room is open. Agents write here from their own
 *  turns, so a short interval plus refetch-on-focus keeps it live. */
export function useDesk() {
  return useQuery({
    queryKey: DESK_KEY,
    queryFn: fetchDesk,
    refetchInterval: 10_000,
    refetchOnWindowFocus: 'always',
    staleTime: 2_000,
    retry: 1,
  });
}

/** Same snapshot for chat pills, without a poll of its own: every pill shares
 *  one cached fetch, and the Desk room keeps it fresh while it is open. */
export function useDeskLookup(enabled: boolean) {
  return useQuery({
    queryKey: DESK_KEY,
    queryFn: fetchDesk,
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/** Tiny poll for the workspace badge. */
export function useDeskSummary(enabled: boolean) {
  return useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: ({ signal }) => apiJson<DeskSummary>('/api/desk/summary', { signal, cache: 'no-store' }),
    enabled,
    refetchInterval: 20_000,
    refetchOnWindowFocus: 'always',
    staleTime: 5_000,
    retry: false,
  });
}

/** The summary counts moved by the same amount an optimistic edit moved the
 *  snapshot, so the Needs-you badge changes with the row (a delta, because the
 *  cached snapshot can be older than the summary). */
function shiftSummary(summary: DeskSummary, before: DeskSnapshot, after: DeskSnapshot): DeskSummary {
  const openIds = (d: DeskSnapshot) => new Set(d.todos.filter((t) => t.status === 'open').map((t) => t.id));
  const highCount = (d: DeskSnapshot) => d.todos.filter((t) => t.status === 'open' && t.priority === 'high').length;
  const stillOpen = openIds(after);
  const openDelta = openIds(before).size - stillOpen.size;
  const highDelta = highCount(before) - highCount(after);
  if (!openDelta && !highDelta) return summary;
  return {
    ...summary,
    openTodos: Math.max(0, summary.openTodos - openDelta),
    highTodos: Math.max(0, summary.highTodos - highDelta),
    ...(summary.high ? { high: summary.high.filter((h) => stillOpen.has(h.id) || !before.todos.some((t) => t.id === h.id)) } : {}),
  };
}

/** Undo one optimistic edit inside whatever the cache holds now: only the
 *  todos and cards that edit touched go back, so an overlapping write from
 *  another row (or a newer poll) survives the rollback. */
function revertEdit(current: DeskSnapshot, before: DeskSnapshot, after: DeskSnapshot): DeskSnapshot {
  const revert = <V extends { id: string }>(now: V[], was: V[], became: V[]): V[] => {
    const wasById = new Map(was.map((x) => [x.id, x]));
    const becameIds = new Set(became.map((x) => x.id));
    const touched = new Set<string>();
    for (const x of became) if (wasById.get(x.id) !== x) touched.add(x.id);
    for (const x of was) if (!becameIds.has(x.id)) touched.add(x.id);
    if (!touched.size) return now;
    const nowIds = new Set(now.map((x) => x.id));
    const out = now.flatMap((x) => (!touched.has(x.id) ? [x] : wasById.has(x.id) ? [wasById.get(x.id)!] : []));
    for (const x of was) if (touched.has(x.id) && !nowIds.has(x.id)) out.push(x);
    return out;
  };
  return { ...current, todos: revert(current.todos, before.todos, after.todos), cards: revert(current.cards, before.cards, after.cards) };
}

/** Run a desk write with an optimistic local edit, then resync from the server.
 *  A failed write takes back just that edit (and its badge count). */
export function useDeskWrite() {
  const queryClient = useQueryClient();
  return useCallback(async <T,>(request: () => Promise<T>, optimistic?: (desk: DeskSnapshot) => DeskSnapshot): Promise<T> => {
    await Promise.all([queryClient.cancelQueries({ queryKey: DESK_KEY }), queryClient.cancelQueries({ queryKey: SUMMARY_KEY })]);
    const previous = queryClient.getQueryData<DeskSnapshot>(DESK_KEY);
    const previousSummary = queryClient.getQueryData<DeskSummary>(SUMMARY_KEY);
    // What the cache actually stored (structural sharing may copy), so the
    // rollback can tell whether anything newer has landed since.
    let applied: { after: DeskSnapshot; shifted?: DeskSummary } | null = null;
    if (previous && optimistic) {
      const after = queryClient.setQueryData<DeskSnapshot>(DESK_KEY, optimistic(previous));
      const shifted = previousSummary && after ? queryClient.setQueryData<DeskSummary>(SUMMARY_KEY, shiftSummary(previousSummary, previous, after)) : undefined;
      if (after) applied = { after, shifted };
    }
    try {
      return await request();
    } catch (error) {
      if (applied && previous) {
        const now = queryClient.getQueryData<DeskSnapshot>(DESK_KEY);
        queryClient.setQueryData(DESK_KEY, !now || now === applied.after ? previous : revertEdit(now, previous, applied.after));
        // The count goes back only if nothing newer replaced it; otherwise the
        // refetch below settles it.
        if (previousSummary && applied.shifted && queryClient.getQueryData(SUMMARY_KEY) === applied.shifted) {
          queryClient.setQueryData(SUMMARY_KEY, previousSummary);
        }
      }
      throw error;
    } finally {
      void queryClient.invalidateQueries({ queryKey: DESK_KEY });
      void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
    }
  }, [queryClient]);
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const enc = encodeURIComponent;

/** Who an owner comment was sent to, so they can answer on the card. */
export type CommentNotice = { delivered: boolean; to?: string; reason?: string };

export type TodoPatch = Partial<{ title: string; detail: string; due: string; priority: DeskPriority; link: string; cardId: string; status: 'open' | 'done' }>;
export type TodoAnswerInput = { choice?: string; text?: string };
export type TodoAnswerResult = { todo: DeskTodo; notified?: CommentNotice; duplicate?: boolean };
export type CardPatch = Partial<{ title: string; description: string; owner: string; project: string; priority: DeskPriority; links: string[]; column: DeskColumn }>;

export const deskApi = {
  addTodo: (input: TodoPatch & { title: string }) => apiJson<{ todo: DeskTodo }>('/api/desk/todos', json('POST', input)),
  updateTodo: (id: string, patch: TodoPatch) => apiJson<{ todo: DeskTodo }>(`/api/desk/todos/${enc(id)}`, json('PATCH', patch)),
  completeTodo: (id: string) => apiJson<{ todo: DeskTodo }>(`/api/desk/todos/${enc(id)}/complete`, json('POST', {})),
  reopenTodo: (id: string) => apiJson<{ todo: DeskTodo }>(`/api/desk/todos/${enc(id)}/reopen`, json('POST', {})),
  deleteTodo: (id: string) => apiJson<void>(`/api/desk/todos/${enc(id)}`, json('DELETE')),
  answerTodo: (id: string, input: TodoAnswerInput) => apiJson<TodoAnswerResult>(`/api/desk/todos/${enc(id)}/answer`, json('POST', input)),
  createCard: (input: CardPatch & { title: string; index?: number }) => apiJson<{ card: DeskCard }>('/api/desk/cards', json('POST', input)),
  updateCard: (id: string, patch: CardPatch) => apiJson<{ card: DeskCard }>(`/api/desk/cards/${enc(id)}`, json('PATCH', patch)),
  moveCard: (id: string, column: DeskColumn, index?: number) => apiJson<{ card: DeskCard }>(`/api/desk/cards/${enc(id)}/move`, json('POST', { column, index })),
  comment: (id: string, text: string) => apiJson<{ card: DeskCard; notified?: CommentNotice }>(`/api/desk/cards/${enc(id)}/comments`, json('POST', { text })),
  deleteComment: (id: string, commentId: string) => apiJson<{ card: DeskCard }>(`/api/desk/cards/${enc(id)}/comments/${enc(commentId)}`, json('DELETE')),
  archiveCard: (id: string, archived: boolean) => apiJson<{ card: DeskCard }>(`/api/desk/cards/${enc(id)}/archive`, json('POST', { archived })),
};

// ---- shared view helpers ----------------------------------------------------------

export const PRIORITY_RANK: Record<DeskPriority, number> = { high: 0, normal: 1, low: 2 };

/** Open items: priority, then due (undated last), then oldest first. */
export function sortOpenTodos(todos: DeskTodo[]): DeskTodo[] {
  return [...todos].sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || (a.due ?? '9999-99-99').localeCompare(b.due ?? '9999-99-99')
    || a.createdAt.localeCompare(b.createdAt));
}

export function parseDay(value: string | undefined): Date | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Days from today to a YYYY-MM-DD (negative = overdue). */
export function daysUntil(value: string | undefined): number | null {
  const day = parseDay(value);
  if (!day) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((day.getTime() - today.getTime()) / 86_400_000);
}

export function dueLabel(value: string | undefined): { text: string; tone: 'rose' | 'gold' | 'elf' | 'neutral' } | null {
  const diff = daysUntil(value);
  if (diff === null) return null;
  if (diff < 0) return { text: diff === -1 ? 'overdue 1d' : `overdue ${-diff}d`, tone: 'rose' };
  if (diff === 0) return { text: 'due today', tone: 'gold' };
  if (diff === 1) return { text: 'due tomorrow', tone: 'elf' };
  const day = parseDay(value)!;
  return { text: `due ${new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(day)}`, tone: 'neutral' };
}

export function ageLabel(iso: string | undefined): string {
  const ts = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ts)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "3d ago", or "just now". */
export function agoText(iso: string | undefined): string {
  const label = ageLabel(iso);
  return !label ? '' : label === 'now' ? 'just now' : `${label} ago`;
}

/** Hours since an ISO time (Infinity when unknown). */
export function hoursSince(iso: string | undefined): number {
  const ts = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ts) ? (Date.now() - ts) / 3_600_000 : Infinity;
}
