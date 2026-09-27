// Client for /api/desk: the owner's "Needs you" list and the agent work board.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { apiJson } from './api';

export const DESK_COLUMNS = ['pipeline', 'up_next', 'in_progress', 'waiting', 'done'] as const;
export type DeskColumn = (typeof DESK_COLUMNS)[number];
export type DeskPriority = 'low' | 'normal' | 'high';
export type DeskActor = { kind: 'owner' | 'agent'; id: string; name: string };

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

export type DeskSummary = { rev: number; openTodos: number; highTodos: number; waitingCards: number };

/** Opens an agent's home thread from anywhere in the shell. */
export const OPEN_AGENT_EVENT = 'rivendell:open-agent';
export function openAgentThread(agentId: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_AGENT_EVENT, { detail: agentId }));
}

const DESK_KEY = ['desk'] as const;
const SUMMARY_KEY = ['desk-summary'] as const;

/** Full desk, polled while the room is open. Agents write here from their own
 *  turns, so a short interval plus refetch-on-focus keeps it live. */
export function useDesk() {
  return useQuery({
    queryKey: DESK_KEY,
    queryFn: ({ signal }) => apiJson<DeskSnapshot>('/api/desk', { signal, cache: 'no-store' }),
    refetchInterval: 10_000,
    refetchOnWindowFocus: 'always',
    staleTime: 2_000,
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

/** Run a desk write with an optimistic local edit, then resync from the server.
 *  A failed write rolls back to the snapshot taken before the edit. */
export function useDeskWrite() {
  const queryClient = useQueryClient();
  return useCallback(async <T,>(request: () => Promise<T>, optimistic?: (desk: DeskSnapshot) => DeskSnapshot): Promise<T> => {
    await queryClient.cancelQueries({ queryKey: DESK_KEY });
    const previous = queryClient.getQueryData<DeskSnapshot>(DESK_KEY);
    if (previous && optimistic) queryClient.setQueryData(DESK_KEY, optimistic(previous));
    try {
      return await request();
    } catch (error) {
      if (previous) queryClient.setQueryData(DESK_KEY, previous);
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

export type TodoPatch = Partial<{ title: string; detail: string; due: string; priority: DeskPriority; link: string; cardId: string; status: 'open' | 'done' }>;
export type CardPatch = Partial<{ title: string; description: string; owner: string; project: string; priority: DeskPriority; links: string[]; column: DeskColumn }>;

export const deskApi = {
  addTodo: (input: TodoPatch & { title: string }) => apiJson<{ todo: DeskTodo }>('/api/desk/todos', json('POST', input)),
  updateTodo: (id: string, patch: TodoPatch) => apiJson<{ todo: DeskTodo }>(`/api/desk/todos/${enc(id)}`, json('PATCH', patch)),
  completeTodo: (id: string) => apiJson<{ todo: DeskTodo }>(`/api/desk/todos/${enc(id)}/complete`, json('POST', {})),
  reopenTodo: (id: string) => apiJson<{ todo: DeskTodo }>(`/api/desk/todos/${enc(id)}/reopen`, json('POST', {})),
  deleteTodo: (id: string) => apiJson<void>(`/api/desk/todos/${enc(id)}`, json('DELETE')),
  createCard: (input: CardPatch & { title: string; index?: number }) => apiJson<{ card: DeskCard }>('/api/desk/cards', json('POST', input)),
  updateCard: (id: string, patch: CardPatch) => apiJson<{ card: DeskCard }>(`/api/desk/cards/${enc(id)}`, json('PATCH', patch)),
  moveCard: (id: string, column: DeskColumn, index?: number) => apiJson<{ card: DeskCard }>(`/api/desk/cards/${enc(id)}/move`, json('POST', { column, index })),
  comment: (id: string, text: string) => apiJson<{ card: DeskCard }>(`/api/desk/cards/${enc(id)}/comments`, json('POST', { text })),
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
