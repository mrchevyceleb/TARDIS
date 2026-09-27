// The Desk: "Needs you" todos for the owner plus a board of agent work.
// Store: ~/.rivendell/desk.json (RIVENDELL_DESK_FILE overrides the path).
//
// Every mutation runs read -> change -> atomic write inside one in-process
// lock, so two agents writing at the same moment cannot clobber each other.
// Only this server writes the file; the team MCP reaches it over HTTP.

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DESK_FILE } from '../config.ts';

export const DESK_COLUMNS = ['pipeline', 'up_next', 'in_progress', 'waiting', 'done'] as const;
export type DeskColumn = (typeof DESK_COLUMNS)[number];
export const DESK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type DeskPriority = (typeof DESK_PRIORITIES)[number];

export type DeskActor = { kind: 'owner' | 'agent'; id: string; name: string };

export type DeskTodo = {
  id: string;
  title: string;
  detail?: string;
  from: DeskActor;
  createdAt: string;
  updatedAt: string;
  /** YYYY-MM-DD */
  due?: string;
  priority: DeskPriority;
  /** http(s) URL or `thread:<agentId>` */
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
  /** When the card entered its current column (for "parked 4d" ages). */
  columnSince: string;
  createdBy?: DeskActor;
  archived?: boolean;
};

export type DeskData = { version: 1; rev: number; todos: DeskTodo[]; cards: DeskCard[] };

export const DESK_LIMITS = {
  title: 200,
  detail: 4000,
  description: 8000,
  comment: 4000,
  project: 60,
  link: 2000,
  links: 20,
  commentsPerCard: 400,
  todos: 2000,
  cards: 2000,
} as const;

/** Thrown for bad input or a missing record; routes map `status` to HTTP. */
export class DeskError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---- normalisers (shared by input validation and on-disk repair) -----------

const COLUMN_ALIASES: Record<string, DeskColumn> = {
  pipeline: 'pipeline', parked: 'pipeline', backlog: 'pipeline', later: 'pipeline',
  up_next: 'up_next', upnext: 'up_next', next: 'up_next', todo: 'up_next',
  in_progress: 'in_progress', inprogress: 'in_progress', doing: 'in_progress', active: 'in_progress', working: 'in_progress',
  waiting: 'waiting', waiting_on_matt: 'waiting', waiting_on_owner: 'waiting', blocked: 'waiting', needs_you: 'waiting',
  done: 'done', complete: 'done', completed: 'done', shipped: 'done',
};

export function parseColumn(value: unknown): DeskColumn | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return COLUMN_ALIASES[key] ?? null;
}

export function parsePriority(value: unknown): DeskPriority | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key === 'low' || key === 'p3') return 'low';
  if (key === 'normal' || key === 'medium' || key === 'med' || key === 'default' || key === 'p2') return 'normal';
  if (key === 'high' || key === 'urgent' || key === 'critical' || key === 'p0' || key === 'p1') return 'high';
  return null;
}

function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD, '' (clear), or null when unparseable. */
export function parseDue(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'today') return localDay(0);
  if (raw === 'tomorrow') return localDay(1);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

/** http(s) URL or `thread:<agentId>`; '' clears; null when invalid. */
export function parseLink(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return '';
  if (raw.length > DESK_LIMITS.link) return null;
  const thread = raw.match(/^thread:([a-z0-9][a-z0-9_-]{0,80})$/i);
  if (thread) return `thread:${thread[1]}`;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
}

function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function isoOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function normalizeActor(value: unknown): DeskActor | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = oneLine(raw.name, 80);
  if (!name) return null;
  return { kind: raw.kind === 'owner' ? 'owner' : 'agent', id: oneLine(raw.id, 80) || name.toLowerCase(), name };
}

