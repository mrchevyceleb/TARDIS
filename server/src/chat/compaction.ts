// Forever-thread compaction: one overwriteable rolling memory per agent
// home thread. Compact is the summary of everything OLDER THAN the last 50
// visible turns — never the last 50 itself. The file is replaced in place.
//
// Every model turn:
//   1. persona / FACE / brief rules (injected by the runner)
//   2. compact(history − last50) — one blob, always overwrites itself
//   3. last 50 visible user+assistant turns
//
// Overflow compact fires when visible turns go past 50: fold the oldest
// extras into the compact blob (replace file), keep last 50 as the tail.
// Persistent Claude-family processes stay warm after overflow compaction. The
// rolling compact is the recovery seed for the next genuine process start;
// durable memory maintenance must never create a mid-chat handoff gap.
//
// The durable event log the user sees is NEVER wiped.

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_DIR } from './config.ts';
import { callMcp } from '../lib/mcp.ts';
import { ensureXaiProxy, xaiProxyBaseUrl, xaiProxySecret } from './xai-proxy.ts';
import { redactSecrets } from './secretRedaction.ts';
import { flushEventLog, loadEventLogForCompactionSync } from './event-log-store.ts';
import {
  COMPACT_BATCH_TURNS,
  WINDOW_TURNS,
  assembleForeverTurn,
  extractVisibleTurns,
  formatAgedTurns,
  overflowChars,
  shouldCompactOverflow,
  splitWindow,
  type VisibleTurn,
} from './threadWindow.ts';

const MIN_ACCEPT_WORDS = 400;
const COMPACT_MAX_TOKENS = 8000;
const TRANSCRIPT_HEAD = 24 * 1024;
const TRANSCRIPT_TAIL = 220 * 1024;

const STATE_FILE = join(STATE_DIR, 'compaction-state.json');
const COMPACTS_DIR = join(STATE_DIR, 'thread-compacts');

export type CompactBlob = {
  compact: string;
  words: number;
  count: number;
  lastAt: number;
  lastCompactedSeq: number;
  chatId?: string;
};

type CompactionRecord = {
  userTurnsTotal: number;
  lastCompactUserTurns: number;
  count: number;
  lastAt: number;
  lastWords: number;
  /** Owed engine rotation (deferred while a turn streamed, or restart). */
  rotationOwed?: boolean;
  /** Legacy primer string — treat as owed and reconstruct. */
  pendingRotation?: string | null;
  lastFatRotateAt?: number;
};
type CompactionState = Record<string, CompactionRecord>;

let stateQueue: Promise<void> = Promise.resolve();

function defaultRec(): CompactionRecord {
  return { userTurnsTotal: 0, lastCompactUserTurns: 0, count: 0, lastAt: 0, lastWords: 0 };
}

function loadState(): CompactionState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as CompactionState;
  } catch {
    return {};
  }
}

function mutateState(fn: (state: CompactionState) => void): Promise<void> {
  stateQueue = stateQueue.then(() => {
    try {
      const state = loadState();
      fn(state);
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn('[compaction] state mutation failed:', (err as Error).message);
    }
  });
  return stateQueue;
}

function compactFileId(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 12);
  const readable = key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return `${readable}_${hash}`;
}

function compactPath(key: string): string {
  return join(COMPACTS_DIR, `${compactFileId(key)}.json`);
}

/** The single overwriteable rolling memory for this thread. */
export function loadCompactBlob(key: string): CompactBlob | null {
  try {
    const raw = JSON.parse(readFileSync(compactPath(key), 'utf8')) as CompactBlob;
    if (!raw || typeof raw.compact !== 'string' || !raw.compact.trim()) return null;
    const compact = redactSecrets(raw.compact);
    if (compact === raw.compact) return raw;

    // Upgrade old compacts in place before they can seed another model turn.
    // Never log the matched value (or even a surrounding excerpt).
    const scrubbed: CompactBlob = {
      ...raw,
      compact,
      words: compact.trim().split(/\s+/).filter(Boolean).length,
    };
    try {
      writeCompactBlob(key, scrubbed);
      console.warn(`[compaction] ${key}: redacted credential material from the rolling compact`);
    } catch (err) {
      // The safe in-memory copy is still usable even if a read-only/full disk
      // prevents the opportunistic upgrade from landing.
      console.warn(`[compaction] ${key}: could not rewrite redacted rolling compact:`, (err as Error).message);
    }
    return scrubbed;
  } catch {
    return null;
  }
}

