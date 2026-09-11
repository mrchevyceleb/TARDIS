import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { ASSISTANT_HUB_PATH } from './config.ts';
import { localMcpServers } from './local-mcp.ts';
import { computerGuidance } from '../devices/context.ts';
import { redactComputerImages } from '../devices/transcript.ts';
import { getSessionId, setSessionId, setSessionSelection } from './sessions.ts';
import { CodexSession, getOrCreateCodexSession, activeCodexSessions, publishCodexExternalEvent } from './codex-runner.ts';
import { BananaSession, getOrCreateBananaSession, activeBananaSessions, publishBananaExternalEvent } from './banana-runner.ts';
import { appendEventLog, appendEventLogSync, clearEventLog, compactEventLog, flushEventLog, isPlumbingEvent, latestEventLogSeq, loadEventLogForCompactionSync, loadEventLogSync, removeEventLogEvents, reserveEventLogSeq } from './event-log-store.ts';
import { maybeAutoCompact, noteUserTurn, peekEnginePrimerThroughSeq, clearThreadMemory, clearRotation, isRotationOwed, compactedThroughSeq } from './compaction.ts';
import { shouldSkipEngineResume } from './threadWindow.ts';
import { isAgentThread, isThreadLogKey, lastEngineOf, logKeyFor } from './threadKey.ts';
import { personaPromptFor } from './personaPrompts.ts';
import { agentForChatId, noteAgentLane } from './agents.ts';
import { assertMemoryAvailableForSpawn, MemoryPressureSpawnError } from './memory.ts';
import { crashTombstoneEvent, crashTombstoneText, restartMarkerEvent } from './crashTombstone.ts';
import { accountEnv, accountEnvForAccount, accountFromChatId } from '../lib/accountResolver.ts';
import { engineDefault } from '../lib/engineConfig.ts';
import { adaptImagesForTextModel } from './vision-adapter.ts';
import { ensureXaiProxy, xaiProxyBaseUrl, xaiProxySecret } from './xai-proxy.ts';
import { getXaiOauthToken, getXaiOauthTokenSync, hasXaiOauthToken } from '../routes/xai-oauth.ts';
import { isRobotVoiceChatId, isVoiceChatId, ROBOT_VOICE_STYLE_ADDENDUM, THREAD_VOICE_STYLE_ADDENDUM, VOICE_STYLE_ADDENDUM } from './voicePrompt.ts';
import { isThreadWatched } from './threadWatch.ts';
import { HUB_WRITE_LOCK_PROMPT } from '../lib/hubPaths.ts';
import { saveChatAttachments } from '../routes/chatAttachments.ts';
import { conversationGuidanceForTurn } from './conversation-guidance.ts';
import { TRANSCRIPT_GUIDANCE } from './transcriptGuidance.ts';
import { isSyntheticApiErrorEvent, isSyntheticApiErrorText, terminalExecutionError, terminalProviderError, type TerminalProviderError } from './providerErrors.ts';

export { MemoryPressureSpawnError } from './memory.ts';

function terminateProcessTree(child: ChildProcessByStdio<Writable, Readable, Readable>, signal: NodeJS.Signals): void {
  const descendants = child.pid ? collectDescendantPids(child.pid) : [];
  try { child.kill(signal); } catch {}
  if (child.pid) {
    try { process.kill(-child.pid, signal); } catch {}
  }
  for (const pid of descendants.reverse()) {
    try { process.kill(pid, signal); } catch {}
  }
}

function collectDescendantPids(pid: number): number[] {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 1000 });
    const children = out
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    return children.flatMap((childPid) => [childPid, ...collectDescendantPids(childPid)]);
  } catch {
    return [];
  }
}

// One persistent `claude` process per (cli, repoPath) pair, fed JSON over
// stdin and reading JSONL events from stdout. This kills the per-turn startup
// tax of the previous spawn-per-message model and matches the architecture
// proven out in Banana IDE.
//
// Lessons borrowed from Banana IDE:
// - Persistent stdin/stdout stream-json so the model warms once.
// - Detect "silent resume failure": if init reports a session_id that doesn't
//   match the one we asked for, the CLI started a fresh session. Treat as a
//   resume failure, drop the stale id, and let the conversation continue from
//   the new one (don't spawn again — the user's message hasn't been sent yet).

// TARDIS binds each companion to a CLI/provider via the `cli` value:
//   assistant      = TARDIS (the ship's own mind) on Claude Code
//   codex          = Codex
//   claude         = Banana through Claude Code
//   codex-personal = Banana through Codex (legacy, no longer surfaced)
//   banana         = Banana → OpenRouter (direct, real OPENROUTER_API_KEY)
//   banana-fireworks = Banana → Fireworks (direct, FIREWORKS_API_KEY)
//   banana-local   = Banana → local OpenAI-compatible model server
//   zai            = Z.ai coding plan (claude CLI → GLM over Anthropic endpoint)
//   xai            = xAI coding plan (claude CLI → Grok 4.6 over Anthropic endpoint)
// Claude Code and Codex account selection comes from the per-directory
// account map, matching terminals, AutoSam, and samwise-2.
export type CliKind =
  | 'claude'
  | 'codex'
  | 'assistant'
  | 'banana'
  | 'codex-personal'
  | 'banana-local'
  | 'banana-fireworks'
  | 'zai'
  | 'xai';

export type StreamEvent = unknown;

type Listener = (msg: SessionEvent) => void;

export type SessionEvent =
  | { type: 'event'; event: any }       // raw stream-json event from claude
  | { type: 'turnStart' }
  | { type: 'turnEnd'; sessionId?: string }
  | { type: 'compacted'; chatId: string; words: number; turns: number; count: number; savedToRag?: boolean; at: number }
  | { type: 'closed'; code: number | null; signal: NodeJS.Signals | null; intentional?: boolean }
  | { type: 'error'; message: string; code?: string; retryable?: boolean; fatal?: boolean };

// Match `/<skill-name> <body>` at the very start of a user message. Skill names
// are kebab-case (lowercase letters, digits, hyphen). The body is anything that
// follows the first whitespace run after the skill name.
const SLASH_COMMAND_HEAD = /^\/([a-z][a-z0-9-]*)([ \t]+)([^\n][\s\S]*)$/;

/**
 * If `text` looks like `/<skill> <body>`, rewrite it to a form where the body
 * is wrapped in `<command-args>` so the model can't drop it when invoking the
 * Skill tool. Returns the original string when it doesn't match.
 *
 * Why this exists: in `--input-format=stream-json` mode claude doesn't
 * pre-expand slash commands, so `/sam Send Mario about X` arrives at the model
 * as a literal user message. The model occasionally invokes
 * `Skill({ skill: "sam" })` with no `args`, and the skill replies "you only
 * sent the slash command, no prompt." Wrapping the body in a structural tag
 * eliminates the ambiguity.
 */
export function wrapSlashArgs(text: string): string {
  if (!text) return text;
  const match = SLASH_COMMAND_HEAD.exec(text);
  if (!match) return text;
  const [, skill, , bodyRaw] = match;
  const body = bodyRaw.trim();
  if (!body) return text;
  return `/${skill}\n<command-args>\n${body}\n</command-args>`;
}

// Model + reasoning effort every `claude` spawn runs with. Single source of
// truth. Opus 4.7+ uses adaptive thinking and ignores MAX_THINKING_TOKENS; the
// live lever is the `--effort` flag (low|medium|high|xhigh|max). "max" is top.
const { model: CLAUDE_MODEL, effort: CLAUDE_EFFORT } = engineDefault('claude', 'claude-opus-4-8', 'xhigh');

// Z.ai coding plan — GLM models served over the Anthropic-compatible endpoint.
// Runs through the same `claude` binary with the base URL + auth token
// redirected and a dedicated, OAuth-free CLAUDE_CONFIG_DIR, so the GLM token
// authenticates (never the operator's Anthropic subscription). GLM 5.3 / 5.2 1M context
// REQUIRES the `[1m]` model-id suffix on Z.ai. Bare `glm-5.3` / `glm-5.2` serve
// the standard 200K variant, which made Claude Code auto-compact far too early
// (observed ~109K) even with CLAUDE_CODE_AUTO_COMPACT_WINDOW=1M. Per Z.ai's
// Claude Code docs the id itself must carry `[1m]`.
const ZAI_BASE_URL = process.env.RIVENDELL_ZAI_BASE_URL?.trim() || 'https://api.z.ai/api/anthropic';
const ZAI_GLM53_MODEL = 'glm-5.3[1m]';
const ZAI_GLM53_FLASH_MODEL = 'glm-5.3-flash[1m]';
const ZAI_GLM52_MODEL = 'glm-5.2[1m]';
const ZAI_GLM51_MODEL = 'glm-5.1';
const ZAI_GLM_1M_COMPACT_WINDOW = '1000000';
const ZAI_GLM51_COMPACT_WINDOW = '200000';
const ZAI_CONFIG_DIR = join(homedir(), '.claude-zai');

// Validate WS/env model/effort against allow-lists; fall back to the config
// default on anything unexpected. Used both for spawn args and for the recycle
// comparison in getOrCreateSession (must resolve identically, or an invalid
// value would loop: spawn falls back but the compare never matches).
const VALID_CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// GLM exposes two real thinking-effort levels — High and Max. Z.ai's
// Anthropic endpoint maps Claude Code's effort onto them: low/medium/high -> GLM
// "high", xhigh/max -> GLM "max". The old {low,medium,high} set stripped `max`,
// so every GLM turn collapsed to High and Max was unreachable. Accept the full
// claude range (Z.ai collapses it); the UI offers just High and Max.
const VALID_ZAI_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_ZAI_MODELS = new Set([ZAI_GLM53_MODEL, ZAI_GLM53_FLASH_MODEL, ZAI_GLM52_MODEL, ZAI_GLM51_MODEL]);
const VALID_MODEL_ID = /^[A-Za-z0-9._-]+$/;
function normalizeZaiModelId(model?: string): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  // Canonicalize 1M ids; leave 5.2 selectable after the 5.3 default bump.
  if (trimmed === 'glm-5.3' || trimmed === 'glm-5.3[1m]') return ZAI_GLM53_MODEL;
  if (trimmed === 'glm-5.3-flash' || trimmed === 'glm-5.3-flash[1m]') return ZAI_GLM53_FLASH_MODEL;
  if (trimmed === 'glm-5.2' || trimmed === 'glm-5.2[1m]') return ZAI_GLM52_MODEL;
  return trimmed;
}
const resolveZaiModel = (m?: string, fallback = ZAI_GLM53_MODEL): string => {
  const model = normalizeZaiModelId(m);
  if (model && VALID_ZAI_MODELS.has(model)) return model;
  const fallbackModel = normalizeZaiModelId(fallback);
  return fallbackModel && VALID_ZAI_MODELS.has(fallbackModel) ? fallbackModel : ZAI_GLM53_MODEL;
};
const resolveZaiEffort = (e?: string, fallback = 'high'): string => {
  const effort = e?.trim();
  return effort && VALID_ZAI_EFFORTS.has(effort) ? effort : fallback;
};
const ZAI_MODEL = resolveZaiModel(process.env.RIVENDELL_ZAI_MODEL);
const ZAI_EFFORT = resolveZaiEffort(process.env.RIVENDELL_ZAI_EFFORT);
const zaiCompactWindowForModel = (model: string): string =>
  resolveZaiModel(model, ZAI_MODEL) === ZAI_GLM51_MODEL ? ZAI_GLM51_COMPACT_WINDOW : ZAI_GLM_1M_COMPACT_WINDOW;

