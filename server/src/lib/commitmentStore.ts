import { checkpointDueError } from './checkpointDue.ts';
// Agent-scoped open commitments — the small always-there list that survives
// compaction by construction. Agents add and clear their own entries (owed
// replies, promises with times, parked items); nothing here is ever rewritten
// by the rolling compact, and the session seed stitches the list in.
// Store: ~/.rivendell/agent-commitments.json

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';

export type Commitment = {
  id: string;
  agentId: string;
  text: string;
  due?: string;
  /** The due parsed to an absolute instant at add time. The sweep and the
   *  scanner match on this, never on reparsing the display text, so a
   *  relative due ("10pm tomorrow") cannot drift with every reparse. */
  dueAt?: number;
  /** The outgoing message id that auto-added this entry, so one message can
   *  never double-add. Undefined for hand-added entries. */
  sourceId?: string;
  /** When the past-due sweep raised this entry, per recipient. A recipient
   *  is marked only after its delivery succeeded, so a failed raise retries
   *  on the next tick instead of being silenced forever. */
  raised?: { owner?: number; chief?: number; wake?: number };
  createdAt: number;
};

const FILE = join(STATE_DIR, 'agent-commitments.json');
const TEXT_CAP = 160;
const DUE_CAP = 40;
/** Every line-break form, including the Unicode separators that could
 *  otherwise forge extra lines in the seed block. Non-global twin for
 *  validation: a /g regex is stateful across .test() calls (lastIndex),
 *  so an identical second value could slip past the check. */
const LINE_BREAKS = /\r\n|\r|\n|\u2028|\u2029/g;
const HAS_LINE_BREAK = /[\r\n\u2028\u2029]/;
/** The list stays small enough to stitch into every seed: about ten lines. */
const MAX_PER_AGENT = 12;

/** A delivered owner raise also marks the commitment TEXT (Max, Oct 18
 *  2026, card-b3468c): an interrupted agent re-tracks a past-due commitment
 *  under a NEW id, and an id-keyed mark alone resets with it — re-raising
 *  into the very turn the digest just derailed, over and over. The text
 *  mark survives the id change, so a re-added commitment cannot reset its
 *  own flag. It expires after a day, so a genuinely fresh same-text promise
 *  that goes past due again still raises once. */
const RAISE_TEXT_TTL_MS = 24 * 3_600_000;

/** The normalized agent+text key a delivered owner raise also marks
 *  (card-b3468c). Exported so the sweep can key its digest queue by the
 *  same text: a re-tracked commitment upserts its own raise instead of
 *  stacking a second line (review P1, Oct 18). */
