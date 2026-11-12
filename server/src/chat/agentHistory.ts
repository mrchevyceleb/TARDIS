// Live conversation history for every agent (Matt, Nov 12 2026).
//
// <state>/agent-notes/<id>/transcript.md is an agent's own greppable record of
// its home thread: the owner's messages, teammates' messages and the agent's
// replies, visible text only, secrets masked. It used to be rebuilt by an
// outside script every 30 minutes, so a thread reset (which deletes the event
// log) erased everything said since the last run, and streamed replies (all of
// Codex's) never reached it at all. The server now writes it as the
// conversation happens:
//
// - Every append to an agent's thread log reaches this module the moment it is
//   made, so frames arrive in the order things were said. They are committed
//   at the next settle point (a message from the owner or a teammate, the end
//   of a turn, or a voice line or reply_now with no reply streaming), rendered
//   whole by extractVisibleTurns, the reader the model window uses, so every
//   engine's replies land alike.
// - A thread clear first writes everything still pending, a reply cut off
//   mid-stream included, plus a reset marker. If that write fails the clear is
//   refused (event-log-store.ts).
// - Boot resumes from each agent's watermark (.state.json, the old script's
//   format, so the switch-over continues exactly where the script stopped),
//   streaming the log from just before the mark and writing the backlog in
//   batches. Until a lane's backlog has landed nothing newer is written and no
//   clear proceeds. Shutdown flushes whatever is still pending.
// - A fresh thread cannot see what came before its reset, so its primer names
//   the last reset and who the agent was talking with just before it
//   (lastReset): "check our latest convo" must land on that conversation.

import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESK_OWNER_NAME } from '../config.ts';
import { listAgentsOrThrow, type Agent } from './agents.ts';
import { ASSISTANT_HUB_PATH, STATE_DIR } from './config.ts';
import { readEventLogFrom, readRange, sanitizeKey, setEventLogObserver, type PersistedEvent } from './event-log-store.ts';
import { redactSecrets } from './secretRedaction.ts';
import { bareChatId, isAgentThread, threadLogKey } from './threadKey.ts';
import { extractVisibleTurns, type VisibleTurn } from './threadWindow.ts';

const NOTES_DIR = join(STATE_DIR, 'agent-notes');
/** Tells any outside tool that used to append to the transcripts that this
 *  server owns them now (pid + heartbeat). */
const WRITER_FILE = join(NOTES_DIR, '.writer.json');
const HEARTBEAT_MS = 5 * 60_000;
/** Lets a burst (a reply's trailing frames, a few queued messages) land as one write. */
const COMMIT_DELAY_MS = 400;
const SEEN_DELIVERIES_MAX = 512;
/** The history tail is read in a window this big, doubled until it holds the
 *  entries asked for (one pasted log can be megabytes). */
const TAIL_READ_BYTES = 512 * 1024;
/** How far before its watermark a boot reads: enough to find the message a
 *  pending reply answers and to recognise a delivery sent again after a restart. */
