import { appendFile, mkdir, rm } from 'node:fs/promises';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.ts';
import type { SessionEvent } from './runner.ts';
import { isSyntheticApiErrorEvent } from './providerErrors.ts';

// Per-session event log persistence. The in-memory rolling buffer
// (ClaudeSession.eventLog / CodexSession.eventLog) is the primary source
// of truth during a process lifetime, but if the server restarts mid-turn
// or between turns those events are lost — so a reconnecting client whose
// `sinceSeq` is past the new session's `latestSeq` ends up with a half-
// rendered conversation that never recovers. Backing the in-memory log to
// disk lets a fresh session restore prior history and keep replay semantics
// intact across restarts.
//
// Format: one JSON object per line, `{"seq":N,"ev":{...},"eng":"xai"}`. Files
// live in ~/.rivendell/event-logs/<sanitized-key>.jsonl. Cap is enforced
// lazily on load (truncate to last MAX_EVENTS_PER_LOG); appends are unbuffered.
//
// `eng`/`mdl` are provenance: which engine and model produced this event. An
// agent thread's log is keyed on the thread, not the engine (see threadKey.ts),
// so a single file holds turns from several brains and the transcript has to be
// able to say which one said what.

export type PersistedEvent = {
  seq: number;
  ev: SessionEvent;
  /** Engine (cli) that produced this event. Absent on pre-provenance lines. */
  eng?: string;
  /** Model id that produced this event, when the engine reports one. */
  mdl?: string;
};

export const EVENT_LOG_DIR = join(STATE_DIR, 'event-logs');
export const MAX_EVENTS_PER_LOG = 2000;

// Cheap process-local invalidation for the sidebar history result cache. Bump
// only after a durable write/clear/trim succeeds; derived per-file entries still
// validate with mtime+size.
let revision = 0;
export function eventLogRevision(): number {
  return revision;
}
function bumpEventLogRevision(ev?: SessionEvent): void {
  if (ev) {
    const inner = ev.type === 'event' ? ev.event : ev;
    const type = (inner as { type?: string } | undefined)?.type;
    // One invalidation at semantic message/turn boundaries, not per streamed
    // token. Otherwise an active agent forces a full directory scan every poll.
    if (!['_user_echo', '_voice_transcript', 'peer_message', 'assistant', 'result', 'turnEnd', 'compacted'].includes(type ?? '')) return;
  }
  revision += 1;
}

export function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** CLI plumbing that is not conversation. Filter on write AND on load so
 * old logs shrink in memory. In particular, Claude Code emits one
 * `thinking_tokens` system record AND one `thinking_delta` stream record for
 * nearly every reasoning token; neither renders in TARDIS, but together
 * they turned two GLM turns into ~40,000 durable events. */
export function isPlumbingEvent(ev: unknown): boolean {
  const e = ev as { type?: unknown; event?: any; subtype?: unknown };
  const inner = e?.type === 'event' ? e.event : e;
  if (isSyntheticApiErrorEvent(inner)) return true;

  const type = (inner as { type?: unknown } | undefined)?.type ?? e?.type;
  const subtype = (inner as { subtype?: unknown } | undefined)?.subtype ?? e?.subtype;
  if (type === '_protocol_watermark') return true;
  if (type === 'system') {
    return subtype === 'commands_changed'
      || subtype === 'hook_response'
      || subtype === 'hook_started'
      || subtype === 'hook_progress'
      || subtype === 'thinking_tokens'
      || subtype === 'api_retry';
  }
  if (type !== 'stream_event' || !inner?.event || typeof inner.event !== 'object') return false;
  const stream = inner.event as { type?: unknown; delta?: { type?: unknown }; content_block?: { type?: unknown } };
  return (stream.type === 'content_block_delta'
      && (stream.delta?.type === 'thinking_delta' || stream.delta?.type === 'signature_delta'))
    || (stream.type === 'content_block_start' && stream.content_block?.type === 'thinking');
}


function logPath(key: string): string {
  return join(EVENT_LOG_DIR, `${sanitizeKey(key)}.jsonl`);
}

/** Overflow sink for trimmed lines. The hot log stays bounded; the bytes are
 *  never destroyed. */
function archivePath(key: string): string {
  return join(EVENT_LOG_DIR, `${sanitizeKey(key)}.archive.jsonl`);
}