/** Highest visible-turn seq already represented by the rolling compact. */
export function compactedThroughSeq(key: string): number {
  return loadCompactBlob(key)?.lastCompactedSeq ?? 0;
}

function writeCompactBlob(key: string, blob: CompactBlob, epoch?: number): boolean {
  mkdirSync(COMPACTS_DIR, { recursive: true });
  const path = compactPath(key);
  const tmp = epoch != null ? `${path}.${epoch}.${process.pid}.tmp` : `${path}.${process.pid}.tmp`;
  const compact = redactSecrets(blob.compact);
  const safeBlob: CompactBlob = {
    ...blob,
    compact,
    words: compact.trim().split(/\s+/).filter(Boolean).length,
  };
  writeFileSync(tmp, JSON.stringify(safeBlob, null, 2));
  if (epoch != null && epochOf(key) !== epoch) {
    try { unlinkSync(tmp); } catch { /* stale tmp only */ }
    return false;
  }
  renameSync(tmp, path);
  return true;
}

/** Copy the newest rolling compact + cadence from leftover per-engine keys
 *  onto the engine-free thread key. Never overwrite a dest blob/state that
 *  is already newer. Sync so boot migrate can run before chat starts. */
export function adoptCompaction(fromKeys: string[], toKey: string): { blob: boolean; state: boolean } {
  const unique = [...new Set(fromKeys.filter((k) => k && k !== toKey))];
  if (unique.length === 0) return { blob: false, state: false };

  const state = loadState();
  const destBlob = loadCompactBlob(toKey);
  const destRec = state[toKey];
  let winKey = toKey;
  let winBlob = destBlob;
  let winRec = destRec;
  let winAt = destBlob?.lastAt ?? destRec?.lastAt ?? -1;

  for (const from of unique) {
    const blob = loadCompactBlob(from);
    const rec = state[from];
    const at = blob?.lastAt ?? rec?.lastAt ?? -1;
    if (at > winAt) {
      winKey = from;
      winBlob = blob;
      winRec = rec ? { ...rec } : rec;
      winAt = at;
    }
  }

  if (winKey === toKey) return { blob: false, state: false };

  let tookBlob = false;
  let tookState = false;
  if (winBlob) {
    tookBlob = writeCompactBlob(toKey, winBlob);
  }
  if (winRec) {
    state[toKey] = winRec;
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE_FILE);
    tookState = true;
  }
  if (tookBlob || tookState) {
    console.log(`[compaction] adopted ${unique.length} legacy key(s) → ${toKey}`);
  }
  return { blob: tookBlob, state: tookState };
}

/** Wipe rolling memory + cadence when the user fresh-starts a thread.
 * Remote deletion is staged first; callers clear the visible event log only
 * after this succeeds, so an MCP outage cannot leave a half-cleared thread. */
export async function clearThreadMemory(key: string, chatId: string): Promise<void> {
  bumpCompactEpoch(key);
  // Queue behind an in-flight replacement. The epoch bump makes that writer
  // discard its result; the lock then guarantees this deletion is last.
  try {
    await clearCompactMemoryMirror(key, chatId);
  } catch (err) {
    throw new Error(`thread was not cleared because its RAG compact could not be deleted: ${(err as Error).message}`);
  }

  try {
    unlinkSync(compactPath(key));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(`thread was not cleared because its local compact could not be deleted: ${(err as Error).message}`);
    }
  }
  await mutateState((state) => {
    delete state[key];
  });
}

export function countUserEchoes(events: Array<{ ev: any }>): number {
  let n = 0;
  for (const { ev } of events) {
    if (ev?.type !== 'event') continue;
    const e = ev.event;
    if (e?.type === '_user_echo' && typeof e.text === 'string' && e.text.trim()) n++;
  }
  return n;
}