const CATCH_UP_CONTEXT_MS = 15 * 60_000;
/** A backlog of any size is written about this many frames at a time. */
const CATCH_UP_BATCH = 2000;
/** The speaker of the marker entry a thread clear writes. */
export const RESET_SPEAKER = 'Thread reset';
const RESET_NOTE = 'The chat thread was cleared here. Everything above happened before the reset; the fresh thread starts below.';
// Same clock as the rest of the office (restartWake, deskHygiene), and the
// exact stamp the transcript and its readers (memory feed) already use.
const stampFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});
const ENTRY_HEADER = /^\*\*(.+?)\*\* \(([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M)\)$/;
/** A message line shaped like an entry header. Written with a leading space,
 *  so a quoted header never reads, or greps, as an entry of its own. */
const HEADER_LOOKALIKE = /^(?=\*\*.+?\*\* \(.*\)$)/gm;

export function agentHistoryPath(agentId: string): string {
  return join(NOTES_DIR, agentId, 'transcript.md');
}

/** The agent whose home thread a durable log key belongs to (`bot-<id>`). */
export function historyAgentIdForLogKey(key: string): string | null {
  if (!key.startsWith('thread|')) return null;
  const chatId = bareChatId(key.slice(key.lastIndexOf('|') + 1));
  return isAgentThread(chatId) ? chatId.slice('bot-'.length) : null;
}

// ---------------------------------------------------------------------------
// Frames

type Inner = Record<string, any>;

function innerOf(ev: unknown): Inner | null {
  if (!ev || typeof ev !== 'object') return null;
  const outer = ev as Inner;
  if ((outer.type === 'event' || typeof outer.type !== 'string') && outer.event && typeof outer.event === 'object') return outer.event;
  return outer;
}

/** The frames the visible-turn reader consumes, and which of them settle the
 *  conversation: a message from a person or teammate flushes the reply before
 *  it, and turnEnd closes the reply, so both are safe commit points. */
function frameOf(ev: unknown): 'settle' | 'part' | null {
  if ((ev as { type?: unknown } | null)?.type === 'turnEnd') return 'settle';
  const inner = innerOf(ev);
  switch (inner?.type) {
    case '_user_echo':
    case 'peer_message':
      return 'settle';
    case '_voice_transcript':
    case '_terminal_error':
    case 'assistant':
      return 'part';
    case 'stream_event': {
      const stream = inner.event;
      if (stream?.type === 'message_start' || stream?.type === 'content_block_stop') return 'part';
      if (stream?.type === 'content_block_start') return stream.content_block?.type === 'text' ? 'part' : null;
      if (stream?.type === 'content_block_delta') return stream.delta?.type === 'text_delta' ? 'part' : null;
      return null;
    }
    default:
      return null;
  }
}

/** A complete line said outside the reply stream: settles once nothing streams. */
function isStandaloneLine(inner: Inner | null): boolean {
  return inner?.type === '_voice_transcript' || (inner?.type === 'assistant' && inner._replyNow === true);
}

function isUserSide(event: PersistedEvent): boolean {
  const type = innerOf(event.ev)?.type;
  return type === '_user_echo' || type === 'peer_message';
}

function deliveryIdOf(event: PersistedEvent): string | null {
  const inner = innerOf(event.ev);
  return inner?.type === 'peer_message' && typeof inner.deliveryId === 'string' && inner.deliveryId ? inner.deliveryId : null;
}

/** How much of `pending` can be written without cutting a reply in half. */
function settledLength(pending: PersistedEvent[]): number {
  const open = new Set<number>();
  let settled = 0;
  for (let i = 0; i < pending.length; i++) {
    const inner = innerOf(pending[i].ev);
    if (inner?.type === 'stream_event') {
      const stream = inner.event;
      if (stream?.type === 'message_start') open.clear();
      else if (stream?.type === 'content_block_start' && typeof stream.index === 'number') open.add(stream.index);
      else if (stream?.type === 'content_block_stop' && typeof stream.index === 'number') open.delete(stream.index);
      continue;
    }
    if (frameOf(pending[i].ev) === 'settle') {
      open.clear();
      settled = i + 1;
    } else if (open.size === 0 && isStandaloneLine(inner)) {
      settled = i + 1;
    }
  }
  return settled;
}

// ---------------------------------------------------------------------------
// Lanes

type Lane = {
  key: string;
  agentId: string;
  /** Observed frames not yet written, in seq order. */
  pending: PersistedEvent[];
  /** The last written message from a person or teammate. The reader needs it
   *  to tell a quiet routine reply (dropped) from a real one. */
  context: PersistedEvent | null;
  /** Peer deliveries already written: a retried delivery re-echoes its message. */
  seen: Set<string>;
  /** The backlog on disk has been written; until then nothing newer is. */
  caughtUp: boolean;
  /** Where the transcript stops, read once and moved by every write, so a
   *  retried catch-up resumes exactly there even if saving the mark failed. */
  mark: Mark | undefined;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
};

const lanes = new Map<string, Lane>();

function laneFor(key: string, agentId: string): Lane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { key, agentId, pending: [], context: null, seen: new Set(), caughtUp: false, mark: undefined, timer: null, chain: Promise.resolve() };
    lanes.set(key, lane);
  }
  return lane;
}

