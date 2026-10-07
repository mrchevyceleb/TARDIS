import { appendFile, mkdir, open as openFile, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
  /** Wall-clock ms when the event was emitted (absent on older lines). */
  at?: number;
  /** Written by an agent's background lane (absent on home-lane events). */
  lane?: 'bg';
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
    if (!['_user_echo', '_voice_transcript', 'peer_message', '_reaction', 'assistant', 'result', 'turnEnd', 'compacted'].includes(type ?? '')) return;
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
type ParsedEntry = {
  mtimeMs: number;
  size: number;
  events: PersistedEvent[];
  /** Source-text length of each entry in `events`, index-aligned. */
  eventChars: number[];
  highWater: number;
  nextSeq: number;
  bytes: number;
  cursor: AppendCursor;
};
const parsedCache = new Map<string, ParsedEntry>();
const PARSED_CACHE_MAX = 128;
// An entry count is not a memory bound. The retained MAX_EVENTS_PER_LOG window
// of this box's biggest lanes is 8-11 MB of JSON *each*, so 128 of them is
// ~340 MB of raw text and several times that once parsed - an OOM on an
// always-on process for anyone paging through the sidebar. Cap retained bytes.
// Budget is RETAINED JSON TEXT, which is a floor on the real heap cost: parsed
// objects typically run 2-4x their source text. 32 MB of text is therefore
// roughly 65-130 MB of heap - deliberately conservative for a process that is
// never restarted.
// Raised from 32 MB (Sep 28 2026): with ~14 busy agent lanes at 8-11 MB of
// retained text each, a 32 MB budget held three or four of them, so the 3 s
// sidebar poll evicted and re-parsed every other lane from scratch on each
// pass (2.9-4.2 s of blocking work that chat switches queued behind).
// 192 MB of text is well under 1 GB of heap on an 8 GB-heap server.
const PARSED_CACHE_MAX_BYTES = 192 * 1024 * 1024;
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

// Incremental reads. Between rare rewrites (sequence repair, compaction,
// clear) a log only grows by appends, and every rewrite replaces the file by
// rename or truncation. So when a file has only grown since the last read (same
// inode, not shorter, and the bytes just before where we stopped are
// unchanged) only the appended bytes need reading. A lane far past the replay
// cap (86 MB for a busy agent) otherwise costs about 1 s of blocking parse on
// every hello and every sidebar poll.
const TAIL_FINGERPRINT_BYTES = 64;

type AppendCursor = { ino: number; consumed: number; fingerprint: Buffer };

function readRange(fd: number, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, start + read);
    if (n <= 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

async function readRangeAsync(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buf, read, length - read, start + read);
    if (bytesRead <= 0) break;
    read += bytesRead;
  }
  return read === length ? buf : buf.subarray(0, read);
}

function fingerprintAt(fd: number, end: number): Buffer {
  return readRange(fd, Math.max(0, end - TAIL_FINGERPRINT_BYTES), end);
}

type LogRead = { text: string; fragment: string; cursor: AppendCursor; size: number; mtimeMs: number };

/** Complete lines (text) plus any trailing line without a newline yet
 * (fragment). The fragment is never consumed, so it is re-read once complete.
 * With a cursor, returns only what was appended after it, or null when the
 * file was rewritten or truncated underneath the cursor. */
