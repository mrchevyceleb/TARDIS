import { closeSync, existsSync, fstatSync, openSync, opendirSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { STATE_DIR } from './config.ts';
import { bareChatId } from './threadKey.ts';
import { sessionDirectory } from './sessionPolicy.ts';
import { accountEnv, accountEnvForAccount, accountForAgent, accountFromChatId } from '../lib/accountResolver.ts';

type CompactEvidence = { input: number; at: number; source: 'native-transcript' };
const cache = new Map<string, { size: number; modified: number; rows: any[] }>();
const evidenceCache = new Map<string, CompactEvidence>();
const fileCache = new Map<string, { view: string; version: string; files: Array<{ path: string; content: string; start: number }> }>();
type RestoredContextBlock = { kind: 'instructions' | 'invoked_skills'; texts: string[];
  files: Array<{ path: string; content: string }>; skills: Array<{ name: string; path: string }> };
const contextCache = new Map<string, RestoredContextBlock[]>();
export function invalidateRestoredFileEvidence(lane: string, sessionId: string | null): void {
  fileCache.delete(`${lane}|${sessionId}`);
  contextCache.delete(`${lane}|${sessionId}`);
}
/** Bounded reads only. Never export transcript content into the report. */
function tailRows(path: string, relevant?: string, attachments = false): any[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const cacheKey = path + '\0' + (relevant || '');
    const stat = fstatSync(fd), previous = cache.get(cacheKey);
    if (!attachments && previous?.size === stat.size && previous.modified === stat.mtimeMs) return previous.rows;
    const start = Math.max(0, stat.size - 16 * 1024 * 1024);
    const buffer = Buffer.alloc(stat.size - start); readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift();
    const rows = lines.flatMap(line => {
      if (relevant && !line.includes(relevant)) return [];
      try {
        const row = JSON.parse(line);
        // Retain only evidence, never whole conversations, thinking or tool
        // bodies in the long-lived report cache.
        return [{ type: row.type, subtype: row.subtype, uuid: row.uuid, parentUuid: row.parentUuid,
          timestamp: row.timestamp, isSidechain: row.isSidechain, isCompactSummary: row.isCompactSummary,
          isMeta: row.isMeta, message: { usage: row.message?.usage },
          ...(row.type === 'event_msg' ? { nativeEvent: row.payload?.type,
            nativeUsage: row.payload?.info?.last_token_usage,
            nativeTotal: row.payload?.info?.total_token_usage?.input_tokens } : {}),
          ...(attachments && row.type === 'attachment' ? { attachment: row.attachment,
            ...(['instructions', 'invoked_skills'].includes(row.attachment?.type) ? { rendered: row.rendered } : {}) } : {}),
          ...(relevant ? { at: row.at, ev: row.ev } : {}) }];
      } catch { return []; }
    });
    if (!attachments) {
      if (cache.size >= 64) cache.delete(cache.keys().next().value!);
      cache.set(cacheKey, { size: stat.size, modified: stat.mtimeMs, rows });
    }
    return rows;
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}

const rolloutCache = new Map<string, { path?: string; checked: number }>();
/** Resolve only the same configured account as the lane's runner. Never
 * search unrelated profiles or infer ownership from transcript contents. */
function codexRollout(lane: string, sessionId: string): string | undefined {
  const id = bareChatId(lane).replace(/^bot-/, '');
  let name = id;
  try {
    const roster = JSON.parse(readFileSync(join(STATE_DIR, 'personas', 'agents.json'), 'utf8'));
    const agents: any[] = Array.isArray(roster) ? roster : Object.values(roster.agents ?? roster);
    name = agents.find((agent: any) => agent.id === id)?.name ?? id;
  } catch { /* Account pins still resolve against the lane id. */ }
  const cwd = sessionDirectory(lane, homedir());
  const pinned = accountFromChatId(lane) ?? accountForAgent(name);
  const env = pinned ? accountEnvForAccount(pinned, cwd) : accountEnv(cwd);
  const directory = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const key = `${directory}|${sessionId}`, previous = rolloutCache.get(key);
  if (previous?.path || previous && Date.now() - previous.checked < 60_000) return previous.path;
  let budget = 20_000;
  const walk = (path: string, depth = 0): string | undefined => {
    let dir;
    try {
      dir = opendirSync(path);
      let entry;
      while (budget > 0 && (entry = dir.readSync())) {
        budget--;
        if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${sessionId}.jsonl`)) return join(path, entry.name);
        if (entry.isDirectory() && depth < 3 && /^(?:\d{4}|\d{2})$/.test(entry.name)) {
          const found = walk(join(path, entry.name), depth + 1); if (found) return found;
        }
      }
    } catch { return; } finally { dir?.closeSync(); }
  };
  // UUIDv7 records encode creation time. Check its date and adjacent local/UTC
  // dates before the bounded legacy walk, so normal reports avoid a full scan.
  let found: string | undefined;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-7/i.test(sessionId)) {
    const created = parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16);
    for (const offset of [0, -86400000, 86400000]) {
      const date = new Date(created + offset).toISOString().slice(0, 10).replaceAll('-', '/');
      found = walk(join(directory, date), 3); if (found) break;
    }
  }
  found ??= walk(directory);
  if (rolloutCache.size >= 128) rolloutCache.delete(rolloutCache.keys().next().value!);
  rolloutCache.set(key, { path: found, checked: Date.now() });
  return found;
}

/** Native Codex's ordered rollout marks installation before a new response's
 * token count. Zero-output prewarms and replayed cumulative counts do not count. */
export function codexCompactEvidence(lane: string, sessionId: string | undefined, compactAt: number): CompactEvidence | undefined {
  if (!sessionId) return;
  const key = `codex|${lane}|${sessionId}|${compactAt}`;
  if (evidenceCache.has(key)) return evidenceCache.get(key);
  try {
    const path = codexRollout(lane, sessionId); if (!path) return;
    const rows = tailRows(path);
    const at = (row: any) => typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp);
    const boundary = rows.findIndex(row => row.type === 'compacted' && Math.abs(at(row) - compactAt) < 5000);
    if (boundary < 0) return;
    let total = 0;
    for (let index = 0; index < boundary; index++) total = Math.max(total, Number(rows[index].nativeTotal) || 0);
    let installed = false;
    for (const row of rows.slice(boundary + 1)) {
      if (row.type === 'compacted') break;
      if (row.nativeEvent === 'context_compacted') installed = true;
      const previous = total; total = Math.max(total, Number(row.nativeTotal) || 0);
      const input = Number(row.nativeUsage?.input_tokens) || 0;
      if (installed && input > 0 && Number(row.nativeUsage?.output_tokens) > 0 && total > previous) {
        const evidence: CompactEvidence = { input, at: at(row), source: 'native-transcript' };
        if (evidenceCache.size >= 128) evidenceCache.delete(evidenceCache.keys().next().value!);
        evidenceCache.set(key, evidence); return evidence;
      }
    }
  } catch { /* Missing, compressed or unprovable history stays unmeasured. */ }
}
/** Old completion-time labels are not evidence of request ordering. A native
 * assistant whose parent chain reaches the compact boundary is evidence. */
export function nativeCompactEvidence(lane: string, sessionId: string | undefined, compactAt: number): CompactEvidence | undefined {
  const evidenceKey = `${lane}|${sessionId}|${compactAt}`;
  if (evidenceCache.has(evidenceKey)) return evidenceCache.get(evidenceKey);
  try {
    const location = JSON.parse(readFileSync(join(STATE_DIR, 'native-claude-locations.json'), 'utf8'))[bareChatId(lane)];
    if (!sessionId || location?.id !== sessionId) return;
    const rows = tailRows(join(location.profile, 'projects', location.project, `${sessionId}.jsonl`));
    const timestamp = (row: any) => typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp);
    const boundary = rows.filter(row => row.type === 'system' && row.subtype === 'compact_boundary'
      && Math.abs(timestamp(row) - compactAt) < 5000).sort((a, b) => Math.abs(timestamp(a) - compactAt) - Math.abs(timestamp(b) - compactAt))[0];
    if (!boundary?.uuid) return;
    const byId = new Map(rows.filter(row => row.uuid).map(row => [row.uuid, row]));
    const descended = (row: any) => {
      const seen = new Set<string>(); let parent = row.parentUuid;
      while (parent && !seen.has(parent) && seen.size < 10000) {
        if (parent === boundary.uuid) return true;
        seen.add(parent); parent = byId.get(parent)?.parentUuid;
      }
      return false;
    };
    for (const row of rows.filter(row => row.type === 'assistant' && !row.isSidechain && timestamp(row) >= timestamp(boundary)).sort((a, b) => timestamp(a) - timestamp(b))) {
      const usage = row.message?.usage;
      const input = Number(usage?.input_tokens || 0) + Number(usage?.cache_read_input_tokens || 0) + Number(usage?.cache_creation_input_tokens || 0);
      if (input > 0 && descended(row)) {
        const evidence: CompactEvidence = { input, at: timestamp(row), source: 'native-transcript' };
        if (evidenceCache.size >= 128) evidenceCache.delete(evidenceCache.keys().next().value!);
        evidenceCache.set(evidenceKey, evidence);
        return evidence;
      }
    }
  } catch { /* Missing or old history stays explicitly unmeasured. */ }
}

/** Only a persisted service-restart marker can explain a legacy interrupted
 * turn. Matching a time shared by other failures alone is never sufficient. */
export function recordedRestartNear(lane: string, at: number): boolean {
  const directory = join(STATE_DIR, 'event-logs');
  if (!existsSync(directory)) return false;
  const suffix = `_${bareChatId(lane)}.jsonl`;
  return readdirSync(directory).filter(name => name.endsWith(suffix)).some(name => tailRows(join(directory, name), '_serviceRestart').some(row =>
    row.ev?.type === 'event' && row.ev.event?._serviceRestart === true && Number.isFinite(row.at) && Math.abs(row.at - at) < 3000));
}

/** Return only the engine's verified reattached text files after its latest
 * native boundary. The full transcript stays unchanged and remains readable. */
export function restoredFileTexts(lane: string, sessionId: string | null, view = ''): Array<{ path: string; content: string; start: number }> {
  const key = `${lane}|${sessionId}`;
  const previous = fileCache.get(key);
  let version = '';
  const retain = (files: Array<{ path: string; content: string; start: number }>) => {
    if (fileCache.size >= 64 && !fileCache.has(key)) fileCache.delete(fileCache.keys().next().value!);
    fileCache.set(key, { view, version, files });
    return files;
  };
  try {
    const location = JSON.parse(readFileSync(join(STATE_DIR, 'native-claude-locations.json'), 'utf8'))[bareChatId(lane)];
    if (!sessionId || location?.id !== sessionId) return retain([]);
    const path = join(location.profile, 'projects', location.project, `${sessionId}.jsonl`);
    const stat = statSync(path); version = `${stat.size}:${stat.mtimeMs}`;
    if (view && previous?.view === view && previous.version === version) return previous.files;
    const rows = tailRows(path, undefined, true);
    const boundary = rows.findLastIndex(row => row.type === 'system' && row.subtype === 'compact_boundary');
    if (boundary < 0) return retain([]);
    const restored = rows.slice(boundary + 1);
    const firstReply = restored.findIndex(row => row.type === 'assistant');
    const opening = firstReply < 0 ? restored : restored.slice(0, firstReply);
    // Native compaction can replay earlier user turns before its restoration
    // batch. The final real user turn before the first reply is the new request;
    // explicit attachments after that turn must remain whole.
    const request = opening.findLastIndex(row => row.type === 'user' && !row.isCompactSummary && !row.isMeta);
    if (request < 0) return retain([]);
    const result = [];
    for (const row of opening.slice(0, request)) {
      const file = row.attachment?.type === 'file' ? row.attachment.content?.file : undefined;
      if (row.attachment?.content?.type === 'text' && typeof file?.content === 'string' && typeof row.attachment.filename === 'string')
        result.push({ path: row.attachment.filename, content: file.content, start: Number(file.startLine) || 1 });
    }
    return retain(result);
  } catch { return retain([]); }
}

/** Native-only instruction and skill renderings. User-authored text never
 * supplies this provenance; complete originals remain in the saved history. */
export function restoredContextBlocks(lane: string, sessionId: string | null): RestoredContextBlock[] {
  const key = `${lane}|${sessionId}`;
  if (contextCache.has(key)) return contextCache.get(key)!;
  try {
    const location = JSON.parse(readFileSync(join(STATE_DIR, 'native-claude-locations.json'), 'utf8'))[bareChatId(lane)];
    if (!sessionId || location?.id !== sessionId) return [];
    const rows = tailRows(join(location.profile, 'projects', location.project, `${sessionId}.jsonl`), undefined, true);
    const boundary = rows.findLastIndex(row => row.type === 'system' && row.subtype === 'compact_boundary');
    if (boundary < 0) return [];
    const opening = rows.slice(boundary + 1);
    const firstReply = opening.findIndex(row => row.type === 'assistant');
    const batch = firstReply < 0 ? opening : opening.slice(0, firstReply);
    const lastPrompt = batch.findIndex(row => row.type === 'last-prompt');
    const result: RestoredContextBlock[] = batch.flatMap((row, index) => {
      const attachment = row.attachment;
      if (!['instructions', 'invoked_skills'].includes(attachment?.type) || row.isSidechain) return [];
      // Freshly invoked skills belong to the new task. Only the engine's
      // compact-restoration batch before its prompt marker can become pointers.
      if (attachment.type === 'invoked_skills' && (lastPrompt < 0 || index >= lastPrompt)) return [];
      const texts = Array.isArray(row.rendered) ? row.rendered.flatMap((block: any) =>
        typeof block.content === 'string' ? [block.content] : block.type === 'text' && typeof block.text === 'string' ? [block.text] : []) : [];
      if (!texts.length) return [];
      return [{ kind: attachment.type, texts,
        files: (attachment.files ?? []).filter((file: any) => typeof file.path === 'string' && typeof file.content === 'string'),
        skills: (attachment.skills ?? []).filter((skill: any) => typeof skill.name === 'string' && typeof skill.path === 'string').map((skill: any) => ({ name: skill.name, path: skill.path })) }];
    });
    if (firstReply >= 0) {
      if (contextCache.size >= 64) contextCache.delete(contextCache.keys().next().value!);
      contextCache.set(key, result);
    }
    return result;
  } catch { return []; }
}
