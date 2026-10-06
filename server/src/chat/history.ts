// Read-only chat history index backing the Grok-style sidebar conversation
// list. Scans the durable event-log directory (~/.rivendell/event-logs), maps
// each log back to (cli, repo, chatId) via the same sanitizeKey transform the
// runners use, and pulls a display title from the first user-authored message.
// Results are cached by (file, mtime) so repeat fetches only re-read logs that
// changed. No writes, no side effects.

import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { EVENT_LOG_DIR, eventLogRevision } from './event-log-store.ts';
import { discoverRepos } from './repos.ts';
import { eventTexts, hasFailureSignal, isAutomationPeerEvent, isQuietRoutineReply, isRoutinePromptText } from './routineNoise.ts';

export type ChatHistoryItem = {
  chatId: string;
  cli: string;
  repo: string;
  title: string;
  /** Last thing said (either side) — the rail's one-line preview. */
  preview?: string;
  updatedAt: number;
};

// `thread` is not an engine — it is the engine-free key an agent home thread's
// continuous log lives under (see threadKey.ts). It shares the prefix grammar
// (`<kind>|<cwd>|<chatId>`), so listing it here is all the mapping this index
// needs: one stat + one head/tail read per conversation, exactly as before.
const CLI_KINDS = ['claude', 'codex', 'assistant', 'banana', 'banana-local', 'banana-fireworks', 'zai', 'xai', 'fireworks', 'thread'];
// Automation/spam logs that would drown the sidebar (bridge probes, browser
// sessions, account bootstraps). Real conversations (studio-*, grok-*, main)
// never start with these prefixes.
const NOISE = /^(bridge|browser|acct|test|probe|smoke)[-_]/i;
const MAX_ITEMS = 200;
// Overflow sinks written by the log trimmer. Real history, but not a
// conversation row — the live log next to them is the row.
const ARCHIVE_SUFFIX = '.archive';

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

