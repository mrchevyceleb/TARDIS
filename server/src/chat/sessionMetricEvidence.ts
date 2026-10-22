import { closeSync, createReadStream, existsSync, fstatSync, openSync, opendirSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { STATE_DIR } from './config.ts';
import { bareChatId } from './threadKey.ts';
import { sessionDirectory } from './sessionPolicy.ts';
import { accountEnv, accountEnvForAccount, accountForAgent, accountFromChatId } from '../lib/accountResolver.ts';
import { JsonStore } from '../lib/jsonStore.ts';

type CompactEvidence = { input: number; at: number; source: 'native-transcript' };
const cache = new Map<string, { size: number; modified: number; rows: any[] }>();
const evidenceCache = new Map<string, CompactEvidence>();
type SavedEvidence = CompactEvidence & { id: string; key: string };
const evidenceStore = new JsonStore<SavedEvidence>('compact-evidence.json', [], join(STATE_DIR, 'native-session-metrics'));
const savedEvidence = new Map<string, CompactEvidence>();
const evidenceLoaded = evidenceStore.list().then(rows => {
  for (const row of rows) if (typeof row.key === 'string' && row.input > 0 && Number.isFinite(row.at) && row.source === 'native-transcript') savedEvidence.set(row.key, row);
}).catch(() => { console.warn('[native-session] saved compact evidence could not be read'); });
const toSave = new Map<string, SavedEvidence>();
let saving: Promise<void> | undefined;
function keepEvidence(key: string, evidence: CompactEvidence): CompactEvidence {
  if (savedEvidence.has(key)) return savedEvidence.get(key)!;
  savedEvidence.set(key, evidence);
  toSave.set(key, { ...evidence, key, id: createHash('sha256').update(key).digest('hex') });
  saving ??= evidenceLoaded.then(async () => {
    while (toSave.size) {
      const batch = [...toSave.values()]; toSave.clear();
      await evidenceStore.modify(rows => {
        const merged = new Map(rows.map(row => [row.key, row]));
        for (const row of batch) merged.set(row.key, row);
        return [...merged.values()].sort((a, b) => a.at - b.at).slice(-50_000);
      });
    }
  }).catch(() => { console.warn('[native-session] compact evidence could not be saved'); }).finally(() => { saving = undefined; });
  return evidence;
}
type IndexJob = { path: string; lane: string; sessionId: string; codex: boolean; targets: Set<number> };
const indexes = new Map<string, IndexJob>();
const indexedVersions = new Map<string, string>();
const indexedBoundaries = new Set<string>();
let indexing = false;
const evidenceKey = (lane: string, id: string, at: number, codex: boolean) => `${codex ? 'codex|' : ''}${lane}|${id}|${at}`;
/** Old boundaries can leave the tail of a growing transcript. Read those files
 * incrementally in the background, retaining only numeric evidence and UUID
 * ancestry. Report requests and active conversations never wait on a replay. */
function queueEvidenceIndex(path: string, lane: string, sessionId: string, compactAt: number, codex: boolean): void {
  const key = `${codex}|${lane}|${sessionId}`;
  const active = indexes.get(key);
  if (active) { active.targets.add(compactAt); return; }
  let version: string;
  try { const s = statSync(path); version = `${s.size}:${s.mtimeMs}`; } catch { return; }
  if (indexedVersions.get(key) === version) return;
  indexes.set(key, { path, lane, sessionId, codex, targets: new Set([compactAt]) });
  if (indexing) return;
  indexing = true;
  setImmediate(async () => {
    try {
      for (const [jobKey, job] of indexes) {
        let versionBefore = '';
        try {
          await evidenceLoaded;
          const s = statSync(job.path); versionBefore = `${s.size}:${s.mtimeMs}`;
          const roots = new Map<string, number>();
          const parents = new Map<string, string>();
          const candidates: Array<{ parent: string; input: number; at: number }> = [];
          let current = 0, installed = false, total = 0, count = 0;
          const found = new Set<number>();
          const stream = createReadStream(job.path, { highWaterMark: 64 * 1024, end: s.size - 1 });
          const reader = createInterface({ input: stream, crlfDelay: Infinity });
          let readError: Error | undefined;
          stream.on('error', error => { readError = error; reader.close(); });
          for await (const line of reader) {
            if (++count % 500 === 0) await new Promise<void>(resolve => setImmediate(resolve));
            // Oversized content rows cannot become usage evidence.
            if (line.length > 16 * 1024 * 1024) continue;
            let row: any; try { row = JSON.parse(line); } catch { continue; }
            const at = typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp);
            const boundary = job.codex ? row.type === 'compacted' : row.type === 'system' && row.subtype === 'compact_boundary';
            if (boundary) {
              current = [...job.targets].filter(target => Math.abs(target - at) < 5000).sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0] ?? 0;
              installed = false;
              if (!job.codex && row.uuid && current) roots.set(row.uuid, current);
            }
            let target = 0, input = 0;
            if (job.codex) {
              if (row.payload?.type === 'context_compacted') installed = true;
              const previous = total; total = Math.max(total, Number(row.payload?.info?.total_token_usage?.input_tokens) || 0);
              const usage = row.payload?.info?.last_token_usage;
              if (current && installed && Number(usage?.output_tokens) > 0 && total > previous) { target = current; input = Number(usage?.input_tokens) || 0; }
            } else {
              if (row.uuid && row.parentUuid) parents.set(row.uuid, row.parentUuid);
              const root = roots.get(row.parentUuid);
              if (row.uuid && root) roots.set(row.uuid, root);
              if (row.type === 'assistant' && !row.isSidechain && row.parentUuid) {
                const usage = row.message?.usage;
                const input = Number(usage?.input_tokens || 0) + Number(usage?.cache_read_input_tokens || 0) + Number(usage?.cache_creation_input_tokens || 0);
                if (input > 0) candidates.push({ parent: row.parentUuid, input, at });
              }
              if (row.type === 'assistant' && !row.isSidechain && root && at >= root) {
                const usage = row.message?.usage;
                target = root; input = Number(usage?.input_tokens || 0) + Number(usage?.cache_read_input_tokens || 0) + Number(usage?.cache_creation_input_tokens || 0);
              }
              if (roots.size > 100_000) roots.delete(roots.keys().next().value!);
              if (parents.size > 100_000) parents.delete(parents.keys().next().value!);
            }
            if (target && input > 0 && !found.has(target)) {
              found.add(target);
              keepEvidence(evidenceKey(job.lane, job.sessionId, target, job.codex), { input, at, source: 'native-transcript' });
            }
          }
          if (readError) throw readError;
          // A compacted preserved segment can precede the parent it names in
          // file order. Resolve that ancestry after the bounded metadata pass.
          for (const candidate of candidates.sort((a, b) => a.at - b.at)) {
            const seen = new Set<string>(); let parent: string | undefined = candidate.parent;
            while (parent && !roots.has(parent) && !seen.has(parent) && seen.size < 10_000) { seen.add(parent); parent = parents.get(parent); }
            const target = parent ? roots.get(parent) : undefined;
            if (target && candidate.at >= target && !found.has(target)) {
              found.add(target);
              keepEvidence(evidenceKey(job.lane, job.sessionId, target, false), { input: candidate.input, at: candidate.at, source: 'native-transcript' });
            }
          }
          indexedVersions.set(jobKey, versionBefore);
          if (indexedVersions.size > 128) indexedVersions.delete(indexedVersions.keys().next().value!);
          for (const at of job.targets) indexedBoundaries.add(evidenceKey(job.lane, job.sessionId, at, job.codex));
          while (indexedBoundaries.size > 50_000) indexedBoundaries.delete(indexedBoundaries.values().next().value!);
          await saving;
        } catch { /* Unavailable history remains explicitly unavailable. */ }
        finally { indexes.delete(jobKey); }
      }
    } finally { indexing = false; }
  });
}
export function compactEvidencePending(lane: string, sessionId: string | undefined, codex: boolean, at: number): boolean {
  return !!sessionId && !indexedBoundaries.has(evidenceKey(lane, sessionId, at, codex)) && indexes.has(`${codex}|${lane}|${sessionId}`);
}
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
  if (savedEvidence.has(key)) return savedEvidence.get(key);
  if (evidenceCache.has(key)) return evidenceCache.get(key);
  try {
    const path = codexRollout(lane, sessionId); if (!path) return;
    queueEvidenceIndex(path, lane, sessionId, compactAt, true);
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
        evidenceCache.set(key, evidence); return keepEvidence(key, evidence);
      }
    }
  } catch { /* Missing, compressed or unprovable history stays unmeasured. */ }
}
/** Old completion-time labels are not evidence of request ordering. A native
 * assistant whose parent chain reaches the compact boundary is evidence. */