function zaiEnv(model: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY; // force token-based auth to Z.ai, not a metered Anthropic key
  env.CLAUDE_CONFIG_DIR = ZAI_CONFIG_DIR;
  env.ANTHROPIC_BASE_URL = ZAI_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = process.env.Z_AI_API_KEY || '';
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = zaiCompactWindowForModel(model);
  // Z.ai's coding-plan 429 is a fixed usage-window cap. Claude Code's default
  // ten exponential retries leave Jessica "typing" for ~5 minutes. Keep one
  // retry for a transient transport/5xx blip, then fail promptly so a manual
  // retry after the provider reset remains the useful behavior.
  env.CLAUDE_CODE_MAX_RETRIES = '1';
  env.SAMWISE_ACCOUNT = 'zai';
  return env;
}

// xAI coding plan — Grok 4.6 served over xAI's Anthropic-compatible endpoint
// (https://api.x.ai/v1/messages). Same trick as Z.ai: run the stock `claude`
// binary with ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN redirected and a
// dedicated, OAuth-free CLAUDE_CONFIG_DIR, so the Grok token authenticates
// (never the operator's Anthropic subscription). Auth uses GROK_PERSONAL_API_KEY from
// the assistant Doppler project (Bearer, which xAI accepts). Grok 4.6 has a
// 500K context window.
//
// Claude Code (v2.1.x) resolves the effective auto-compact window as
// Math.min(modelContext, CLAUDE_CODE_AUTO_COMPACT_WINDOW). For non-claude-*
// model ids, modelContext defaults to 200K UNLESS CLAUDE_CODE_MAX_CONTEXT_TOKENS
// is set. Without the max-context env, AUTO_COMPACT_WINDOW=500000 is silently
// capped to 200K and compact fires around ~170K (observed 2026-07-15).
const XAI_BASE_URL = process.env.RIVENDELL_XAI_BASE_URL?.trim() || '';
const XAI_GROK46_MODEL = 'grok-4.6';
const XAI_GROK45_MODEL = 'grok-4.5'; // legacy pin still accepted
const XAI_COMPACT_WINDOW = '500000';
const XAI_CONFIG_DIR = join(homedir(), '.claude-xai');
const VALID_XAI_MODELS = new Set([XAI_GROK46_MODEL, XAI_GROK45_MODEL]);
// xAI's Anthropic endpoint accepts Claude Code's full effort range and maps it
// onto Grok's thinking budget; the UI offers a focused subset.
const VALID_XAI_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function resolveXaiModel(m?: string, fallback = XAI_GROK46_MODEL): string {
  const trimmed = m?.trim();
  if (trimmed && VALID_XAI_MODELS.has(trimmed)) return trimmed;
  return fallback;
}
function resolveXaiEffort(e?: string, fallback = 'high'): string {
  const effort = e?.trim();
  return effort && VALID_XAI_EFFORTS.has(effort) ? effort : fallback;
}
const XAI_MODEL = resolveXaiModel(process.env.RIVENDELL_XAI_MODEL);
const XAI_EFFORT = resolveXaiEffort(process.env.RIVENDELL_XAI_EFFORT);
function xaiEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY; // force token-based auth to xAI, not a metered Anthropic key
  env.CLAUDE_CONFIG_DIR = XAI_CONFIG_DIR;
  // The claude CLI emits a `role: "system"` message that xAI's Anthropic
  // endpoint rejects (400 "Invalid message role"). A localhost transform
  // proxy folds it into the top-level system field; ANTHROPIC_BASE_URL points
  // at the proxy, which forwards to https://api.x.ai. RIVENDELL_XAI_BASE_URL
  // (the proxy URL) is set at startup once the proxy is listening.
  env.ANTHROPIC_BASE_URL = XAI_BASE_URL || xaiProxyBaseUrl();
  // Prefer the SuperGrok subscription (flat-rate) over the metered
  // GROK_PERSONAL_API_KEY.
  //
  // Deliberately NOT a real token: a child's env freezes at spawn, so any token
  // put here is dead within ~6h while the session lives on — that was the
  // "OAuth2 access token could not be validated" bug. Instead we seed the
  // proxy's non-expiring per-process secret, and the proxy swaps it for a live
  // token on every request. The RIVENDELL_XAI_BASE_URL override bypasses our
  // proxy, so that path still needs a real (and, yes, expirable) token.
  if (!XAI_BASE_URL && hasXaiOauthToken()) {
    env.ANTHROPIC_AUTH_TOKEN = xaiProxySecret();
  } else {
    env.ANTHROPIC_AUTH_TOKEN = getXaiOauthTokenSync() || process.env.GROK_PERSONAL_API_KEY || '';
  }
  // Both knobs required: MAX_CONTEXT tells Claude Code Grok is 500K (not the
  // 200K non-claude default); AUTO_COMPACT_WINDOW is the compact threshold.
  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = XAI_COMPACT_WINDOW;
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = XAI_COMPACT_WINDOW;
  // Capacity/quota windows do not improve during Claude Code's long default
  // retry storm. Fail promptly so the user can switch brains or retry later.
  env.CLAUDE_CODE_MAX_RETRIES =
    process.env.RIVENDELL_XAI_MAX_RETRIES?.trim()
    || process.env.CLAUDE_CODE_MAX_RETRIES?.trim()
    || '1';
  env.SAMWISE_ACCOUNT = 'xai';
  return env;
}
/** Persistent `claude` binary lanes (Anthropic, Z.ai, xAI). Not Codex/Banana. */
export function isClaudeFamilyCli(cli: CliKind | null | undefined): cli is 'claude' | 'assistant' | 'zai' | 'xai' {
  return cli === 'claude' || cli === 'assistant' || cli === 'zai' || cli === 'xai';
}

const resolveClaudeModel = (cli: CliKind, m?: string): string => {
  if (cli === 'zai') return resolveZaiModel(m, ZAI_MODEL);
  if (cli === 'xai') return resolveXaiModel(m, XAI_MODEL);
  // Anthropic Claude Code only. A drifted Counsel picker can send grok-* / glm-*
  // here; those ids are valid xAI/Z.ai spawn args and must not become `--model`
  // on an Anthropic Claude process (which then prints unrecognized_model to stderr).
  if (m && VALID_MODEL_ID.test(m) && m.startsWith('claude-')) return m;
  return CLAUDE_MODEL;
};

/** Claude Code `-p` writes this once per unknown model id per process. It still
 *  sends the request — the line is a registry warning, not a failed turn. */
export function isClaudeUnrecognizedModelWarning(message: string): boolean {
  return message.includes('[claude-code:unrecognized_model]');
}

const resolveClaudeEffort = (cli: CliKind, e?: string): string =>
  cli === 'zai' ? resolveZaiEffort(e, ZAI_EFFORT)
  : cli === 'xai' ? resolveXaiEffort(e, XAI_EFFORT)
  : e && VALID_CLAUDE_EFFORTS.has(e) ? e : CLAUDE_EFFORT;

/** Prime the SuperGrok OAuth token (refreshing now if it's near expiry) and
 *  keep it fresh on a background interval so xaiEnv() always has a valid token
 *  at spawn time. Safe to call when no token exists (no-op). */
let xaiTokenTimer: NodeJS.Timeout | null = null;
export async function primeXaiOauthToken(): Promise<void> {
  try { await getXaiOauthToken(); }
  catch (err) { console.warn(`[chat xai] OAuth token prime failed: ${(err as Error).message}`); }
  if (xaiTokenTimer) return;
  // Refresh every 30 minutes. getXaiOauthToken() only hits xAI when the token
  // is within its 5-minute expiry skew, so this is cheap between refreshes.
  xaiTokenTimer = setInterval(() => {
    getXaiOauthToken().catch((err) => console.warn(`[chat xai] OAuth refresh failed: ${(err as Error).message}`));
  }, 30 * 60 * 1000).unref();
}


// Optional operator-provided MCP integrations. The team bus below is built in;
// external task/browser backends are included only when their entry points are
// actually configured and present. A fresh clone never calls the maintainer's
// services or spawns a missing private bridge.
const ASSISTANT_MCP_WORKSPACE = process.env.ELROND_WORKSPACE_PATH || join(homedir(), 'ASSISTANT-HUB');
const ASSISTANT_MCP_SERVER_URL =
  process.env.ASSISTANT_MCP_URL || process.env.RAILWAY_MCP_URL || '';
const ASSISTANT_MCP_PROXY =
  process.env.RIVENDELL_ASSISTANT_MCP_PROXY ||
  join(ASSISTANT_MCP_WORKSPACE, 'assistant-mcp', 'proxy', 'mcp-proxy.js');
const BROWSER_MCP_ENTRY = process.env.RIVENDELL_BROWSER_MCP?.trim() || '';
const optionalMcpServers: Record<string, {
  type: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}> = {};
if (ASSISTANT_MCP_SERVER_URL && existsSync(ASSISTANT_MCP_PROXY)) {
  optionalMcpServers['assistant-mcp'] = {
    type: 'stdio',
    command: 'node',
    args: [ASSISTANT_MCP_PROXY],
    env: { MCP_SERVER_URL: ASSISTANT_MCP_SERVER_URL },
  };
}
if (BROWSER_MCP_ENTRY && existsSync(BROWSER_MCP_ENTRY)) {
  optionalMcpServers['rivendell-browser'] = {
    type: 'stdio',
    command: 'node',
    args: [BROWSER_MCP_ENTRY],
  };
}
const ASSISTANT_MCP_CONFIG = JSON.stringify({ mcpServers: optionalMcpServers });


/** Add the local MCP servers to any mcp-config JSON: rivendell-team
 *  (agent-to-agent messaging, stamped with the calling agent's name so the
 *  tool can attribute sends) and rivendell-device (the user's own computers,
 *  reachable while their desktop app is open). */
let localMcpLogged = false;
function withTeamMcp(configJson: string, chatId: string): string {
  try {
    if (!localMcpLogged) {
      localMcpLogged = true;
      console.log('[chat] built-in team and computer MCPs enabled');
    }
    const cfg = JSON.parse(configJson) as { mcpServers: Record<string, { type: string; command: string; args: string[]; env?: Record<string, string> }> };
    Object.assign(cfg.mcpServers, localMcpServers(agentForChatId(chatId)?.name));
    return JSON.stringify(cfg);
  } catch {
    return configJson;
  }
}

// Grok (xAI) can use the full optional assistant-mcp integration (the same
// toolbox as every other lane - "give grok my mcp"). Built-in WebSearch/
// WebFetch stay disallowed below (xAI's Anthropic endpoint 422s the server
// tool shape; the MCP's web_search/quick_search/deep_research tools cover it
// instead). The spawn below still passes --strict-mcp-config with the fresh
// ASSISTANT_MCP_CONFIG so the STALE assistant-mcp entry in
// ~/.claude-xai/.claude.json (dead proxy path) cannot shadow this one.

const ASSISTANT_AGENT_PROMPT =
  "You are TARDIS, a calm, exacting, helpful assistant — named for the ship, and at most " +
  "lightly in character: plain first-person answers, no roleplay, no nicknames for the user " +
  "unless they use them first, and the persona never changes what you do or how thoroughly you do it. " +
  "You're working inside ASSISTANT-HUB, which contains the user's task system, " +
  "project dashboards, and personal automation. Address the user directly. Stay terse. " +
  "When you reference a workspace file or folder, use the form `ASSISTANT-HUB/relative/path` " +
  "rather than an absolute filesystem path. TARDIS may be accessed from multiple " +
  "machines, so host-specific absolute paths are not useful on other devices. " +
  "For file search, use `rg` or `rg --files` with scoped paths and explicit exclusions. " +
  "Do not run broad recursive `grep` or `find` over a home directory, workspace hub, " +
  "or ASSISTANT-HUB without excluding `node_modules`, `.git`, and generated output; " +
  "give the same constraint to any subagent you launch. " +
  HUB_WRITE_LOCK_PROMPT;