function readLog(path: string, cursor?: AppendCursor): LogRead | null {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const st = fstatSync(fd);
    let from = 0;
    if (cursor) {
      if (st.ino !== cursor.ino || st.size < cursor.consumed) return null;
      if (!fingerprintAt(fd, cursor.consumed).equals(cursor.fingerprint)) return null;
      from = cursor.consumed;
    }
    const chunk = readRange(fd, from, st.size);
    const completeEnd = chunk.lastIndexOf(0x0a) + 1;
    const consumed = from + completeEnd;
    return {
      text: chunk.toString('utf8', 0, completeEnd),
      fragment: chunk.toString('utf8', completeEnd),
      cursor: { ino: st.ino, consumed, fingerprint: fingerprintAt(fd, consumed) },
      size: from + chunk.length,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** clientMsgId of a durable `_user_echo` (the receipt that a person's message
 * was admitted), unwrapping event/stream_event envelopes. */
function userEchoClientMsgIdOf(raw: unknown): string | null {
  let event: any = raw;
  while (
    event
    && typeof event === 'object'
    && (event.type === 'event' || event.type === 'stream_event')
    && event.event
  ) event = event.event;
  return event?.type === '_user_echo' && typeof event.clientMsgId === 'string' ? event.clientMsgId : null;
}

// Delivery receipts per log, oldest to newest, collected from EVERY line the
// reader parses, not just the trimmed replay window. A busy lane pushes a
// natively delivered steer's _user_echo out of the MAX_EVENTS_PER_LOG window
// within minutes, and a reconnect then reported it missing, which raised the
// false "Queued guidance was not retained" banner. Kept alongside the parsed
// cache but outside its eviction: any evicted or rewritten log is re-read in
// full, which rebuilds its receipts.
const RECEIPTS_PER_LOG = 1024;
const echoReceipts = new Map<string, string[]>();

/** Parse persisted lines into events. High-water comes from every valid
 * persisted record, including plumbing dropped from the replay window, so
 * nextSeq can never collide with an on-disk seq. */
function parseLogLines(
  text: string,
  into: { events: PersistedEvent[]; eventChars: number[]; highWater: number; echoIds?: string[] },
): void {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.seq === 'number' && parsed?.ev) {
        if (parsed.seq > into.highWater) into.highWater = parsed.seq;
        if (isPlumbingEvent(parsed.ev)) continue;
        if (into.echoIds) {
          const echoId = userEchoClientMsgIdOf(parsed.ev);
          if (echoId) into.echoIds.push(echoId);
        }
        const event: PersistedEvent = { seq: parsed.seq, ev: parsed.ev as SessionEvent };
        if (typeof parsed.eng === 'string' && parsed.eng) event.eng = parsed.eng;
        if (typeof parsed.mdl === 'string' && parsed.mdl) event.mdl = parsed.mdl;
        if (parsed.lane === 'bg') event.lane = 'bg';
        if (typeof parsed.at === 'number' && Number.isFinite(parsed.at)) event.at = parsed.at;
        into.events.push(event);
        // Source-text length, so the cache can charge itself the EXACT
        // retained tail (the biggest events cluster at the end of a lane).
        into.eventChars.push(line.length);
      }
    } catch {
      // skip malformed lines (interrupted append, etc.)
    }
  }
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

  // Grown since the cached read: parse only the appended bytes. Anything else
  // (never read, evicted, rewritten, truncated) is a full read.
  const appended = cached ? readLog(path, cached.cursor) : null;
  const read = appended ?? readLog(path);
  if (!read) return { events: [], nextSeq: nextSeqByLogKey.get(key) ?? 1 };
  const incremental = Boolean(appended && cached);
  const state = incremental && cached
    ? { events: cached.events, eventChars: cached.eventChars, highWater: cached.highWater, echoIds: echoReceipts.get(path) ?? [] }
    : { events: [] as PersistedEvent[], eventChars: [] as number[], highWater: 0, echoIds: [] as string[] };
  parseLogLines(read.text, state);
  if (state.echoIds.length > RECEIPTS_PER_LOG) state.echoIds.splice(0, state.echoIds.length - RECEIPTS_PER_LOG);
  echoReceipts.set(path, state.echoIds);
  // Trim to the most recent window so a long-lived session that crashed
  // mid-turn doesn't keep replaying ancient events forever.
  if (state.events.length > MAX_EVENTS_PER_LOG) {
    const drop = state.events.length - MAX_EVENTS_PER_LOG;
    state.events.splice(0, drop);
    state.eventChars.splice(0, drop);
  }
  // High-water + 1 from the FULL file, not last-line + 1 and not only the
  // trimmed window: concurrent writers can append a duplicate lower seq,
  // and trimming oldest lines must not rewind the allocator.
  const nextSeq = state.highWater + 1;
  let retainedBytes = 0;
  for (const chars of state.eventChars) retainedBytes += chars;
  if (cached) parsedCacheBytes -= cached.bytes;
  parsedCache.delete(path);
  parsedCache.set(path, {
    mtimeMs: read.mtimeMs,
    // With an unterminated trailing line the cache must not serve exact hits:
    // the fragment is not cached, so an unchanged file would silently drop it.
    // -1 never matches, which sends the next call through the (cheap)
    // incremental path that re-reads just the fragment.
    size: read.fragment ? -1 : read.size,
    events: state.events,
    eventChars: state.eventChars,
    highWater: state.highWater,
    nextSeq,
    bytes: retainedBytes,
    cursor: read.cursor,
  });
  parsedCacheBytes += retainedBytes;
  // A single log bigger than the whole budget evicts itself here: callers still
  // get their data, it just is not retained.
  evictParsedCache();

  // A complete record that is not newline-terminated yet (rare) still counts
  // for this caller, as it did before incremental reads; it is not cached.
  const tail = { events: [] as PersistedEvent[], eventChars: [] as number[], highWater: 0 };
  if (read.fragment) parseLogLines(read.fragment, tail);
  const events = state.events.concat(tail.events);
  const trimmed = events.length > MAX_EVENTS_PER_LOG ? events.slice(events.length - MAX_EVENTS_PER_LOG) : events;
  return { events: trimmed, nextSeq: observeNextSeq(key, Math.max(nextSeq, tail.highWater + 1)) };
}