// Pull the first user-typed text out of an event-log prefix. Tolerant of the
// three runner shapes (claude stream-json user events, banana/codex echoes).
function extractTitle(raw: string): string | null {
  const lines = raw.split('\n');
  const cap = Math.min(lines.length, 400);
  for (let i = 0; i < cap; i++) {
    const line = lines[i];
    if (!line || (!line.includes('"user"') && !line.includes('_user_echo'))) continue;
    try {
      const parsed = JSON.parse(line);
      const ev = parsed?.ev ?? parsed;
      // codex/banana: { type:'event', event:{ type:'_user_echo', text } }
      if (ev?.event?.type === '_user_echo' && typeof ev.event.text === 'string' && ev.event.text.trim()) {
        const clean = ev.event.text.replace(/\s+/g, ' ').trim().replace(/^[#*>`\-\s]+/, '').replace(/^\/(?=[a-z])/i, '').trim();
        if (clean) {
          const sliced = clean.length <= 90 ? clean : `${clean.slice(0, 90).replace(/\s+\S*$/, '')}…`;
          return sliced;
        }
      }
      // claude: { type:'event', event:{ type:'user', message:{ role:'user', content:[{type:'text',text}] | string } } }
      const msg = ev?.event?.message ?? ev?.message;
      const role = ev?.event?.type === 'user' || ev?.type === 'user' ? 'user' : msg?.role;
      if (role !== 'user') continue;
      const content = msg?.content ?? ev?.text ?? ev?.event?.text;
      let text: string | null = null;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        const t = content.find((c: any) => c?.type === 'text' && typeof c.text === 'string');
        if (t) text = t.text;
      }
      if (text) {
        const clean = text.replace(/\s+/g, ' ').trim().replace(/^[#*>`\-\s]+/, '').replace(/^\/(?=[a-z])/i, '').trim();
        if (clean) {
          // Slice at a word boundary so the sidebar never truncates mid-clause.
          const sliced = clean.length <= 90 ? clean : `${clean.slice(0, 90).replace(/\s+\S*$/, '')}…`;
          return sliced;
        }
      }
    } catch {
      // malformed line — keep scanning
    }
  }
  return null;
}

// Pull the final visible text BLOCK out of a log tail. A conversation-window
// extractor intentionally concatenates progress + final prose; the sidebar must
// instead show the conclusion. This handles Claude full messages and
// Codex/Banana stream-only content blocks.
function extractPreview(rawTail: string): string | undefined {
  let latest = '';
  let afterAutomation = false;
  let automationTexts: string[] = [];
  const openText = new Map<number, string>();

  const accept = (text: unknown) => {
    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed || isRoutinePromptText(trimmed)) return;
    if (afterAutomation) automationTexts.push(trimmed);
    else latest = trimmed;
  };
  const finishAutomation = () => {
    if (!afterAutomation) return;
    const final = automationTexts.at(-1) ?? '';
    if (final && !isQuietRoutineReply(final)) {
      latest = final;
    } else {
      // A quiet sign-off must not bury a real failure/delivery reported one
      // block earlier. This mirrors the live client automation filter.
      const actionable = [...automationTexts].slice(0, -1).reverse().find(hasFailureSignal);
      if (actionable) latest = actionable;
    }
    automationTexts = [];
    afterAutomation = false;
  };

  for (const line of rawTail.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      const outer = parsed?.ev ?? parsed;
      const inner = outer?.event ?? outer;
      const type = inner?.type;
      if (type === '_user_echo') {
        finishAutomation();
        openText.clear();
        accept(inner.text);
        continue;
      }
      if (type === 'peer_message') {
        finishAutomation();
        openText.clear();
        if (isAutomationPeerEvent(parsed)) {
          afterAutomation = true;
          continue;
        }
        accept(inner.text);
        continue;
      }
      if (type === 'assistant') {
        openText.clear();
        for (const text of eventTexts(parsed)) accept(text);
        continue;
      }
      if (type === 'stream_event') {
        const stream = inner.event;
        if (stream?.type === 'message_start') openText.clear();
        else if (stream?.type === 'content_block_start' && stream.content_block?.type === 'text' && typeof stream.index === 'number') {
          openText.set(stream.index, typeof stream.content_block.text === 'string' ? stream.content_block.text : '');
        } else if (stream?.type === 'content_block_delta' && stream.delta?.type === 'text_delta' && typeof stream.index === 'number' && openText.has(stream.index)) {
          openText.set(stream.index, (openText.get(stream.index) ?? '') + String(stream.delta.text ?? ''));
        } else if (stream?.type === 'content_block_stop' && typeof stream.index === 'number') {
          const text = openText.get(stream.index);
          openText.delete(stream.index);
          accept(text);
        }
        continue;
      }
      if (type === 'result' || type === 'turnEnd') finishAutomation();
    } catch { /* partial first/trailing line — keep scanning */ }
  }
  // Do NOT flush an unfinished automation at EOF. A history scan can land
  // mid-turn; keep the prior settled preview until result/turnEnd or a later
  // conversation boundary proves the routine completed.
  const clean = stripMarkdown(latest);
  if (!clean) return undefined;
  const chars = [...clean];
  return chars.length <= 110 ? clean : `${chars.slice(0, 110).join('').replace(/\s+\S*$/, '')}…`;
}

/** Preview text is one plain line — drop markdown syntax so the rail never
 *  shows raw `**bold**` / `*em*` / `` `code` `` / headings. Only paired
 *  delimiters are rewritten (plus stray asterisks from truncated markers);
 *  plain text like C#, snake_case, ~10, and prose pipes survives intact. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')                 // closed fenced code
    .replace(/```[\s\S]*$/g, ' ')                    // unterminated fence: drop to end
    .replace(/`([^`]*)`/g, '$1')                     // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')        // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // links → link text
    .replace(/^#{1,6}\s+/gm, '')                     // headings
    .replace(/^>\s?/gm, '')                          // quotes
    .replace(/^[-*+]\s+/gm, '')                      // bullets
    .replace(/^\d+\.\s+/gm, '')                      // ordered lists
    .replace(/^\s*\|?[\s:|-]*\|[\s:|-]*\|?\s*$/gm, ' ') // table separator rows
    .replace(/^\s*\|/gm, '')                            // leading row pipe
    .replace(/\|\s*$/gm, '')                            // trailing row pipe
    .replace(/\s\|\s/g, ' — ')                          // interior cell pipes
    .replace(/\*\*([^*]+)\*\*/g, '$1')               // bold
    .replace(/\*([^*]+)\*/g, '$1')                   // italic
    .replace(/(^|[^\w_])__([^_]+)__(?=[^\w_]|$)/gm, '$1$2') // bold, non-word boundaried (snake_case safe)
    .replace(/(^|[^\w_])_([^_]+)_(?=[^\w_]|$)/gm, '$1$2')   // italic, non-word boundaried
    .replace(/~~([^~]+)~~/g, '$1')                   // strikethrough
    .replace(/\*+/g, '')                             // stray asterisks (truncated markers)
    .replace(/\s+/g, ' ')
    .trim();
}
// Title/preview derived from a log's head+tail, keyed by (mtime, size). A log
// whose bytes have not changed cannot have gained a title, so a *negative*
// result is cacheable too. Caching only the hits meant every untitled
// automation log re-read 192 KB + 48 KB and re-parsed 400 JSON lines on every
// single request — with 650+ logs on disk that alone pegged a core.
/** Last engine stamped in a log tail — a thread-keyed log's filename no longer
 *  names one, and the sidebar has to reopen the conversation on the brain that
 *  spoke last. Scans backwards; `eng` is a top-level field so this is cheap. */
