import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SESSIONS_FILE, STATE_DIR } from './config.ts';

// One mapping per native lane → session id plus last proven model/effort.
// Persists across server restarts so chats resume or prewarm with the same brain.

type Cli = 'claude' | 'codex' | 'assistant' | 'banana' | 'codex-personal' | 'banana-local' | 'banana-fireworks' | 'zai' | 'xai' | 'fireworks';
type Key = string; // `${cli}|${repoPath}` or `${cli}|${repoPath}|${chatId}`

type StoredSession = {
  sessionId?: string;
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
  const normalized = chatId || 'main';
  return normalized === 'main' ? `${cli}|${repoPath}` : `${cli}|${repoPath}|${normalized}`;
};

async function load(): Promise<Stored> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await readFile(SESSIONS_FILE, 'utf8');
      cache = JSON.parse(raw) as Stored;
    } catch {
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
  await writeFile(SESSIONS_FILE, JSON.stringify(cache, null, 2));
}

export async function getSessionId(cli: Cli, repoPath: string, chatId = 'main'): Promise<string | undefined> {
  const all = await load();
  return all[key(cli, repoPath, chatId)]?.sessionId;
}

export async function setSessionId(cli: Cli, repoPath: string, sessionId: string, chatId = 'main'): Promise<void> {
  const all = await load();
  const storageKey = key(cli, repoPath, chatId);
  const existing = all[storageKey];
  if (sessionId) {
    all[storageKey] = { ...existing, sessionId, updatedAt: Date.now() };
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
  const storageKey = key(cli, repoPath, chatId);
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
  const storageKey = key(cli, repoPath, chatId);
  const existing = all[storageKey];
  const model = typeof selection.model === 'string' && selection.model ? selection.model : undefined;
  const effort = typeof selection.effort === 'string' && selection.effort ? selection.effort : undefined;
  all[storageKey] = { ...existing, model, effort, updatedAt: Date.now() };
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