// Synchronous load — called once during ClaudeSession / CodexSession
// construction so the new instance can prime its in-memory buffer and
// `nextSeq` counter before any new emit. Files top out at MAX_EVENTS_PER_LOG
// lines (~a few MB), so blocking the construct here is fine.
// Parsed-log cache, validated against (mtimeMs, size). The same multi-MB logs
// are re-read by every session spawn, every ws `hello`, and the /api/agents
// unread pass; parsing them per call is pure event-loop burn. Callers mutate the
// array they receive (a live session appends to its own event log), so the
// cached array stays private and every caller gets a shallow copy.
const parsedCache = new Map<
  string,
  { mtimeMs: number; size: number; events: PersistedEvent[]; nextSeq: number; bytes: number }
>();
const PARSED_CACHE_MAX = 128;
// An entry count is not a memory bound. The retained MAX_EVENTS_PER_LOG window
// of this box's biggest lanes is 8-11 MB of JSON *each*, so 128 of them is
// ~340 MB of raw text and several times that once parsed - an OOM on an
// always-on process for anyone paging through the sidebar. Cap retained bytes.
// Budget is RETAINED JSON TEXT, which is a floor on the real heap cost: parsed
// objects typically run 2-4x their source text. 32 MB of text is therefore
// roughly 65-130 MB of heap - deliberately conservative for a process that is
// never restarted.
const PARSED_CACHE_MAX_BYTES = 32 * 1024 * 1024;
let parsedCacheBytes = 0;

// Agent home threads are engine-neutral, so several native session objects can
// write the same durable log over their lifetime. Sequence allocation must be
// shared process-wide; a stale Codex session must never resume below events a
// GLM/Claude/Banana session appended in the meantime.
const nextSeqByLogKey = new Map<string, number>();

function observeNextSeq(key: string, nextSeq: number): number {
  const next = Math.max(1, nextSeqByLogKey.get(key) ?? 1, nextSeq);
  nextSeqByLogKey.set(key, next);
  return next;
}

export function reserveEventLogSeq(key: string, localFloor = 1): number {
  let next = nextSeqByLogKey.get(key);
  if (next === undefined) next = loadEventLogSync(key).nextSeq;
  const seq = Math.max(next, localFloor);
  nextSeqByLogKey.set(key, seq + 1);
  return seq;
}

export function latestEventLogSeq(key: string, localFloor = 0): number {
  let next = nextSeqByLogKey.get(key);
  if (next === undefined) next = loadEventLogSync(key).nextSeq;
  return Math.max(localFloor, next - 1);
}

// Map iteration is insertion-ordered and a cache hit re-inserts, so the front
// of the map is the least recently used entry.
function evictParsedCache(): void {
  while (
    parsedCache.size > 0
    && (parsedCache.size > PARSED_CACHE_MAX || parsedCacheBytes > PARSED_CACHE_MAX_BYTES)
  ) {
    const oldest = parsedCache.keys().next().value;
    if (oldest === undefined) break;
    const dropped = parsedCache.get(oldest);
    parsedCache.delete(oldest);
    if (dropped) parsedCacheBytes -= dropped.bytes;
  }
  if (parsedCacheBytes < 0) parsedCacheBytes = 0;
}