function extractEngine(rawTail: string): string | null {
  const lines = rawTail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"eng"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.eng === 'string' && parsed.eng) return parsed.eng;
    } catch { /* partial first line of the tail window — keep scanning */ }
  }
  return null;
}

type DerivedEntry = { mtimeMs: number; size: number; title: string | null; preview?: string; engine?: string | null };
const cache = new Map<string, DerivedEntry>();
const CACHE_MAX = 400;

// The sidebar polls every 15s and several callers can land at once; one
// directory walk per few seconds is plenty for a conversation list.
const RESULT_TTL_MS = 15_000;
let resultCache: { at: number; revision: number; items: ChatHistoryItem[] } | null = null;
let inFlight: { revision: number; promise: Promise<ChatHistoryItem[]> } | null = null;

export async function listChatHistory(): Promise<ChatHistoryItem[]> {
  const now = Date.now();
  const revision = eventLogRevision();
  if (resultCache && resultCache.revision === revision && now - resultCache.at < RESULT_TTL_MS) return resultCache.items;
  if (inFlight) {
    if (inFlight.revision === revision) return inFlight.promise;
    // A semantic append landed during the older scan. Let that scan release
    // its file handles, then immediately run/join one for the new revision.
    return inFlight.promise.then(() => listChatHistory());
  }
  const scanRevision = revision;
  const promise = scanChatHistory()
    .then((items) => {
      resultCache = { at: Date.now(), revision: scanRevision, items };
      return items;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { revision: scanRevision, promise };
  return promise;
}

async function scanChatHistory(): Promise<ChatHistoryItem[]> {
  let files: string[] = [];
  try {
    files = await readdir(EVENT_LOG_DIR);
  } catch {
    return [];
  }

  // Build sanitized prefixes for every known (cli, cwd) pair so a filename can
  // be mapped back to its chatId by prefix-strip.
  const prefixes: Array<{ prefix: string; cli: string; cwd: string }> = [];
  try {
    const repos = await discoverRepos();
    for (const repo of repos) {
      for (const cli of CLI_KINDS) {
        prefixes.push({ prefix: `${sanitizeKey(`${cli}|${repo.path}|`)}`, cli, cwd: repo.path });
      }
    }
  } catch {
    // repo discovery failed — history is best-effort
  }
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  // `main` sessions have NO chatId segment (key = cli|cwd) — their sanitized
  // stem is the chatId-prefix WITHOUT the trailing separator.
  const mainKeys = new Map<string, { cli: string; cwd: string }>();
  for (const p of prefixes) {
    const base = p.prefix.replace(/_$/, '');
    if (!mainKeys.has(base)) mainKeys.set(base, { cli: p.cli, cwd: p.cwd });
  }

  // Hide a leftover per-engine bot log only when THIS workspace already has
  // the matching thread_ file. A thread in the hub must not hide a bot-max
  // conversation that still lives under a different cwd.
  const threadKeys = new Set<string>();
  for (const file of files) {
    if (!file.startsWith('thread_') || !file.endsWith('.jsonl') || file.endsWith('.archive.jsonl')) continue;
    const stem = file.slice(0, -'.jsonl'.length);
    const hit = prefixes.find((p) => p.cli === 'thread' && stem.startsWith(p.prefix));
    if (!hit) continue;
    const chatId = stem.slice(hit.prefix.length);
    const bareHome = chatId.replace(/__acct__[a-z0-9-]+$/i, '');
    if (/^bot-[a-z0-9][a-z0-9-]*$/i.test(bareHome)) threadKeys.add(`${hit.cwd}\0${bareHome}`);
  }

  // Stat first, cap the candidate set, THEN pay for content reads — and keep
  // every read async so a big log dir never stalls the chat/WebSocket loop.
  type Candidate = { file: string; chatId: string; cli: string; cwd: string; path: string; mtimeMs: number; size: number };
  const candidates: Candidate[] = [];
  await Promise.all(files.map(async (file) => {
    if (!file.endsWith('.jsonl')) return;
    const stem = file.slice(0, -'.jsonl'.length);
    if (stem.endsWith(ARCHIVE_SUFFIX)) return;
    let hit = prefixes.find((p) => stem.startsWith(p.prefix));
    if (!hit) {
      // main-session form: stem is exactly the cli|cwd key (no chatId part)
      const mainHit = mainKeys.get(stem);
      if (mainHit) {
        try {
          const st = await stat(join(EVENT_LOG_DIR, file));
          candidates.push({ file, chatId: 'main', cli: mainHit.cli, cwd: mainHit.cwd, path: join(EVENT_LOG_DIR, file), mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* skip */ }
      }
      return;
    }
    const chatId = stem.slice(hit.prefix.length);
    if (!chatId || NOISE.test(chatId)) return;
    // Per-engine leftovers of an already-migrated agent thread. The live row
    // is the thread_ file; showing both forks the sidebar the way the logs did.
    const bareHome = chatId.replace(/__acct__[a-z0-9-]+$/i, '');
    if (hit.cli !== 'thread' && /^bot-/.test(bareHome) && threadKeys.has(`${hit.cwd}\0${bareHome}`)) return;
    try {
      const st = await stat(join(EVENT_LOG_DIR, file));
      candidates.push({ file, chatId, cli: hit.cli, cwd: hit.cwd, path: join(EVENT_LOG_DIR, file), mtimeMs: st.mtimeMs, size: st.size });
    } catch { /* vanished between readdir/stat — skip */ }
  }));
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length > MAX_ITEMS) candidates.length = MAX_ITEMS;

  const out: ChatHistoryItem[] = [];
  for (const c of candidates) {
    let title: string | null = null;
    let preview: string | undefined;
    let engine: string | null = null;
    const cached = cache.get(c.file);
    if (cached && cached.mtimeMs === c.mtimeMs && cached.size === c.size) {
      title = cached.title;
      preview = cached.preview;
      engine = cached.engine ?? null;
    } else {
      // Read a prefix for the title and a tail for the preview — a long log's
      // first user message lands early, its last message lands late.
      let readFailed = false;
      try {
        const fh = await open(c.path, 'r');
        try {
          const headSize = Math.min(c.size, 192 * 1024);
          const head = Buffer.alloc(headSize);
          await fh.read(head, 0, headSize, 0);
          title = extractTitle(head.toString('utf8'));
          // 512 KB covers the largest configured model answer in practice and
          // keeps a stream-only final delta + its content_block_start together.
          const tailSize = Math.min(c.size, 512 * 1024);
          const tail = Buffer.alloc(tailSize);
          await fh.read(tail, 0, tailSize, Math.max(0, c.size - tailSize));
          const tailText = tail.toString('utf8');
          preview = extractPreview(tailText);
          engine = extractEngine(tailText);
        } finally {
          await fh.close();
        }
      } catch {
        title = null;
        preview = undefined;
        engine = null;
        readFailed = true;
      }
      // A negative result is only cacheable when the bytes were actually READ
      // and held no title. Caching an EMFILE/EIO failure under (mtime, size)
      // makes it permanent: an idle log's bytes never change, so the
      // conversation would stay mistitled — or, past the 30-minute grace
      // window, invisible — until the entry is evicted or the log is appended
      // to again.
      if (!readFailed) {
        if (cache.size >= CACHE_MAX) {
          const evict = cache.keys().next().value;
          if (evict !== undefined) cache.delete(evict);
        }
        cache.set(c.file, { mtimeMs: c.mtimeMs, size: c.size, title, preview, engine });
      }
    }

    // Automation/scratch logs with no user-authored message expire from the
    // sidebar, but an agent home thread NEVER does. Its first title-bearing
    // user event can age into the archive while the hot log still contains the
    // current preview; dropping the row then leaves the agent on "No work yet."
    const agentHome = /^bot-[a-z0-9][a-z0-9-]*(?:__acct__[a-z0-9-]+)?$/i.test(c.chatId);
    if (!title && !agentHome && Date.now() - c.mtimeMs > 30 * 60 * 1000) continue;

    out.push({
      chatId: c.chatId,
      // A thread-keyed log's filename names no engine. Reopen it on whichever
      // brain spoke last, so clicking the row lands on the live model.
      cli: c.cli === 'thread' ? (engine ?? 'xai') : c.cli,
      repo: c.cwd,
      title: title ?? 'New conversation',
      preview,
      updatedAt: Math.round(c.mtimeMs),
    });
  }

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
