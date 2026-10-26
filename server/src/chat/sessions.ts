import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { SESSIONS_FILE, STATE_DIR } from './config.ts';
import { bareChatId, isAgentThread } from './threadKey.ts';
import { NATIVE_SESSION_GENERATION } from './sessionPolicy.ts';

// One mapping per native lane → session id plus last proven model/effort.
// Persists across server restarts so chats resume or prewarm with the same brain.

type Cli = 'claude' | 'codex' | 'assistant' | 'banana' | 'codex-personal' | 'banana-local' | 'banana-fireworks' | 'zai' | 'xai' | 'fireworks' | 'openrouter' | 'openrouter2' | 'agy' | 'meta' | 'muse';
type Key = string; // `${cli}|${repoPath}` or `${cli}|${repoPath}|${chatId}`

type StoredSession = {
  cli?: Cli;
  nativeProfile?: string;
  sessionId?: string;
  /** Working directory in which the provider-native session was created.
   * Muse binds session ids to a workspace and refuses cross-workspace resume. */
  workspace?: string;
  generation?: number;
  updatedAt: number;
  /** Last model/effort actually applied to this native process. Kept even when
   * rotation clears sessionId so boot prewarm uses the same brain settings. */
  model?: string;
  effort?: string;
};
type Stored = Record<Key, StoredSession>;

export type SessionSelection = { model?: string; effort?: string };

let cache: Stored | null = null;
let loadPromise: Promise<Stored> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

const key = (cli: Cli, repoPath: string, chatId = 'main'): Key => {
  const normalized = isAgentThread(chatId) ? bareChatId(chatId) : chatId || 'main';
  return normalized === 'main' ? `${cli}|${repoPath}` : `${cli}|${repoPath}|${normalized}`;
};
const nativeKey = (cli: Cli, repoPath: string, chatId: string): Key => {
  if (!isAgentThread(chatId)) return key(cli, repoPath, chatId);
  const engine = ['claude', 'assistant', 'zai', 'xai', 'fireworks', 'openrouter', 'openrouter2', 'meta'].includes(cli) ? 'claude-code'
    : cli === 'codex-personal' ? 'codex' : cli;
  return `${engine}|${bareChatId(chatId)}`;
};