export function loadEventLogSync(key: string): { events: PersistedEvent[]; nextSeq: number } {
  const path = logPath(key);
  let mtimeMs: number;
  let size: number;
  try {
    const st = statSync(path);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    return { events: [], nextSeq: nextSeqByLogKey.get(key) ?? 1 };
  }
  const cached = parsedCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    // Re-insert so eviction order is least-recently-USED, not first-inserted.
    parsedCache.delete(path);
    parsedCache.set(path, cached);
    return { events: cached.events.slice(), nextSeq: observeNextSeq(key, cached.nextSeq) };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { events: [], nextSeq: nextSeqByLogKey.get(key) ?? 1 };
  }
  const events: PersistedEvent[] = [];
  // Source-text length of each kept event, so the cache can charge itself the
  // EXACT retained tail. Pro-rating the whole file by event count under-counts
  // badly on a long lane, where the biggest events cluster at the end.
  const eventChars: number[] = [];
  // High-water comes from every valid persisted record, including plumbing we
  // drop from the replay window. Filtering first would let nextSeq collide
  // with an on-disk seq when the file ends on commands_changed / hook_*.
  let highWater = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.seq === 'number' && parsed?.ev) {
        if (parsed.seq > highWater) highWater = parsed.seq;
        if (isPlumbingEvent(parsed.ev)) continue;
        const event: PersistedEvent = { seq: parsed.seq, ev: parsed.ev as SessionEvent };
        if (typeof parsed.eng === 'string' && parsed.eng) event.eng = parsed.eng;
        if (typeof parsed.mdl === 'string' && parsed.mdl) event.mdl = parsed.mdl;
        events.push(event);
        eventChars.push(line.length);
      }
    } catch {
      // skip malformed lines (interrupted append, etc.)
    }
  }
  // Trim to the most recent window so a long-lived session that crashed
  // mid-turn doesn't keep replaying ancient events forever.
  const trimmed = events.length > MAX_EVENTS_PER_LOG
    ? events.slice(events.length - MAX_EVENTS_PER_LOG)
    : events;
  // High-water + 1 from the FULL file, not last-line + 1 and not only the
  // trimmed window: concurrent writers can append a duplicate lower seq,
  // and trimming oldest lines must not rewind the allocator.
  const nextSeq = highWater + 1;
  // Charge the cache for exactly what we retained, so a handful of multi-MB
  // lanes cannot quietly hold hundreds of MB. `trimmed` is always a suffix of
  // `events`, so this window is in range.
  let retainedBytes = 0;
  for (let i = eventChars.length - trimmed.length; i < eventChars.length; i += 1) {
    retainedBytes += eventChars[i];
  }
  const prior = parsedCache.get(path);
  if (prior) parsedCacheBytes -= prior.bytes;
  parsedCache.delete(path);
  parsedCache.set(path, { mtimeMs, size, events: trimmed, nextSeq, bytes: retainedBytes });
  parsedCacheBytes += retainedBytes;
  // A single log bigger than the whole budget evicts itself here: callers still
  // get their data, it just is not retained.
  evictParsedCache();
  return { events: trimmed.slice(), nextSeq: observeNextSeq(key, nextSeq) };
}

export function normalizeEventLogSequence(lines: readonly string[]): {
  lines: string[];
  repaired: boolean;
  latestSeq: number;
} {
  const originalMax = lines.reduce((max, line) => {
    try {
      const seq = JSON.parse(line)?.seq;
      return typeof seq === 'number' && Number.isFinite(seq) ? Math.max(max, seq) : max;
    } catch {
      return max;
    }
  }, 0);
  let previous = 0;
  let repairCursor = originalMax;
  let repaired = false;
  let repairingTail = false;
  const normalized = lines.map((line) => {
    if (!line) return line;
    try {
      const record = JSON.parse(line);
      if (typeof record?.seq !== 'number' || !Number.isFinite(record.seq)) return line;
      if (!repairingTail && record.seq > previous) {
        previous = record.seq;
        return line;
      }
      // Once chronology regresses, move the ENTIRE remaining tail above the
      // old file maximum. A browser already at that old maximum will then
      // receive every repaired event instead of silently discarding one that
      // merely collided with an existing cursor value.
      repairingTail = true;
      const next = ++repairCursor;
      previous = next;
      repaired = true;
      return JSON.stringify({ ...record, seq: next });
    } catch {
      return line;
    }
  });
  return { lines: normalized, repaired, latestSeq: previous };
}

/** Repair sequence regressions left by older per-engine allocators.
 *
 * File order is the durable chronology. Keep every already-monotonic number and
 * bump only a duplicate/regression above its predecessor, so existing client
 * cursors remain valid and previously hidden late events become replayable.
 */
export function repairEventLogSequenceSync(key: string): { repaired: boolean; latestSeq: number } {
  const path = logPath(key);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { repaired: false, latestSeq: latestEventLogSeq(key) };
  }

  const normalized = normalizeEventLogSequence(raw.split('\n'));
  if (normalized.repaired) {
    const temporaryPath = `${path}.seq-repair-${process.pid}.tmp`;
    let fd = -1;
    try {
      mkdirSync(EVENT_LOG_DIR, { recursive: true });
      fd = openSync(temporaryPath, 'w');
      writeFileSync(fd, normalized.lines.join('\n'), 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = -1;
      renameSync(temporaryPath, path);
    } catch (error) {
      if (fd >= 0) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      try { unlinkSync(temporaryPath); } catch { /* absent */ }
      throw error;
    }
    const cached = parsedCache.get(path);
    if (cached) parsedCacheBytes -= cached.bytes;
    parsedCache.delete(path);
    if (parsedCacheBytes < 0) parsedCacheBytes = 0;
    bumpEventLogRevision();
  }

  // Advance the allocator, but report the DURABLE repaired boundary. The
  // process allocator may already be higher because of memory-only events; a
  // replay must not mistake those newer events for stale session-buffer data.
  observeNextSeq(key, normalized.latestSeq + 1);
  return { repaired: normalized.repaired, latestSeq: normalized.latestSeq };
}