/** What a catch-up scan may be told about its caller. `keep` drops events the
 *  replay would discard anyway as each chunk is parsed, so a long scan does not
 *  hold the whole range in memory; `aborted` stops it when nobody is listening. */
export type CatchUpScanOptions = {
  keep?: (ev: SessionEvent) => boolean;
  aborted?: () => boolean;
};

/** The events a resuming device is owed that the loader's window no longer
 *  holds. loadEventLogSync keeps the newest few thousand events, which a busy
 *  lane fills in hours; a device away longer resumes below that floor. Reading
 *  only the window would hand it the tail, let its cursor jump to latest, and
 *  leave everything between missing with no signal (a routine every five
 *  minutes hid a night of real reports this way). `reachedSince` false means
 *  even the log file no longer reaches the cursor. */
export async function loadEventLogCatchUp(
  key: string,
  windowEvents: PersistedEvent[],
  replaySince: number,
  maxBytes: number,
  options: CatchUpScanOptions = {},
): Promise<{ extra: PersistedEvent[]; reachedSince: boolean }> {
  if (replaySince < 0 || windowEvents.length === 0) return { extra: [], reachedSince: true };
  if (replaySince === 0) {
    // A device with nothing saved is owed as much recent history as one attach
    // may carry, not just what the count-capped window happens to hold: on a
    // chatty lane 2000 events is a few hours, mostly quiet routine turns, and
    // the byte budget (which is what is meant to bind) sat mostly unspent.
    if (windowEvents.length < MAX_EVENTS_PER_LOG) return { extra: [], reachedSince: true };
    const cold = await loadEventLogSince(key, 0, Math.min(maxBytes, COLD_ATTACH_SCAN_BYTES), options);
    return { extra: cold.events, reachedSince: true };
  }
  if (windowEvents[0].seq <= replaySince + 1) return { extra: [], reachedSince: true };
  const { events, reachedSince } = await loadEventLogSince(key, replaySince, maxBytes, options);
  return { extra: events, reachedSince };
}

// Raw log bytes a cold attach may scan for recent history. Replay collapses and
// clamps what it finds, so this is several times what is actually sent.
const COLD_ATTACH_SCAN_BYTES = 8 * 1024 * 1024;

// Raw bytes parsed per slice of the backwards walk. Parsing costs about 12ms per
// MB, so a slice is one short stretch of the event loop, then the scan yields.
const SINCE_SCAN_CHUNK_BYTES = 1024 * 1024;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Every event after `sinceSeq`, read from the tail of the hot log file.
 *
 *  loadEventLogSync keeps only the newest MAX_EVENTS_PER_LOG events, and a busy
 *  lane fills that window in a few hours. A device that was away longer resumes
 *  at a cursor the window no longer reaches, so catching it up from the window
 *  silently skips everything between. This walks backwards from the end of the
 *  file in fixed chunks (each byte read once) until it has seen a line at or
 *  below `sinceSeq + 1`, the start of the file, or spent `maxBytes`. Reads are
 *  asynchronous and the scan yields to the event loop after every chunk, so a
 *  deep scan never stalls the sockets of other devices. It is the rare path, so
 *  nothing is cached.
 *
 *  `reachedSince` is judged on the raw first seq of what was read, plumbing
 *  lines included: those are dropped from `events`, so the first surviving
 *  event can sit above `sinceSeq + 1` without anything being missing. A scan
 *  that `aborted` returns what it has with `reachedSince` false. */