function normalizeTodo(value: unknown, now: string): DeskTodo | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = oneLine(raw.id, 80);
  const title = oneLine(raw.title, DESK_LIMITS.title);
  const from = normalizeActor(raw.from);
  if (!id || !title || !from) return null;
  const todo: DeskTodo = {
    id,
    title,
    from,
    createdAt: isoOr(raw.createdAt, now),
    updatedAt: isoOr(raw.updatedAt, now),
    priority: parsePriority(raw.priority) ?? 'normal',
    status: raw.status === 'done' ? 'done' : 'open',
  };
  const detail = clip(raw.detail, DESK_LIMITS.detail);
  if (detail) todo.detail = detail;
  const due = parseDue(raw.due);
  if (due) todo.due = due;
  const link = parseLink(raw.link);
  if (link) todo.link = link;
  if (todo.status === 'done') todo.completedAt = isoOr(raw.completedAt, todo.updatedAt);
  const cardId = oneLine(raw.cardId, 80);
  if (cardId) todo.cardId = cardId;
  return todo;
}

function normalizeComment(value: unknown, now: string): DeskComment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = oneLine(raw.id, 80);
  const text = clip(raw.text, DESK_LIMITS.comment);
  const author = normalizeActor(raw.author);
  if (!id || !text || !author) return null;
  return { id, author, text, at: isoOr(raw.at, now) };
}

function normalizeCard(value: unknown, now: string): DeskCard | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = oneLine(raw.id, 80);
  const title = oneLine(raw.title, DESK_LIMITS.title);
  const owner = normalizeActor(raw.owner);
  if (!id || !title || !owner) return null;
  const updatedAt = isoOr(raw.updatedAt, now);
  const card: DeskCard = {
    id,
    title,
    owner,
    column: parseColumn(raw.column) ?? 'pipeline',
    priority: parsePriority(raw.priority) ?? 'normal',
    links: Array.isArray(raw.links)
      ? raw.links.map(parseLink).filter((l): l is string => Boolean(l)).slice(0, DESK_LIMITS.links)
      : [],
    comments: Array.isArray(raw.comments)
      ? raw.comments.map((c) => normalizeComment(c, now)).filter((c): c is DeskComment => Boolean(c))
      : [],
    createdAt: isoOr(raw.createdAt, now),
    updatedAt,
    columnSince: isoOr(raw.columnSince, updatedAt),
  };
  const description = clip(raw.description, DESK_LIMITS.description);
  if (description) card.description = description;
  const project = oneLine(raw.project, DESK_LIMITS.project);
  if (project) card.project = project;
  const createdBy = normalizeActor(raw.createdBy);
  if (createdBy) card.createdBy = createdBy;
  if (raw.archived === true) card.archived = true;
  return card;
}

// ---- persistence ------------------------------------------------------------

let cache: { data: DeskData; mtimeMs: number; size: number } | null = null;
let chain: Promise<unknown> = Promise.resolve();

function emptyDesk(): DeskData {
  return { version: 1, rev: 0, todos: [], cards: [] };
}