export function nativeCompactEvidence(lane: string, sessionId: string | undefined, compactAt: number): CompactEvidence | undefined {
  const evidenceKey = `${lane}|${sessionId}|${compactAt}`;
  if (savedEvidence.has(evidenceKey)) return savedEvidence.get(evidenceKey);
  if (evidenceCache.has(evidenceKey)) return evidenceCache.get(evidenceKey);
  try {
    const location = JSON.parse(readFileSync(join(STATE_DIR, 'native-claude-locations.json'), 'utf8'))[bareChatId(lane)];
    if (!sessionId || location?.id !== sessionId) return;
    const path = join(location.profile, 'projects', location.project, `${sessionId}.jsonl`);
    queueEvidenceIndex(path, lane, sessionId, compactAt, false);
    const rows = tailRows(path);
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
        return keepEvidence(evidenceKey, evidence);
      }
    }
  } catch { /* Missing or old history stays explicitly unmeasured. */ }
}

type RestartEvidence = { id: string; lane: string; at: number };
const restartStore = new JsonStore<RestartEvidence>('restart-evidence.json', [], join(STATE_DIR, 'native-session-metrics'));
const restartTimes = new Map<string, Set<number>>();
const restartLoaded = restartStore.list().then(rows => {
  for (const row of rows) if (typeof row.lane === 'string' && Number.isFinite(row.at)) {
    const times = restartTimes.get(row.lane) ?? new Set<number>(); times.add(row.at); restartTimes.set(row.lane, times);
  }
}).catch(() => { console.warn('[native-session] saved restart evidence could not be read'); });
const restartScans = new Map<string, Promise<void>>();
const restartVersions = new Map<string, string>();
const restartTargets = new Map<string, Set<number>>();
const restartChecked = new Set<string>();
let restartQueue = Promise.resolve();
function indexRestartMarkers(path: string, lane: string, at: number): boolean {
  let version: string;
  try { const s = statSync(path); version = `${s.size}:${s.mtimeMs}`; } catch { return false; }
  if (restartVersions.get(path) === version) return false;
  const targetKey = `${path}|${at}`;
  const targets = restartTargets.get(path) ?? new Set<number>();
  targets.add(at); restartTargets.set(path, targets);
  if (restartScans.has(path)) return !restartChecked.has(targetKey);
  const scan = restartQueue.then(async () => {
    await restartLoaded;
    const stat = statSync(path);
    const times = restartTimes.get(lane) ?? new Set<number>();
    const stream = createReadStream(path, { highWaterMark: 64 * 1024, end: stat.size - 1 });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    let readError: Error | undefined;
    stream.on('error', error => { readError = error; reader.close(); });
    let count = 0;
    for await (const line of reader) {
      if (++count % 500 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      if (!line.includes('_serviceRestart')) continue;
      let row: any; try { row = JSON.parse(line); } catch { continue; }
      if (row.ev?.type === 'event' && row.ev.event?._serviceRestart === true && Number.isFinite(row.at)) times.add(row.at);
    }
    if (readError) throw readError;
    restartTimes.set(lane, times);
    await restartStore.modify(rows => {
      const merged = new Map(rows.map(row => [row.id, row]));
      for (const at of times) {
        const id = createHash('sha256').update(`${lane}|${at}`).digest('hex');
        merged.set(id, { id, lane, at });
      }
      return [...merged.values()].sort((a, b) => a.at - b.at).slice(-50_000);
    });
    restartVersions.set(path, `${stat.size}:${stat.mtimeMs}`);
  }).catch(() => { /* Missing restart evidence cannot certify an interruption. */ }).finally(() => {
    for (const target of targets) restartChecked.add(`${path}|${target}`);
    while (restartChecked.size > 50_000) restartChecked.delete(restartChecked.values().next().value!);
    restartTargets.delete(path); restartScans.delete(path);
  });
  restartScans.set(path, scan);
  restartQueue = scan;
  return !restartChecked.has(targetKey);
}
/** Only a persisted service-restart marker can explain a legacy interrupted
 * turn. Undefined means its saved markers are still being read. */
export function recordedRestartNear(lane: string, at: number): boolean | undefined {
  lane = bareChatId(lane);
  if ([...(restartTimes.get(lane) ?? [])].some(time => Math.abs(time - at) < 3000)) return true;
  const directory = join(STATE_DIR, 'event-logs');
  if (!existsSync(directory)) return false;
  const paths = readdirSync(directory).filter(name => name.endsWith(`_${lane}.jsonl`)).map(name => join(directory, name));
  let pending = false;
  for (const path of paths) {
    if (tailRows(path, '_serviceRestart').some(row => row.ev?.type === 'event' && row.ev.event?._serviceRestart === true && Number.isFinite(row.at) && Math.abs(row.at - at) < 3000)) return true;
    pending = indexRestartMarkers(path, lane, at) || pending;
  }
  return pending ? undefined : false;
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