export async function loadEventLogSince(
  key: string,
  sinceSeq: number,
  maxBytes: number,
  options: CatchUpScanOptions = {},
): Promise<{ events: PersistedEvent[]; reachedSince: boolean }> {
  let handle: FileHandle | null = null;
  try {
    handle = await openFile(logPath(key), 'r');
    const size = (await handle.stat()).size;
    // Whole lines only: a record still being appended has no newline yet, and
    // the live session's own buffer already carries it.
    let end = 0;
    let searched = 0; // tail bytes already checked for a newline; each is read once
    for (let probe = Math.min(size, 64 * 1024); ; probe = Math.min(size, probe * 2)) {
      const lastNewline = (await readRangeAsync(handle, size - probe, size - searched)).lastIndexOf(0x0a);
      if (lastNewline >= 0) { end = size - probe + lastNewline + 1; break; }
      searched = probe;
      if (probe >= size || probe >= maxBytes) break;
    }
    if (end === 0) return { events: [], reachedSince: false };

    // `carry` is the head of the earliest chunk read so far: the end of a line
    // that begins further back. Keeping it (instead of re-reading it) means every
    // byte is read once even when a single record is bigger than a chunk. It is
    // held as pieces and joined only when the line's start turns up, so a record
    // spanning many chunks is copied once, not once per chunk.
    let carry: Buffer[] = [];
    let carryStart = end;
    let spent = 0;
    let rawFirstSeq: number | null = null;
    let collected: PersistedEvent[] = [];
    for (;;) {
      const window = Math.max(1, Math.min(SINCE_SCAN_CHUNK_BYTES, maxBytes - spent));
      const start = Math.max(0, carryStart - window);
      const fresh = await readRangeAsync(handle, start, carryStart);
      spent += fresh.length;
      // A chunk that starts mid-file starts inside a line; that line is
      // finished by the next (earlier) chunk.
      let skip = 0;
      if (start > 0) {
        const nl = fresh.indexOf(0x0a);
        if (nl < 0) {
          // The whole chunk is the middle of one record: park it and read on.
          carry.unshift(fresh);
          carryStart = start;
          if (spent >= maxBytes) {
            return { events: collected.filter((event) => event.seq > sinceSeq), reachedSince: false };
          }
          await yieldToEventLoop();
          if (options.aborted?.()) return { events: [], reachedSince: false };
          continue;
        }
        skip = nl + 1;
      }
      const buf = Buffer.concat([fresh, ...carry]);
      const text = buf.toString('utf8', skip);
      const state = { events: [] as PersistedEvent[], eventChars: [] as number[], highWater: 0 };
      parseLogLines(text, state);
      const kept = options.keep ? state.events.filter((event) => options.keep!(event.ev)) : state.events;
      collected = kept.concat(collected);
      const firstLine = text.slice(0, Math.max(0, text.indexOf('\n')));
      try {
        const seq = JSON.parse(firstLine)?.seq;
        if (typeof seq === 'number') rawFirstSeq = seq;
      } catch { /* malformed first line: keep the previous answer */ }
      carry = skip > 0 ? [fresh.subarray(0, skip)] : [];
      carryStart = start;
      if (start === 0 && rawFirstSeq === null) rawFirstSeq = collected[0]?.seq ?? null;
      const reached = rawFirstSeq !== null && rawFirstSeq <= sinceSeq + 1;
      if (reached || start === 0 || spent >= maxBytes) {
        return { events: collected.filter((event) => event.seq > sinceSeq), reachedSince: reached };
      }
      await yieldToEventLoop();
      if (options.aborted?.()) return { events: [], reachedSince: false };
    }
  } catch {
    return { events: [], reachedSince: false };
  } finally {
    if (handle) await handle.close().catch(() => { /* already closed */ });
  }
}

/** Newest-first, de-duplicated clientMsgIds of durable user echoes, i.e. the
 * delivery receipts a reconnecting client reconciles its pending sends
 * against. Reads only what was appended since the last call. */
