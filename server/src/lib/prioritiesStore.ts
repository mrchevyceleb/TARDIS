// Matt's Priorities: a small, ordered, per-agent board the owner keeps on his
// Desk. The owner usually adds; the agent may edit too. Open items are
// stitched into every turn of that agent, read fresh from disk each time.
// Store: ~/.rivendell/matts-priorities.json

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';

/** Agents that have a board. One line adds another. */
export const PRIORITY_AGENTS = ['chief-of-staff', 'riley', 'kip'] as const;

export type PriorityItem = {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  /** 'matt' or the agent id that wrote it. */
  by: string;
};

const FILE = join(STATE_DIR, 'matts-priorities.json');
const TEXT_CAP = 240;
const MAX_PER_BOARD = 40;
const LINE_BREAKS = /\r\n|\r|\n|\u2028|\u2029/g;

export function hasPriorityBoard(agentId: string): boolean {
  return (PRIORITY_AGENTS as readonly string[]).includes(agentId);
}

function cleanText(value: unknown): string {
  // One line per item: a line break could forge extra lines in the turn block.
  return typeof value === 'string' ? value.replace(LINE_BREAKS, ' ').trim().slice(0, TEXT_CAP) : '';
}

function normalizeItem(value: unknown): PriorityItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const text = cleanText(raw.text);
  if (!id || !text) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    id,
    text,
    done: raw.done === true,
    createdAt: num(raw.createdAt),
    updatedAt: num(raw.updatedAt),
    by: typeof raw.by === 'string' && raw.by.trim() ? raw.by.trim() : 'matt',
  };
}

type Boards = Record<string, PriorityItem[]>;

function readAll(): Boards {
  let raw: string;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const data = JSON.parse(raw) as { boards?: unknown };
  const boards: Boards = {};
  if (data?.boards && typeof data.boards === 'object') {
    for (const [agentId, list] of Object.entries(data.boards as Record<string, unknown>)) {
      if (Array.isArray(list)) boards[agentId] = openFirst(list.map(normalizeItem).filter((i): i is PriorityItem => Boolean(i)));
    }
  }
  return boards;
}

/** Open items above done ones, each group in stored order. Moves and the
 *  Desk's open/done split both rely on this. */
function openFirst(list: PriorityItem[]): PriorityItem[] {
  return [...list.filter((i) => !i.done), ...list.filter((i) => i.done)];
}

function save(boards: Boards): void {
  mkdirSync(STATE_DIR, { recursive: true });
  // Unique temp name, flushed before the rename: a crash mid-write leaves the
  // old file intact, never a torn one.
  const tmp = `${FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, `${JSON.stringify({ boards }, null, 2)}\n`); // loops until every byte is written
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, FILE);
    try {
      const dir = openSync(STATE_DIR, 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { /* directory fsync is best-effort (unsupported on some platforms) */ }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/** Board order as stored (the owner's order). */
export function listPriorities(agentId: string): PriorityItem[] {
  return readAll()[agentId] ?? [];
}

export function listAllPriorityBoards(): Record<string, PriorityItem[]> {
  const all = readAll();
  return Object.fromEntries(PRIORITY_AGENTS.map((id) => [id, all[id] ?? []]));
}

type Result = { item?: PriorityItem; error?: string; status?: number };

function mutate(agentId: string, fn: (list: PriorityItem[]) => Result): Result {
  if (!hasPriorityBoard(agentId)) return { error: 'no priorities board for that agent', status: 404 };
  const all = readAll();
  const list = all[agentId] ?? [];
  const result = fn(list);
  if (result.error) return result;
  all[agentId] = openFirst(list);
  save(all);
  return result;
}

function findIndex(list: PriorityItem[], id: unknown): number {
  return typeof id === 'string' ? list.findIndex((i) => i.id === id.trim()) : -1;
}

export function addPriority(agentId: string, text: unknown, by: string): Result {
  return mutate(agentId, (list) => {
    const body = cleanText(text);
    if (!body) return { error: 'text is required', status: 400 };
    if (list.length >= MAX_PER_BOARD) return { error: `The board is full (${MAX_PER_BOARD}). Clear done items first.`, status: 409 };
    const now = Date.now();
    const item: PriorityItem = {
      id: `pr-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: body, done: false, createdAt: now, updatedAt: now, by,
    };
    // New items land after the last open item, above the done ones.
    const firstDone = list.findIndex((i) => i.done);
    list.splice(firstDone === -1 ? list.length : firstDone, 0, item);
    return { item };
  });
}

export function updatePriority(agentId: string, id: unknown, patch: { text?: unknown; done?: unknown }, by: string): Result {
  return mutate(agentId, (list) => {
    const idx = findIndex(list, id);
    if (idx === -1) return { error: 'priority not found', status: 404 };
    const item = { ...list[idx] };
    if (patch.text !== undefined) {
      const body = cleanText(patch.text);
      if (!body) return { error: 'text cannot be empty', status: 400 };
      item.text = body;
    }
    item.updatedAt = Date.now();
    item.by = by;
    if (typeof patch.done === 'boolean' && patch.done !== item.done) {
      // Done drops to the top of the done group; reopened goes to the bottom
      // of the open group (openFirst keeps the rest in place).
      item.done = patch.done;
      list.splice(idx, 1);
      const firstDone = list.findIndex((i) => i.done);
      list.splice(firstDone === -1 ? list.length : firstDone, 0, item);
    } else {
      list[idx] = item;
    }
    return { item };
  });
}

export function removePriority(agentId: string, id: unknown): Result {
  return mutate(agentId, (list) => {
    const idx = findIndex(list, id);
    if (idx === -1) return { error: 'priority not found', status: 404 };
    const [item] = list.splice(idx, 1);
    return { item };
  });
}

export function movePriority(agentId: string, id: unknown, direction: 'up' | 'down'): Result {
  return mutate(agentId, (list) => {
    const idx = findIndex(list, id);
    if (idx === -1) return { error: 'priority not found', status: 404 };
    const item = list[idx];
    const to = direction === 'up' ? idx - 1 : idx + 1;
    // Moves stay inside the item's own group (open or done).
    if (to >= 0 && to < list.length && list[to].done === item.done) [list[idx], list[to]] = [list[to], item];
    return { item };
  });
}

export function clearDonePriorities(agentId: string): Result {
  return mutate(agentId, (list) => {
    const open = list.filter((i) => !i.done);
    list.splice(0, list.length, ...open);
    return {};
  });
}

/** The per-turn block, read fresh. Empty board or no board: no block. */
export function prioritiesBlockFor(agentId: string | undefined): string {
  if (!agentId || !hasPriorityBoard(agentId)) return '';
  let open: PriorityItem[];
  try {
    open = listPriorities(agentId).filter((i) => !i.done);
  } catch {
    return ''; // fail open: a bad store file never blocks a turn
  }
  if (!open.length) return '';
  return [
    '<matts-priorities>',
    "Matt's Priorities (his board for you, kept on his Desk; load-bearing every turn, never forget these):",
    // Angle brackets escaped: item text can never close or forge the block.
    ...open.map((item, n) => `${n + 1}. ${item.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`),
    '</matts-priorities>',
  ].join('\n');
}