export function noteUserTurn(key: string): void {
  void mutateState((state) => {
    const rec = state[key];
    if (!rec) {
      state[key] = { userTurnsTotal: 1, lastCompactUserTurns: 0, count: 0, lastAt: 0, lastWords: 0 };
    } else {
      rec.userTurnsTotal += 1;
    }
  });
}

function recIsOwed(rec: CompactionRecord | undefined): boolean {
  if (!rec) return false;
  // Fat-rotate used to bank a session kill after bloated jsonl. That debt
  // must never drop --resume. Only overflow-compact (lastAt after the fat
  // stamp) still owes an engine window seed.
  if ((rec.lastFatRotateAt ?? 0) > 0 && (rec.lastFatRotateAt ?? 0) >= (rec.lastAt ?? 0)) {
    return false;
  }
  if (rec.rotationOwed) return true;
  return typeof rec.pendingRotation === 'string' && rec.pendingRotation.trim().length > 0;
}

export function bankRotation(key: string, _primer?: string): void {
  void mutateState((state) => {
    const rec = state[key] ?? defaultRec();
    rec.rotationOwed = true;
    rec.pendingRotation = null;
    state[key] = rec;
  });
}

export function isRotationOwed(key: string): boolean {
  return recIsOwed(loadState()[key]);
}

export function clearRotation(key: string): Promise<void> {
  return mutateState((state) => {
    if (state[key]) {
      state[key].rotationOwed = false;
      state[key].pendingRotation = null;
    }
  });
}

/** Lift a pre-forever-thread `pendingRotation` primer into the overwriteable blob
 *  so upgrade does not throw away the only durable summary. */
function migrateLegacyPrimer(key: string): void {
  const rec = loadState()[key];
  const pending = rec?.pendingRotation;
  if (typeof pending !== 'string' || !pending.trim()) return;
  if (!loadCompactBlob(key)) {
    const compact = pending.trim();
    writeCompactBlob(key, {
      compact,
      words: compact.split(/\s+/).length,
      count: Math.max(1, rec.count || 1),
      lastAt: rec.lastAt || Date.now(),
      lastCompactedSeq: 0,
    });
  }
  void mutateState((state) => {
    if (state[key]) {
      state[key].pendingRotation = null;
      state[key].rotationOwed = true;
    }
  });
}

export function peekEnginePrimer(key: string, events?: Array<{ seq?: number; ev: any }>): string {
  migrateLegacyPrimer(key);
  const evs = events ?? loadEventLogForCompactionSync(key);
  const blob = loadCompactBlob(key);
  return assembleForeverTurn({
    events: evs,
    compact: blob?.compact ?? '',
    lastCompactedSeq: blob?.lastCompactedSeq,
  }).primer;
}

/** Build a seed from the COMPLETE durable hot log as it existed before the
 * current user echo. Runners keep only 2,000 replay events in memory, which can
 * be less than one tool-heavy turn; using that tail here caused fresh engines
 * to forget the rest of an agent's conversation. */
export async function peekEnginePrimerThroughSeq(
  key: string,
  throughSeq: number,
  fallbackEvents: Array<{ seq?: number; ev: any }> = [],
): Promise<string> {
  await flushEventLog(key);
  const durable = loadEventLogForCompactionSync(key).filter((event) => event.seq <= throughSeq);
  // Durable appends deliberately fail soft so a disk hiccup cannot crash a
  // live answer. Merge the runner's pre-send buffer back in by seq, otherwise
  // that same hiccup would make a forced fresh engine forget recent turns.
  const seen = new Set(durable.map((event) => event.seq));
  const merged: Array<{ seq?: number; ev: any }> = [...durable];
  for (const event of fallbackEvents) {
    if (typeof event.seq !== 'number' || event.seq > throughSeq || seen.has(event.seq)) continue;
    seen.add(event.seq);
    merged.push(event);
  }
  merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return peekEnginePrimer(key, merged);
}