// Each session keeps a rolling tail of recent events so a reconnecting client
// gets the in-flight turn's output even if its WS dropped mid-stream. Bigger
// is better here — claude emits ~30+ events per turn and the user might run a
// dozen turns before reconnecting; old events fall off the tail.
const EVENT_BUFFER_SIZE = 2000;

export type SeqEvent = { seq: number; ev: SessionEvent };

class ClaudeSession {
  readonly key: string;
  /** Durable-history key. Equals `key` for ordinary lanes; for an agent home
   *  thread it drops the engine so every brain appends to one continuous log
   *  (see threadKey.ts). The live process and its native resume id stay under
   *  `key`. */
  readonly logKey: string;
  readonly cli: CliKind;
  readonly cwd: string;
  readonly chatId: string;
  private child: ChildProcessByStdio<Writable, Readable, Readable>;
  private stdoutBuf = '';
  private stderrBuf = '';
  private listeners = new Set<(e: SeqEvent) => void>();
  private subscriberCount = 0;
  /** Rolling tail of recent events (with sequence numbers) for reconnect replay. */
  private eventLog: SeqEvent[] = [];
  private nextSeq = 1;
  private lastActivityAtMs = Date.now();
  /** session_id we asked the CLI to resume (cleared once the init event arrives). */
  private pendingResumeId: string | null = null;
  /** session_id reported by the most recent init event. Persisted on every change. */
  private currentSessionId: string | null = null;
  private readonly startedResumeId: string | null = null;
  /** Next send prepends compact + last 50 at user-message precedence (not system). */
  private seedWindowOnNextTurn = false;
  /** Seeded stdin is in flight; ack rotation debt only after a successful result. */
  private pendingSeedAck = false;
  /** Model + effort this process was spawned with (per-session, defaults from config). */
  readonly spawnModel: string;
  readonly spawnEffort: string;
  private resumeFailed = false;
  private spawnError: string | null = null;
  /** Set once we detect a fatal 401. Guards failAuth() so a retry storm only
   *  tears the child down once, and flips isAlive() false so the next
   *  getOrCreateSession respawns against fresh credentials. */
  private authFailed = false;
  /** A 401 can arrive as both api_retry and result. Persist one notice per turn. */
  private terminalNoticeEmitted = false;
  /** The CLI may stream API-error prose before flagging its synthetic message. */
  private syntheticApiErrorSeen = false;
  /** Text-block seqs for the current Claude stream. A later synthetic marker
   * lets us surgically remove only its protocol prose from durable storage. */
  private streamTextBlocks = new Map<number, { text: string; seqs: number[] }>();
  /** True only while the active turn came from a scheduled routine. Human
   * input must wait for this turn's boundary instead of steering its mission. */
  private automationTurn = false;
  /** Tool calls that Claude Code has handed to its executor but has not yet
   * returned. Stream-json guidance is only reliably incorporated in this
   * window. Writing while the provider is already generating its next message
   * is accepted by stdin but can be silently ignored by that in-flight request. */
  private activeToolIds = new Set<string>();
  /** Explicit Stop uses Claude Code's control protocol, not SIGTERM. This flag
   * prevents its expected canceled result from rendering as a provider failure. */
  private userInterruptPending = false;
  private interruptInFlight: Promise<boolean> | null = null;
  /** A new image turn can spend time persisting/adapting before stdin. Stop
   * aborts that preparation locally instead of interrupting an idle provider. */
  private preparingTurnAborter: AbortController | null = null;
  private turnPromptSubmitted = false;
  /** Boot/rotation warmup uses Claude's read-only `mcp_status` control request:
   * no model turn, no tool call, and no transcript event. */
  private mcpPrewarmed = false;
  private warmupRequestId: string | null = null;
  private warmupPromise: Promise<void> | null = null;
  private finishWarmupWait: ((error?: Error) => void) | null = null;
  private warmupTimer: NodeJS.Timeout | null = null;
  private selectionPersisted = false;
  private initSeen = false;
  private exitedBeforeInit = false;
  /** Set by shutdown(): once an intentional teardown begins, stop appending to
   *  the durable log. The killed child's `exit`→`closed` emit fires async and
   *  must NOT re-create the jsonl after freshStart's clearEventLog removed it
   *  (that would resurrect a reset thread on a later full replay). */
  private disposed = false;
  private startupWaiters = new Set<(state: 'initialized' | 'closed') => void>();
  /** Resolves true once init is received, false if the process exits before init. */
  readonly ready: Promise<boolean>;
  private resolveReady!: (ok: boolean) => void;

  constructor(cli: CliKind, cwd: string, chatId: string, resumeId: string | null, model?: string, effort?: string, seedFirst = false, switchedFrom: string | null = null) {
    this.cli = cli;
    this.cwd = cwd;
    this.chatId = chatId;
    this.key = keyOf(cli, cwd, chatId);
    this.logKey = logKeyFor(cli, cwd, chatId);
    this.pendingResumeId = resumeId;
    this.startedResumeId = resumeId;
    this.spawnModel = resolveClaudeModel(cli, model);
    this.spawnEffort = resolveClaudeEffort(cli, effort);
    // Persona/FACE stay in --append-system-prompt. The forever-window
    // (compact + last 50) is prepended to the first user message so raw
    // turns are not promoted to system-level instructions.
    this.seedWindowOnNextTurn = seedFirst;
    this.ready = new Promise<boolean>((res) => { this.resolveReady = res; });

    // Restore any prior emitted events from disk so a server restart (manual
    // kickstart, crash, Mac sleep) doesn't drop the conversation tail. The
    // in-memory eventLog is the source of truth during a process lifetime;
    // disk is the failover so reconnecting clients with a stale `sinceSeq`
    // can still replay everything past their last-seen seq.
    try {
      const restored = loadEventLogSync(this.logKey);
      if (restored.events.length > 0) {
        this.eventLog = restored.events;
        this.nextSeq = restored.nextSeq;
        console.log(
          `[chat ${cli}] restored ${restored.events.length} event(s) from disk for ${this.logKey} (nextSeq=${this.nextSeq})`,
        );
      }
    } catch (err) {
      console.warn(`[chat ${cli}] event-log restore failed for ${this.logKey}:`, (err as Error).message);
    }
    // Mark the handover in the transcript itself, so the thread shows where the
    // brain changed instead of silently changing voice mid-conversation.
    if (switchedFrom && switchedFrom !== cli) {
      this.emit({
        type: 'event',
        event: {
          type: '_engine_switch',
          from: switchedFrom,
          to: cli,
          model: this.spawnModel,
          ts: Date.now(),
        },
      } as SessionEvent);
    }
    void compactEventLog(this.logKey, compactedThroughSeq(this.logKey));

    // Quiet-ready: the modern claude binary doesn't emit system/init until it
    // receives its first stdin message. Per Banana IDE: if the process is
    // alive after a short window and stderr is clean, treat it as ready so
    // the first send can go through. Init will fire later, after that send.
    setTimeout(() => {
      if (!this.initSeen && !this.exitedBeforeInit && !this.spawnError) {
        this.resolveReady(true);
      }
    }, 2000).unref();

    // xai also blocks the built-in web tools: they are unusable against xAI's
    // Anthropic endpoint (WebSearch is a server tool xAI 422s for a missing
    // `description`; WebFetch's summarization call returns "No response from
    // model"), and Grok gets a working client-side search via --mcp-config below.
    // SendMessage/ListAgents are the CLI's OWN peer-session messaging — they
    // only see other live claude processes, never TARDIS agents, so a model
    // that reaches for them "successfully" messages nobody. Block them so the
    // rivendell-team MCP (team_message) is the only messaging surface.
    const disallowedTools = cli === 'xai'
      ? 'AskUserQuestion WebSearch WebFetch SendMessage ListAgents ReadAgentMemory WriteAgentMemory'
      : 'AskUserQuestion SendMessage ListAgents ReadAgentMemory WriteAgentMemory';
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // In -p (non-interactive) stream-json mode the CLI auto-fails an
      // AskUserQuestion call within milliseconds with a `{content:"Answer
      // questions?",is_error:true}` result the host can't answer in time — so the
      // question silently collapses and the model thinks the user "declined".
      // Block the tool so the model asks inline in plain text, which the user can
      // actually reply to in the composer. (Same fix as samwise-2.)
      '--disallowedTools', disallowedTools,
      '--dangerously-skip-permissions',
      '--model', this.spawnModel,
      '--effort', this.spawnEffort,
    ];
    if (resumeId) args.push('--resume', resumeId);
    // Voice mode is derived from the chatId (`jarvis-*`, set by the
    // jarvis-agent worker) so it survives respawns/recycles with no protocol
    // changes — see voicePrompt.ts.
    const voice = isVoiceChatId(chatId);
    // A robot body's Jarvis thread (`jarvis-robot-*`) adds the physical-presence
    // guidance on top of the spoken register.
    const voiceAddendum = voice ? [VOICE_STYLE_ADDENDUM, isRobotVoiceChatId(chatId) ? ROBOT_VOICE_STYLE_ADDENDUM : null].filter(Boolean).join('\n\n') : null;
    // Persona scope: the teammate's who-I-am/what-I-do document follows the
    // home thread's chatId — survives rebrains (any engine) and compaction
    // rotations (fresh spawns re-read the file).
    const personaScope = personaPromptFor(chatId);
    if (cli === 'assistant') {
      args.push(
        '--append-system-prompt',
        [ASSISTANT_AGENT_PROMPT, voiceAddendum, personaScope, isAgentThread(chatId) ? TRANSCRIPT_GUIDANCE : null].filter(Boolean).join('\n\n'),
      );
    } else {
      const sys = [voiceAddendum, personaScope, isAgentThread(chatId) ? TRANSCRIPT_GUIDANCE : null].filter(Boolean).join('\n\n');
      if (sys) args.push('--append-system-prompt', sys);
    }

    // Same toolbox on every Claude-family engine: optional external MCPs plus
    // rivendell-team. --strict-mcp-config so a model switch cannot
    // silently pick up extra (or stale) servers from ~/.claude*.json. Keep
    // --mcp-config last: it is variadic and swallows any plain arg after it.
    if (cli === 'assistant' || cli === 'xai' || cli === 'claude' || cli === 'zai') {
      args.push('--strict-mcp-config', '--mcp-config', withTeamMcp(ASSISTANT_MCP_CONFIG, chatId));
    }