async function load(): Promise<DeskData> {
  let info;
  try {
    info = await stat(DESK_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = null;
      return emptyDesk();
    }
    throw error;
  }
  if (cache && cache.mtimeMs === info.mtimeMs && cache.size === info.size) return cache.data;
  const raw = await readFile(DESK_FILE, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never paper over a damaged file with an empty desk: that would erase it
    // on the next write. Fail loudly until someone repairs or moves it.
    throw new DeskError(500, `desk.json is not valid JSON; refusing to overwrite it (${DESK_FILE})`);
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const data: DeskData = {
    version: 1,
    rev: typeof obj.rev === 'number' && Number.isFinite(obj.rev) ? obj.rev : 0,
    todos: Array.isArray(obj.todos) ? obj.todos.map((t) => normalizeTodo(t, now)).filter((t): t is DeskTodo => Boolean(t)) : [],
    cards: Array.isArray(obj.cards) ? obj.cards.map((c) => normalizeCard(c, now)).filter((c): c is DeskCard => Boolean(c)) : [],
  };
  cache = { data, mtimeMs: info.mtimeMs, size: info.size };
  return data;
}

async function save(data: DeskData): Promise<void> {
  const dir = dirname(DESK_FILE);
  await mkdir(dir, { recursive: true });
  const tmp = `${DESK_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  let handleOpen = true;
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handleOpen = false;
    try {
      await rename(tmp, DESK_FILE);
    } catch {
      // Windows can refuse to replace an open file; overwrite in place so a
      // failed rename never leaves the desk deleted.
      await writeFile(DESK_FILE, await readFile(tmp));
      await rm(tmp, { force: true });
    }
  } catch (error) {
    if (handleOpen) await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  const info = await stat(DESK_FILE);
  cache = { data, mtimeMs: info.mtimeMs, size: info.size };
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Read-modify-write under the lock. `fn` edits a private copy; the file is
 *  only written (and rev bumped) when `fn` returns without throwing. */
function mutate<T>(fn: (data: DeskData, now: string) => T): Promise<T> {
  return withLock(async () => {
    const data = structuredClone(await load());
    const result = fn(data, new Date().toISOString());
    data.rev += 1;
    await save(data);
    return result;
  });
}

export async function readDesk(): Promise<DeskData> {
  return load();
}

function newId(prefix: string, taken: (id: string) => boolean): string {
  for (;;) {
    const id = `${prefix}-${randomBytes(4).toString('hex').slice(0, 6)}`;
    if (!taken(id)) return id;
  }
}

function findTodo(data: DeskData, id: string): DeskTodo {
  const todo = data.todos.find((t) => t.id === id);
  if (!todo) throw new DeskError(404, `No Needs-you item with id ${id}.`);
  return todo;
}

function findCard(data: DeskData, id: string): DeskCard {
  const card = data.cards.find((c) => c.id === id);
  if (!card) throw new DeskError(404, `No board card with id ${id}.`);
  return card;
}

function requireTitle(value: unknown): string {
  const title = oneLine(value, DESK_LIMITS.title);
  if (!title) throw new DeskError(400, 'title is required');
  return title;
}

function requirePriority(value: unknown): DeskPriority {
  const priority = parsePriority(value);
  if (!priority) throw new DeskError(400, 'priority must be low, normal, or high');
  return priority;
}

function requireColumn(value: unknown): DeskColumn {
  const column = parseColumn(value);
  if (!column) throw new DeskError(400, `column must be one of ${DESK_COLUMNS.join(', ')}`);
  return column;
}

function requireDue(value: unknown): string {
  const due = parseDue(value);
  if (due === null) throw new DeskError(400, 'due must be a date like 2026-10-01 (or today / tomorrow)');
  return due;
}

function requireLink(value: unknown): string {
  const link = parseLink(value);
  if (link === null) throw new DeskError(400, 'link must be an http(s) URL or thread:<agentId>');
  return link;
}

function requireLinks(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    const link = requireLink(item);
    if (link && !out.includes(link)) out.push(link);
  }
  if (out.length > DESK_LIMITS.links) throw new DeskError(400, `at most ${DESK_LIMITS.links} links per card`);
  return out;
}

function requireCardRef(data: DeskData, value: unknown): string {
  const cardId = oneLine(value, 80);
  if (cardId && !data.cards.some((c) => c.id === cardId)) throw new DeskError(400, `No board card with id ${cardId}.`);
  return cardId;
}

/** Make room under a cap by dropping the oldest finished records first. */
function pruneTodos(data: DeskData): void {
  if (data.todos.length < DESK_LIMITS.todos) return;
  const done = data.todos
    .filter((t) => t.status === 'done')
    .sort((a, b) => (a.completedAt ?? a.updatedAt).localeCompare(b.completedAt ?? b.updatedAt));
  const drop = new Set(done.slice(0, data.todos.length - DESK_LIMITS.todos + 1).map((t) => t.id));
  data.todos = data.todos.filter((t) => !drop.has(t.id));
  if (data.todos.length >= DESK_LIMITS.todos) throw new DeskError(409, 'The Needs-you list is full; complete or delete some items first.');
}

function pruneCards(data: DeskData): void {
  if (data.cards.length < DESK_LIMITS.cards) return;
  const finished = data.cards
    .filter((c) => c.archived || c.column === 'done')
    .sort((a, b) => Number(Boolean(b.archived)) - Number(Boolean(a.archived)) || a.updatedAt.localeCompare(b.updatedAt));
  const drop = new Set(finished.slice(0, data.cards.length - DESK_LIMITS.cards + 1).map((c) => c.id));
  data.cards = data.cards.filter((c) => !drop.has(c.id));
  if (data.cards.length >= DESK_LIMITS.cards) throw new DeskError(409, 'The board is full; archive some cards first.');
}

/** Insert `card` into `column` at `index` among that column's live cards. */
function placeCard(data: DeskData, card: DeskCard, index: number | undefined): void {
  const others = data.cards.filter((c) => c.id !== card.id);
  const peers = others.filter((c) => c.column === card.column && !c.archived);
  const at = index === undefined ? 0 : Math.max(0, Math.min(Math.floor(index), peers.length));
  let position: number;
  if (!peers.length) position = others.length;
  else if (at >= peers.length) position = others.indexOf(peers[peers.length - 1]) + 1;
  else position = others.indexOf(peers[at]);
  others.splice(position, 0, card);
  data.cards = others;
}

// ---- todos --------------------------------------------------------------------

export type TodoInput = {
  title?: unknown; detail?: unknown; due?: unknown; priority?: unknown; link?: unknown; cardId?: unknown; status?: unknown;
};

export function createTodo(input: TodoInput, from: DeskActor): Promise<DeskTodo> {
  return mutate((data, now) => {
    const todo: DeskTodo = {
      id: newId('todo', (id) => data.todos.some((t) => t.id === id)),
      title: requireTitle(input.title),
      from,
      createdAt: now,
      updatedAt: now,
      priority: input.priority === undefined || input.priority === '' ? 'normal' : requirePriority(input.priority),
      status: 'open',
    };
    const detail = clip(input.detail, DESK_LIMITS.detail);
    if (detail) todo.detail = detail;
    const due = requireDue(input.due);
    if (due) todo.due = due;
    const link = requireLink(input.link);
    if (link) todo.link = link;
    const cardId = requireCardRef(data, input.cardId);
    if (cardId) todo.cardId = cardId;
    pruneTodos(data);
    data.todos.unshift(todo);
    return todo;
  });
}

export function updateTodo(id: string, input: TodoInput): Promise<DeskTodo> {
  return mutate((data, now) => {
    const todo = findTodo(data, id);
    if (input.title !== undefined) todo.title = requireTitle(input.title);
    if (input.detail !== undefined) {
      const detail = clip(input.detail, DESK_LIMITS.detail);
      if (detail) todo.detail = detail; else delete todo.detail;
    }
    if (input.due !== undefined) {
      const due = requireDue(input.due);
      if (due) todo.due = due; else delete todo.due;
    }
    if (input.priority !== undefined) todo.priority = requirePriority(input.priority);
    if (input.link !== undefined) {
      const link = requireLink(input.link);
      if (link) todo.link = link; else delete todo.link;
    }
    if (input.cardId !== undefined) {
      const cardId = requireCardRef(data, input.cardId);
      if (cardId) todo.cardId = cardId; else delete todo.cardId;
    }
    if (input.status !== undefined) {
      if (input.status !== 'open' && input.status !== 'done') throw new DeskError(400, 'status must be open or done');
      applyTodoStatus(todo, input.status, now);
    }
    todo.updatedAt = now;
    return todo;
  });
}

function applyTodoStatus(todo: DeskTodo, status: 'open' | 'done', now: string): void {
  if (status === todo.status) return;
  todo.status = status;
  if (status === 'done') todo.completedAt = now;
  else delete todo.completedAt;
}

export function setTodoStatus(id: string, status: 'open' | 'done'): Promise<DeskTodo> {
  return mutate((data, now) => {
    const todo = findTodo(data, id);
    applyTodoStatus(todo, status, now);
    todo.updatedAt = now;
    return todo;
  });
}

export function deleteTodo(id: string): Promise<void> {
  return mutate((data) => {
    findTodo(data, id);
    data.todos = data.todos.filter((t) => t.id !== id);
  });
}

// ---- cards --------------------------------------------------------------------

export type CardInput = {
  title?: unknown; description?: unknown; column?: unknown; priority?: unknown; project?: unknown; links?: unknown; index?: unknown;
};

export function createCard(input: CardInput, owner: DeskActor, by: DeskActor): Promise<DeskCard> {
  return mutate((data, now) => {
    const card: DeskCard = {
      id: newId('card', (id) => data.cards.some((c) => c.id === id)),
      title: requireTitle(input.title),
      owner,
      column: input.column === undefined || input.column === '' ? 'up_next' : requireColumn(input.column),
      priority: input.priority === undefined || input.priority === '' ? 'normal' : requirePriority(input.priority),
      links: requireLinks(input.links),
      comments: [],
      createdAt: now,
      updatedAt: now,
      columnSince: now,
      createdBy: by,
    };
    const description = clip(input.description, DESK_LIMITS.description);
    if (description) card.description = description;
    const project = oneLine(input.project, DESK_LIMITS.project);
    if (project) card.project = project;
    pruneCards(data);
    placeCard(data, card, typeof input.index === 'number' ? input.index : undefined);
    return card;
  });
}

export function updateCard(id: string, input: CardInput, owner?: DeskActor): Promise<DeskCard> {
  return mutate((data, now) => {
    const card = findCard(data, id);
    if (input.title !== undefined) card.title = requireTitle(input.title);
    if (input.description !== undefined) {
      const description = clip(input.description, DESK_LIMITS.description);
      if (description) card.description = description; else delete card.description;
    }
    if (input.project !== undefined) {
      const project = oneLine(input.project, DESK_LIMITS.project);
      if (project) card.project = project; else delete card.project;
    }
    if (input.priority !== undefined) card.priority = requirePriority(input.priority);
    if (input.links !== undefined) card.links = requireLinks(input.links);
    if (owner) card.owner = owner;
    if (input.column !== undefined) {
      const column = requireColumn(input.column);
      if (column !== card.column) {
        card.column = column;
        card.columnSince = now;
        delete card.archived;
        placeCard(data, card, 0);
      }
    }
    card.updatedAt = now;
    return card;
  });
}

export function moveCard(id: string, column: unknown, index?: unknown): Promise<DeskCard> {
  return mutate((data, now) => {
    const card = findCard(data, id);
    const target = requireColumn(column);
    if (target !== card.column) {
      card.column = target;
      card.columnSince = now;
    }
    delete card.archived;
    card.updatedAt = now;
    const at = typeof index === 'number' && Number.isFinite(index) ? index : undefined;
    placeCard(data, card, at);
    return card;
  });
}

export function commentCard(id: string, text: unknown, author: DeskActor): Promise<{ card: DeskCard; comment: DeskComment }> {
  return mutate((data, now) => {
    const card = findCard(data, id);
    const body = clip(text, DESK_LIMITS.comment);
    if (!body) throw new DeskError(400, 'text is required');
    if (card.comments.length >= DESK_LIMITS.commentsPerCard) {
      throw new DeskError(409, 'This card has too many comments; start a fresh card for the next phase.');
    }
    const comment: DeskComment = {
      id: newId('cm', (cid) => card.comments.some((c) => c.id === cid)),
      author,
      text: body,
      at: now,
    };
    card.comments.push(comment);
    card.updatedAt = now;
    return { card, comment };
  });
}

export function deleteComment(cardId: string, commentId: string): Promise<DeskCard> {
  return mutate((data, now) => {
    const card = findCard(data, cardId);
    const next = card.comments.filter((c) => c.id !== commentId);
    if (next.length === card.comments.length) throw new DeskError(404, `No comment ${commentId} on ${cardId}.`);
    card.comments = next;
    card.updatedAt = now;
    return card;
  });
}

export function archiveCard(id: string, archived: boolean): Promise<DeskCard> {
  return mutate((data, now) => {
    const card = findCard(data, id);
    if (archived) card.archived = true;
    else delete card.archived;
    card.updatedAt = now;
    return card;
  });
}