export function raiseTextKey(agentId: string, text: string): string {
  return `${agentId.trim()}::${text.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function pruneRaisedText(raisedText: Record<string, number>, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  for (const [key, at] of Object.entries(raisedText)) {
    if (typeof at === 'number' && Number.isFinite(at) && now - at < RAISE_TEXT_TTL_MS * 2) pruned[key] = at;
  }
  return pruned;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeCommitment(value: unknown): Commitment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  // One line per commitment, always: CR/LF or a Unicode line separator
  // (U+2028/U+2029) could spoof the seed block's line structure, so a stored
  // value can never carry one through either.
  const text = typeof raw.text === 'string' ? raw.text.replace(LINE_BREAKS, ' ').trim() : '';
  if (!id || !agentId || !text) return null;
  const due = typeof raw.due === 'string' ? raw.due.replace(LINE_BREAKS, ' ').trim().slice(0, DUE_CAP) : '';
  const dueAt = asFiniteNumber(raw.dueAt, 0);
  const sourceId = typeof raw.sourceId === 'string' ? raw.sourceId.trim().slice(0, 120) : '';
  const raisedRaw = raw.raised;
  const raisedOwner = raisedRaw && typeof raisedRaw === 'object' ? asFiniteNumber((raisedRaw as { owner?: unknown }).owner, 0) : 0;
  const raisedChief = raisedRaw && typeof raisedRaw === 'object' ? asFiniteNumber((raisedRaw as { chief?: unknown }).chief, 0) : 0;
  const raisedWake = raisedRaw && typeof raisedRaw === 'object' ? asFiniteNumber((raisedRaw as { wake?: unknown }).wake, 0) : 0;
  return {
    id,
    agentId,
    text: text.slice(0, TEXT_CAP),
    ...(due ? { due } : {}),
    ...(dueAt > 0 ? { dueAt } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(raisedOwner > 0 || raisedChief > 0 || raisedWake > 0 ? {
      raised: {
        ...(raisedOwner > 0 ? { owner: raisedOwner } : {}),
        ...(raisedChief > 0 ? { chief: raisedChief } : {}),
        ...(raisedWake > 0 ? { wake: raisedWake } : {}),
      },
    } : {}),
    createdAt: asFiniteNumber(raw.createdAt, 0),
  };
}

function readStore(): { list: unknown[]; raisedText: Record<string, number>; raisedChiefText: Record<string, number> } {
  let raw: string;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { list: [], raisedText: {}, raisedChiefText: {} };
    throw err;
  }
  const data = JSON.parse(raw) as { commitments?: unknown; raisedText?: unknown } | unknown;
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { commitments?: unknown }).commitments)
      ? (data as { commitments: unknown[] }).commitments
      : [];
  const raisedText: Record<string, number> = {};
  const marks = data && typeof data === 'object' && !Array.isArray(data) ? (data as { raisedText?: unknown }).raisedText : undefined;
  if (marks && typeof marks === 'object' && !Array.isArray(marks)) {
    for (const [key, at] of Object.entries(marks as Record<string, unknown>)) {
      if (key && typeof at === 'number' && Number.isFinite(at) && at > 0) raisedText[key.slice(0, 240)] = at;
    }
  }
  // Chief-side text marks (card-b3468c verify P1): one Chief escalation per
  // promise text inside the TTL, so concurrent same-text re-tracks never
  // stack duplicate copies. Same shape, same TTL, own map.
  const raisedChiefText: Record<string, number> = {};
  const chiefMarks = data && typeof data === 'object' && !Array.isArray(data) ? (data as { raisedChiefText?: unknown }).raisedChiefText : undefined;
  if (chiefMarks && typeof chiefMarks === 'object' && !Array.isArray(chiefMarks)) {
    for (const [key, at] of Object.entries(chiefMarks as Record<string, unknown>)) {
      if (key && typeof at === 'number' && Number.isFinite(at) && at > 0) raisedChiefText[key.slice(0, 240)] = at;
    }
  }
  return { list, raisedText, raisedChiefText };
}

function readAll(): Commitment[] {
  return readStore().list.map(normalizeCommitment).filter((c): c is Commitment => Boolean(c));
}

function readRaisedText(): Record<string, number> {
  return readStore().raisedText;
}

function readRaisedChiefText(): Record<string, number> {
  return readStore().raisedChiefText;
}

/** True when a same-text owner raise for this agent already delivered inside
 *  the TTL: the sweep must not re-raise a re-tracked commitment. */
export function ownerRaiseHeldByText(agentId: string, text: string, now = Date.now()): boolean {
  const at = readRaisedText()[raiseTextKey(agentId, text)];
  return typeof at === 'number' && now - at < RAISE_TEXT_TTL_MS;
}

/** True when a same-text Chief escalation already delivered inside the TTL
 *  (card-b3468c verify P1): concurrent same-text re-tracks share ONE Chief
 *  copy, exactly as they share one owner raise. */
export function chiefRaiseHeldByText(agentId: string, text: string, now = Date.now()): boolean {
  const at = readRaisedChiefText()[raiseTextKey(agentId, text)];
  return typeof at === 'number' && now - at < RAISE_TEXT_TTL_MS;
}

/** Re-track lineage (card-b3468c verify P1): the admission instant a
 *  re-tracked blown promise inherits, or undefined. Only a commitment that
 *  was ALREADY past due when its agent added it (createdAt at or after its
 *  own due) can inherit a same-text raise — that shape is a re-track of a
 *  blown promise, not a fresh one. A commitment created before its own due
 *  is a genuinely fresh promise: it always gets its own raise when it goes
 *  past due, however many same-text promises were raised before it. A
 *  legacy entry without a readable createdAt never inherits (fail open:
 *  raise). */
export function inheritedOwnerRaiseAt(c: { agentId: string; text: string; createdAt?: number; dueAt?: number }, now = Date.now()): number | undefined {
  if (typeof c.dueAt !== 'number' || !(c.dueAt > 0)) return undefined;
  if (typeof c.createdAt !== 'number' || !(c.createdAt >= c.dueAt)) return undefined;
  const at = readRaisedText()[raiseTextKey(c.agentId, c.text)];
  return typeof at === 'number' && at > 0 && now - at < RAISE_TEXT_TTL_MS ? at : undefined;
}

/** Stamp a re-tracked commitment with the raise it inherits (card-b3468c
 *  verify P1): raised.owner at the ORIGINAL raise's admission instant, so
 *  the Chief copy's hold stays bounded from the raise's true delivery. The
 *  text mark itself is untouched — it already exists. */
export function markCommitmentInheritedRaise(id: string, at: number): boolean {
  const target = id.trim();
  if (!target || !Number.isFinite(at) || at <= 0) return false;
  const all = readAll();
  let changed = false;
  const next = all.map((c) => {
    if (c.id === target && !c.raised?.owner) {
      changed = true;
      return { ...c, raised: { ...c.raised, owner: at } };
    }
    return c;
  });
  if (changed) save(next);
  return changed;
}

function save(
  commitments: Commitment[],
  raisedText: Record<string, number> = pruneRaisedText(readRaisedText(), Date.now()),
  raisedChiefText: Record<string, number> = pruneRaisedText(readRaisedChiefText(), Date.now()),
): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ commitments, raisedText, raisedChiefText }, null, 2)}\n`);
  // Atomic replace only. Never fall back to overwriting the live shared
  // store in place: a partial in-place write could corrupt every live
  // agent's commitments. A failed rename leaves the previous store fully
  // intact and throws to the caller (the server never runs on Windows, so
  // the old in-place fallback was dead code carrying exactly that risk).
  renameSync(tmp, FILE);
}