/** Full durable HOT log for forever-thread assembly/compaction. Unlike
 * loadEventLogSync this does not cap the result to the UI replay buffer: the
 * turns that just aged out of the last-50 window must remain available until
 * Grok has merged them into the rolling compact. compactEventLog below refuses
 * to archive past that compacted seq, so the hot file is the complete source. */
export function loadEventLogForCompactionSync(key: string): PersistedEvent[] {
  let raw: string;
  try {
    raw = readFileSync(logPath(key), 'utf8');
  } catch {
    return [];
  }
  const events: PersistedEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.seq !== 'number' || !parsed?.ev || isPlumbingEvent(parsed.ev)) continue;
      const event: PersistedEvent = { seq: parsed.seq, ev: parsed.ev as SessionEvent };
      if (typeof parsed.eng === 'string' && parsed.eng) event.eng = parsed.eng;
      if (typeof parsed.mdl === 'string' && parsed.mdl) event.mdl = parsed.mdl;
      events.push(event);
    } catch {
      // Interrupted trailing append: ignore only the malformed line.
    }
  }
  return events;
}

// Append-only writer keyed by sanitized session key. A per-key promise chain
// preserves ordering when many emits land back-to-back during streaming. We
// fire-and-forget at the call site (emit is sync); failures get logged but
// don't propagate, since losing a disk-mirror line is better than crashing a
// live turn.
const writeChains = new Map<string, Promise<void>>();

/** Resolves once every queued append for `key` has hit disk — compaction
 *  flushes its marker before rotating so the fresh session's log restore
 *  can't race the append chain and miss it. */
export function flushEventLog(key: string): Promise<void> {
  return writeChains.get(key) ?? Promise.resolve();
}

/** Flush EVERY pending write chain. Called on shutdown: restart tombstones
 *  and trailing turn events are queued async, and a fast server.close() must
 *  not let process.exit beat them to disk. */
export function flushAllEventChains(): Promise<void> {
  console.warn(`[event-log-store] flushing ${writeChains.size} pending chain(s) before exit`);
  return Promise.all([...writeChains.values()]).then(() => undefined);
}

/** Synchronous append for hard durability boundaries. Shutdown tombstones
 * cannot race process exit, and `_user_echo` admission records must hit disk
 * before listeners acknowledge or the model receives the prompt. Callers flush
 * the per-key async chain first when the process is staying alive. */
export function appendEventLogSync(key: string, persisted: PersistedEvent): boolean {
  observeNextSeq(key, persisted.seq + 1);
  if (isPlumbingEvent(persisted.ev)) return true;
  try {
    mkdirSync(EVENT_LOG_DIR, { recursive: true });
    appendFileSync(logPath(key), JSON.stringify(persisted) + '\n', 'utf8');
    bumpEventLogRevision(persisted.ev);
    return true;
  } catch (err) {
    console.warn('[event-log-store] sync append failed', key, (err as Error).message);
    return false;
  }
}

/** External conversation records use the same write chain as native output.
 * A synchronous append outside it could land ahead of older queued frames. */
export function appendEventLogDurable(key: string, persisted: PersistedEvent): Promise<void> {
  observeNextSeq(key, persisted.seq + 1);
  const next = (writeChains.get(key) ?? Promise.resolve()).then(() => {
    if (!appendEventLogSync(key, persisted)) throw new Error('Could not save the call transcript to the conversation');
  });
  writeChains.set(key, next.catch(() => {}));
  return next;
}

export function appendEventLog(key: string, persisted: PersistedEvent): void {
  observeNextSeq(key, persisted.seq + 1);
  if (isPlumbingEvent(persisted.ev)) return;
  const path = logPath(key);
  const line = JSON.stringify(persisted) + '\n';
  const prior = writeChains.get(key) ?? Promise.resolve();
  const next = prior
    .then(async () => {
      try {
        await mkdir(EVENT_LOG_DIR, { recursive: true });
        await appendFile(path, line, 'utf8');
        bumpEventLogRevision(persisted.ev);
      } catch (err) {
        console.warn('[event-log-store] append failed', key, (err as Error).message);
      }
    })
    .catch(() => {});
  writeChains.set(key, next);
}