export async function takeRotation(key: string): Promise<string | null> {
  if (!recIsOwed(loadState()[key])) return null;
  await mutateState((state) => {
    if (state[key]) {
      state[key].rotationOwed = false;
      state[key].pendingRotation = null;
    }
  });
  await flushEventLog(key);
  const primer = peekEnginePrimer(key);
  return primer || null;
}

function formatTurnsForCompact(turns: VisibleTurn[]): string {
  return formatAgedTurns(turns);
}

/** Oldest-first batch that fits the compact prompt budget so lastCompactedSeq
 *  never advances past turns the model actually saw. */
function takeOverflowBatch(overflow: VisibleTurn[]): VisibleTurn[] {
  const budget = TRANSCRIPT_HEAD + TRANSCRIPT_TAIL;
  const batch: VisibleTurn[] = [];
  let used = 0;
  for (const t of overflow) {
    const cost = t.text.length + 16;
    if (batch.length > 0 && used + cost > budget) break;
    batch.push(t);
    used += cost;
  }
  return batch;
}

const COMPACT_SYSTEM = `You are the memory keeper for a long-running AI-teammate conversation. You write the ONE rolling memory document that lets the thread continue FOREVER. Each time you run, you REPLACE the previous document entirely (never append a new primer).

Rules for the document you produce:
- LENGTH: keep the previous document's substance and fold in the new aged-out turns. Do not pad. Do not invent. Target 3000–5000 words only when the combined history actually supports that density; a short overflow should produce a modest update.
- Capture: every decision made (and why), every open task and its state, every fact about people/projects/systems mentioned, every commitment or promise, every preference expressed, every technical detail that mattered (paths, models, endpoints, prices, IDs), and the current state of play.
- Organize with clear headings (## ...) so it can be indexed: Overview / People & Projects / Decisions / Open Work / Facts & References / Preferences & Style / Current State.
- Write in third person, past tense, no fluff, no meta commentary. Never invent content that is not in the previous document or the aged-out turns.
- SECURITY: never retain passwords, passcodes, OTPs, API keys, access/auth tokens, cookies, private keys, or other credential values. Replace every value with [redacted secret]. Keep only the fact that a credential exists and where the user intentionally stored it (for example, a vault service/account name).
- The last ~50 visible turns stay in the live working window and are NOT your job — only merge what just aged out of that window.`;

const inFlight = new Set<string>();
const compactEpoch = new Map<string, number>();

function epochOf(key: string): number {
  return compactEpoch.get(key) ?? 0;
}

function bumpCompactEpoch(key: string): number {
  const n = epochOf(key) + 1;
  compactEpoch.set(key, n);
  return n;
}

export type AutoCompactArgs = {
  key: string;
  cli: string;
  chatId: string;
  events: Array<{ seq?: number; ev: any }>;
  isBusy: () => boolean;
  emit: (ev: any) => void;
  /** Return `false` when the engine will seed on the *next* send (banana/codex).
   *  Owed rotation stays banked until that send is acknowledged. */
  rotate: (primer: string) => Promise<boolean | void> | boolean | void;
};

type MemorySearchResponse = {
  memories?: Array<{
    id?: unknown;
    title?: unknown;
    project?: unknown;
    tags?: unknown;
  }>;
};

type MemorySaveResponse = {
  memory?: { id?: unknown };
};

const ragChains = new Map<string, Promise<void>>();

async function withRagLock(key: string, operation: () => Promise<void>): Promise<void> {
  const prior = ragChains.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(operation);
  ragChains.set(key, next);
  try {
    await next;
  } finally {
    if (ragChains.get(key) === next) ragChains.delete(key);
  }
}

type CompactMemoryIdentity = { title: string; threadTag: string };

function compactMemoryIdentity(key: string, chatId: string): CompactMemoryIdentity {
  // `chatId=main` exists in every repo and agent ids can also repeat across
  // workspaces. Hash the complete durable log key so replacement/reset can
  // never touch another thread that happens to share the display id. Account
  // suffixes are live-engine aliases, not part of an agent's durable identity.
  const threadHash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const canonicalChatId = key.startsWith('thread|')
    ? key.slice(key.lastIndexOf('|') + 1)
    : (chatId || 'main').replace(/__acct__[a-z0-9-]+$/i, '');
  return {
    title: `Chat compact (${canonicalChatId}; ${threadHash})`,
    threadTag: `rivendell-thread:${threadHash}`,
  };
}