export function recentUserEchoClientMsgIds(key: string, limit = 128): string[] {
  loadEventLogSync(key);
  const receipts = echoReceipts.get(logPath(key)) ?? [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let index = receipts.length - 1; index >= 0 && ids.length < limit; index -= 1) {
    const id = receipts[index];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Whether a durable user echo exists for this clientMsgId (the send was
 * admitted), within the last RECEIPTS_PER_LOG receipts of the live log. */
export function durableUserEchoClientMsgId(key: string, clientMsgId: string): boolean {
  loadEventLogSync(key);
  return (echoReceipts.get(logPath(key)) ?? []).includes(clientMsgId);
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

// Per-log verification cursor for repairEventLogSequenceSync. Every hello runs
// the repair check; re-reading and double-parsing a whole busy lane (~1 s for
// 86 MB) on each one is what made chat switches wait. Only bytes appended since
// the last verified point need checking, as long as the file was not rewritten.
const repairCursors = new Map<string, AppendCursor & { previous: number }>();

/** Check appended lines for a sequence regression without rewriting. Returns
 * null on any regression (the caller falls back to the full repair). */
function verifyAppendedSequence(
  text: string,
  fragment: string,
  previous: number,
): { previousComplete: number; latestSeq: number } | null {
  let prev = previous;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let seq: unknown;
    try { seq = JSON.parse(line)?.seq; } catch { continue; }
    if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
    if (seq <= prev) return null;
    prev = seq;
  }
  const previousComplete = prev;
  if (fragment) {
    let seq: unknown;
    try { seq = JSON.parse(fragment)?.seq; } catch { seq = undefined; }
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      if (seq <= prev) return null;
      prev = seq;
    }
  }
  return { previousComplete, latestSeq: prev };
}

/** Last numeric seq among complete lines (the file is monotonic when this is
 * called, so the last one is also the highest). */
function lastCompleteSeq(text: string): number {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i]) continue;
    try {
      const seq = JSON.parse(lines[i])?.seq;
      if (typeof seq === 'number' && Number.isFinite(seq)) return seq;
    } catch { /* keep looking */ }
  }
  return 0;
}

/** Repair sequence regressions left by older per-engine allocators.
 *
 * File order is the durable chronology. Keep every already-monotonic number and
 * bump only a duplicate/regression above its predecessor, so existing client
 * cursors remain valid and previously hidden late events become replayable.
 */
export function repairEventLogSequenceSync(key: string): { repaired: boolean; latestSeq: number } {
  const path = logPath(key);

  // Fast path: nothing was rewritten since the last verified point and the
  // appended lines are already in order.
  const known = repairCursors.get(path);
  if (known) {
    const appended = readLog(path, known);
    if (appended) {
      const verdict = verifyAppendedSequence(appended.text, appended.fragment, known.previous);
      if (verdict) {
        repairCursors.set(path, { ...appended.cursor, previous: verdict.previousComplete });
        observeNextSeq(key, verdict.latestSeq + 1);
        return { repaired: false, latestSeq: verdict.latestSeq };
      }
    }
  }
  repairCursors.delete(path);

  const whole = readLog(path);
  if (!whole) {
    return { repaired: false, latestSeq: latestEventLogSeq(key) };
  }
  const raw = whole.text + whole.fragment;

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
    // The rewrite changed the inode; the next call re-verifies from scratch
    // and sets a fresh cursor.
  } else {
    repairCursors.set(path, { ...whole.cursor, previous: lastCompleteSeq(whole.text) });
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
      if (parsed.lane === 'bg') event.lane = 'bg';
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

  // Only archive records the rolling compact already covers — checked PER
  // LINE across the whole over-cap head, not only up to the first uncovered
  // one. The old break-at-first-uncovered rule let one late-arriving
  // high-seq line (or one unparseable line) pin every compacted line behind it
  // forever (one lane: a single bad line held 41k archived-ready events;
  // another: the cap break held 201k), and those pinned files are what made
  // startup restores expensive. Uncovered head lines (not compacted yet, no
  // seq, or unparseable) are retained in place, in order; nothing the rolling
  // compact does not cover ever leaves the hot file.
  const head = lines.slice(0, desiredDrop);
  const dropped: string[] = [];
  const retainedHead: string[] = [];
  for (const line of head) {
    let seq: unknown;
    try {
      seq = JSON.parse(line)?.seq;
    } catch {
      seq = undefined;
    }
    if (typeof seq === 'number' && seq <= compactedThroughSeq) dropped.push(line);
    else retainedHead.push(line);
  }

  if (cleaned.removed === 0 && dropped.length === 0) {
    if (desiredDrop > 0) {
      console.log(
        `[event-log-store] trim deferred for ${key}: ${desiredDrop} event(s) are not compacted yet`,
      );
    }
    return;
  }
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

  const keptLines = [...retainedHead, ...lines.slice(desiredDrop)];
  const kept = keptLines.length ? keptLines.join('\n') + '\n' : '';
  const tmp = `${path}.compact-${process.pid}`;
  try {
    writeFileSync(tmp, kept, 'utf8');
    renameSync(tmp, path);
    bumpEventLogRevision();
    console.log(
      `[event-log-store] cleaned ${key}: dropped ${cleaned.removed} plumbing event(s), archived ${dropped.length} compacted event(s), retained ${retainedHead.length} uncovered event(s)`,
    );
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