/** Remove already-streamed protocol text once Claude identifies the enclosing
 * assistant message as synthetic. Exact seqs are supplied by the live runner,
 * so legitimate prose that merely discusses an API error is untouched. The
 * rewrite queues behind those appends and ahead of the durable terminal card. */
export function removeEventLogEvents(key: string, sequences: Iterable<number>): Promise<void> {
  const targets = new Set([...sequences].filter((seq) => Number.isFinite(seq) && seq > 0));
  if (targets.size === 0) return Promise.resolve();
  const path = logPath(key);
  const prior = writeChains.get(key) ?? Promise.resolve();
  const next = prior.then(() => {
    try {
      const raw = readFileSync(path, 'utf8');
      const kept: string[] = [];
      let maxRemoved = 0;
      let maxKept = 0;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          const seq = typeof parsed?.seq === 'number' ? parsed.seq : 0;
          if (seq > 0 && targets.has(seq)) {
            maxRemoved = Math.max(maxRemoved, seq);
            continue;
          }
          maxKept = Math.max(maxKept, seq);
        } catch {
          // Preserve malformed/interrupted lines; this targeted scrub owns only
          // records whose exact sequence was positively classified synthetic.
        }
        kept.push(line);
      }
      if (maxRemoved === 0) return;
      if (maxRemoved > maxKept) {
        kept.push(JSON.stringify({
          seq: maxRemoved,
          ev: { type: 'event', event: { type: '_protocol_watermark' } },
        }));
      }
      const tmp = `${path}.scrub-${process.pid}`;
      writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
      renameSync(tmp, path);
      bumpEventLogRevision();
    } catch (err) {
      console.warn('[event-log-store] synthetic stream scrub failed', key, (err as Error).message);
    }
  }).catch(() => {});
  writeChains.set(key, next);
  void next.finally(() => {
    if (writeChains.get(key) === next) writeChains.delete(key);
  });
  return next;
}

// Wipe the durable log for a key. Called on freshStart so a reset thread can't
// be resurrected when a client with an empty cache requests a full replay
// (sinceSeq=0). Chained through the per-key write queue so any in-flight append
// from the prior session lands first and can't re-create the file afterward,
// then the chain is cleared so the next session starts from an empty log.
export async function clearEventLog(key: string): Promise<void> {
  const path = logPath(key);
  const prior = writeChains.get(key) ?? Promise.resolve();
  const next = prior
    .then(async () => {
      try {
        await rm(path, { force: true });
        // A fresh start resets the whole thread, so the overflow archive goes
        // too — otherwise the next trim would splice pre-reset turns back in.
        await rm(archivePath(key), { force: true });
        nextSeqByLogKey.delete(key);
        bumpEventLogRevision();
      } catch (err) {
        console.warn('[event-log-store] clear failed', key, (err as Error).message);
      }
    })
    .catch(() => {});
  writeChains.set(key, next);
  await next;
  // Drop the chain entry if no newer write superseded ours, so the file we
  // just removed isn't pinned by a stale resolved promise.
  if (writeChains.get(key) === next) writeChains.delete(key);
}

// Rewrite the file to drop everything but the most recent MAX_EVENTS_PER_LOG
// entries. Called from session spawn after load so a long-running session
// doesn't grow its file unboundedly. Atomic via write-temp + rename so a crash
// mid-rewrite never leaves a half-written log.
//
// The trimmed prefix is APPENDED to `<key>.archive.jsonl` before the rewrite,
// not discarded. The cap is a bound on the hot window a session replays and
// holds in memory, and it has to stay one — but merging an agent's per-engine
// logs into a single thread log pushes long threads past the event cap, and
// deleting the oldest turns off disk to enforce a memory bound is not a trade
// anyone agreed to. Archive first, then trim; nothing leaves the box.
type LogLine = { raw: string; seq: number | null; plumbing: boolean };

/** Remove old invisible protocol chatter without sacrificing the allocator's
 * high-water mark. If the newest record is plumbing, retain that ONE line so a
 * restart cannot reuse its seq; loadEventLogSync still hides it from replay. */