    // Account-pinned lanes (chatId carries `__acct__<account>`) force that exact
    // login; everything else keeps the per-repo account-map resolution.
    const forcedAccount = accountFromChatId(chatId);
    this.child = spawn('claude', args, {
      cwd,
      env:
        cli === 'zai'
          ? zaiEnv(this.spawnModel)
          : cli === 'xai'
            ? xaiEnv()
            : forcedAccount
              ? accountEnvForAccount(forcedAccount, cwd)
              : accountEnv(cwd),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    // Remaining bytes can arrive after `exit`; flush on stream close so a
    // trailing error without a newline is not stuck in stderrBuf forever.
    this.child.stderr.on('end', () => this.flushStderr());
    this.child.stderr.on('close', () => this.flushStderr());

    this.child.on('exit', (code, signal) => {
      this.flushStderr();
      if (this.warmupPromise) {
        this.finishWarmupWait?.(new Error(`Max warmup process exited (${code ?? signal ?? 'unknown'})`));
      }
      const idleMs = Date.now() - this.lastActivityAtMs;
      console.log(
        `[chat ${this.cli}] child exit cwd=${this.cwd} code=${code} signal=${signal ?? '-'} initSeen=${this.initSeen} idleMs=${idleMs}`,
      );
      if (!this.initSeen) {
        this.exitedBeforeInit = true;
        if (this.pendingResumeId) void setSessionId(this.cli, this.cwd, '', this.chatId);
        this.resolveReady(false);
        this.resolveStartupWaiters('closed');
      }
      // Died mid-turn: no `result` event ever landed, so without this marker the
      // event log holds the user's message and nothing after it. The next turn
      // would then read a blank window and report that it did nothing, while the
      // work it actually finished sits on disk. `disposed` is set first by
      // shutdown()/interrupt(), so a deliberate stop stays quiet.
      if (this.turnStartedAt !== null && !this.disposed) {
        const ranMs = Date.now() - this.turnStartedAt;
        console.warn(
          `[chat ${this.cli}] mid-turn death after ${ranMs}ms — writing crash tombstone (code=${code} signal=${signal ?? '-'})`,
        );
        try {
          this.emit(crashTombstoneEvent(crashTombstoneText({
            cli: this.cli,
            cwd: this.cwd,
            sessionId: this.currentSessionId,
            code,
            signal: signal ?? null,
            ranMs,
          })));
          this.emit({ type: 'turnEnd', sessionId: this.currentSessionId ?? undefined });
        } catch (err) {
          console.warn(`[chat ${this.cli}] tombstone emit failed:`, (err as Error).message);
        }
      }
      // A dead process is never busy, however it got there.
      this.turnStartedAt = null;
      this.automationTurn = false;
      this.activeToolIds.clear();
      this.preparingTurnAborter = null;
      this.turnPromptSubmitted = false;
      if (this.disposed) this.notifyClosed(code, signal);
      else this.emit({ type: 'closed', code, signal });
    });

    this.child.on('error', (err) => {
      this.spawnError = String(err?.message ?? err);
      if (!this.initSeen) {
        this.resolveReady(false);
        this.resolveStartupWaiters('closed');
      }
      this.emit({ type: 'error', message: this.spawnError });
    });
  }

  /**
   * Subscribe to live events. If `sinceSeq` is provided, immediately replays
   * any buffered events with seq > sinceSeq before returning. Pass 0 for
   * "give me everything in the buffer."
   */
  subscribe(fn: (e: SeqEvent) => void, sinceSeq = -1, countSubscriber = true): () => void {
    if (sinceSeq >= 0) {
      for (const se of this.eventLog) {
        if (se.seq > sinceSeq) fn(se);
      }
    }
    this.listeners.add(fn);
    if (countSubscriber) this.subscriberCount += 1;
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(fn);
      if (countSubscriber) {
        this.subscriberCount = Math.max(0, this.subscriberCount - 1);
        if (this.subscriberCount === 0) this.lastActivityAtMs = Date.now();
      }
    };
  }

  /** Reserve and return the next seq (tombstone writes race a dying session's
   *  own emit path — never let two events share a seq). */
  reserveSeq(): number {
    const seq = reserveEventLogSeq(this.logKey, this.nextSeq);
    this.nextSeq = seq + 1;
    return seq;
  }

  /** The latest sequence number (clients can send this on reconnect). */
  latestSeq(): number {
    return latestEventLogSeq(this.logKey, this.nextSeq - 1);
  }

  /** Most recent turn start (ms) — used for telegram-ping duration. */
  private turnStartedAt: number | null = null;

