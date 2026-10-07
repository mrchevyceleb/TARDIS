// Thread identity — the key a conversation is remembered under.
//
// A conversation's identity is the AGENT plus the workspace, never the engine.
// Engines are interchangeable brains; the thread outlives them. So an agent
// home thread's durable event log, its rolling compact, and the client's cache
// are all keyed on `thread|<cwd>|bot-<id>`, while the live child process and
// its NATIVE resume id stay keyed per engine — a claude session id means
// nothing to grok, and handing one to the wrong engine is exactly what
// produced the `No conversation found with session ID: <uuid>` failures.
//
// Non-agent lanes (studio-*, grok-*, probes, main) keep the legacy
// `<cli>|<cwd>|<chatId>` key, so the several hundred existing logs on disk stay
// exactly where they are and nothing has to be migrated to keep working.

const ACCOUNT_SUFFIX = /__acct__[a-z0-9-]+$/i;
const BACKGROUND_SUFFIX = '__bg';
const AGENT_HOME = /^bot-[a-z0-9][a-z0-9-]*$/i;

/** chatId without its engine-account pin or background-lane suffix
 *  (`bot-kip__acct__kim` and `bot-kip__bg` both → `bot-kip`). */
export function bareChatId(chatId: string): string {
  const id = (chatId || 'main').replace(ACCOUNT_SUFFIX, '');
  return id.endsWith(BACKGROUND_SUFFIX) ? id.slice(0, -BACKGROUND_SUFFIX.length) : id;
}

// Background lane: an agent's second live session. Teammate handoffs,
// routines, job results and system nudges run there so the human's own lane
// stays free. Same persona, brain and durable thread log as the home thread;
// its own engine process and native resume id. Not an account pin.

/** The background-lane chatId for an agent home (`bot-max` → `bot-max__bg`). */
export function backgroundChatId(home: string): string {
  return `${bareChatId(home)}${BACKGROUND_SUFFIX}`;
}

/** True for an agent's background-lane chatId. */
export function isBackgroundChatId(chatId: string | null | undefined): boolean {
  const id = (chatId || '').replace(ACCOUNT_SUFFIX, '');
  return id.endsWith(BACKGROUND_SUFFIX) && AGENT_HOME.test(id.slice(0, -BACKGROUND_SUFFIX.length));
}

/** Kill switch, read on every call. `RIVENDELL_BACKGROUND_LANE=false` routes
 *  everything back to the home lane exactly as before. Default on. */
export function backgroundLaneEnabled(): boolean {
  const raw = (process.env.RIVENDELL_BACKGROUND_LANE ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(raw);
}

/** The account pinned into a chatId, if any. */
export function accountOfChatId(chatId: string): string | null {
  const m = ACCOUNT_SUFFIX.exec(chatId || '');
  return m ? m[0].slice('__acct__'.length) : null;
}

/** True when this chatId is an agent's home thread — the threads that have to
 *  survive a model change. The `bot-<id>` shape is the convention every agent
 *  record is created with (`home: bot-<id>`), so this needs no state read and
 *  still covers homes whose agent record was deleted. */
export function isAgentThread(chatId: string): boolean {
  return AGENT_HOME.test(bareChatId(chatId));
}

/** Engine-free durable key for an agent thread. */
export function threadLogKey(cwd: string, chatId: string): string {
  return `thread|${cwd}|${bareChatId(chatId)}`;
}

/** Legacy per-engine key — still the identity of every non-agent lane, and
 *  always the identity of a live child process and its native resume id. */
export function laneKey(cli: string, cwd: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  return normalized === 'main' ? `${cli}|${cwd}` : `${cli}|${cwd}|${normalized}`;
}

/** The key the durable log and the rolling compact live under. */
export function logKeyFor(cli: string, cwd: string, chatId = 'main'): string {
  return isAgentThread(chatId) ? threadLogKey(cwd, chatId) : laneKey(cli, cwd, chatId);
}

export function isThreadLogKey(key: string): boolean {
  return key.startsWith('thread|');
}

/** Which engine wrote the newest provenance-stamped event. Null for a log that
 *  predates stamping, or an empty one — both read as "nothing to announce". */
export function lastEngineOf(events: ReadonlyArray<unknown>): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const eng = (events[i] as { eng?: unknown } | null | undefined)?.eng;
    if (typeof eng === 'string' && eng) return eng;
  }
  return null;
}