async function compactMemoryIds(key: string, chatId: string): Promise<string[]> {
  const identity = compactMemoryIdentity(key, chatId);
  const found = await callMcp<MemorySearchResponse & { error?: unknown }>('memory', {
    action: 'search_memory',
    params: {
      // Keep the server-side query free of chat-id punctuation because the
      // current assistant-mcp search tool interpolates it into a PostgREST
      // `.or(...)` expression. Exact identity is enforced locally below.
      query: 'Chat compact',
      project: 'rivendell',
      category: 'context',
      tags: [identity.threadTag, 'rolling-compact'],
      limit: 2000,
    },
  });
  if (!found || typeof found !== 'object' || found.error !== undefined || !Array.isArray(found.memories)) {
    throw new Error('RAG search returned a malformed or failed response');
  }
  return [...new Set(found.memories
    // The hashed tag is the sole durable identity. Display titles may evolve
    // and account aliases may vary without orphaning the prior memory row.
    .filter((memory) => memory?.project === 'rivendell')
    .filter((memory) => Array.isArray(memory.tags)
      && memory.tags.includes(identity.threadTag)
      && memory.tags.includes('rolling-compact'))
    .map((memory) => memory.id)
    .filter((memoryId): memoryId is string => typeof memoryId === 'string' && memoryId.length > 0))];
}

async function deleteCompactMemoryIds(memoryIds: string[]): Promise<void> {
  await Promise.all(memoryIds.map(async (memoryId) => {
    const result = await callMcp<{ message?: unknown; error?: unknown }>('memory', {
      action: 'delete_memory',
      params: { id: memoryId },
    });
    if (!result || typeof result !== 'object' || result.error !== undefined
      || result.message !== 'Memory deleted successfully') {
      throw new Error(`RAG delete was not acknowledged for memory ${memoryId}`);
    }
  }));
}

async function clearCompactMemoryMirror(key: string, chatId: string): Promise<void> {
  await withRagLock(key, async () => {
    await deleteCompactMemoryIds(await compactMemoryIds(key, chatId));
  });
}

/** Keep the RAG mirror overwriteable just like the local rolling blob. The
 * assistant-mcp save API inserts, so save the replacement first and then
 * remove every exact prior row. The per-thread lock also serializes fresh-start
 * deletion behind any in-flight save, preventing stale context resurrection. */
async function saveCompactToMemory(
  key: string,
  epoch: number,
  cli: string,
  chatId: string,
  compact: string,
): Promise<void> {
  await withRagLock(key, async () => {
    if (epochOf(key) !== epoch) throw new Error('thread was fresh-started before RAG save');
    const identity = compactMemoryIdentity(key, chatId);
    const priorIds = await compactMemoryIds(key, chatId);
    if (epochOf(key) !== epoch) throw new Error('thread was fresh-started before RAG save');

    const saved = await callMcp<MemorySaveResponse>('memory', {
      action: 'save_memory',
      params: {
        title: identity.title,
        content: redactSecrets(compact),
        project: 'rivendell',
        category: 'context',
        tags: [cli, chatId, identity.threadTag, 'rolling-compact'],
      },
    });
    const savedId = saved.memory?.id;
    if (typeof savedId !== 'string' || !savedId) {
      throw new Error('RAG save returned no memory id');
    }

    if (epochOf(key) !== epoch) {
      await deleteCompactMemoryIds([savedId]);
      throw new Error('thread was fresh-started during RAG save');
    }
    await deleteCompactMemoryIds(priorIds.filter((memoryId) => memoryId !== savedId));
    if (epochOf(key) !== epoch) {
      await deleteCompactMemoryIds([savedId]);
      throw new Error('thread was fresh-started during RAG cleanup');
    }
  });
}