  /** Initialize Claude plus every configured MCP without invoking the model or
   * exposing any tool. `mcp_status` is a read-only stream-json control request. */
  async prewarm(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise;
    if (this.mcpPrewarmed || this.initSeen || this.turnStartedAt !== null) return;
    if (this.child.exitCode !== null || this.disposed) throw new Error('cannot prewarm an exited session');

    const requestId = `prewarm-${randomUUID()}`;
    this.warmupRequestId = requestId;
    let settled = false;
    const boundary = new Promise<void>((resolve, reject) => {
      this.finishWarmupWait = (error) => {
        if (settled) return;
        settled = true;
        if (this.warmupTimer) clearTimeout(this.warmupTimer);
        this.warmupTimer = null;
        this.finishWarmupWait = null;
        if (error) reject(error);
        else resolve();
      };
    });
    this.warmupPromise = boundary;
    this.warmupTimer = setTimeout(() => {
      this.finishWarmupWait?.(new Error('Max MCP warmup timed out'));
      this.shutdown('prewarm-timeout');
    }, 120_000);
    this.warmupTimer.unref?.();

    try {
      this.child.stdin.write(JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'mcp_status' },
      }) + '\n');
      await boundary;
    } catch (err) {
      this.finishWarmupWait?.(err as Error);
      throw err;
    } finally {
      this.warmupRequestId = null;
      this.warmupPromise = null;
    }
  }

  isPrewarming(): boolean {
    return this.warmupPromise !== null;
  }

  /** Send a user message into the running CLI as one turn. `peerFrom` marks
   *  agent-to-agent deliveries (team bus): they echo as a sender-tagged
   *  peer_message instead of _user_echo and don't tick compaction. */
  async send(text: string, images?: Array<{ mediaType: string; base64: string }>, opts: { peerFrom?: string; peerFromRole?: string; peerText?: string; peerDeliveryId?: string; allowNativePeerSteer?: boolean; allowNativeHumanSteer?: boolean; signal?: AbortSignal; clientMsgId?: string; skipAttachments?: boolean; voiceMode?: boolean } = {}): Promise<void> {
    // Every caller (human, teammate, routine) shares this admission barrier.
    // A read-only MCP control warmup can never reject or absorb a real message.
    if (this.warmupPromise) await this.warmupPromise.catch(() => {});
    if (opts.signal?.aborted) return;
    if (this.child.exitCode !== null || this.disposed) {
      throw new Error('session has exited');
    }
    const startsNewTurn = this.turnStartedAt === null;
    // Concurrent stdin is never implicit. Register/teamBus must opt into the
    // native path after observing a tool window, and we revalidate that window
    // here in the same event-loop slice as the eventual stdin.write. This shuts
    // the check/write race that previously acknowledged guidance after provider
    // inference had already begun.
    if (!startsNewTurn) {
      if (opts.peerFrom && !opts.allowNativePeerSteer) return;
      if (!opts.peerFrom && !opts.allowNativeHumanSteer) {
        throw new Error('the current turn must reach a safe boundary before guidance is delivered');
      }
      if (this.activeToolIds.size === 0) {
        if (opts.peerFrom) return;
        throw new Error('the native steering window closed before delivery');
      }
    }
    const automationRequest = opts.peerFromRole === 'automation';
    if (automationRequest && (!startsNewTurn || isThreadWatched(this.cwd, this.chatId))) {
      throw new Error('routine deferred because this thread is active');
    }
    if (!startsNewTurn && this.automationTurn) {
      // Register normally waits for this boundary. Keep this admission guard
      // here too so a race can reject, but never hijack, the routine mission.
      throw new Error('human message is waiting for the automation turn to finish');
    }
    const preparationAborter = startsNewTurn ? new AbortController() : null;
    const sendAborted = () => Boolean(opts.signal?.aborted || preparationAborter?.signal.aborted);
    if (startsNewTurn) {
      this.turnStartedAt = Date.now();
      this.automationTurn = automationRequest;
      this.activeToolIds.clear();
      this.terminalNoticeEmitted = false;
      this.syntheticApiErrorSeen = false;
      this.streamTextBlocks.clear();
      this.preparingTurnAborter = preparationAborter;
      this.turnPromptSubmitted = false;
    }
    const abandonUnsentTurn = () => {
      if (!startsNewTurn || this.preparingTurnAborter !== preparationAborter) return;
      this.preparingTurnAborter = null;
      this.turnPromptSubmitted = false;
      if (this.turnStartedAt === null) return;
      this.turnStartedAt = null;
      this.automationTurn = false;
      this.activeToolIds.clear();
      if (!this.disposed) this.emit({ type: 'turnEnd', sessionId: this.currentSessionId ?? undefined });
    };
    const historyThroughSeq = this.latestSeq();
    const fallbackHistory = this.eventLog.slice();
    const wantSeed = this.seedWindowOnNextTurn;
    const seed = wantSeed
      ? await peekEnginePrimerThroughSeq(this.logKey, historyThroughSeq, fallbackHistory)
      : '';
    if (sendAborted()) {
      abandonUnsentTurn();
      return;
    }

    // Prepare durable attachments and any text-only vision adaptation BEFORE
    // echoing acceptance. Stop/Fresh/newer guidance may abort these awaits; an
    // echo must never claim the model received a message that never hit stdin.
    let attachments: Array<{ id: string; mediaType: string }> = [];
    try {
      if (!opts.peerFrom && !opts.skipAttachments && images?.length) {
        attachments = await saveChatAttachments(images);
      }
    } catch (error) {
      abandonUnsentTurn();
      throw error;
    }
    if (sendAborted()) {
      abandonUnsentTurn();
      return;
    }

    // Z.ai GLM models are text-only over the Anthropic-compatible endpoint, so a
    // native image payload is dropped (or errors). Route pasted images through
    // the local LM Studio vision model and inject a text description instead.
    // claude/assistant keep full native vision — they never adapt.
    let promptText = text;
    let outImages = images;
    let visionNote: string | undefined;
    if (this.cli === 'zai' && images && images.length) {
      const result = await adaptImagesForTextModel({ text, images, modelSupportsImages: false });
      if (result.adapted) {
        promptText = result.text;
        outImages = undefined;
        visionNote = result.note;
      }
      // shutdown()/interrupt during the (up to 90s) adapter await sets disposed
      // but may leave exitCode null momentarily — don't write to a dying stdin.
      if (sendAborted()) {
        abandonUnsentTurn();
        return;
      }
      if (this.disposed || this.child.exitCode !== null) {
        abandonUnsentTurn();
        this.emit({ type: 'error', message: 'session has exited' });
        return;
      }
    }

    // Revalidate native steering after every possible await. From this check
    // through stdin.write there is no event-loop yield, so a completed tool
    // cannot silently move us into provider inference between check and write.
    if (!startsNewTurn && this.activeToolIds.size === 0) {
      if (opts.peerFrom) return;
      throw new Error('the native steering window closed before delivery');
    }

    // Echo only now: this is the durable admission boundary reconnecting
    // clients and the team outbox trust.
    if (opts.peerFrom) {
      if (startsNewTurn) this.emit({ type: 'turnStart' });
      this.emit({
        type: 'event',
        event: {
          type: 'peer_message',
          from: opts.peerFrom,
          fromRole: opts.peerFromRole ?? '',
          text: opts.peerText !== undefined ? opts.peerText : text,
          ...(opts.peerDeliveryId ? { deliveryId: opts.peerDeliveryId } : {}),
          ts: Date.now(),
        },
      });
    } else {
      await flushEventLog(this.logKey);
      if (sendAborted()) {
        abandonUnsentTurn();
        return;
      }
      if (!startsNewTurn && this.activeToolIds.size === 0) {
        throw new Error('the native steering window closed before delivery');
      }
      this.emit({
        type: 'event',
        event: {
          type: '_user_echo',
          text,
          imageCount: images?.length ?? 0,
          attachments,
          clientMsgId: opts.clientMsgId,
          ts: Date.now(),
        },
      });
      noteUserTurn(this.logKey); // forever-thread compaction cadence (monotonic)
      noteAgentLane(this.chatId, this.cli); // historical lane diagnostics
    }
    if (visionNote) {
      console.log(`[chat zai] vision adapter: ${visionNote}`);
      this.emit({
        type: 'event',
        event: { type: '_vision_adapter', images: images!.length, note: visionNote, ts: Date.now() },
      });
    }
    // The model occasionally drops the body when a user message is
    // `/<skill> <body>` and invokes the Skill tool with empty args. Wrap any
    // body in `<command-args>` so the args are structurally obvious before the
    // text reaches claude stdin. The UI echo above keeps the original visible.
    const commandText = wrapSlashArgs(promptText);
    // Claude Code emits system/init for every stream-json query, even though
    // TARDIS deliberately keeps one warm process and one durable thread.
    // Workspace instructions interpreted that as a brand-new session and made
    // Max run `date`, reload session context, and narrate "I'm on it" on every
    // ordinary follow-up. Supply the runtime fact inline so agent-home turns
    // continue immediately instead of acting like cold starts.
    const conversationGuidance = conversationGuidanceForTurn({
      chatId: this.chatId, logKey: this.logKey, historyThroughSeq,
      peerFrom: opts.peerFrom,
      peerFromRole: opts.peerFromRole,
    });
    const continuationText = isAgentThread(this.chatId)
      ? [
          '<rivendell-continuation>',
          `This is a warm continuation of the existing conversation, not a new user-visible session. Host time: ${new Date().toString()}.`,
          'Do not repeat session-start rituals for this turn: do not run `date`, do not call session_start_context, and do not open with empty boilerplate such as “I’m on it” or “checking now.” TARDIS already renders basic liveness.',
          '</rivendell-continuation>',
          ...(conversationGuidance ? ['', conversationGuidance] : []),
          ...(opts.voiceMode ? ['', THREAD_VOICE_STYLE_ADDENDUM] : []),
          '',
          commandText,
        ].join('\n')
      : commandText;
    const computerContext = computerGuidance(this.chatId, agentForChatId(this.chatId)?.name ?? 'Companion', !opts.peerFrom && opts.peerFromRole !== 'automation');
    const stdinText = `${computerContext}\n\n${seed ? `${seed}\n\n---\n\n` : ''}${continuationText}`;
    // Build claude's content array. Images come first so claude sees them
    // before the prompt.
    const content: Array<any> = [];
    if (outImages && outImages.length) {
      for (const img of outImages) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        });
      }
    }
    if (stdinText) content.push({ type: 'text', text: stdinText });
    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: content.length === 1 && content[0].type === 'text' && !outImages?.length
          ? stdinText
          : content,
      },
    });
    try {
      // Commit preparation to provider submission in one synchronous slice.
      // An old canceled image-prep closure must never write after a newer turn
      // has replaced its controller.
      if (sendAborted() || (startsNewTurn && this.preparingTurnAborter !== preparationAborter)) {
        abandonUnsentTurn();
        return;
      }
      if (startsNewTurn) {
        this.preparingTurnAborter = null;
        this.turnPromptSubmitted = true;
      }
      await new Promise<void>((resolve, reject) => {
        this.child.stdin.write(payload + '\n', (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      if (wantSeed) {
        this.seedWindowOnNextTurn = false;
        if (seed) this.pendingSeedAck = true;
      }
      if (opts.peerDeliveryId) {
        this.emit({
          type: 'event',
          event: { type: 'peer_delivery_accepted', deliveryId: opts.peerDeliveryId, ts: Date.now() },
        });
      }
    } catch (e) {
      if (wantSeed) this.seedWindowOnNextTurn = true;
      if (startsNewTurn && this.turnStartedAt !== null) {
        this.turnStartedAt = null;
        this.automationTurn = false;
        this.turnPromptSubmitted = false;
        this.emit({ type: 'turnEnd', sessionId: this.currentSessionId ?? undefined });
      }
      this.emit({ type: 'error', message: `stdin write failed: ${(e as Error).message}` });
    }
  }

  /** Tear down the underlying process. */
  shutdown(reason = 'unspecified'): void {
    this.disposed = true;
    const idleMs = Date.now() - this.lastActivityAtMs;
    console.warn(
      `[chat ${this.cli}] shutdown key=${this.key} pid=${this.child.pid ?? '-'} initSeen=${this.initSeen} listeners=${this.subscriberCount} idleMs=${idleMs} reason=${reason}`,
    );
    try { this.child.stdin.end(); } catch {}
    terminateProcessTree(this.child, 'SIGTERM');
    setTimeout(() => {
      if (this.child.exitCode === null) terminateProcessTree(this.child, 'SIGKILL');
    }, 3000).unref();
  }

  /** Cancel only the active turn and keep the initialized CLI/MCP process warm.
   * Claude Code's stream-json control protocol returns a normal canceled result
   * and then accepts the next user message in the same process. Fall back to a
   * process kill only if the control channel itself fails or never settles. */
  interrupt(reason = 'interrupt'): Promise<boolean> {
    if (this.interruptInFlight) return this.interruptInFlight;
    if (this.turnStartedAt === null) return Promise.resolve(this.isAlive());

    // An image may still be in attachment persistence or the text-only vision
    // adapter, before the CLI has received any prompt. Cancel that local work
    // and close the turn immediately; sending provider interrupt here would hit
    // an idle session and the late preprocessing closure could otherwise write
    // the prompt afterward.
    if (this.preparingTurnAborter && !this.turnPromptSubmitted) {
      this.preparingTurnAborter.abort();
      this.preparingTurnAborter = null;
      this.emit({ type: 'event', event: { type: '_interrupted', ts: Date.now() } });
      this.turnStartedAt = null;
      this.automationTurn = false;
      this.activeToolIds.clear();
      this.emit({ type: 'turnEnd', sessionId: this.currentSessionId ?? undefined });
      return Promise.resolve(this.isAlive());
    }

    const run = async (): Promise<boolean> => {
      type Outcome = 'ended' | 'closed' | 'failed' | 'timeout';
      let finish!: (outcome: Outcome) => void;
      let settled = false;
      let unsubscribe: () => void = () => {};
      const outcome = new Promise<Outcome>((resolve) => {
        const done = (value: Outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(value);
        };
        finish = done;
        const timer = setTimeout(() => done('timeout'), 12_000);
        timer.unref?.();
        unsubscribe = this.subscribe((event) => {
          if (event.ev.type === 'turnEnd') done('ended');
          else if (event.ev.type === 'closed') done('closed');
        }, -1, false);
      });

      this.userInterruptPending = true;
      this.emit({ type: 'event', event: { type: '_interrupted', ts: Date.now() } });
      const requestId = `interrupt-${randomUUID()}`;
      try {
        await new Promise<void>((resolve, reject) => {
          this.child.stdin.write(JSON.stringify({
            type: 'control_request',
            request_id: requestId,
            request: { subtype: 'interrupt' },
          }) + '\n', (error) => error ? reject(error) : resolve());
        });
      } catch {
        finish('failed');
      }

      const result = await outcome;
      if (result === 'ended' && this.isAlive()) return true;

      console.warn(`[chat ${this.cli}] warm interrupt ${result}; falling back to process stop (${reason})`);
      this.userInterruptPending = false;
      if (this.turnStartedAt !== null && !this.disposed) {
        this.turnStartedAt = null;
        this.automationTurn = false;
        this.activeToolIds.clear();
        this.preparingTurnAborter = null;
        this.turnPromptSubmitted = false;
        this.emit({ type: 'turnEnd', sessionId: this.currentSessionId ?? undefined });
      }
      this.shutdown(`${reason}-${result}`);
      return false;
    };

    this.interruptInFlight = run().finally(() => { this.interruptInFlight = null; });
    return this.interruptInFlight;
  }

  isAlive(): boolean {
    return this.child.exitCode === null && !this.spawnError && !this.authFailed && !this.disposed;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** The warm child's OAuth token is dead (401/403). Retrying in-process can't
   *  recover it — its cached refresh token was rotated out. Tear the child down
   *  so the next getOrCreateSession respawns a fresh process that re-reads
   *  credentials from disk. Guarded so a retry storm only kills once. */
  private failAuth(): void {
    if (this.authFailed) return;
    this.authFailed = true;
    // Kill immediately. The fatal error was already emitted synchronously just
    // above, and the child's 'exit'→'closed' fires on a later tick regardless,
    // so ordering is safe without deferring. Killing now shrinks the window
    // before the process dies: the respawn only happens on the user's NEXT send
    // (human-timescale away), by which point SIGTERM + the 3s SIGKILL backstop
    // have reaped this process — so two `claude --resume` processes never run
    // against the same session id.
    this.shutdown('auth-failed');
  }

  hasResumeFailed(): boolean {
    return this.resumeFailed;
  }

  /** True while this session is actively processing a turn (between user send and result event). */
  isBusy(): boolean {
    return this.turnStartedAt !== null;
  }

  /** Scheduled turns yield to human messages at their natural boundary. */
  isAutomationTurn(): boolean {
    return this.turnStartedAt !== null && this.automationTurn;
  }

  /** One synchronous admission snapshot for register's native-steer decision.
   * Claude's stream-json stdin only behaves like interactive steering while a
   * tool is executing. During provider inference it acknowledges the write but
   * the model can finish without ever seeing it, so callers must queue a
   * separate turn instead. */
  canAcceptNativeHumanSteer(): boolean {
    return this.turnStartedAt !== null && !this.automationTurn && this.activeToolIds.size > 0;
  }

  sessionId(): string | null {
    return this.currentSessionId ?? this.pendingResumeId;
  }

  startedWithResume(): boolean {
    return Boolean(this.startedResumeId);
  }

  waitForInitOrExit(timeoutMs: number): Promise<'initialized' | 'closed' | 'timeout'> {
    if (this.initSeen) return Promise.resolve('initialized');
    if (this.exitedBeforeInit || this.child.exitCode !== null || this.spawnError) {
      return Promise.resolve('closed');
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (state: 'initialized' | 'closed' | 'timeout') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.startupWaiters.delete(waiter);
        resolve(state);
      };
      const waiter = (state: 'initialized' | 'closed') => finish(state);
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      timer.unref?.();
      this.startupWaiters.add(waiter);
    });
  }

  listenerCount(): number {
    return this.subscriberCount;
  }

  /** Most recent activity timestamp (ms). */
  lastActivityAt(): number {
    return this.lastActivityAtMs;
  }

  // ── private ────────────────────────────────────────────────

  private trackStreamText(ev: any): void {
    if (ev?.type !== 'stream_event' || !ev.event || typeof ev.event !== 'object') return;
    const stream = ev.event;
    if (stream.type === 'message_start') {
      this.streamTextBlocks.clear();
      return;
    }
    if (typeof stream.index !== 'number') return;
    if (stream.type === 'content_block_start' && stream.content_block?.type === 'text') {
      this.streamTextBlocks.set(stream.index, {
        text: typeof stream.content_block.text === 'string' ? stream.content_block.text : '',
        seqs: [this.nextSeq],
      });
      return;
    }
    if (stream.type === 'content_block_delta' && stream.delta?.type === 'text_delta') {
      const block = this.streamTextBlocks.get(stream.index) ?? { text: '', seqs: [] };
      if (typeof stream.delta.text === 'string') block.text += stream.delta.text;
      block.seqs.push(this.nextSeq);
      this.streamTextBlocks.set(stream.index, block);
      return;
    }
    if (stream.type === 'content_block_stop') {
      const block = this.streamTextBlocks.get(stream.index);
      if (block) block.seqs.push(this.nextSeq);
    }
  }

  private scrubSyntheticStreamText(): void {
    const seqs = [...this.streamTextBlocks.values()]
      .filter((block) => isSyntheticApiErrorText(block.text))
      .flatMap((block) => block.seqs);
    this.streamTextBlocks.clear();
    if (seqs.length === 0) return;
    const targets = new Set(seqs);
    this.eventLog = this.eventLog.filter((event) => !targets.has(event.seq));
    // Queue behind the stream appends and ahead of the terminal notice append.
    // The exact-seq rewrite also leaves a safe high-watermark if needed.
    void removeEventLogEvents(this.logKey, targets);
  }

  private persistAppliedSelection(): void {
    if (this.selectionPersisted) return;
    this.selectionPersisted = true;
    void setSessionSelection(this.cli, this.cwd, {
      model: this.spawnModel,
      effort: this.spawnEffort,
    }, this.chatId).catch((err) => {
      this.selectionPersisted = false;
      console.warn(`[chat ${this.cli}] could not persist applied model/effort:`, (err as Error).message);
    });
  }

  private emitTerminalNotice(
    terminal: TerminalProviderError,
    discardSynthetic = this.syntheticApiErrorSeen,
  ): void {
    if (this.terminalNoticeEmitted) return;
    this.terminalNoticeEmitted = true;
    this.emit({
      type: 'event',
      event: {
        type: '_terminal_error',
        message: terminal.message,
        code: terminal.code,
        retryable: terminal.retryable,
        discardSynthetic: discardSynthetic || undefined,
        ts: Date.now(),
      },
    });
  }

  private notifyClosed(code: number | null, signal: NodeJS.Signals | null): void {
    // Intentional replacement must detach server subscribers without advancing
    // clients beyond the durable seq high-water. The replacement inherits that
    // exact allocator; a synthetic higher seq here would make clients discard
    // its first real events as duplicates.
    const se: SeqEvent = { seq: this.latestSeq(), ev: { type: 'closed', code, signal, intentional: true } };
    for (const fn of this.listeners) fn(se);
  }

  private emit(msg: SessionEvent): void {
    msg = redactComputerImages(msg);
    // Once intentional teardown begins, every remaining child frame belongs to
    // the retiring process. Do not allocate, persist, or deliver it.
    if (this.disposed || isPlumbingEvent(msg)) return;
    this.lastActivityAtMs = Date.now();
    const se: SeqEvent = { seq: this.reserveSeq(), ev: msg };
    const persisted = { ...se, eng: this.cli, mdl: this.spawnModel };
    const durableUserEcho = msg.type === 'event' && msg.event?.type === '_user_echo';
    // A user echo is the admission commit. Persist it synchronously before any
    // listener can dequeue/replay the prompt or the model can receive it.
    if (durableUserEcho && !appendEventLogSync(this.logKey, persisted)) {
      throw new Error('could not durably accept the user message');
    }
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) {
      this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    }
    // Don't persist events emitted after an intentional shutdown — they're the
    // dying child's trailing output and would repollute a freshly-cleared log.
    if (!durableUserEcho && !this.disposed) appendEventLog(this.logKey, persisted);
    for (const fn of this.listeners) fn(se);
  }

  /** Already durable; do not persist again or touch native turn state. */
  ingestExternalEvent(se: SeqEvent): void {
    if (this.disposed) return;
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    for (const fn of this.listeners) fn(se);
  }

  /** Forever-thread compaction check — see server/src/chat/compaction.ts. */
  private async maybeCompact(): Promise<void> {
    try {
      await maybeAutoCompact({
        key: this.logKey,
        cli: this.cli,
        chatId: this.chatId,
        events: this.eventLog,
        isBusy: () => this.turnStartedAt !== null,
        emit: (ev) => this.emit(ev as SessionEvent),
        rotate: () => this.keepWarmAfterCompact(),
      });
    } catch (err) {
      console.warn(`[chat ${this.cli}] compaction check failed for ${this.key}:`, (err as Error).message);
    }
  }

  /** The durable compact is for recovery, not a reason to kill a healthy
   * persistent process. Claude/xAI retain their live context and native
   * auto-compaction; the next genuine process start receives compact+window.
   * Returning true clears obsolete rotation debt without a handoff gap. */
  private keepWarmAfterCompact(): boolean {
    if (sessions.get(this.key) !== this || !this.isAlive()) return false;
    console.warn(`[chat ${this.cli}] compact saved; keeping warm session ${this.key}`);
    return true;
  }

  private resolveStartupWaiters(state: 'initialized' | 'closed'): void {
    const waiters = Array.from(this.startupWaiters);
    this.startupWaiters.clear();
    for (const fn of waiters) fn(state);
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    let nl = this.stderrBuf.indexOf('\n');
    while (nl !== -1) {
      const line = this.stderrBuf.slice(0, nl);
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      nl = this.stderrBuf.indexOf('\n');
      this.handleStderrLine(line);
    }
  }

  private flushStderr(): void {
    if (!this.stderrBuf) return;
    const rest = this.stderrBuf;
    this.stderrBuf = '';
    this.handleStderrLine(rest);
  }

  private handleStderrLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    // Surface stderr as a soft error but skip Claude Code's model-registry
    // warning: xAI/Z.ai ids are off-registry by design, and the CLI still
    // sends the request. Forwarding it became a red error pill on steer
    // (respawn → first query of a new process).
    if (isClaudeUnrecognizedModelWarning(line)) {
      console.log(`[chat ${this.cli}] ignored unrecognized_model warning: ${line.slice(0, 180)}`);
      return;
    }
    this.emit({ type: 'error', message: line });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl = this.stdoutBuf.indexOf('\n');
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      nl = this.stdoutBuf.indexOf('\n');
      if (!line) continue;
      let ev: any;
      try { ev = JSON.parse(line); }
      catch { continue; }
      this.handleEvent(ev);
    }
  }

  private handleEvent(ev: any): void {
    // Track the one phase where Claude Code can incorporate realtime stdin
    // without interrupting: after it emitted tool_use and before every matching
    // tool_result came back. A user message written during message generation
    // was observed to receive an echo yet be absent from every later response.
    if (ev?.type === 'stream_event' && ev.event?.type === 'message_start') {
      this.activeToolIds.clear();
    } else if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          this.activeToolIds.add(block.id);
        }
      }
    } else if (ev?.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          this.activeToolIds.delete(block.tool_use_id);
        }
      }
    }

    if (
      ev?.type === 'control_response'
      && ev.response?.request_id === this.warmupRequestId
    ) {
      const servers = Array.isArray(ev.response?.response?.mcpServers)
        ? ev.response.response.mcpServers
        : [];
      const statuses = new Map<string, string>(servers.map((server: any) => [
        typeof server?.name === 'string' ? server.name : '',
        typeof server?.status === 'string' ? server.status : '',
      ]));
      const required = ['assistant-mcp', 'rivendell-browser', 'rivendell-team'];
      const unavailable = required.filter((name) => statuses.get(name) !== 'connected');
      const succeeded = ev.response?.subtype === 'success' && unavailable.length === 0;
      this.mcpPrewarmed = succeeded;
      this.finishWarmupWait?.(succeeded
        ? undefined
        : new Error(`Max MCP warmup incomplete: ${unavailable.join(', ') || 'status request failed'}`));
      return;
    }

    // Detect init + silent-resume-failure.
    if (!this.disposed && ev?.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
      const pending = this.pendingResumeId;
      this.pendingResumeId = null;
      this.initSeen = true;
      this.resolveReady(true);
      this.resolveStartupWaiters('initialized');
      if (pending && pending !== ev.session_id) {
        this.resumeFailed = true;
        this.emit({
          type: 'error',
          message: `Resume failed (session ${pending.slice(0, 8)}… not found). Started a fresh thread.`,
        });
      }
      this.currentSessionId = ev.session_id;
      void setSessionId(this.cli, this.cwd, ev.session_id, this.chatId);
    }

    // Track session_id from any event that carries it (some events carry it
    // as well as init; persisting on every change keeps us safe across forks).
    if (!this.disposed && ev && typeof ev === 'object' && typeof ev.session_id === 'string'
        && ev.session_id !== this.currentSessionId) {
      this.currentSessionId = ev.session_id;
      void setSessionId(this.cli, this.cwd, ev.session_id, this.chatId);
    }

    this.trackStreamText(ev);
    const syntheticApiError = isSyntheticApiErrorEvent(ev);
    if (syntheticApiError) {
      this.syntheticApiErrorSeen = true;
      this.scrubSyntheticStreamText();
    }
    const expectedUserInterrupt = ev?.type === 'result' && this.userInterruptPending;
    const providerTerminal = ev?.type === 'result' && !expectedUserInterrupt
      ? terminalProviderError(this.cli, ev)
      : null;
    const terminal = providerTerminal
      ?? (ev?.type === 'result' && !expectedUserInterrupt ? terminalExecutionError(this.cli, ev) : null);
    if (terminal) {
      // Never persist the raw failed result: provider payloads can include
      // request metadata or echoed prompt fragments. The normalized notice is
      // the durable transcript record; turnEnd below remains the boundary.
      this.emitTerminalNotice(terminal, this.syntheticApiErrorSeen);
    } else {
      this.emit({ type: 'event', event: ev });
    }
    if ((ev?.type === 'assistant' && !syntheticApiError) || ev?.type === 'result') {
      this.streamTextBlocks.clear();
    }

    if (terminal && ev.api_error_status === 401) {
      // Only 401 benefits from killing an OAuth-backed warm process. Fixed-key
      // engines still report the durable notice and respawn on a later send.
      this.failAuth();
    }

    // A mid-turn API retry storm is otherwise invisible. A 401 means the
    // credential is dead: retrying in-process cannot fix it, so leave a durable
    // notice and retire the child. Other engines may still back off on 429;
    // Z.ai gets only one retry because its common 429 is a fixed usage window.
    if (ev?.type === 'system' && ev.subtype === 'api_retry' && typeof ev.error_status === 'number') {
      // error_status is always present here, so key strictly off 401 — a 403
      // carrying error:"authentication_failed" is a plan/permission problem a
      // respawn can't fix, so it must NOT be treated as fatal.
      const fatalAuth = ev.error_status === 401;
      const tokenBacked = this.cli === 'zai' || this.cli === 'xai';
      if (fatalAuth) {
        const provider = tokenBacked ? (this.cli === 'xai' ? 'xAI' : 'Z.ai') : 'Claude';
        this.emitTerminalNotice({
          message: `${provider} could not authenticate. Check its account or API key, then try again.`,
          code: String(ev.error_status),
        }, true);
        this.failAuth();
      } else {
        const attempt = ev.attempt ? ` (attempt ${ev.attempt}/${ev.max_retries ?? '?'})` : '';
        this.emit({ type: 'error', message: `API ${ev.error} ${ev.error_status}${attempt} — retrying…`, code: String(ev.error_status), retryable: true });
      }
    }

    // turn end = `result` event from the CLI
    if (ev?.type === 'result') {
      // Clear the completed state before notifying synchronous subscribers; a
      // subscriber may immediately admit the next queued human turn.
      this.turnStartedAt = null;
      this.automationTurn = false;
      this.activeToolIds.clear();
      this.preparingTurnAborter = null;
      this.turnPromptSubmitted = false;
      this.userInterruptPending = false;
      this.emit({ type: 'turnEnd', sessionId: this.currentSessionId ?? undefined });
      const seeded = this.pendingSeedAck;
      const resultFailed = ev.is_error === true || typeof ev.api_error_status === 'number';
      const failed = seeded && resultFailed;
      if (seeded) this.pendingSeedAck = false;
      if (failed) this.seedWindowOnNextTurn = true;
      if (!resultFailed) this.persistAppliedSelection();
      void (async () => {
        if (seeded && !failed) await clearRotation(this.logKey);
        await this.maybeCompact();
      })();
    }
  }
}