/** Insert in seq order. Frames nearly always come in order, so this walks
 *  back only past the few that arrived early. */
function insertBySeq(list: PersistedEvent[], event: PersistedEvent): void {
  let at = list.length;
  while (at > 0 && list[at - 1].seq > event.seq) at--;
  list.splice(at, 0, event);
}

function remember(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size > SEEN_DELIVERIES_MAX) seen.delete(seen.values().next().value as string);
}

/** Every write for a lane runs in order: the boot catch-up, commits, the
 *  pre-clear flush, shutdown. */
function enqueue(lane: Lane, task: () => Promise<void>): Promise<void> {
  const run = lane.chain.then(task);
  lane.chain = run.catch(() => {});
  return run;
}

function cancelTimer(lane: Lane): void {
  if (lane.timer) clearTimeout(lane.timer);
  lane.timer = null;
}

function schedule(lane: Lane): void {
  if (lane.timer) return;
  lane.timer = setTimeout(() => {
    lane.timer = null;
    enqueue(lane, () => commit(lane, false)).catch((err) => {
      console.warn('[agent-history] commit failed; retrying at the next message', lane.agentId, (err as Error).message);
    });
  }, COMMIT_DELAY_MS);
  lane.timer.unref?.();
}

/** The time an event carries, its own or its inner payload's. */
function stampOf(event: PersistedEvent): number | null {
  if (Number.isFinite(event.at)) return event.at as number;
  const ts = innerOf(event.ev)?.ts;
  return Number.isFinite(ts) ? ts as number : null;
}

/** A copy holding what the transcript needs: the time it was said, and only
 *  the text of an assistant message (tool inputs can be whole files). */
function slim(event: PersistedEvent, at: number): PersistedEvent {
  const inner = innerOf(event.ev);
  let ev = event.ev;
  if (inner?.type === 'assistant' && Array.isArray(inner.message?.content)) {
    const content = inner.message.content.filter((block: Inner | null) => block?.type === 'text');
    if (content.length !== inner.message.content.length) {
      const thin = { ...inner, message: { ...inner.message, content } };
      ev = (inner === event.ev ? thin : { ...(event.ev as Inner), event: thin }) as PersistedEvent['ev'];
    }
  }
  return { seq: event.seq, ev, at, ...(event.lane ? { lane: event.lane } : {}) };
}

// ---------------------------------------------------------------------------
// Rendering and writing

let rosterCache = new Map<string, Agent>();
let rosterRead = false;

function rememberRoster(agents: Agent[]): void {
  rosterCache = new Map(agents.map((agent) => [agent.id, agent]));
  rosterRead = true;
}

/** The roster agent, or null when it was retired. A roster that cannot be read
 *  right now falls back to the last good copy; with none this throws, so the
 *  frames stay pending and a clear is refused instead of history dropped. */
function rosterAgent(agentId: string): Agent | null {
  try {
    rememberRoster(listAgentsOrThrow());
  } catch (err) {
    if (!rosterRead) throw err;
  }
  return rosterCache.get(agentId) ?? null;
}

type Entry = { who: string; at: number; text: string };

function speakerOf(turn: VisibleTurn, source: PersistedEvent, agent: Agent): { who: string; text: string } {
  if (turn.role === 'assistant') return { who: agent.name, text: turn.text };
  const inner = innerOf(source.ev);
  if (inner?.type === 'peer_message') {
    const from = typeof inner.from === 'string' && inner.from.trim() ? inner.from.trim() : 'peer';
    const prefix = `[${from}] `;
    return { who: from, text: turn.text.startsWith(prefix) ? turn.text.slice(prefix.length) : turn.text };
  }
  return { who: DESK_OWNER_NAME, text: turn.text };
}

