// Agent-scoped open commitments — the small always-there list that survives
// compaction by construction. Agents add and clear their own entries (owed
// replies, promises with times, parked items); nothing here is ever rewritten
// by the rolling compact, and the session seed stitches the list in.
// Store: ~/.rivendell/agent-commitments.json

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';

export type Commitment = {
  id: string;
  agentId: string;
  text: string;
  due?: string;
  createdAt: number;
};

const FILE = join(STATE_DIR, 'agent-commitments.json');
const TEXT_CAP = 160;
const DUE_CAP = 40;
/** The list stays small enough to stitch into every seed: about ten lines. */
const MAX_PER_AGENT = 12;

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeCommitment(value: unknown): Commitment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!id || !agentId || !text) return null;
  const due = typeof raw.due === 'string' ? raw.due.trim().slice(0, DUE_CAP) : '';
  return {
    id,
    agentId,
    text: text.slice(0, TEXT_CAP),
    ...(due ? { due } : {}),
    createdAt: asFiniteNumber(raw.createdAt, 0),
  };
}

function readAll(): Commitment[] {
  let raw: string;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const data = JSON.parse(raw) as { commitments?: unknown } | unknown;
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { commitments?: unknown }).commitments)
      ? (data as { commitments: unknown[] }).commitments
      : [];
  return list.map(normalizeCommitment).filter((c): c is Commitment => Boolean(c));
}

function save(commitments: Commitment[]): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ commitments }, null, 2)}\n`);
  try {
    renameSync(tmp, FILE);
  } catch {
    // Windows cannot replace via rename; overwrite in place so a failed
    // write cannot leave the store deleted. Linux rename already replaced.
    writeFileSync(FILE, readFileSync(tmp));
    try { unlinkSync(tmp); } catch { /* leftover tmp is harmless */ }
  }
}

/** Oldest first, so the seed reads like a queue. */
export function listCommitments(agentId?: string): Commitment[] {
  const all = readAll();
  const filtered = agentId ? all.filter((c) => c.agentId === agentId) : all;
  return filtered.sort((a, b) => a.createdAt - b.createdAt);
}

export function addCommitment(agentId: string, text: string, due?: string):
  { commitment?: Commitment; error?: string } {
  const owner = agentId.trim();
  const body = (text ?? '').trim();
  if (!owner || !body) return { error: 'agentId and text are required' };
  if (body.length > TEXT_CAP) {
    return { error: `Keep it under ${TEXT_CAP} characters; a commitment must stay one line (got ${body.length}).` };
  }
  const trimmedDue = (due ?? '').trim();
  if (trimmedDue.length > DUE_CAP) {
    return { error: `Keep the time under ${DUE_CAP} characters (got ${trimmedDue.length}).` };
  }
  const all = readAll();
  if (all.filter((c) => c.agentId === owner).length >= MAX_PER_AGENT) {
    return { error: `Your commitments list is full (${MAX_PER_AGENT}). Clear one that is done before adding another.` };
  }
  const commitment: Commitment = {
    id: `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: owner,
    text: body,
    ...(trimmedDue ? { due: trimmedDue.slice(0, DUE_CAP) } : {}),
    createdAt: Date.now(),
  };
  all.push(commitment);
  save(all);
  return { commitment };
}

/** Only the owner can clear its own entry; returns false when nothing matched. */
export function clearCommitment(agentId: string, id: string): boolean {
  const owner = agentId.trim();
  const target = id.trim();
  if (!owner || !target) return false;
  const all = readAll();
  const next = all.filter((c) => !(c.id === target && c.agentId === owner));
  if (next.length === all.length) return false;
  save(next);
  return true;
}