/** On service shutdown: tag every BUSY lane's durable log with the restart
 *  marker, so the resumed agent reads "your turn was killed — check the work
 *  before answering" in its next seed window instead of stalling silently. */
export function markBusyLanesRestarting(signal: string): number {
  let marked = 0;
  for (const s of sessions.values()) {
    if (!s.isBusy()) continue;
    try {
      const session = s as unknown as { logKey: string; reserveSeq(): number; cli: string; spawnModel: string };
      // SYNC write: a dying process can't be trusted to flush an async queue.
      const written = appendEventLogSync(session.logKey, {
        seq: session.reserveSeq(),
        ev: restartMarkerEvent(signal) as never,
        eng: session.cli,
        mdl: session.spawnModel,
      });
      if (written) marked++;
      console.warn(`[tardis] restart tombstone ${written ? 'written' : 'FAILED'} for ${session.logKey}`);
    } catch (err) {
      console.warn(`[tardis] restart tombstone failed for ${s.key}:`, (err as Error).message);
    }
  }
  return marked;
}

// ── Session manager ────────────────────────────────────────────────

const sessions = new Map<string, ClaudeSession>();
let sessionsShuttingDown = false;
const resettingThreadLogs = new Set<string>();
const inFlightSessionLookups = new Map<string, Set<Promise<void>>>();