/** The entries `batch` adds, plus the peer deliveries it writes. Pure: the
 *  caller applies the deliveries only once the write succeeded. */
function render(lane: Lane, batch: PersistedEvent[], agent: Agent): { entries: Entry[]; deliveries: string[] } {
  const deliveries: string[] = [];
  const fresh = batch.filter((event) => {
    const id = deliveryIdOf(event);
    if (!id) return true;
    if (lane.seen.has(id) || deliveries.includes(id)) return false;
    deliveries.push(id);
    return true;
  });
  const sources = new Map(fresh.map((event) => [event.seq, event] as const));
  const window = lane.context && !fresh.includes(lane.context) ? [lane.context, ...fresh] : fresh;
  const entries: Entry[] = [];
  // A record, not a model window: every message is kept whole.
  for (const turn of extractVisibleTurns(window, Infinity)) {
    const source = sources.get(turn.seq);
    if (!source || source === lane.context) continue;
    const { who, text } = speakerOf(turn, source, agent);
    const body = redactSecrets(text).trim();
    if (body) entries.push({ who, at: source.at ?? Date.now(), text: body });
  }
  return { entries, deliveries };
}

function formatEntry(entry: Entry): string {
  return `**${entry.who}** (${stampFormat.format(entry.at)})\n${entry.text.replace(HEADER_LOOKALIKE, ' ')}\n`;
}

const prepared = new Set<string>();

function ignoreExisting(err: NodeJS.ErrnoException): void {
  if (err.code !== 'EEXIST') throw err;
}

async function appendEntries(agent: Agent, entries: Entry[]): Promise<void> {
  if (!entries.length) return;
  const dir = join(NOTES_DIR, agent.id);
  if (!prepared.has(agent.id)) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'transcript.md'),
      `# ${agent.name} — conversation history\n\nEverything said in ${agent.name}'s thread, visible text only: ${DESK_OWNER_NAME}'s messages, teammates' messages and ${agent.name}'s replies, tool calls stripped and secrets masked. Written live by TARDIS within seconds and kept across thread resets. Search it or read its tail instead of loading it whole.\n\n`,
      { flag: 'wx' }).catch(ignoreExisting);
    await writeFile(join(dir, 'notes.md'),
      `# ${agent.name} — own notes\n\nThis file belongs to ${agent.name}. Durable facts the agent wants to keep, one per line as \`- (YYYY-MM-DD) <fact>\`, safe to read, grep, and edit. Nothing here is ever rewritten by the transcript writer or by compaction.\n`,
      { flag: 'wx' }).catch(ignoreExisting);
    prepared.add(agent.id);
  }
  await appendFile(join(dir, 'transcript.md'), `\n${entries.map(formatEntry).join('\n')}`, 'utf8');
}

type Mark = { at: number; seq: number };

/** The mark of a history this writer starts from nothing: every frame is newer. */
const FROM_START: Mark = { at: 0, seq: -1 };

function statePath(agentId: string): string {
  return join(NOTES_DIR, agentId, '.state.json');
}

function familyOf(key: string): string {
  return `${sanitizeKey(key)}.jsonl`;
}

function readState(agentId: string): { lanes: Record<string, unknown> } & Record<string, unknown> {
  try {
    const state = JSON.parse(readFileSync(statePath(agentId), 'utf8'));
    if (state && typeof state === 'object' && state.lanes && typeof state.lanes === 'object') return state;
  } catch {
    // fresh
  }
  return { lanes: {} };
}

/** Where this agent's transcript stops. A transcript with no usable mark is
 *  taken as complete up to its last write, never replayed from the start. */