async function load(): Promise<Stored> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await readFile(SESSIONS_FILE, 'utf8');
      cache = JSON.parse(raw) as Stored;
      if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new Error('Invalid native session store');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      cache = {};
    }
    return cache;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function flush() {
  if (!cache) return;
  await mkdir(dirname(SESSIONS_FILE), { recursive: true });
  const temporary = `${SESSIONS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(cache, null, 2), { mode: 0o600, flush: true });
  await rename(temporary, SESSIONS_FILE);
}

export async function getSessionId(cli: Cli, repoPath: string, chatId = 'main'): Promise<string | undefined> {
  const all = await load();
  const nativeStorageKey = nativeKey(cli, repoPath, chatId);
  const scopedStorageKey = key(cli, repoPath, chatId);
  const nativeRecord = all[nativeStorageKey];
  const scopedRecord = all[scopedStorageKey];
  const record = nativeRecord ?? scopedRecord;
  if (isAgentThread(chatId) && record?.generation !== NATIVE_SESSION_GENERATION) return undefined;
  // Muse owns the native transcript and records its creation workspace. It
  // rejects the same UUID from any other cwd. A legacy repo-scoped key already
  // proves its workspace; only cwd-free agent records are unproven. A genuine
  // mismatch starts a new native window seeded from the durable thread.
  if (cli === 'muse' && record?.sessionId) {
    const recordedWorkspace = typeof record.workspace === 'string' && record.workspace
      ? record.workspace : null;
    const legacyScoped = !recordedWorkspace
      && (nativeStorageKey === scopedStorageKey || (!nativeRecord && record === scopedRecord));
    const sameWorkspace = recordedWorkspace !== null && resolve(recordedWorkspace) === resolve(repoPath);
    if (!legacyScoped && !sameWorkspace) {
      console.warn(`[native-session] Muse session ${record.sessionId.slice(0, 8)} belongs to another or unknown workspace; seeding this lane instead of resuming it`);
      return undefined;
    }
  }
  return record?.sessionId;
}

export async function setSessionId(cli: Cli, repoPath: string, sessionId: string, chatId = 'main', nativeProfile?: string): Promise<void> {
  const all = await load();
  const storageKey = nativeKey(cli, repoPath, chatId);
  const existing = all[storageKey];
  if (sessionId) {
    all[storageKey] = { ...existing, cli, sessionId, workspace: resolve(repoPath), ...(nativeProfile ? { nativeProfile } : {}), generation: NATIVE_SESSION_GENERATION, updatedAt: Date.now() };
  } else if (existing?.model || existing?.effort) {
    const { sessionId: _discard, ...selection } = existing;
    all[storageKey] = { ...selection, updatedAt: Date.now() };
  } else {
    delete all[storageKey];
  }
  // Coalesce concurrent writes.
  writeQueue = writeQueue.then(flush, flush);
  await writeQueue;
}

export async function getSessionSelection(
  cli: Cli,
  repoPath: string,
  chatId = 'main',
): Promise<SessionSelection | null> {
  const all = await load();
  const storageKey = nativeKey(cli, repoPath, chatId);
  const stored = all[storageKey] ?? Object.entries(all)
    .filter(([candidate]) => candidate.startsWith(`${storageKey}__acct__`))
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)[0]?.[1];
  // Account-suffixed chat IDs were removed from public defaults. Preserve the
  // most recent model/effort during that one-time key migration without ever
  // reusing the old profile-specific native session ID.
  if (!stored) return null;
  const model = typeof stored.model === 'string' && stored.model ? stored.model : undefined;
  const effort = typeof stored.effort === 'string' && stored.effort ? stored.effort : undefined;
  return model || effort ? { model, effort } : null;
}

export async function setSessionSelection(
  cli: Cli,
  repoPath: string,
  selection: SessionSelection,
  chatId = 'main',
): Promise<void> {
  const all = await load();
  const storageKey = nativeKey(cli, repoPath, chatId);
  const existing = all[storageKey];
  const model = typeof selection.model === 'string' && selection.model ? selection.model : undefined;
  const effort = typeof selection.effort === 'string' && selection.effort ? selection.effort : undefined;
  all[storageKey] = { ...existing, cli, model, effort, updatedAt: Date.now() };
  writeQueue = writeQueue.then(flush, flush);
  await writeQueue;
}

/** Remove provider-native resume ids for a Fresh Thread reset. Named teammate
 * logs are engine-neutral, so every provider lane is cleared; ordinary Studio
 * threads retain their historical selected-engine-only reset semantics. Keep
 * model/effort metadata only as harmless diagnostics/cold migration data. */
export async function clearThreadSessionIds(repoPath: string, chatId = 'main', cli?: Cli): Promise<void> {
  const all = await load();
  const normalized = chatId || 'main';
  const threadSuffix = normalized === 'main' ? `|${repoPath}` : `|${repoPath}|${normalized}`;
  const agentSuffix = normalized.startsWith('bot-') ? `|${normalized}` : null;
  let changed = false;
  for (const [storageKey, existing] of Object.entries(all)) {
    const matches = storageKey.endsWith(threadSuffix)
      || (normalized !== 'main' && storageKey.includes(`${threadSuffix}__acct__`))
      || Boolean(agentSuffix && (
        storageKey.endsWith(agentSuffix)
        || storageKey.endsWith(`${agentSuffix}__bg`)
        || storageKey.includes(`${agentSuffix}__acct__`)
      ));
    const providerMatches = agentSuffix !== null || !cli || storageKey.startsWith(`${cli}|`);
    if (!matches || !providerMatches || !existing.sessionId) continue;
    const { sessionId: _discard, ...selection } = existing;
    all[storageKey] = { ...selection, updatedAt: Date.now() };
    changed = true;
  }
  if (!changed) return;
  writeQueue = writeQueue.then(flush, flush);
  await writeQueue;
}

export async function ensureStateDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
}

/** Last accepted engine/provider, independent of the working directory. */
export async function nativeSessionProvenance(cli: Cli, repoPath: string, chatId: string): Promise<StoredSession | undefined> {
  const all = await load();
  const record = all[nativeKey(cli, repoPath, chatId)];
  if (!record || record.cli) return record;
  // Older records may have no explicit CLI. Recover only from a key that
  // proves the exact same native ID, never from a default subscription.
  const variants = new Set<Cli>();
  const known = new Set<Cli>(['claude', 'assistant', 'codex', 'codex-personal', 'banana', 'banana-local', 'banana-fireworks', 'zai', 'xai', 'fireworks', 'openrouter', 'openrouter2', 'agy', 'meta', 'muse']);
  for (const [storageKey, candidate] of Object.entries(all)) {
    if (!record.sessionId || candidate.sessionId !== record.sessionId) continue;
    // A CLI name alone cannot reproduce a directory-specific subscription.
    // Leave this legacy account selection held for repair instead of billing
    // whichever account happens to be the current directory default.
    if (storageKey.includes('__acct__')) return record;
    const variant = candidate.cli ?? storageKey.split('|')[0] as Cli;
    if (known.has(variant)) variants.add(variant);
  }
  return variants.size === 1 ? { ...record, cli: [...variants][0] } : record;
}