function trackedThreadLogKey(opts: { cli: CliKind; repoPath: string; chatId?: string }): string {
  const chatId = opts.chatId || 'main';
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  return logKeyFor(opts.cli, cwd, chatId);
}

function beginSessionLookup(logKey: string): () => void {
  let resolve!: () => void;
  const token = new Promise<void>((done) => { resolve = done; });
  const pending = inFlightSessionLookups.get(logKey) ?? new Set<Promise<void>>();
  pending.add(token);
  inFlightSessionLookups.set(logKey, pending);
  return () => {
    pending.delete(token);
    if (pending.size === 0) inFlightSessionLookups.delete(logKey);
    resolve();
  };
}

/** Wait for lookups that entered before a Fresh barrier to finish claiming
 * their runner maps. New lookups are refused while the barrier is held. */
export async function settleThreadSessionLookups(opts: { cli: CliKind; repoPath: string; chatId?: string }): Promise<void> {
  const logKey = trackedThreadLogKey(opts);
  while (true) {
    const pending = [...(inFlightSessionLookups.get(logKey) ?? [])];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}


/** Claim an engine-neutral Fresh Thread barrier. All normal delivery paths enter
 * through getOrCreateSession and are refused until the reset has retired every
 * native lane and cleared the durable history. */
export function beginThreadReset(opts: { cli: CliKind; repoPath: string; chatId?: string }): (() => void) | null {
  const logKey = trackedThreadLogKey(opts);
  if (resettingThreadLogs.has(logKey)) return null;
  resettingThreadLogs.add(logKey);
  return () => { resettingThreadLogs.delete(logKey); };
}

export function isThreadResetting(opts: { cli: CliKind; repoPath: string; chatId?: string }): boolean {
  return resettingThreadLogs.has(trackedThreadLogKey(opts));
}

function keyOf(cli: CliKind, cwd: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  return normalized === 'main' ? `${cli}|${cwd}` : `${cli}|${cwd}|${normalized}`;
}

// Returned by getOrCreateSession — common interface across all runners.
export type AnySession = ClaudeSession | CodexSession | BananaSession;

export async function getOrCreateSession(opts: {
  cli: CliKind;
  repoPath: string;
  chatId?: string;
  model?: string;
  effort?: string;
  /** Only an explicit user turn (send/steer) may recycle a warm session to
   *  apply a changed model/effort. Passive hellos/reconnects MUST default to
   *  attach-only: a backgrounded tab or a second device with a stale effort
   *  fires a hello on every focus/visibility/online event, and recycling on
   *  that would SIGTERM the warm session each time. With 30-70s MCP startup the
   *  replacement never reaches init → the "asleep"/"no session" storm. */
  recycleOnMismatch?: boolean;
}): Promise<AnySession> {
  if (sessionsShuttingDown) throw new Error('TARDIS is shutting down');
  const chatId = opts.chatId || 'main';
  if (isThreadResetting({ cli: opts.cli, repoPath: opts.repoPath, chatId })) {
    throw new Error('This thread is being reset — retry in a moment.');
  }
  const finishLookup = beginSessionLookup(trackedThreadLogKey({ ...opts, chatId }));
  try {
  retireOtherEnginesOnThread(opts.cli, opts.repoPath, chatId);
  if (opts.cli === 'codex' || opts.cli === 'codex-personal') {
    return await getOrCreateCodexSession({
      repoPath: opts.repoPath,
      chatId,
      cli: opts.cli,
    });
  }
  if (opts.cli === 'banana' || opts.cli === 'banana-local' || opts.cli === 'banana-fireworks') {
    return await getOrCreateBananaSession({ repoPath: opts.repoPath, chatId, cli: opts.cli });
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  const wantModel = resolveClaudeModel(opts.cli, opts.model);
  const wantEffort = resolveClaudeEffort(opts.cli, opts.effort);

  while (true) {
    const existing = sessions.get(key);
    if (!existing) break;
    if (!existing.isAlive()) {
      if (sessions.get(key) === existing) sessions.delete(key);
      continue;
    }

    const ok = await existing.ready;
    if (sessions.get(key) !== existing) continue;
    if (ok && existing.isAlive()) {
      await flushEventLog(existing.logKey);
      const priorEngine = lastEngineOf(loadEventLogSync(existing.logKey).events);
      if (!existing.isBusy() && priorEngine && priorEngine !== opts.cli) {
        // This native session predates turns from another brain on the shared
        // agent thread. Recreate it so the next turn seeds current context.
        existing.shutdown('cross-engine context refresh');
        sessions.delete(key);
        continue;
      }
      // Recycle only an IDLE session whose model/effort differs, and only when
      // the caller explicitly opted in (a real authoritative turn). session_id
      // is preserved so the replacement --resumes the same conversation. A
      // control-only boot prewarm may have passed the readiness grace without
      // emitting `init`; it is still safe and necessary to replace before its
      // first real turn. Passive hello/reconnect callers never opt in, which is
      // what prevents replacement storms during normal startup.
      const matches = existing.spawnModel === wantModel && existing.spawnEffort === wantEffort;
      const recyclable =
        opts.recycleOnMismatch === true &&
        !matches &&
        !existing.isBusy();
      if (!recyclable) return existing;
      existing.shutdown('model/effort change');
      sessions.delete(key);
      continue;
    }
    sessions.delete(key);
  }

  if (opts.cli === 'xai') {
    // The xAI engine runs through a localhost transform proxy; never spawn
    // without it (an empty ANTHROPIC_BASE_URL would fall back to Anthropic and
    // leak the Grok credential to the wrong provider). Throws if the proxy
    // can't start, surfacing a clear error instead of a silent wrong-provider spawn.
    await ensureXaiProxy();
  }
  return await spawnSessionOnce(opts.cli, cwd, chatId, key, wantModel, wantEffort);
  } finally {
    finishLookup();
  }
}

/** One live engine per thread.
 *
 *  An agent thread's engines now share a single durable log and a single seq
 *  allocator, primed from that log at construction. Two live processes on the
 *  same thread would hand out the same sequence numbers — a routine firing into
 *  the retired brain is enough to interleave duplicates into the transcript. So
 *  when a turn is claimed for one engine, retire the thread's other engines.
 *
 *  A BUSY session is left alone: an in-flight turn is worth more than the
 *  invariant, and it will be retired on the next turn once it is idle. */
function retireOtherEnginesOnThread(cli: CliKind, repoPath: string, chatId: string): void {
  const cwd = cli === 'assistant' ? ASSISTANT_HUB_PATH : repoPath;
  const logKey = logKeyFor(cli, cwd, chatId);
  if (!isThreadLogKey(logKey)) return;
  const retire = (session: AnySession, drop?: () => void) => {
    if (session.cli === cli || session.logKey !== logKey) return;
    if (!session.isAlive()) return;
    if (typeof session.isBusy === 'function' && session.isBusy()) return;
    console.warn(`[chat ${cli}] retiring ${session.cli} on ${logKey} — one engine per thread`);
    session.shutdown('model switch');
    drop?.();
  };
  for (const [key, session] of [...sessions]) {
    retire(session, () => {
      if (sessions.get(key) === session) sessions.delete(key);
    });
  }
  // Only claude-family engines are retired here. Codex and banana expose no live
  // session accessor, so their child lingers until idle timeout after a switch.
}

/** Live, already-spawned session for a Claude-family lane, or null.
 *  A passive `hello` uses this to attach to a warm lane WITHOUT spawning.
 *  Reconnects used to run getOrCreateSession, so a client holding N sockets on a
 *  lane started N CLI children; spawning a claude process (multi-KB argv) is
 *  costly enough that a reconnect burst pinned the event loop and starved every
 *  other request, including static assets. Engine children are now created
 *  lazily, on the first real turn. */
export function peekClaudeSession(opts: {
  cli: CliKind;
  repoPath: string;
  chatId?: string;
}): AnySession | null {
  if (!isClaudeFamilyCli(opts.cli)) return null;
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, opts.chatId || 'main');
  const live = sessions.get(key);
  if (!live || !live.isAlive()) return null;
  const priorEngine = lastEngineOf(loadEventLogSync(live.logKey).events);
  if (!live.isBusy() && priorEngine && priorEngine !== opts.cli) {
    live.shutdown('cross-engine context refresh');
    sessions.delete(key);
    return null;
  }
  return live;
}

/** Durable event-log key for a lane - the same key its session would use, so a
 *  cold attach can replay history without constructing a session. Agent home
 *  threads resolve to their engine-free thread key, which is what makes a cold
 *  attach on a *newly picked* engine replay the whole prior conversation. */
export function laneLogKey(cli: CliKind, repoPath: string, chatId = 'main'): string {
  const cwd = cli === 'assistant' ? ASSISTANT_HUB_PATH : repoPath;
  return logKeyFor(cli, cwd, chatId || 'main');
}

/** Consecutive "died before init" spawns per lane. A lane whose engine cannot
 *  start (bad auth, missing CLI, upstream 5xx) was retried on every reconnect,
 *  and every retry is a full process spawn. After BREAKER_TRIP terminal failures
 *  the lane stops spawning for a cooldown and reports why instead of burning the
 *  event loop in a respawn loop. */
const spawnFailures = new Map<string, { count: number; until: number }>();
const BREAKER_TRIP = 3;
const BREAKER_COOLDOWN_MS = 60_000;

/** Concurrent getOrCreateSession calls for the same key (e.g. the hello handler
 *  and the send-reconcile firing on the same socket within a few ms) can each
 *  fall through to a spawn — the second would orphan the first process. Share a
 *  single in-flight spawn per key so only one process is ever created. */
const pendingSpawns = new Map<string, Promise<ClaudeSession>>();

async function spawnSessionOnce(
  cli: CliKind,
  cwd: string,
  chatId: string,
  key: string,
  model: string,
  effort: string,
): Promise<ClaudeSession> {
  const inFlight = pendingSpawns.get(key);
  if (inFlight) return inFlight;
  const spawnPromise = (async () => {
    const logKey = logKeyFor(cli, cwd, chatId);
    let resumeId = (await getSessionId(cli, cwd, chatId)) ?? null;
    let seedFirst = !resumeId;
    await flushEventLog(logKey);
    const restored = loadEventLogSync(logKey);
    const durable = loadEventLogForCompactionSync(logKey);
    const history = durable.length ? durable : restored.events;
    // Who spoke last on this thread. On a model switch that is a DIFFERENT
    // engine, and this engine's own native session id (if it kept one from an
    // earlier stint) is stale by exactly the turns the other brain produced.
    // Resuming it would silently drop them, so seed compact+50 from the shared
    // thread log instead. Cross-engine resume is never attempted: that is what
    // produced `No conversation found with session ID: <uuid>`.
    const priorEngine = lastEngineOf(history);
    const switchedFrom = priorEngine && priorEngine !== cli ? priorEngine : null;
    const skipResume = shouldSkipEngineResume({
      events: history,
      cli,
      cwd,
      sessionId: resumeId,
    });
    if (switchedFrom) {
      console.warn(
        `[chat ${cli}] model switch on ${logKey}: ${switchedFrom} → ${cli} — seeding compact+50 from the thread log, not resuming`,
      );
      if (resumeId) await setSessionId(cli, cwd, '', chatId);
      resumeId = null;
      seedFirst = true;
    } else if (resumeId && (isRotationOwed(logKey) || skipResume)) {
      const why = isRotationOwed(logKey) ? 'overflow-compact owed' : 'seed compact+50 (do not replay jsonl/tool dump)';
      console.warn(
        `[chat ${cli}] ${why} — skipping resume ${resumeId.slice(0, 8)}… for ${logKey}`,
      );
      await setSessionId(cli, cwd, '', chatId);
      resumeId = null;
      seedFirst = true;
    }
    if (sessionsShuttingDown) throw new Error('TARDIS is shutting down');
    return spawnSession(cli, cwd, chatId, resumeId, key, 0, model, effort, seedFirst, switchedFrom);
  })();
  pendingSpawns.set(key, spawnPromise);
  try {
    return await spawnPromise;
  } finally {
    if (pendingSpawns.get(key) === spawnPromise) pendingSpawns.delete(key);
  }
}

async function spawnSession(
  cli: CliKind,
  cwd: string,
  chatId: string,
  resumeId: string | null,
  key: string,
  attempt = 0,
  model?: string,
  effort?: string,
  seedFirst = false,
  switchedFrom: string | null = null,
): Promise<ClaudeSession> {
  if (sessionsShuttingDown) throw new Error('TARDIS is shutting down');
  const breaker = spawnFailures.get(key);
  if (breaker && Date.now() >= breaker.until) {
    // Window closed: those failures are history, not a streak. The count used to
    // reset only on a SUCCESSFUL spawn, so three unrelated failures days apart
    // tripped a breaker that documents itself as "3 in a row in 60s" - and a
    // lane nobody had touched in a week refused its first message.
    spawnFailures.delete(key);
  } else if (breaker && breaker.count >= BREAKER_TRIP) {
    const waitSec = Math.ceil((breaker.until - Date.now()) / 1000);
    throw new Error(
      `this lane's engine failed to start ${breaker.count} times in a row - paused for ${waitSec}s. Check the CLI auth/install, then send again.`,
    );
  }
  assertMemoryAvailableForSpawn(cli);
  const session = new ClaudeSession(cli, cwd, chatId, resumeId, model, effort, seedFirst, switchedFrom);
  sessions.set(key, session);

  session.subscribe((se) => {
    if (se.ev.type === 'closed' && sessions.get(key) === session) {
      sessions.delete(key);
    }
  }, -1, false);

  const ok = await session.ready;
  if (!ok) {
    if (session.isDisposed() || sessionsShuttingDown) {
      throw new Error('claude startup was intentionally cancelled');
    }
    const owner = sessions.get(key);
    if (owner && owner !== session) {
      // Fresh/model replacement won the lane while this older spawn was still
      // initializing. Never delete or overwrite the new owner.
      return owner;
    }
    // The closed-event subscriber may already have removed this exact failed
    // session before ready resolves. An empty slot is still ours to recover;
    // it is not evidence that another spawn superseded us.
    if (owner === session) sessions.delete(key);
    // Recover from a stale persisted session id: drop it and retry without
    // --resume. Only one retry — if even a fresh spawn dies before init,
    // something else is wrong.
    if (resumeId && attempt === 0) {
      await setSessionId(cli, cwd, '', chatId); // clear the bad id
      const replacement = sessions.get(key);
      if (replacement) return replacement;
      return spawnSession(
        cli, cwd, chatId, null, key, attempt + 1, model, effort, true,
      );
    }
    const priorFailure = spawnFailures.get(key);
    spawnFailures.set(key, {
      count: (priorFailure?.count ?? 0) + 1,
      until: Date.now() + BREAKER_COOLDOWN_MS,
    });
    throw new Error('claude exited before initializing — check the CLI install or auth');
  }
  spawnFailures.delete(key);
  return session;
}

export function shutdownAllSessions(): void {
  sessionsShuttingDown = true;
  console.warn(`[chat] shutdownAllSessions called (${sessions.size} session(s))`);
  for (const s of sessions.values()) s.shutdown('shutdownAllSessions');
  sessions.clear();
}

export type LiveSession = {
  cli: CliKind;
  cwd: string;
  chatId: string;
  busy: boolean;
  sessionId: string | null;
  /** ms since epoch of the most recent event (or spawn time if no events yet). */
  lastActivityAt: number;
};

export function activeClaudeSessions(): LiveSession[] {
  const out: LiveSession[] = [];
  for (const s of sessions.values()) {
    out.push({
      cli: s.cli,
      cwd: s.cwd,
      chatId: s.chatId,
      busy: s.isBusy(),
      sessionId: s.sessionId(),
      lastActivityAt: s.lastActivityAt(),
    });
  }
  return out;
}

export function activeChatSessions(): LiveSession[] {
  return [
    ...activeClaudeSessions(),
    ...activeCodexSessions(),
    ...activeBananaSessions(),
  ];
}

export function pruneIdleClaudeSessions(ttlMs: number, now = Date.now()): number {
  let pruned = 0;
  for (const [key, session] of sessions) {
    if (session.isBusy()) continue;
    if (session.listenerCount() > 0) continue;
    if (now - session.lastActivityAt() < ttlMs) continue;
    session.shutdown('idle-prune');
    sessions.delete(key);
    pruned += 1;
  }
  return pruned;
}

// Drop the warm process AND the stored session id so the next spawn starts a
// fresh thread. Picks up any `claude update` you've run since the process
// last spawned.
export async function freshStart(opts: {
  cli: CliKind;
  repoPath: string;
  chatId?: string;
  model?: string;
  effort?: string;
}): Promise<AnySession> {
  const chatId = opts.chatId || 'main';
  if (opts.cli === 'codex' || opts.cli === 'codex-personal') {
    const { freshStartCodex } = await import('./codex-runner.ts');
    return freshStartCodex({ repoPath: opts.repoPath, chatId, cli: opts.cli });
  }
  if (opts.cli === 'banana' || opts.cli === 'banana-local' || opts.cli === 'banana-fireworks') {
    const { freshStartBanana } = await import('./banana-runner.ts');
    return freshStartBanana({ repoPath: opts.repoPath, chatId, cli: opts.cli });
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  // A boot prewarm may still be resolving getSessionId before its constructor
  // claims the map. Let it claim, then replace that exact owner, rather than
  // racing two detached children into the same lane.
  const pending = pendingSpawns.get(key);
  if (pending) await pending.catch(() => null);
  const existing = sessions.get(key);
  if (existing) {
    existing.shutdown('freshStart');
    sessions.delete(key);
  }
  await setSessionId(opts.cli, cwd, '', chatId); // drop the stored id so we don't --resume
  // Wipe the durable log too — otherwise a client whose cache is empty would
  // pull the old thread back via a full (sinceSeq=0) replay after the reset.
  // For an agent home thread that log is the shared, engine-free one, so a
  // fresh start resets the whole thread rather than just this brain's slice.
  const logKey = logKeyFor(opts.cli, cwd, chatId);
  // Stage external compact deletion first. Only clear the visible log after it
  // succeeds, so an MCP outage leaves a coherent, retryable old thread.
  await clearThreadMemory(logKey, chatId);
  await clearEventLog(logKey);
  if (opts.cli === 'xai') await ensureXaiProxy();
  return spawnSession(opts.cli, cwd, chatId, null, key, 0, opts.model, opts.effort);
}

export function dropSession(cli: CliKind, repoPath: string, chatId = 'main'): void {
  const cwd = cli === 'assistant' ? ASSISTANT_HUB_PATH : repoPath;
  const key = keyOf(cli, cwd, chatId);
  const s = sessions.get(key);
  if (s) {
    s.shutdown('dropSession');
    sessions.delete(key);
  }
}

/** Interrupt the in-flight turn for this (cli, repo) pair. Preserves the
 *  saved session_id so the next message resumes the conversation. */
export async function interruptSession(opts: { cli: CliKind; repoPath: string; chatId?: string }): Promise<void> {
  const chatId = opts.chatId || 'main';
  if (opts.cli === 'codex' || opts.cli === 'codex-personal') {
    const { interruptCodex } = await import('./codex-runner.ts');
    await interruptCodex({ repoPath: opts.repoPath, chatId, cli: opts.cli });
    return;
  }
  if (opts.cli === 'banana' || opts.cli === 'banana-local' || opts.cli === 'banana-fireworks') {
    const { interruptBanana } = await import('./banana-runner.ts');
    interruptBanana({ repoPath: opts.repoPath, chatId, cli: opts.cli });
    return;
  }
  const cwd = opts.cli === 'assistant' ? ASSISTANT_HUB_PATH : opts.repoPath;
  const key = keyOf(opts.cli, cwd, chatId);
  const s = sessions.get(key);
  if (s) {
    const keptWarm = await s.interrupt('interruptSession');
    if (!keptWarm && sessions.get(key) === s) sessions.delete(key);
  }
}

// Re-export so callers can ignore the manager and use the class type.
export { ClaudeSession };

// Convenience for index.ts: stable ids per WebSocket subscription.
export function newSubscriberId(): string {
  return randomUUID();
}

const externalThreadListeners = new Set<(logKey: string, se: SeqEvent) => void>();
export function subscribeExternalThreadEvents(fn: (logKey: string, se: SeqEvent) => void): () => void {
  externalThreadListeners.add(fn);
  return () => { externalThreadListeners.delete(fn); };
}

/** Fan out a voice event to warm engine views and cold log-only subscribers. */
export function publishExternalThreadEvent(logKey: string, se: SeqEvent): void {
  for (const session of sessions.values()) {
    if (session.logKey === logKey) session.ingestExternalEvent(se);
  }
  publishCodexExternalEvent(logKey, se);
  publishBananaExternalEvent(logKey, se);
  for (const fn of externalThreadListeners) fn(logKey, se);
}