function stripPlumbingLines(lines: string[]): { lines: string[]; removed: number } {
  const parsed: LogLine[] = lines.map((raw) => {
    try {
      const record = JSON.parse(raw);
      return {
        raw,
        seq: typeof record?.seq === 'number' ? record.seq : null,
        plumbing: Boolean(record?.ev && isPlumbingEvent(record.ev)),
      };
    } catch {
      return { raw, seq: null, plumbing: false };
    }
  });

  let maxSemanticSeq = -1;
  let maxPlumbingSeq = -1;
  let watermarkIndex = -1;
  for (let i = 0; i < parsed.length; i += 1) {
    const line = parsed[i];
    if (line.seq === null) continue;
    if (line.plumbing) {
      if (line.seq > maxPlumbingSeq) {
        maxPlumbingSeq = line.seq;
        watermarkIndex = i;
      }
    } else if (line.seq > maxSemanticSeq) {
      maxSemanticSeq = line.seq;
    }
  }
  const keepWatermark = maxPlumbingSeq > maxSemanticSeq ? watermarkIndex : -1;
  const kept = parsed.filter((line, index) => !line.plumbing || index === keepWatermark).map((line) => line.raw);
  return { lines: kept, removed: lines.length - kept.length };
}

function compactEventLogUnlocked(key: string, compactedThroughSeq: number): void {
  const path = logPath(key);
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const original = raw.split('\n').filter(Boolean);
  const cleaned = stripPlumbingLines(original);
  const lines = cleaned.lines;
  const desiredDrop = Math.max(0, lines.length - MAX_EVENTS_PER_LOG);

  // Only archive records the rolling compact already covers. The old cap-only
  // trim could evict a tiny unmerged overflow batch before it reached the
  // batching threshold, so a one-word reply either triggered a full compact or
  // disappeared from model memory. Retaining a temporarily oversized hot file
  // is the safe side of that trade; the next post-compact spawn trims it.
  let safeDrop = 0;
  for (; safeDrop < desiredDrop; safeDrop += 1) {
    try {
      const parsed = JSON.parse(lines[safeDrop]);
      if (typeof parsed?.seq !== 'number' || parsed.seq > compactedThroughSeq) break;
    } catch {
      break;
    }
  }

  if (cleaned.removed === 0 && safeDrop === 0) {
    if (desiredDrop > 0) {
      console.log(
        `[event-log-store] trim deferred for ${key}: ${desiredDrop} event(s) are not compacted yet`,
      );
    }
    return;
  }

  const dropped = lines.slice(0, safeDrop);
  if (dropped.length > 0) {
    try {
      // Archive must land BEFORE the rewrite. Keep the whole critical section
      // synchronous: shutdown tombstones use appendEventLogSync(), and any
      // await between read and rename would let that terminal line land in the
      // old file and then be overwritten by our snapshot.
      appendFileSync(archivePath(key), dropped.join('\n') + '\n', 'utf8');
    } catch (err) {
      console.warn(
        `[event-log-store] archive failed for ${key}, leaving log untrimmed:`,
        (err as Error).message,
      );
      return;
    }
  }

  const keptLines = lines.slice(safeDrop);
  const kept = keptLines.length ? keptLines.join('\n') + '\n' : '';
  const tmp = `${path}.compact-${process.pid}`;
  try {
    writeFileSync(tmp, kept, 'utf8');
    renameSync(tmp, path);
    bumpEventLogRevision();
    console.log(
      `[event-log-store] cleaned ${key}: dropped ${cleaned.removed} plumbing event(s), archived ${dropped.length} compacted event(s)`,
    );
    if (desiredDrop > safeDrop) {
      console.log(
        `[event-log-store] trim deferred for ${key}: ${desiredDrop - safeDrop} event(s) are not compacted yet`,
      );
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort stale temp cleanup */ }
    console.warn('[event-log-store] compact failed', key, (err as Error).message);
  }
}

export async function compactEventLog(key: string, compactedThroughSeq = 0): Promise<void> {
  // Serialize cleanup with appends. An append landing between our read and
  // atomic rename must queue behind the rewrite rather than disappear.
  const prior = writeChains.get(key) ?? Promise.resolve();
  const next = prior.then(() => compactEventLogUnlocked(key, compactedThroughSeq));
  writeChains.set(key, next);
  try {
    await next;
  } catch (err) {
    console.warn('[event-log-store] compact failed', key, (err as Error).message);
  } finally {
    if (writeChains.get(key) === next) writeChains.delete(key);
  }
}