async function generateCompact(previous: string, overflow: VisibleTurn[]): Promise<{ compact: string; words: number }> {
  // Redact BEFORE sending the prompt to the compaction provider, then redact
  // the generated document again before it touches local disk or RAG.
  const safePrevious = redactSecrets(previous);
  const safeOverflow = overflow.map((turn) => ({ ...turn, text: redactSecrets(turn.text) }));
  const overflowText = formatTurnsForCompact(safeOverflow);
  const userContent = safePrevious.trim()
    ? `Previous rolling memory document (REPLACE this entirely with an updated version — do not stack primers):\n\n${safePrevious}\n\n---\n\nAged-out turns that just left the last-${WINDOW_TURNS} working window. Merge them in:\n\n${overflowText}`
    : `Turns older than the last-${WINDOW_TURNS} working window. Write the first rolling memory document:\n\n${overflowText}`;

  await ensureXaiProxy();
  const res = await fetch(`${xaiProxyBaseUrl().replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${xaiProxySecret()}`,
    },
    body: JSON.stringify({
      model: 'grok-4.7',
      max_tokens: COMPACT_MAX_TOKENS,
      system: COMPACT_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`compact generation failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const generated = (body.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n').trim();
  const compact = redactSecrets(generated);
  const words = compact ? compact.split(/\s+/).length : 0;
  const prevWords = safePrevious.trim() ? safePrevious.trim().split(/\s+/).length : 0;
  const overflowWordEst = Math.max(1, Math.floor(overflowChars(safeOverflow) / 5));
  const minWords = prevWords
    ? Math.max(80, Math.floor(prevWords * 0.85))
    : Math.max(80, Math.min(MIN_ACCEPT_WORDS, overflowWordEst));
  if (words < minWords) throw new Error(`compact came back thin (${words} words < ${minWords}) — will retry`);
  return { compact, words };
}

export async function maybeAutoCompact(args: AutoCompactArgs): Promise<boolean> {
  const { key, cli, chatId } = args;
  if (inFlight.has(key)) return false;
  const epoch = epochOf(key);

  const state = loadState();
  const rec = state[key];

  migrateLegacyPrimer(key);

  if (recIsOwed(loadState()[key]) && !args.isBusy()) {
    try {
      if (epochOf(key) !== epoch) return false;
      await flushEventLog(key);
      if (!recIsOwed(loadState()[key])) return false;
      // A turn can start during the flush await (e.g. a graceful steer
      // landing right after its interrupt's result) — rotating now would
      // kill the warm process mid-turn. Recheck and retry next time.
      if (args.isBusy()) return false;
      const durable = loadEventLogForCompactionSync(key);
      const primer = peekEnginePrimer(key, durable.length ? durable : args.events);
      const applied = await args.rotate(primer);
      if (epochOf(key) !== epoch) return false;
      if (applied !== false) {
        await mutateState((s) => {
          if (s[key]) {
            s[key].rotationOwed = false;
            s[key].pendingRotation = null;
          }
        });
      }
      console.warn(`[compaction] ${key}: owed rotation applied (primer ${primer.length} chars)`);
      return true;
    } catch (err) {
      console.warn(`[compaction] ${key}: owed rotation failed, will retry:`, (err as Error).message);
      return false;
    }
  }

  // The live/UI buffer is intentionally capped at 2000 raw events, which can
  // be fewer than 50 turns on tool-heavy lanes. Assemble memory from the full
  // durable hot log after flushing the append chain; compactEventLog protects
  // every seq newer than the rolling compact, so batched overflow stays here.
  await flushEventLog(key);
  if (epochOf(key) !== epoch) return false;
  const durable = loadEventLogForCompactionSync(key);
  const events = durable.length ? durable : args.events;
  const visible = extractVisibleTurns(events);
  const { overflow } = splitWindow(visible);
  const blob = loadCompactBlob(key);
  const lastSeq = blob?.lastCompactedSeq ?? 0;
  let overflowNew = overflow.filter((t) => t.seq > lastSeq);
  if (!shouldCompactOverflow(overflowNew)) return false;

  inFlight.add(key);
  try {
    let previous = blob?.compact ?? '';
    let count = blob?.count ?? rec?.count ?? 0;
    let lastCompactedSeq = lastSeq;
    let generatedWords = 0;
    let compactText = previous;
    const total = rec?.userTurnsTotal ?? countUserEchoes(events);

    for (let batch = 0; batch < 1; batch++) {
      overflowNew = overflow.filter((t) => t.seq > lastCompactedSeq);
      if (overflowNew.length === 0) break;
      // One overwrite consumes exactly one 50-message batch. Catch-up overflow
      // remains durable and is folded by later batches rather than silently
      // changing cadence after downtime.
      const overflowBatch = takeOverflowBatch(overflowNew.slice(0, COMPACT_BATCH_TURNS));
      if (overflowBatch.length === 0) break;
      console.warn(
        `[compaction] ${key}: ${overflowBatch.length} visible turns past the ${WINDOW_TURNS}-window (${overflowChars(overflowBatch)} chars, overflow) — overwriting rolling compact`,
      );
      const generated = await generateCompact(previous, overflowBatch);
      if (epochOf(key) !== epoch) {
        console.warn(`[compaction] ${key}: discarded compact — thread was fresh-started`);
        return false;
      }
      count += 1;
      lastCompactedSeq = overflowBatch.reduce((m, t) => Math.max(m, t.seq), lastCompactedSeq);
      previous = generated.compact;
      compactText = generated.compact;
      generatedWords = generated.words;
      const wrote = writeCompactBlob(key, {
        compact: generated.compact,
        words: generated.words,
        count,
        lastAt: Date.now(),
        lastCompactedSeq,
        chatId,
      }, epoch);
      if (!wrote || epochOf(key) !== epoch) {
        console.warn(`[compaction] ${key}: discarded compact blob — thread was fresh-started`);
        return false;
      }
      await mutateState((s) => {
        if (epochOf(key) !== epoch) return;
        s[key] = {
          userTurnsTotal: total,
          lastCompactUserTurns: total,
          count,
          lastAt: Date.now(),
          lastWords: generated.words,
          rotationOwed: true,
          pendingRotation: null,
        };
      });
    }

    await mutateState((s) => {
      if (epochOf(key) !== epoch) return;
      s[key] = {
        userTurnsTotal: total,
        lastCompactUserTurns: total,
        count,
        lastAt: Date.now(),
        lastWords: generatedWords,
        rotationOwed: true,
        pendingRotation: null,
      };
    });
    if (epochOf(key) === epoch && !loadState()[key]?.rotationOwed) {
      bankRotation(key);
    }

    let savedToRag = false;
    try {
      await saveCompactToMemory(key, epoch, cli, chatId, compactText);
      savedToRag = true;
    } catch (err) {
      console.warn(`[compaction] ${key}: savemem hook failed (compact still applies locally):`, (err as Error).message);
    }
    if (epochOf(key) !== epoch) return false;

    args.emit({
      type: 'compacted',
      chatId,
      words: generatedWords,
      turns: total,
      count,
      savedToRag,
      at: Date.now(),
    });
    await flushEventLog(key);

    const assembled = assembleForeverTurn({
      events,
      compact: compactText,
      lastCompactedSeq,
    });
    const primer = assembled.primer;
    if (args.isBusy()) {
      console.warn(`[compaction] ${key}: turn in flight — rotation deferred to next turn end`);
      return true;
    }
    if (epochOf(key) !== epoch) return false;
    const applied = await args.rotate(primer);
    if (epochOf(key) !== epoch) return false;
    if (applied !== false) {
      await mutateState((s) => {
        if (s[key]) {
          s[key].rotationOwed = false;
          s[key].pendingRotation = null;
        }
      });
    }
    console.warn(
      `[compaction] ${key}: overwrote compact #${count} (covers ${assembled.compactCovers} older, window=${assembled.windowTurns}, ${generatedWords} words, rag=${savedToRag})`,
    );
    return true;
  } catch (err) {
    console.warn(`[compaction] ${key}: compact failed, will retry:`, (err as Error).message);
    return false;
  } finally {
    inFlight.delete(key);
  }
}