/** Oldest first, so the seed reads like a queue. */
export function listCommitments(agentId?: string): Commitment[] {
  const all = readAll();
  const filtered = agentId ? all.filter((c) => c.agentId === agentId) : all;
  return filtered.sort((a, b) => a.createdAt - b.createdAt);
}

export function addCommitment(
  agentId: string,
  text: string,
  due?: string,
  opts?: { dueAt?: number; sourceId?: string; enforceCheckpoint?: boolean },
): { commitment?: Commitment; error?: string } {
  const owner = agentId.trim();
  const body = (text ?? '').trim();
  if (!owner || !body) return { error: 'agentId and text are required' };
  if (body.length > TEXT_CAP) {
    return { error: `Keep it under ${TEXT_CAP} characters; a commitment must stay one line (got ${body.length}).` };
  }
  const trimmedDue = (due ?? '').trim();
  if (HAS_LINE_BREAK.test(body) || HAS_LINE_BREAK.test(trimmedDue)) {
    return { error: 'A commitment is one line; no line breaks in the text or the time.' };
  }
  if (trimmedDue.length > DUE_CAP) {
    return { error: `Keep the time under ${DUE_CAP} characters (got ${trimmedDue.length}).` };
  }
  const all = readAll();
  if (all.filter((c) => c.agentId === owner).length >= MAX_PER_AGENT) {
    return { error: `Your commitments list is full (${MAX_PER_AGENT}). Clear one that is done before adding another.` };
  }
  const dueAt = asFiniteNumber(opts?.dueAt, 0);
  if (dueAt > 0 && opts?.enforceCheckpoint !== false) { const error = checkpointDueError(dueAt); if (error) return { error }; }
  const sourceId = typeof opts?.sourceId === 'string' ? opts.sourceId.trim().slice(0, 120) : '';
  const commitment: Commitment = {
    id: `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: owner,
    text: body,
    ...(trimmedDue ? { due: trimmedDue.slice(0, DUE_CAP) } : {}),
    ...(dueAt > 0 ? { dueAt } : {}),
    ...(sourceId ? { sourceId } : {}),
    createdAt: Date.now(),
  };
  all.push(commitment);
  save(all);
  return { commitment };
}

/** The past-due sweep records a raise per recipient, only after that
 *  recipient's delivery succeeded: a failed raise retries on the next tick,
 *  a succeeded one never repeats. A no-op never rewrites the file. 'wake' is
 *  the due-time wake to a worker owner (commitmentSweep.ts); it carries no
 *  text mark. */
export function markCommitmentRaised(id: string, recipient: 'owner' | 'chief' | 'wake', textKey?: { agentId: string; text: string }): boolean {
  const target = id.trim();
  if (!target) return false;
  const now = Date.now();
  const all = readAll();
  let changed = false;
  const next = all.map((c) => {
    if (c.id === target && !c.raised?.[recipient]) {
      changed = true;
      return { ...c, raised: { ...c.raised, [recipient]: now } };
    }
    return c;
  });
  // The owner raise ALSO marks the text (see raiseTextKey, card-b3468c): set
  // it even when the entry itself is already gone — a raise can deliver
  // AFTER the interrupted agent cleared and re-tracked the entry under a new
  // id, and the text mark is what keeps that new id from re-raising the same
  // flag. The re-tracked entry itself inherits that raise in the sweep
  // (inheritedOwnerRaiseAt / markCommitmentInheritedRaise, verify P1): only a
  // commitment that was already past due at creation can inherit — a bulk
  // stamp here would arm the Chief gate on future same-text commitments that
  // were never raised at all.
  const raisedText = pruneRaisedText(readRaisedText(), now);
  if (recipient === 'owner' && textKey) {
    raisedText[raiseTextKey(textKey.agentId, textKey.text)] = now;
    changed = true;
  }
  // The Chief copy marks the text on its own side (verify P1): concurrent
  // same-text re-tracks then share ONE escalation inside the TTL.
  let raisedChiefText: Record<string, number> | undefined;
  if (recipient === 'chief' && textKey) {
    raisedChiefText = pruneRaisedText(readRaisedChiefText(), now);
    raisedChiefText[raiseTextKey(textKey.agentId, textKey.text)] = now;
    changed = true;
  }
  if (changed) save(next, raisedText, raisedChiefText);
  return changed;
}

/** Persist a legacy entry's parsed due as its absolute instant, so a
 *  relative display due stops moving with every sweep reparse. */
export function noteCommitmentDueAt(id: string, dueAt: number): void {
  const target = id.trim();
  if (!target || !Number.isFinite(dueAt) || dueAt <= 0) return;
  const all = readAll();
  let changed = false;
  const next = all.map((c) => {
    if (c.id === target && c.dueAt === undefined) {
      changed = true;
      return { ...c, dueAt };
    }
    return c;
  });
  if (changed) save(next);
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

/** Agent deletion cascade: a deleted teammate leaves no commitments behind,
 *  so a recreated agent with the same id never inherits stale entries. */
export function deleteCommitmentsForAgent(agentId: string): void {
  const owner = agentId.trim();
  if (!owner) return;
  const all = readAll();
  const next = all.filter((c) => c.agentId !== owner);
  if (next.length !== all.length) save(next);
}