function markOf(agentId: string, key: string): Mark | null {
  const value = readState(agentId).lanes[familyOf(key)] as Partial<Mark> | number | undefined;
  if (value && typeof value === 'object' && Number.isFinite(value.at) && Number.isFinite(value.seq)) {
    return { at: value.at as number, seq: value.seq as number };
  }
  try {
    return { at: statSync(agentHistoryPath(agentId)).mtimeMs, seq: 0 };
  } catch {
    return null;
  }
}

async function saveMark(agentId: string, key: string, mark: Mark): Promise<void> {
  const file = statePath(agentId);
  await mkdir(join(NOTES_DIR, agentId), { recursive: true });
  const state = readState(agentId);
  state.lanes[familyOf(key)] = { at: mark.at, seq: mark.seq };
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

/** Append `batch` (frames in seq order) to the transcript and move the mark past it. */
async function writeFrames(lane: Lane, agent: Agent, batch: PersistedEvent[]): Promise<void> {
  if (!batch.length) return;
  const { entries, deliveries } = render(lane, batch, agent);
  await appendEntries(agent, entries);
  for (const id of deliveries) remember(lane.seen, id);
  for (const event of batch) if (isUserSide(event)) lane.context = event;
  const last = batch[batch.length - 1];
  lane.mark = { at: last.at as number, seq: last.seq };
  await saveMark(agent.id, lane.key, lane.mark).catch((err) => {
    console.warn('[agent-history] watermark not saved', agent.id, (err as Error).message);
  });
}

/** Write what has settled, or with `all` everything, still pending. The
 *  lane's backlog on disk lands first: if it cannot, this throws, nothing
 *  newer is written and a clear waiting on it is refused. */
async function commit(lane: Lane, all: boolean): Promise<void> {
  await ensureCaughtUp(lane);
  const end = all ? lane.pending.length : settledLength(lane.pending);
  if (end <= 0) return;
  const batch = lane.pending.slice(0, end);
  const agent = rosterAgent(lane.agentId);
  if (agent) await writeFrames(lane, agent, batch);
  const done = new Set(batch);
  lane.pending = lane.pending.filter((event) => !done.has(event));
}

// ---------------------------------------------------------------------------
// Event-log observer

function appended(key: string, event: PersistedEvent): void {
  const agentId = historyAgentIdForLogKey(key);
  if (!agentId) return;
  const frame = frameOf(event.ev);
  if (!frame) return;
  const lane = laneFor(key, agentId);
  // Observed as it is logged: a frame with no time of its own is said now.
  // Appends arrive in the order seqs were handed out; the sort only guards a
  // frame whose append came a moment after a later one's.
  insertBySeq(lane.pending, slim(event, stampOf(event) ?? Date.now()));
  if (frame === 'settle' || isStandaloneLine(innerOf(event.ev))) schedule(lane);
}

async function beforeClear(key: string): Promise<void> {
  const agentId = historyAgentIdForLogKey(key);
  if (!agentId) return;
  const lane = laneFor(key, agentId);
  await enqueue(lane, async () => {
    cancelTimer(lane);
    await commit(lane, true);
    const agent = rosterAgent(agentId);
    if (agent) await appendEntries(agent, [{ who: RESET_SPEAKER, at: Date.now(), text: RESET_NOTE }]);
    lane.context = null;
  });
}

function removed(key: string, sequences: ReadonlySet<number>): void {
  const lane = lanes.get(key);
  if (lane) lane.pending = lane.pending.filter((event) => !sequences.has(event.seq));
}

// ---------------------------------------------------------------------------
// Boot, shutdown

/** Pick up where the transcript stopped: every frame the log holds past the
 *  watermark, which no process has written. The log is streamed from a little
 *  before the mark and written in seq order, in batches as it goes, all of it
 *  older than what the observer has delivered since boot, which waits in
 *  `pending` and is skipped here by seq. A reply the last process was still
 *  streaming can never finish now, so the end of the backlog is written whole. */
async function catchUp(agent: Agent, lane: Lane): Promise<void> {
  if (!lane.mark) {
    // A history started from nothing says so on disk before anything is
    // written, so a transcript left by a failed first write never passes
    // for a complete one.
    const found = markOf(agent.id, lane.key);
    if (!found) await saveMark(agent.id, lane.key, FROM_START);
    lane.mark = found ?? FROM_START;
  }
  const mark = lane.mark;
  // New frames wait in `held` until nothing still to come can sort before
  // them, then move to `backlog` in seq order: the file holds sync appends
  // (an owner's message) ahead of async ones queued before them (the reply it
  // interrupted), and the mark only ever moves past a whole written prefix.
  let held: PersistedEvent[] = [];
  let backlog: PersistedEvent[] = [];
  const write = async (end: number) => {
    if (end <= 0) return;
    await writeFrames(lane, agent, backlog.slice(0, end));
    backlog = backlog.slice(end);
  };
  // Builds before this one stamped only some events: one without a time was
  // logged right after the event before it.
  let lastAt = 0;
  // The marked frame still in the log means the same thread, where seqs order
  // everything after it. Before it, or when the thread was reset since, the
  // time it was said does.
  let pastMark = false;
  await readEventLogFrom(
    lane.key,
    (event) => Number.isFinite(event.at) && (event.at as number) < mark.at - CATCH_UP_CONTEXT_MS,
    async (events, laterMinSeq) => {
      const live = new Set(lane.pending.map((event) => event.seq));
      for (const event of events) {
        const at = stampOf(event) ?? lastAt;
        lastAt = at;
        if (!frameOf(event.ev)) continue;
        const isNew = pastMark ? event.seq > mark.seq : at > mark.at || (at === mark.at && event.seq > mark.seq);
        if (event.seq === mark.seq && at === mark.at) pastMark = true;
        if (isNew) {
          if (!live.has(event.seq)) insertBySeq(held, slim(event, at));
          continue;
        }
        if (isUserSide(event)) lane.context = slim(event, at);
        const id = deliveryIdOf(event);
        if (id) remember(lane.seen, id);
      }
      let ready = 0;
      while (ready < held.length && held[ready].seq < laterMinSeq) ready++;
      if (ready > 0) {
        backlog = backlog.concat(held.slice(0, ready));
        held = held.slice(ready);
      }
      if (backlog.length >= CATCH_UP_BATCH) await write(settledLength(backlog));
    },
  );
  backlog = backlog.concat(held);
  await write(backlog.length);
}

/** Catch the lane up from disk once, before its first write. A failure leaves
 *  it to be retried, from the mark, by the next write. */
async function ensureCaughtUp(lane: Lane): Promise<void> {
  if (lane.caughtUp) return;
  const agent = rosterAgent(lane.agentId);
  if (agent) await catchUp(agent, lane);
  lane.caughtUp = true;
}

function claimWriter(): void {
  const beat = () => {
    try {
      mkdirSync(NOTES_DIR, { recursive: true });
      const tmp = `${WRITER_FILE}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ writer: 'tardis', pid: process.pid, heartbeatAt: Date.now() }));
      renameSync(tmp, WRITER_FILE);
    } catch (err) {
      console.warn('[agent-history] writer heartbeat failed', (err as Error).message);
    }
  };
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();
}

let started = false;

/** Install the observer and catch every agent up in the background. Call it
 *  once at boot, before any agent's lane is live. Resolves when every
 *  catch-up has been tried. */
export function startAgentHistory(): Promise<void> {
  if (started) return Promise.resolve();
  started = true;
  setEventLogObserver({ appended, beforeClear, removed });
  claimWriter();
  let agents: Agent[] = [];
  try {
    agents = listAgentsOrThrow();
    rememberRoster(agents);
  } catch (err) {
    console.warn('[agent-history] roster unreadable at boot; each agent catches up at its next write', (err as Error).message);
  }
  return Promise.all(agents.map((agent) => {
    const lane = laneFor(threadLogKey(ASSISTANT_HUB_PATH, agent.home), agent.id);
    return enqueue(lane, () => ensureCaughtUp(lane)).catch((err) => {
      console.warn('[agent-history] catch-up failed; retrying at the next write, and clears wait for it', agent.id, (err as Error).message);
    });
  })).then(() => undefined);
}

/** Write everything still pending. Shutdown runs this after the log chains flush. */
export async function flushAgentHistory(): Promise<void> {
  await Promise.all([...lanes.values()].map((lane) => enqueue(lane, async () => {
    cancelTimer(lane);
    await commit(lane, true);
  }).catch((err) => {
    console.warn('[agent-history] flush failed', lane.agentId, (err as Error).message);
  })));
}

// ---------------------------------------------------------------------------
// Reading

export type HistoryEntry = { who: string; stamp: string; text: string };

function parseEntries(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  let current: { who: string; stamp: string; lines: string[] } | null = null;
  const close = () => {
    if (current) out.push({ who: current.who, stamp: current.stamp, text: current.lines.join('\n').trim() });
  };
  for (const line of text.split('\n')) {
    const header = ENTRY_HEADER.exec(line);
    if (header) {
      close();
      current = { who: header[1], stamp: header[2], lines: [] };
    } else {
      current?.lines.push(line);
    }
  }
  close();
  return out;
}

/** The newest `wanted` entries `counts` accepts, read from the end of the
 *  agent's history in a window that doubles until it holds them or reaches
 *  the start: however big a message, it never hides the entries before it. */
function newestEntries(agentId: string, wanted: number, counts: (entry: HistoryEntry) => boolean = () => true): HistoryEntry[] {
  let fd = -1;
  try {
    fd = openSync(agentHistoryPath(agentId), 'r');
    const size = fstatSync(fd).size;
    for (let window = TAIL_READ_BYTES; ; window *= 2) {
      const start = Math.max(0, size - window);
      const text = readRange(fd, start, size).toString('utf8');
      // From the first whole line; an entry whose header is cut off is skipped.
      const entries = parseEntries(start > 0 ? text.slice(text.indexOf('\n') + 1) : text).filter(counts);
      if (entries.length >= wanted || start === 0) return entries.slice(-wanted);
    }
  } catch {
    return [];
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function agentName(agentId: string): string | null {
  try {
    return rosterAgent(agentId)?.name ?? null;
  } catch {
    return null;
  }
}

/** The newest messages in an agent's history, across thread resets, with the
 *  reply still streaming (not yet written) included. */
export function recentHistory(agentId: string, limit: number): HistoryEntry[] {
  const said = (entry: HistoryEntry) => entry.who !== RESET_SPEAKER && entry.text !== '';
  const entries = newestEntries(agentId, limit, said);
  const name = agentName(agentId);
  const agent = name ? rosterCache.get(agentId) : undefined;
  const lane = [...lanes.values()].find((candidate) => candidate.agentId === agentId);
  if (agent && lane?.pending.length) {
    for (const entry of render(lane, lane.pending, agent).entries) {
      entries.push({ who: entry.who, stamp: stampFormat.format(entry.at), text: entry.text });
    }
  }
  return entries.filter(said).slice(-limit);
}

/** The agent's latest thread reset and who it was talking with just before it
 *  (the owner or a teammate), or null when its recent history has none. */
export function lastReset(agentId: string): { stamp: string; with: string | null } | null {
  const entries = newestEntries(agentId, 64);
  const index = entries.findLastIndex((entry) => entry.who === RESET_SPEAKER);
  if (index < 0) return null;
  const name = agentName(agentId);
  for (let i = index - 1; i >= 0 && entries[i].who !== RESET_SPEAKER; i--) {
    if (entries[i].who !== name) return { stamp: entries[index].stamp, with: entries[i].who };
  }
  return { stamp: entries[index].stamp, with: null };
}
