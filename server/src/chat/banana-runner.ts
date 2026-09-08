import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { Event, PermissionRequest, PermissionRuleset } from '@opencode-ai/sdk/v2';
import type { CliKind, SessionEvent, SeqEvent } from './runner.ts';
import { getSessionId, setSessionId } from './sessions.ts';
import { adaptImagesForTextModel, getVisionMode } from './vision-adapter.ts';
import { appendEventLog, appendEventLogSync, clearEventLog, compactEventLog, flushEventLog, isPlumbingEvent, latestEventLogSeq, loadEventLogForCompactionSync, loadEventLogSync, reserveEventLogSeq, type PersistedEvent } from './event-log-store.ts';
import { crashTombstoneEvent, crashTombstoneText , restartMarkerEvent } from './crashTombstone.ts';
import { maybeAutoCompact, noteUserTurn, bankRotation, isRotationOwed, clearRotation, peekEnginePrimerThroughSeq, clearThreadMemory, compactedThroughSeq } from './compaction.ts';
import { extractVisibleTurns, WINDOW_TURNS } from './threadWindow.ts';
import { lastEngineOf, logKeyFor } from './threadKey.ts';
import { personaPromptFor } from './personaPrompts.ts';
import { agentForChatId, noteAgentLane } from './agents.ts';
import {
  ASSISTANT_HUB_PATH,
  BANANA_COMMANDS_DIR,
  BANANA_DIR,
  BANANA_GLOBAL_INSTRUCTIONS_FILE,
  CLAUDE_COMMANDS_DIR,
} from './config.ts';
import { localMcpBananaServers } from './local-mcp.ts';
import { computerGuidance } from '../devices/context.ts';
import { redactComputerImages } from '../devices/transcript.ts';
import { saveChatAttachments } from '../routes/chatAttachments.ts';
import { ensureLocalLlmProxy, shutdownLocalLlmProxy } from './local-llm-proxy.ts';
import { conversationGuidanceForTurn } from './conversation-guidance.ts';
import { THREAD_VOICE_STYLE_ADDENDUM } from './voicePrompt.ts';

const EVENT_BUFFER_SIZE = 2000;

// ── Banana v2 ────────────────────────────────────────────────────────────
//
// v1 spawned `banana run --format json` once per turn. That paid a cold-start
// tax (25-40s) every message and could not stream — the answer landed all at
// once. v2 keeps a single persistent `banana serve` process for the whole app
// (the BananaServer singleton), talks to it through the @opencode-ai/sdk v2
// client, and consumes ONE shared SSE event stream. Each turn drives a
// `sdk.session.prompt` and the SDK's `message.part.delta` events are
// normalized into the SAME claude-shaped stream-json vocabulary v1 emitted,
// but now incrementally — real token streaming.
//
// BananaSession keeps its v1 external contract intact (constructor, subscribe,
// send, shutdown, getOrCreateBananaSession, freshStartBanana, interruptBanana,
// activeBananaSessions, pruneIdleBananaSessions, shutdownAllBananaSessions) so
// chat/runner.ts and the WS layer are unchanged.

export type Listener = (e: SeqEvent) => void;

let nextSyntheticId = 1;
const synth = (prefix: string) => `${prefix}_${nextSyntheticId++}`;
type ChatImage = { mediaType: string; base64: string };
type BananaSessionOptions = {
  recoverContextOnNextTurn?: boolean;
  cli?: CliKind;
  durableHistory?: PersistedEvent[];
};
type BananaSendOptions = {
  model?: string;
  /** Reasoning effort (e.g. low|medium|high) for OpenRouter/openai-compatible models. */
  effort?: string;
  hidden?: boolean;
  /** Team-bus delivery: sender-tagged peer_message echo, no compaction tick. */
  peerFrom?: string;
  clientMsgId?: string;
  skipAttachments?: boolean;
  peerFromRole?: string;
  /** Visible peer_message body. Full `text` still goes to the model. */
  peerText?: string;
  /** Correlates queued team delivery admission with its exact turn boundary. */
  peerDeliveryId?: string;
  /** Cancels a queued teammate send before it claims this turn. */
  signal?: AbortSignal;
  autoContinueDepth?: number;
  blockedSideEffectContinueDepth?: number;
  /** Deprecated alias kept so an in-flight hidden continuation from older code
   *  cannot reset the retry guard during a hot reload. */
  blockedSearchContinueDepth?: number;
  voiceMode?: boolean;
};
type GmailSideEffectAction = 'gmail_send' | 'gmail_reply';
type ApprovedGmailDraft = {
  from: string;
  to: string[];
  subject: string;
  body: string;
};
type GmailSideEffectCall = {
  action: GmailSideEffectAction;
  account?: string;
  to?: string[];
  subject?: string;
  body?: string;
};
type BananaUsage = {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
};

/** Per-turn bookkeeping. Tracks the claude-shaped block indices we have
 *  opened so deltas can be routed to the right block.
 *
 *  `emittedLen` is the count of chars already emitted for a text/reasoning
 *  block. The snapshot reconciler in handlePartUpdated emits only
 *  `part.text.slice(emittedLen)`, so a dropped or pre-anchor delta can never
 *  lose text — the next message.part.updated snapshot backfills it. */
type PartRecord = {
  index: number;
  kind: 'text' | 'reasoning' | 'tool';
  started: boolean;
  emittedLen: number;
  /** True once the block's content_block_stop has been emitted. A closed
   *  text/reasoning record is kept in `state.parts` (not deleted) so a
   *  repeated/replayed final snapshot for the same partID cannot recreate it
   *  with emittedLen 0 and re-emit the whole answer as a duplicate block. */
  closed: boolean;
  /** Text blocks start pending so we can classify and hide opencode compact
   *  summaries before a literal `<summary>` block leaks into the UI. */
  hidden?: boolean;
  pendingText?: string;
  /** Tool-only metadata. `emittedLen` tracks emitted input_json_delta length for tools. */
  toolUseId?: string;
  toolName?: string;
  approvedGmailSideEffect?: boolean;
  /** Redacted JSON string used only for UI/log display, never model context. */
  inputText?: string;
};
type BananaTurnState = {
  messageId: string;
  nextBlockIndex: number;
  messageStarted: boolean;
  /** banana partID -> claude block record. */
  parts: Map<string, PartRecord>;
  /** deltas that arrived before their part-created event, keyed by partID. */
  bufferedDeltas: Map<string, string[]>;
  /** banana assistant messageID currently being normalized. A tool-using turn
   *  can have more than one assistant message: one for tool_use blocks, then
   *  a later one for final text after tool results. */
  assistantMessageId: string | null;
  /** True once this turn's prompt has been accepted by the server, or once
   *  the turn has anchored to an assistant message. A `session.status idle`
   *  only completes the turn after one of those — a late/trailing idle from
   *  the PREVIOUS prompt (the banana session is reused) can otherwise land in
   *  the window between this turn's state being created and its prompt being
   *  accepted, and would fake-complete the turn before the real answer streams. */
  promptAccepted: boolean;
  /** Durable team outbox id acknowledged once Banana accepts this prompt. */
  peerDeliveryId?: string;
  /** True when this prompt was prepended with an event-log recovery recap. */
  recoveryRecapUsed: boolean;
  /** True once this turn has actually emitted or observed a tool_use part. */
  sawToolUse: boolean;
  /** True if the current opencode assistant message emitted visible text/tool content. */
  currentMessageVisibleContent: boolean;
  /** True if the current opencode assistant message was just an internal compact summary. */
  currentMessageHiddenCompactionSummary: boolean;
  /** Model id to reuse if an internal compact summary consumes the turn. */
  model?: string;
  /** Preserve spoken-output rules across hidden internal continuations. */
  voiceMode: boolean;
  /** Prevent runaway auto-continue loops if a model keeps compacting. */
  autoContinueDepth: number;
  /** Prevent retry loops if a model keeps launching the same blocked side effect. */
  blockedSideEffectContinueDepth: number;
  /** Single-use approval for a recently displayed email draft. */
  gmailApprovedDraft: ApprovedGmailDraft | null;
  usage: BananaUsage | null;
  done: boolean;
  /** Tear-down for this turn's image temp dir. Carried on the turn (not the
   *  session) so a stale idle event for a previous turn cannot delete the
   *  current turn's files. Idempotent; a no-op when the turn sent no images. */
  cleanup: () => void;
};

// `banana serve` has no internal turn timeout; if the backend stalls the SSE
// stream simply goes quiet. Default 120s of silence aborts the turn. The
// watchdog NEVER kills the shared server — it only ends the stuck turn.
const DEFAULT_STALL_TIMEOUT_MS = 120_000;
// A tool that runs in its own context (e.g. `task` spawning a subagent) streams
// NO events back to the parent banana session while it works, so the parent
// stream goes silent for the tool's whole lifetime. 120s of that silence is
// normal, not a stall — a slow local-model subagent reading files easily
// exceeds it. While a tool is open and unfinished, the watchdog tolerates this
// much cumulative silence before it gives up and aborts. Pure silence with NO
// open tool still aborts at the base timeout.
const DEFAULT_TOOL_STALL_TIMEOUT_MS = 15 * 60_000;
const SESSION_VALIDATION_TIMEOUT_MS = 5_000;

function stallTimeoutMs(): number {
  const raw = process.env.RIVENDELL_BANANA_STALL_TIMEOUT_MS;
  if (!raw) return DEFAULT_STALL_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_TIMEOUT_MS;
}

function toolStallTimeoutMs(): number {
  const raw = process.env.RIVENDELL_BANANA_TOOL_STALL_TIMEOUT_MS;
  if (!raw) return DEFAULT_TOOL_STALL_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOOL_STALL_TIMEOUT_MS;
}

async function validateSessionExists(client: any, sessionID: string): Promise<string | null> {
  try {
    const result = await Promise.race([
      client.session.get({ sessionID }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`session.get timed out after ${SESSION_VALIDATION_TIMEOUT_MS}ms`)),
          SESSION_VALIDATION_TIMEOUT_MS,
        ).unref();
      }),
    ]);
    const error = (result as any)?.error;
    return error ? errorText(error) : null;
  } catch (err) {
    return (err as Error).message;
  }
}

// The launchd service PATH often omits /opt/homebrew/bin, so resolve the
// banana binary to an absolute path. Honor BANANA_BIN, then Homebrew, then
// fall back to bare `banana`.
function resolveBananaBin(): string {
  const override = process.env.BANANA_BIN?.trim();
  if (override) return override;
  const homebrew = '/opt/homebrew/bin/banana';
  if (existsSync(homebrew)) return homebrew;
  const intel = '/usr/local/bin/banana';
  if (existsSync(intel)) return intel;
  return 'banana';
}

const BANANA_GLOBAL_COMMANDS_LINK = join(homedir(), '.config', 'banana', 'commands');
const BANANA_HOME_LINK = join(homedir(), '.bananacode');
const BANANA_GLOBAL_INSTRUCTIONS_LINK = join(BANANA_HOME_LINK, '.banana.md');

async function ensureSymlink(linkPath: string, targetPath: string, label: string): Promise<void> {
  const target = await lstat(targetPath).catch(() => null);
  if (!target) return;

  await mkdir(dirname(linkPath), { recursive: true });
  const existing = await lstat(linkPath).catch(() => null);
  if (!existing) {
    await symlink(targetPath, linkPath, target.isDirectory() ? 'dir' : 'file');
    console.log(`[banana-runner] linked ${label} from ${targetPath}`);
    return;
  }

  if (existing.isSymbolicLink()) {
    const current = await readlink(linkPath).catch(() => '');
    const resolvedCurrent = isAbsolute(current)
      ? resolve(current)
      : resolve(dirname(linkPath), current);
    if (resolvedCurrent === resolve(targetPath)) return;
    await unlink(linkPath);
    await symlink(targetPath, linkPath, target.isDirectory() ? 'dir' : 'file');
    console.log(`[banana-runner] relinked ${label} from ${targetPath}`);
    return;
  }

  if (existing.isDirectory()) {
    const entries = await readdir(linkPath).catch(() => []);
    if (entries.length === 0) {
      await rm(linkPath, { recursive: true, force: true });
      await symlink(targetPath, linkPath, 'dir');
      console.log(`[banana-runner] linked ${label} from ${targetPath}`);
      return;
    }
  }

  if (existing.isFile() && existing.size === 0) {
    await rm(linkPath, { force: true });
    await symlink(targetPath, linkPath, target.isDirectory() ? 'dir' : 'file');
    console.log(`[banana-runner] linked ${label} from ${targetPath}`);
    return;
  }

  console.warn(`[banana-runner] ${linkPath} exists, leaving it unchanged`);
}

async function ensureBananaGlobalInstructionsLinked(): Promise<void> {
  try {
    await ensureSymlink(BANANA_HOME_LINK, BANANA_DIR, 'Banana home');
    const target = await lstat(BANANA_GLOBAL_INSTRUCTIONS_FILE).catch(() => null);
    if (!target) {
      console.warn(`[banana-runner] Banana global instructions missing at ${BANANA_GLOBAL_INSTRUCTIONS_FILE}`);
      return;
    }
    const visible = await lstat(BANANA_GLOBAL_INSTRUCTIONS_LINK).catch(() => null);
    if (!visible) {
      await ensureSymlink(BANANA_GLOBAL_INSTRUCTIONS_LINK, BANANA_GLOBAL_INSTRUCTIONS_FILE, 'Banana global instructions');
    }
  } catch (err) {
    console.warn(`[banana-runner] could not link Banana global instructions: ${(err as Error).message}`);
  }
}

async function ensureBananaCommandsLinked(): Promise<void> {
  try {
    await ensureSymlink(BANANA_GLOBAL_COMMANDS_LINK, BANANA_COMMANDS_DIR, 'Banana commands');
  } catch (err) {
    console.warn(`[banana-runner] could not link Banana commands: ${(err as Error).message}`);
  }
}

type BananaSlashCommand = {
  command: string;
  arguments: string;
  body: string;
  sourcePath: string;
};

type SlashCommandSource = {
  name: string;
  path: string;
  label: string;
};

function slashCommandDirs(cwd: string): Array<{ dir: string; label: string }> {
  const dirs = [
    { dir: join(cwd, '.claude', 'commands'), label: 'project Claude command' },
    { dir: join(ASSISTANT_HUB_PATH, '.claude', 'commands'), label: 'ASSISTANT-HUB Claude command' },
    { dir: CLAUDE_COMMANDS_DIR, label: 'shared Claude command' },
    { dir: BANANA_COMMANDS_DIR, label: 'Banana command' },
  ];
  const seen = new Set<string>();
  return dirs.filter(({ dir }) => {
    const normalized = resolve(dir);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function listMarkdownCommandSources(dir: string, label: string, prefix: string[] = []): Promise<SlashCommandSource[]> {
  let files: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }> = [];
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SlashCommandSource[] = [];
  for (const file of files) {
    if (file.name.startsWith('.')) continue;
    const path = join(dir, file.name);
    if (file.isDirectory()) {
      out.push(...await listMarkdownCommandSources(path, label, [...prefix, file.name]));
      continue;
    }
    if (!file.isFile() || !file.name.endsWith('.md')) continue;
    out.push({
      name: [...prefix, file.name.slice(0, -3)].join(':'),
      path,
      label,
    });
  }
  return out;
}

function commandNameMatches(input: string, command: string): boolean {
  const lowerInput = input.toLowerCase();
  const lowerCommand = command.toLowerCase();
  return lowerInput === lowerCommand || lowerInput === lowerCommand.replace(/:/g, '/');
}

async function findMarkdownCommand(input: string, cwd: string): Promise<SlashCommandSource | null> {
  for (const { dir, label } of slashCommandDirs(cwd)) {
    const commands = await listMarkdownCommandSources(dir, label);
    for (const command of commands) {
      if (commandNameMatches(input, command.name)) {
        return command;
      }
    }
  }
  return null;
}

async function readSlashCommand(input: string, cwd: string): Promise<SlashCommandSource & { body: string } | null> {
  const found = await findMarkdownCommand(input, cwd);
  if (!found) return null;
  try {
    return { ...found, body: await readFile(found.path, 'utf8') };
  } catch (err) {
    console.warn(`[chat banana] failed to read slash command ${found.path}: ${(err as Error).message}`);
    return null;
  }
}

async function parseBananaSlashCommand(text: string, cwd: string): Promise<BananaSlashCommand | null> {
  const match = text.trimStart().match(/^\/([A-Za-z0-9][A-Za-z0-9_:/-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const command = await readSlashCommand(match[1], cwd);
  if (!command) return null;
  return {
    command: command.name,
    arguments: match[2] ?? '',
    body: command.body,
    sourcePath: command.path,
  };
}

function expandBananaSlashCommand(command: BananaSlashCommand): string {
  const args = command.arguments.trim();
  return [
    `The user invoked /${command.command}. Execute the slash command instructions below as the active task.`,
    `Command source: ${command.sourcePath}`,
    '',
    '<slash-command>',
    command.body.trim(),
    '</slash-command>',
    '',
    '<command-args>',
    args || '(none)',
    '</command-args>',
    '',
    'Important: external side effects remain draft/review-first. For email, show the full draft with From, To, Subject, and Body, then wait for the user to explicitly approve in a later message before sending.',
  ].join('\n');
}

function normalizeActionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toolInputRecord(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return input;
  if (typeof input !== 'string') return {};
  try {
    const parsed = JSON.parse(input);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function emailAddressesFrom(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,]/) : [];
  const addresses = raw
    .flatMap((item) => {
      const text = String(item).trim();
      const angle = text.match(/<([^>]+)>/);
      const candidate = (angle ? angle[1] : text).trim();
      const email = candidate.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? candidate;
      return email ? [email] : [];
    })
    .map((item) => item.toLowerCase())
    .filter(Boolean)
    .sort();
  return addresses.length ? Array.from(new Set(addresses)) : undefined;
}

function normalizeDraftBody(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function sameString(a: string | undefined, b: string | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim();
}

function sameEmailList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a?.length || !b?.length || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function sameBody(a: string | undefined, b: string | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && normalizeDraftBody(a) === normalizeDraftBody(b);
}

function extractEmailDraft(text: string): ApprovedGmailDraft | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const fields: Partial<ApprovedGmailDraft & { toRaw: string }> = {};
  let bodyLine = -1;
  let bodyPrefix = '';

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*(?:[-*]\s*)?\*{0,2}(from|to|subject|body)\s*:\*{0,2}\s*(.*)$/i);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2] ?? '';
    if (field === 'body') {
      bodyLine = index;
      bodyPrefix = value;
      break;
    }
    if (field === 'from' && !fields.from) fields.from = value.trim().toLowerCase();
    if (field === 'to' && !fields.toRaw) fields.toRaw = value.trim();
    if (field === 'subject' && !fields.subject) fields.subject = value.trim();
  }

  if (bodyLine < 0) return null;
  const from = emailAddressesFrom(fields.from)?.[0];
  const to = emailAddressesFrom(fields.toRaw);
  const body = normalizeDraftBody([bodyPrefix, ...lines.slice(bodyLine + 1)].join('\n'));
  if (!from || !to?.length || !fields.subject || !body) return null;
  return { from, to, subject: fields.subject, body };
}

function gmailSideEffectAction(toolName: string, input: unknown): GmailSideEffectAction | null {
  const tool = normalizeActionName(toolName);
  if (tool.endsWith('gmailsend')) return 'gmail_send';
  if (tool.endsWith('gmailreply')) return 'gmail_reply';

  const inputRecord = toolInputRecord(input);
  const action = typeof inputRecord.action === 'string' ? normalizeActionName(inputRecord.action) : '';
  if (tool.includes('gmail') || tool.includes('mail')) {
    if (action === 'gmailsend' || action === 'send') return 'gmail_send';
    if (action === 'gmailreply' || action === 'reply') return 'gmail_reply';
  }

  return null;
}

function gmailSideEffectCall(toolName: string, input: unknown): GmailSideEffectCall | null {
  const action = gmailSideEffectAction(toolName, input);
  if (!action) return null;
  const inputRecord = toolInputRecord(input);
  const params = isRecord(inputRecord.params) ? inputRecord.params : inputRecord;
  return {
    action,
    account: stringValue(params.account ?? params.from_account ?? params.from)?.toLowerCase(),
    to: emailAddressesFrom(params.to),
    subject: stringValue(params.subject),
    body: stringValue(params.body),
  };
}

function approvedDraftMatchesCall(draft: ApprovedGmailDraft, call: GmailSideEffectCall): boolean {
  if (!sameString(draft.from, call.account)) return false;
  if (!sameBody(draft.body, call.body)) return false;
  if (call.action === 'gmail_reply') {
    return call.subject === undefined || sameString(draft.subject, call.subject);
  }
  return sameEmailList(draft.to, call.to) && sameString(draft.subject, call.subject);
}

function gmailSideEffectBlockMessage(toolName: string, input: unknown, approvedDraft: ApprovedGmailDraft | null): string | null {
  const call = gmailSideEffectCall(toolName, input);
  if (!call) return null;
  if (approvedDraft && approvedDraftMatchesCall(approvedDraft, call)) return null;
  const label = call.action === 'gmail_reply' ? 'reply' : 'send';
  const mismatch = approvedDraft
    ? 'The attempted Gmail payload does not match the approved draft.'
    : 'No matching approved draft was found for this Gmail payload.';
  return [
    `Banana blocked a Gmail ${label}.`,
    'Email sends/replies require a previously displayed full draft with From, To, Subject, and Body, plus the user\'s explicit approval in a later message.',
    mismatch,
    'Draft it for review instead.',
  ].join(' ');
}

function gmailSideEffectPermissionMessage(request: PermissionRequest, approvedDraft: ApprovedGmailDraft | null): string | null {
  const permission = String(request.permission ?? '');
  const direct = gmailSideEffectBlockMessage(permission, request.metadata, approvedDraft);
  if (direct) return direct;
  for (const pattern of request.patterns ?? []) {
    const fromPattern = gmailSideEffectBlockMessage(pattern, request.metadata, approvedDraft);
    if (fromPattern) return fromPattern;
  }
  return null;
}

function isExplicitEmailApprovalText(text: string): boolean {
  if (/\b(?:don't|do not|dont|not yet|wait|hold|stop|cancel|no)\b/i.test(text)) return false;
  return /\b(?:send it|send this|send that|send the (?:email|draft)|send email|please send|approved|approve|looks good|go ahead|yes|yep|ok|okay|ship it)\b/i.test(text);
}

function hasEmailDraftField(text: string, field: string, valuePattern = ''): boolean {
  const re = new RegExp(`(^|\\n)\\s*(?:[-*]\\s*)?\\*{0,2}${field}\\s*:\\*{0,2}\\s*${valuePattern}`, 'i');
  return re.test(text);
}

function looksLikeEmailDraftText(text: string): boolean {
  return hasEmailDraftField(text, 'from', '.*@')
    && hasEmailDraftField(text, 'to', '.*@')
    && hasEmailDraftField(text, 'subject', '\\S')
    && hasEmailDraftField(text, 'body');
}

const CONFIGURED_SERVE_PORT = configuredServePort();
function configuredServePort(): number | null {
  const raw = process.env.RIVENDELL_BANANA_SERVE_PORT;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return null;
}

function pickServePort(previous?: number): number {
  if (CONFIGURED_SERVE_PORT) return CONFIGURED_SERVE_PORT;
  let next: number;
  do {
    next = 41000 + Math.floor(Math.random() * 4000);
  } while (next === previous);
  return next;
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try { child.kill(signal); } catch {}
  if (child.pid) {
    try { process.kill(-child.pid, signal); } catch {}
  }
}

// ── OpenRouter (direct) + Fireworks ──────────────────────────────────────
//
// Banana's built-in `openrouter` provider only autoloads when it has an API
// key. With no key it registers ZERO models, so any OpenRouter pick fails
// with "model not found".
//
// History: this used to route through a `monkey-models` Railway proxy that
// supplied a shared OpenRouter key. That proxy was deleted (every call now
// 404s "Application not found"), which broke OpenRouter entirely AND killed
// the `monkey/*` tiers (Silverback/Mandrill/Tamarin) that pointed at the same
// dead app. We now go DIRECT to OpenRouter with the operator's OPENROUTER_API_KEY,
// overriding the `openrouter` provider's baseURL + apiKey inline via the
// BANANA_CONFIG_CONTENT env var. Any model id is forwarded straight to
// OpenRouter, so picks past the registered cap still route.
const OPENROUTER_BASE_URL =
  process.env.RIVENDELL_OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';

/** Real OpenRouter API key (Doppler: OPENROUTER_API_KEY). Empty if unset —
 *  the openrouter provider then registers no models and picks fail cleanly
 *  instead of hammering a dead proxy. */
function resolveOpenRouterKey(): string {
  return process.env.OPENROUTER_API_KEY?.trim() || '';
}

/** Default OpenRouter model used when the `banana` engine is sent an empty or
 *  non-OpenRouter id (e.g. a stale `monkey/*` tier). Keeps a turn from silently
 *  falling back to Banana's built-in (now dead) monkey default. */
const OPENROUTER_DEFAULT_MODEL = 'openrouter/anthropic/claude-sonnet-5';

// ── Fireworks (direct, PERSONAL key) ─────────────────────────────────────
// Fireworks AI exposes an OpenAI-compatible API. We register a custom
// `fireworks` provider (baseURL + apiKey + auto-discovered models) so the
// Fireworks engine routes `fireworks/<account-model-id>` picks directly. Auth
// uses FIREWORKS_API_KEY from the assistant Doppler project.
const FIREWORKS_BASE_URL =
  process.env.RIVENDELL_FIREWORKS_BASE_URL?.trim() || 'https://api.fireworks.ai/inference/v1';

function resolveFireworksKey(): string {
  return process.env.FIREWORKS_API_KEY?.trim() || '';
}

/** Default Fireworks model when the `banana-fireworks` engine is sent an empty
 *  or non-Fireworks id. GLM 5.2 (1M ctx) is the strongest in the current
 *  serverless set; if it isn't available the request errors locally rather
 *  than routing elsewhere. */
const FIREWORKS_DEFAULT_MODEL = 'fireworks/accounts/fireworks/models/glm-5p2';

// Fireworks' OpenAI-compatible /inference/v1/models only returns ~7 stale,
// account-scoped rows — not the real serverless set. The control-plane library
// (/v1/accounts/fireworks/models) carries every model plus a `supportsServerless`
// flag, so we page through that and keep the serverless rows. This is the
// difference between the picker showing 7 models vs the full ~14 serverless ones.
const FIREWORKS_CONTROL_BASE_URL =
  process.env.RIVENDELL_FIREWORKS_CONTROL_BASE_URL?.trim() || 'https://api.fireworks.ai/v1';
// Serverless models that aren't chat completions (image/embedding/reranker) —
// flagged supports_chat=false so the config/picker mappers drop them.
const FIREWORKS_NON_CHAT_RE = /embedding|reranker|rerank|flux|whisper|sdxl|stable-diffusion|image-?gen/i;

const MODEL_CATALOG_TTL_MS = 60 * 1000;
const MODEL_CATALOG_TIMEOUT_MS = 10_000;

type CatalogCache = { rows: unknown[] | null; at: number; inflight: Promise<unknown[]> | null };
const openrouterCatalog: CatalogCache = { rows: null, at: 0, inflight: null };
const fireworksCatalog: CatalogCache = { rows: null, at: 0, inflight: null };

type BananaPickerModel = {
  id: string;
  name: string;
  context_length?: number;
};

function numberFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizedModalities(value: unknown): string[] {
  if (!Array.isArray(value)) return ['text'];
  const allowed = new Set(['text', 'audio', 'image', 'video', 'pdf']);
  const out: string[] = [];
  for (const item of value) {
    const raw = String(item);
    const normalized = raw === 'file' ? 'pdf' : raw;
    if (allowed.has(normalized) && !out.includes(normalized)) out.push(normalized);
  }
  return out.length ? out : ['text'];
}

/** Fetch an OpenAI-style `{data:[...]}` model catalog with a short TTL cache.
 *  On any failure (no key, non-2xx, timeout) the prior cached rows are kept so
 *  a transient blip doesn't empty the picker. */
async function fetchModelCatalog(
  label: string,
  url: string,
  apiKey: string,
  cache: CatalogCache,
): Promise<unknown[]> {
  const fresh = cache.rows !== null && Date.now() - cache.at < MODEL_CATALOG_TTL_MS;
  if (fresh) return cache.rows as unknown[];
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    if (!apiKey) {
      console.warn(`[banana-runner] ${label} catalog: no API key set, returning empty`);
      return cache.rows ?? [];
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_CATALOG_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        console.warn(`[banana-runner] ${label} catalog returned ${response.status}, keeping prior catalog`);
        return cache.rows ?? [];
      }
      const body = await response.json() as { data?: unknown[] };
      const models = Array.isArray(body.data) ? body.data : [];
      if (models.length > 0) {
        cache.rows = models;
        cache.at = Date.now();
      }
      return cache.rows ?? [];
    } catch (error) {
      const reason = (error as Error)?.name === 'AbortError'
        ? 'timeout'
        : ((error as Error)?.message || 'unknown error');
      console.warn(`[banana-runner] ${label} catalog fetch failed (${reason}), keeping prior catalog`);
      return cache.rows ?? [];
    } finally {
      clearTimeout(timeout);
      cache.inflight = null;
    }
  })();

  return cache.inflight;
}

function fetchOpenRouterCatalog(): Promise<unknown[]> {
  return fetchModelCatalog('openrouter', `${OPENROUTER_BASE_URL}/models`, resolveOpenRouterKey(), openrouterCatalog);
}

// Page the Fireworks control-plane library, keep serverless rows, and normalize
// each to the same shape the old /inference/v1/models path produced
// ({ id, supports_chat, supports_image_input, supports_tools, context_length })
// so the downstream config/picker mappers stay unchanged. Short TTL cache +
// keep-prior-on-failure, matching fetchModelCatalog.
function fetchFireworksCatalog(): Promise<unknown[]> {
  const apiKey = resolveFireworksKey();
  const cache = fireworksCatalog;
  const fresh = cache.rows !== null && Date.now() - cache.at < MODEL_CATALOG_TTL_MS;
  if (fresh) return Promise.resolve(cache.rows as unknown[]);
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    if (!apiKey) {
      console.warn('[banana-runner] Fireworks catalog: no API key set, returning empty');
      return cache.rows ?? [];
    }
    try {
      const rows: Record<string, unknown>[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 8; page++) {
        const url =
          `${FIREWORKS_CONTROL_BASE_URL}/accounts/fireworks/models?pageSize=200` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), MODEL_CATALOG_TIMEOUT_MS);
        let body: Record<string, unknown>;
        try {
          const response = await fetch(url, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
          if (!response.ok) {
            console.warn(`[banana-runner] Fireworks control-plane returned ${response.status}, keeping prior catalog`);
            return cache.rows ?? [];
          }
          body = recordOf(await response.json());
        } finally {
          clearTimeout(timeout);
        }
        const models = Array.isArray(body.models) ? body.models : [];
        for (const model of models) {
          const rec = recordOf(model);
          if (rec.supportsServerless !== true) continue;
          const id = typeof rec.name === 'string' ? rec.name.trim() : '';
          if (!id) continue;
          rows.push({
            id,
            supports_chat: !FIREWORKS_NON_CHAT_RE.test(id),
            supports_image_input: rec.supportsImageInput === true,
            supports_tools: rec.supportsTools !== false,
            context_length: numberFrom(rec.contextLength),
          });
        }
        pageToken =
          typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
        if (!pageToken) break;
      }
      if (rows.length > 0) {
        cache.rows = rows;
        cache.at = Date.now();
      }
      return cache.rows ?? [];
    } catch (error) {
      const reason =
        (error as Error)?.name === 'AbortError' ? 'timeout' : (error as Error)?.message || 'unknown error';
      console.warn(`[banana-runner] Fireworks control-plane fetch failed (${reason}), keeping prior catalog`);
      return cache.rows ?? [];
    } finally {
      cache.inflight = null;
    }
  })();
  return cache.inflight;
}

// Does the model the next turn will run natively accept image input? Local
// (LM Studio chat) models are always registered text-only here, so they never
// do. OpenRouter models are looked up in the live catalog by their image input
// modality. Anything we can't resolve is treated as text-only (safer: the
// vision adapter kicks in rather than silently dropping the image).
async function bananaModelSupportsImages(cli: CliKind, modelId: string | undefined): Promise<boolean> {
  if (cli === 'banana-local') return false;
  const parsed = parseModel((modelId || '').trim());
  if (!parsed) return false;
  try {
    if (parsed.providerID === 'fireworks') {
      const rows = await fetchFireworksCatalog();
      const row = rows
        .map((r) => recordOf(r))
        .find((r) => (typeof r.id === 'string' ? r.id.trim() : '') === parsed.modelID);
      return row?.supports_image_input === true;
    }
    // OpenRouter: match on the bare model id (catalog rows carry no provider
    // prefix), keyed off the modality list in the row's architecture.
    const rows = await fetchOpenRouterCatalog();
    const row = rows
      .map((r) => recordOf(r))
      .find((r) => (typeof r.id === 'string' ? r.id.trim() : '') === parsed.modelID);
    if (!row) return false;
    const architecture = recordOf(row.architecture);
    return normalizedModalities(architecture.input_modalities).includes('image');
  } catch {
    return false;
  }
}

function toPickerModel(model: unknown): BananaPickerModel | null {
  const row = recordOf(model);
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id || !id.includes('/')) return null;
  const context = numberFrom(row.context_length, recordOf(row.top_provider).context_length);
  return {
    id,
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id,
    ...(context ? { context_length: context } : {}),
  };
}

function toProviderModelConfig(model: unknown): [string, Record<string, unknown>] | null {
  const row = recordOf(model);
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id || !id.includes('/')) return null;

  const architecture = recordOf(row.architecture);
  const topProvider = recordOf(row.top_provider);
  const supported = Array.isArray(row.supported_parameters)
    ? row.supported_parameters.map((item) => String(item))
    : [];
  const input = normalizedModalities(architecture.input_modalities);
  const outputModalities = normalizedModalities(architecture.output_modalities);
  const context = numberFrom(row.context_length, topProvider.context_length);
  const output = numberFrom(topProvider.max_completion_tokens, context) ?? context;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
  const lower = `${id} ${name}`.toLowerCase();
  const reasoning = supported.includes('reasoning') ||
    supported.includes('include_reasoning') ||
    lower.includes('reasoning') ||
    lower.includes('thinking');

  const config: Record<string, unknown> = {
    id,
    name,
    attachment: input.some((item) => item !== 'text'),
    reasoning,
    temperature: supported.length === 0 || supported.includes('temperature'),
    tool_call: supported.length === 0 ||
      supported.includes('tools') ||
      supported.includes('tool_choice') ||
      supported.includes('function_calling'),
    modalities: { input, output: outputModalities },
  };
  if (context && output) {
    config.limit = {
      context,
      input: context,
      output,
    };
  }
  if (reasoning) {
    config.interleaved = { field: 'reasoning_details' };
    // Expose low/medium/high reasoning-effort variants so the effort picker works
    // on EVERY reasoning-capable OpenRouter model — including ones Banana's
    // transform.ts deliberately omits (glm/kimi/qwen/deepseek). Banana mergeDeep's
    // these config variants into the model (provider.ts), then the prompt `variant`
    // selects one -> {reasoning:{effort}} in the OpenRouter request body. OpenRouter
    // normalizes effort per-model (mapping to a thinking-token budget where a model
    // has no native effort tiers), so this degrades gracefully.
    config.variants = {
      low: { reasoning: { effort: 'low' } },
      medium: { reasoning: { effort: 'medium' } },
      high: { reasoning: { effort: 'high' } },
    };
  }
  return [id, config];
}

// Full OpenRouter catalog (~350 models / ~150KB JSON) is written to a config
// FILE (BANANA_CONFIG), not BANANA_CONFIG_CONTENT. Putting that blob in the
// spawn env exceeds Linux's ~128KB per-arg limit (E2BIG). Banana still requires
// every pick to exist in provider.models (ProviderModelNotFoundError), so the
// picker and the registered config must stay 1:1 with the live catalog.
async function openrouterConfigModels(): Promise<Record<string, Record<string, unknown>>> {
  const rows = await fetchOpenRouterCatalog();
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const next = toProviderModelConfig(row);
    if (next) out[next[0]] = next[1];
  }
  return out;
}

export async function listBananaOpenRouterModels(): Promise<BananaPickerModel[]> {
  // Advertise the full live catalog. openrouterConfigModels() registers the
  // same set via the Banana config file, so every pick is runnable.
  const rows = await fetchOpenRouterCatalog();
  return rows
    .filter((row) => toProviderModelConfig(row) !== null)
    .map(toPickerModel)
    .filter((model): model is BananaPickerModel => model !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Fireworks model config + picker ──────────────────────────────────────
// Fireworks /v1/models rows look like:
//   { id, supports_chat, supports_image_input, supports_tools, context_length }
// We register chat-capable models only (skips image/FLUX models) and attach
// low/medium/high effort variants to reasoning-capable models. Fireworks is an
// openai-compatible provider, so the variant body must be `{reasoningEffort}`
// (→ `reasoning_effort` on the wire), NOT OpenRouter's `{reasoning:{effort}}`.
const FIREWORKS_REASONING_RE =
  /glm|deepseek|kimi|k2p|qwen|gpt-oss|minimax|thinking|reason|\br1\b|big-pickle/i;

function toFireworksPickerModel(model: unknown): BananaPickerModel | null {
  const row = recordOf(model);
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id || row.supports_chat === false) return null;
  const context = numberFrom(row.context_length);
  return {
    id,
    name: id.split('/').pop() || id,
    ...(context ? { context_length: context } : {}),
  };
}

function toFireworksProviderModelConfig(model: unknown): [string, Record<string, unknown>] | null {
  const row = recordOf(model);
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id || row.supports_chat === false) return null;

  const context = numberFrom(row.context_length);
  const name = id.split('/').pop() || id;
  const attachment = row.supports_image_input === true;
  const toolCall = row.supports_tools !== false;
  const reasoning = FIREWORKS_REASONING_RE.test(id);
  // Cap requested output so input + output fits the context window with room
  // for Banana's system prompt + tool schemas.
  const output = context ? Math.min(32768, Math.max(4096, Math.floor(context / 4))) : undefined;

  const config: Record<string, unknown> = {
    id,
    name,
    attachment,
    reasoning,
    temperature: true,
    tool_call: toolCall,
    modalities: { input: attachment ? ['text', 'image'] : ['text'], output: ['text'] },
  };
  if (context) {
    config.limit = { context, input: context, output: output ?? context };
  }
  if (reasoning) {
    // openai-compatible effort variants (see transform.ts grok-3-mini branch):
    // the non-openrouter shape is `{reasoningEffort}`. Config variants merge in
    // and override Banana's auto-generated ones (provider.ts ~2160), which
    // return {} for glm/kimi/qwen/deepseek — so this is what makes the effort
    // selector actually work for those families on Fireworks.
    config.variants = {
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
    };
  }
  return [id, config];
}

async function fireworksConfigModels(): Promise<Record<string, Record<string, unknown>>> {
  const rows = await fetchFireworksCatalog();
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const next = toFireworksProviderModelConfig(row);
    if (next) out[next[0]] = next[1];
  }
  return out;
}

/** Picker catalog for the Fireworks engine — bare ids (the client prefixes
 *  `fireworks/`). Only chat-capable models, matching the registered config. */
export async function listFireworksModels(): Promise<BananaPickerModel[]> {
  const rows = await fetchFireworksCatalog();
  return rows
    .filter((row) => toFireworksProviderModelConfig(row) !== null)
    .map(toFireworksPickerModel)
    .filter((model): model is BananaPickerModel => model !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True unless explicitly disabled. A deploy can set
 *  RIVENDELL_BANANA_OPENROUTER_VIA_MONKEY (legacy name kept for back-compat) to
 *  a falsy value to turn the openrouter provider override off without a code
 *  change. Accepts the common boolean-off spellings (false/0/no/off). */
function openrouterProviderEnabled(): boolean {
  const raw = process.env.RIVENDELL_BANANA_OPENROUTER_VIA_MONKEY?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

type BananaMcpConfig =
  | {
      type: 'local';
      command: string[];
      environment?: Record<string, string>;
      enabled?: boolean;
      timeout?: number;
    }
  | {
      type: 'remote';
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
      oauth?: false | Record<string, string>;
      timeout?: number;
    }
  | { enabled: boolean };

const DEFAULT_MCP_MIRROR_SERVERS = new Set([
  'assistant-mcp',
  'playwright',
  'supabase-elite',
  'supabase-personal',
  'game-assets-mcp',
  'rivendell-team',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    out[key] = String(item);
  }
  return Object.keys(out).length ? out : undefined;
}

function enabledByEnv(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

function remoteBananaMcpEnabled(): boolean {
  return enabledByEnv(process.env.RIVENDELL_BANANA_REMOTE_MCP ?? process.env.BANANA_REMOTE_MCP);
}

function projectBananaMcpEnabled(): boolean {
  return enabledByEnv(process.env.RIVENDELL_BANANA_PROJECT_MCP ?? process.env.BANANA_PROJECT_MCP);
}

function shouldMirrorMcpServer(name: string): boolean {
  const raw = process.env.RIVENDELL_BANANA_MCP_MIRROR_SERVERS ?? process.env.BANANA_MCP_MIRROR_SERVERS;
  if (!raw?.trim()) return DEFAULT_MCP_MIRROR_SERVERS.has(name);
  const requested = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return requested.includes('*') || requested.includes(name);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function isRelativePathLike(value: string): boolean {
  return (
    value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\')
  );
}

function resolveMcpPathPart(value: string, sourceDir: string): string {
  if (!isRelativePathLike(value) || isAbsolute(value) || isWindowsAbsolutePath(value)) return value;
  return resolve(sourceDir, value);
}

function stripJsoncForParse(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < input.length && input[i] !== '\n' && input[i] !== '\r') i += 1;
      i -= 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        if (input[i] === '\n' || input[i] === '\r') out += input[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    out += ch;
  }

  let cleaned = '';
  inString = false;
  escaped = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      cleaned += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j += 1;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    cleaned += ch;
  }
  return cleaned;
}

function parseJsoncObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(stripJsoncForParse(raw));
  if (!isRecord(parsed)) throw new Error('config content must be a JSON object');
  return parsed;
}

function mapClaudeMcpServer(name: string, value: unknown, sourceDir: string): BananaMcpConfig | null {
  if (!isRecord(value)) return null;
  if (value.enabled === false || value.disabled === true) return { enabled: false };

  const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  const timeout = typeof value.timeout === 'number' && value.timeout > 0 ? value.timeout : undefined;

  const command = typeof value.command === 'string' ? value.command.trim() : '';
  if ((type === 'stdio' || type === 'local' || (!type && command)) && command) {
    const args = Array.isArray(value.args) ? value.args.map((arg) => resolveMcpPathPart(String(arg), sourceDir)) : [];
    const environment = toStringMap(value.env ?? value.environment);
    return {
      type: 'local',
      command: [resolveMcpPathPart(command, sourceDir), ...args],
      ...(environment ? { environment } : {}),
      ...(timeout ? { timeout } : {}),
    };
  }

  const url = typeof value.url === 'string' ? value.url.trim() : '';
  if ((type === 'http' || type === 'sse' || type === 'remote' || (!type && url)) && url) {
    const headers = toStringMap(value.headers);
    return {
      type: 'remote',
      url,
      ...(headers ? { headers } : {}),
      ...(timeout ? { timeout } : {}),
      // Mirrored servers already carry their auth in config/env. Avoid
      // Banana's OAuth auto-detection trying to pop an interactive flow.
      oauth: false,
    };
  }

  console.warn(`[banana-runner] skipping unsupported Claude MCP server "${name}"`);
  return null;
}

function readClaudeMcpServers(
  projectPathHint?: string,
  opts: { includeProjectMcp?: boolean } = {},
): Record<string, BananaMcpConfig> {
  if (enabledByEnv(process.env.RIVENDELL_BANANA_MCP_MIRROR_DISABLED ?? process.env.BANANA_MCP_MIRROR_DISABLED)) {
    return {};
  }

  const merged: Record<string, BananaMcpConfig> = {};
  const addServers = (servers: unknown, sourceDir: string) => {
    if (!isRecord(servers)) return;
    for (const [name, entry] of Object.entries(servers)) {
      if (!shouldMirrorMcpServer(name)) continue;
      const mapped = mapClaudeMcpServer(name, entry, sourceDir);
      if (mapped) merged[name] = mapped;
    }
  };

  const readJson = (filePath: string): Record<string, unknown> | null => {
    if (!existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      return isRecord(parsed) ? parsed : null;
    } catch (error) {
      console.warn(`[banana-runner] failed to parse ${filePath} for MCP mirroring: ${errorText(error)}`);
      return null;
    }
  };

  const claudeConfigPath = process.env.CLAUDE_CONFIG_FILE?.trim() || join(homedir(), '.claude.json');
  const claudeConfig = readJson(claudeConfigPath);
  if (claudeConfig) addServers(claudeConfig.mcpServers, dirname(claudeConfigPath));

  const projects = claudeConfig && isRecord(claudeConfig.projects) ? claudeConfig.projects : undefined;
  const envProjectHint =
    process.env.RIVENDELL_BANANA_MCP_PROJECT_PATH ?? process.env.BANANA_MCP_PROJECT_PATH;
  if (opts.includeProjectMcp || envProjectHint) {
    const fallbackProjectHints = projectPathHint
      ? []
      : [process.env.ELROND_WORKSPACE_PATH, process.cwd()];
    const projectCandidates = [
      envProjectHint,
      projectPathHint,
      ...(opts.includeProjectMcp ? fallbackProjectHints : []),
    ].flatMap((item) => {
      if (typeof item !== 'string') return [];
      const trimmed = item.trim();
      return trimmed ? [trimmed] : [];
    });

    for (const projectPath of Array.from(new Set(projectCandidates))) {
      const mcpJson = readJson(join(projectPath, '.mcp.json'));
      if (mcpJson) addServers(mcpJson.mcpServers, projectPath);
      const project = projects?.[projectPath];
      if (isRecord(project)) addServers(project.mcpServers, projectPath);
    }
  }

  const names = Object.keys(merged);
  if (names.length) {
    console.log(`[banana-runner] mirrored ${names.length} MCP server(s) into Banana: ${names.join(', ')}`);
  }
  return merged;
}

/** Stable signature for a Banana config blob. The actual config written for
 *  `banana serve` is left untouched — only the comparison key is canonicalized
 *  so semantically identical configs with shuffled key order (Claude rewriting
 *  ~/.claude.json, OpenRouter returning models in a new order) don't trigger
 *  a serve restart and wipe every chat's context. */
function canonicalConfigSignature(configContent: string | null): string {
  if (!configContent) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(configContent);
  } catch {
    // Unparseable input falls back to the raw string — better to over-restart
    // than to silently treat two genuinely different blobs as equal.
    return configContent;
  }
  return canonicalJson(parsed);
}

/** On-disk Banana config path. Full OpenRouter+Fireworks catalogs are too large
 *  for BANANA_CONFIG_CONTENT (spawn E2BIG); BANANA_CONFIG points at this file. */
const BANANA_SERVE_CONFIG_PATH = join(homedir(), '.rivendell', 'banana-serve-config.json');

async function writeBananaServeConfig(configContent: string): Promise<string> {
  await mkdir(dirname(BANANA_SERVE_CONFIG_PATH), { recursive: true });
  const tmpPath = `${BANANA_SERVE_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, configContent, { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, BANANA_SERVE_CONFIG_PATH);
  return BANANA_SERVE_CONFIG_PATH;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(String(value));
}

/** Inline JSON config that overrides Banana's `openrouter` provider to route
 *  through the monkey-models proxy. Passed to `banana serve` as
 *  BANANA_CONFIG_CONTENT.
 *
 *  If the parent environment already carries an inline Banana config
 *  (BANANA_CONFIG_CONTENT or its OPENCODE_CONFIG_CONTENT alias), the
 *  OpenRouter override is MERGED into it rather than replacing it wholesale,
 *  so operator-supplied providers/agents/permissions survive. A non-JSON or
 *  unparseable existing value is ignored (logged) and only the override is
 *  used — better than crashing the spawn. */
// ── Local LLM (LM Studio on the TARDIS host) ─────────────────────────────
// The "Local" engine talks DIRECTLY to LM Studio's on-box OpenAI-compatible
// endpoint (default http://localhost:1234/v1). We register whatever text model
// LM Studio currently has loaded as a custom openai-compatible provider
// `local`; model ids are `local/<lmstudio-model-id>`. No serve/download — load
// models in the LM Studio app and they show up here automatically.
const LOCAL_VLLM_BASE_URL =
  process.env.RIVENDELL_LOCAL_LLM_BASE_URL?.trim() ||
  process.env.RIVENDELL_VLLM_BASE_URL?.trim() ||
  'http://localhost:1234/v1';

type LocalVllmModel = { id: string; maxLen: number };

// LM Studio mislabels text models as type:'vlm' (e.g. qwen3.8-27b), so the
// `type` field can't be trusted to tell text from vision. Filter vision + embed
// by id instead — same heuristic the assistant-mcp dev-pr-tracker bridge uses.
// Keeps vision-only models (qwen3-vl-*) out of the Forge cron picker + Hall
// companion picker. The vision adapter (vision-adapter.ts) finds its own model
// and does NOT go through here, so this is safe for it.
const VISION_OR_EMBED =
  /embed|vlm|vision|llava|moondream|pixtral|internvl|smolvlm|cogvlm|minicpm-v|-vl-|-vl\b|\bvl-/i;
const LOCAL_QWEN_THINKING_RE = /(?:^|[/_-])(?:qwen3|qwq)(?:[._/-]|$)/i;

function localSupportsThinkingControl(modelId: string | null | undefined): boolean {
  return LOCAL_QWEN_THINKING_RE.test(String(modelId ?? '').replace(/^local\//, ''));
}

function localThinkingDirective(modelId: string | null | undefined, effort: string | undefined): string | null {
  if (!localSupportsThinkingControl(modelId)) return null;
  if (effort === 'low') return '/no_think';
  if (effort === 'high') return '/think';
  return null;
}

async function fetchLocalVllmModels(): Promise<LocalVllmModel[]> {
  // Prefer LM Studio's native API: it reports each model's REAL loaded context
  // window. The OpenAI /v1/models endpoint omits it, which forced a 32k guess.
  try {
    const host = LOCAL_VLLM_BASE_URL.replace(/\/v1\/?$/, '');
    const r = await fetch(`${host}/api/v0/models`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const json = (await r.json()) as {
        data?: Array<{ id?: unknown; type?: unknown; state?: unknown; loaded_context_length?: unknown; max_context_length?: unknown }>;
      };
      const loaded = (json.data ?? [])
        .filter(
          (m) =>
            m.state === 'loaded' &&
            m.type !== 'embeddings' &&
            !VISION_OR_EMBED.test(String(m.id)),
        )
        .map((m) => ({
          id: typeof m.id === 'string' ? m.id : '',
          maxLen:
            (typeof m.loaded_context_length === 'number' && m.loaded_context_length > 0 && m.loaded_context_length) ||
            (typeof m.max_context_length === 'number' && m.max_context_length > 0 && m.max_context_length) ||
            32768,
        }))
        .filter((m): m is LocalVllmModel => m.id.length > 0);
      if (loaded.length) return loaded;
    }
  } catch {
    // fall through to the OpenAI-compatible endpoint
  }
  // Fallback: OpenAI-compatible /v1/models (no per-model context info).
  try {
    const response = await fetch(`${LOCAL_VLLM_BASE_URL}/models`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return [];
    const json = (await response.json()) as {
      data?: Array<{ id?: unknown; max_model_len?: unknown }>;
    };
    return (json.data ?? [])
      .map((m) => ({
        id: typeof m.id === 'string' ? m.id : '',
        maxLen: typeof m.max_model_len === 'number' && m.max_model_len > 0 ? m.max_model_len : 32768,
      }))
      .filter((m): m is LocalVllmModel => m.id.length > 0 && !VISION_OR_EMBED.test(m.id));
  } catch {
    // LM Studio not running / unreachable: no local models registered.
    return [];
  }
}

function toLocalModelConfig(model: LocalVllmModel): [string, Record<string, unknown>] {
  const context = model.maxLen;
  const reasoning = localSupportsThinkingControl(model.id);
  // Cap requested output so input + output fits the (small) local context window.
  // Banana's system prompt + built-in tool schemas run ~13k tokens, so leave
  // generous input headroom rather than letting it request the whole window.
  const output = Math.min(8192, Math.max(1024, Math.floor(context / 4)));
  const config: Record<string, unknown> = {
    id: model.id,
    name: model.id.split('/').pop() || model.id,
    attachment: false,
    reasoning,
    temperature: true,
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context, input: context, output },
  };
  return [model.id, config];
}

async function localConfigModels(): Promise<Record<string, Record<string, unknown>>> {
  const models = await fetchLocalVllmModels();
  return Object.fromEntries(models.map(toLocalModelConfig));
}

/** Picker catalog for the Local (vLLM) engine — ids are `local/<vllm-model-id>`. */
export async function listLocalModels(): Promise<{ id: string; name: string }[]> {
  const models = await fetchLocalVllmModels();
  return models.map((m) => ({ id: `local/${m.id}`, name: m.id.split('/').pop() || m.id }));
}

// ── Local vLLM control plane (swap / download models from the UI) ──────────
// Drives ~/samwise/.bin/vllm so the user never touches a terminal. `serve` kicks
// off a detached docker run that downloads the model from HF if needed; a
// background watcher then reloads the banana serve once vLLM is up, so the new
// model re-registers automatically (no TARDIS restart).
const LMS_BIN = join(homedir(), '.lmstudio', 'bin', 'lms');
const HF_HUB_DIR = join(homedir(), '.cache', 'huggingface', 'hub');
const LOCAL_MODEL_ID_RE = /^[A-Za-z0-9._/-]+$/;
const LOCAL_CURATED: { id: string; label: string; note: string }[] = [
  { id: 'Qwen/Qwen3-8B-FP8', label: 'Qwen3 8B', note: 'small + fast · 32k ctx' },
  { id: 'Qwen/Qwen3-14B-FP8', label: 'Qwen3 14B', note: 'mid · stronger' },
  { id: 'Qwen/Qwen3-32B-FP8', label: 'Qwen3 32B', note: 'dense · strongest' },
  { id: 'Qwen/Qwen3-30B-A3B-Instruct-2507-FP8', label: 'Qwen3 30B-A3B (2507)', note: 'MoE · fast · long ctx' },
];

export async function localVllmStatus(): Promise<{
  loaded: string | null;
  ready: boolean;
  contextLen: number | null;
  supportsThinking: boolean;
}> {
  const models = await fetchLocalVllmModels();
  const loaded = models[0]?.id ?? null;
  return {
    loaded,
    ready: models.length > 0,
    contextLen: models[0]?.maxLen ?? null,
    supportsThinking: localSupportsThinkingControl(loaded),
  };
}

// Cap the AUTO context default for memory safety — a model may advertise 256k+
// native, but a KV cache that large can OOM. The user can override upward, but
// only up to a hard maximum.
const LOCAL_CTX_CEILING = 131072;
const LOCAL_CTX_HARD_MAX = 262144;

/** The model's max context window from LM Studio's native API (so we can load it
 *  at its full window instead of a small default). 0 if unknown/unreachable. */
async function lmStudioMaxContext(key: string): Promise<number> {
  try {
    const host = LOCAL_VLLM_BASE_URL.replace(/\/v1\/?$/, '');
    const r = await fetch(`${host}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return 0;
    const data = (await r.json()) as { data?: Array<{ id?: string; max_context_length?: number }> };
    const m = (data.data ?? []).find((x) => x.id === key);
    const n = Number(m?.max_context_length);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function cachedLocalModelIds(): string[] {
  try {
    return readdirSync(HF_HUB_DIR)
      .filter((d) => d.startsWith('models--'))
      .map((d) => d.slice('models--'.length).replace(/--/g, '/'));
  } catch {
    return [];
  }
}

export async function localFullCatalog(): Promise<{
  loaded: string | null;
  ready: boolean;
  contextLen: number | null;
  supportsThinking: boolean;
  cached: string[];
  curated: { id: string; label: string; note: string }[];
}> {
  const status = await localVllmStatus();
  return {
    loaded: status.loaded,
    ready: status.ready,
    contextLen: status.contextLen,
    supportsThinking: status.supportsThinking,
    cached: cachedLocalModelIds(),
    curated: LOCAL_CURATED,
  };
}

/** Drop the shared banana serve so the next turn respawns it and rebuilds its
 *  config — re-registering whatever model vLLM now has loaded. Immediate; from
 *  background paths prefer reloadBananaServeWhenIdle() so an in-flight turn isn't
 *  stranded. */
export function reloadBananaServe(): void {
  bananaServer.shutdown();
}

/** Reload, but first wait (up to ~2 min) for Banana turns to go idle so we don't
 *  SIGTERM an in-flight OpenRouter/local turn out from under the user. */
async function reloadBananaServeWhenIdle(): Promise<void> {
  // Wait for Banana turns to go idle; NEVER SIGTERM an in-flight turn. Poll up
  // to ~10 min; if a turn is still running past that, defer rather than kill it
  // — the next serve respawn (idle prune / next session) re-registers the model.
  for (let i = 0; i < 120; i++) {
    if (!activeBananaSessions().some((s) => s.busy)) {
      bananaServer.shutdown();
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.warn('[local-vllm] banana still busy after reload window; deferring serve reload to next respawn');
}

// Single-flight guard for local serves: the newest serve wins; older background
// watchers bail when superseded, so concurrent swaps don't race reloads.
let localServeGeneration = 0;
// Reject concurrent local serves so two swaps can't race the docker run / reload.
let localServeInFlight = false;

/** (Re)load `model` in LM Studio at a chosen context via the `lms` CLI, then
 *  reload the banana serve so it re-registers. Defaults to the model's MAX
 *  context window — the whole point: a local model should get its full context
 *  (256k for the qwen family), not LM Studio's small default. */
export async function serveLocalModel(
  model: string,
  opts?: { util?: string; maxLen?: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!LOCAL_MODEL_ID_RE.test(model)) return { ok: false, error: 'invalid model id' };
  if (localServeInFlight) {
    return { ok: false, error: 'a local model load is already in progress — wait for it to finish' };
  }
  localServeInFlight = true;
  const gen = ++localServeGeneration;
  const key = model.replace(/^local\//, '');

  // Context: explicit value floored + hard-capped; blank => the model's MAX
  // window (large-memory hosts may hold 256k for the qwen family), capped.
  const explicitLen = opts?.maxLen != null && opts.maxLen !== '' ? Number(opts.maxLen) : NaN;
  let ctx = 0;
  if (Number.isFinite(explicitLen) && explicitLen > 0) {
    ctx = Math.min(Math.floor(explicitLen), LOCAL_CTX_HARD_MAX);
  } else {
    const max = await lmStudioMaxContext(key);
    ctx = max > 0 ? Math.min(max, LOCAL_CTX_HARD_MAX) : 0;
  }

  try {
    // Unload the running instance (ignore if not loaded), then load fresh at the
    // chosen context with full GPU offload. `lms load` blocks until ready.
    await new Promise<void>((resolve) => {
      execFile(LMS_BIN, ['unload', key], { timeout: 30_000 }, () => resolve());
    });
    const args = ['load', key, '--gpu', 'max', '-y'];
    if (ctx > 0) args.push('-c', String(ctx));
    await new Promise<void>((resolve, reject) => {
      execFile(LMS_BIN, args, { timeout: 240_000 }, (err) => (err ? reject(err) : resolve()));
    });
    if (gen !== localServeGeneration) return { ok: true }; // a newer load superseded us
    await reloadBananaServeWhenIdle();
    console.log(`[local-lms] loaded ${key} at ctx=${ctx || 'default'}; reloaded banana serve`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  } finally {
    localServeInFlight = false;
  }
}

/** Which MCP servers to mirror into Banana. Local models can receive the global
 *  tool surface by default. Remote OpenRouter models require an explicit deploy
 *  flag because those tools can touch privileged local/data systems. Project
 *  MCPs are also opt-in: banana serve is shared globally, so project-scoped MCP
 *  config would otherwise restart or stale the shared process across chats. */
function resolveMirroredMcp(opts: { projectPathHint?: string; cli?: CliKind } = {}): Record<string, BananaMcpConfig> {
  if ((opts.cli ?? 'banana') === 'banana' && !remoteBananaMcpEnabled()) return {};
  return readClaudeMcpServers(opts.projectPathHint, { includeProjectMcp: projectBananaMcpEnabled() });
}

async function bananaConfigContent(opts: { projectPathHint?: string; cli?: CliKind } = {}): Promise<string | null> {
  const includeOpenrouter = openrouterProviderEnabled();
  // Mirror the configured MCP set into Banana so OpenRouter and Local models
  // keep the same tool surface as the Claude/Codex-backed companions.
  const mirroredMcp = { ...resolveMirroredMcp(opts), ...localMcpBananaServers() };
  const override: any = {
    $schema: 'https://banana-code.dev/config.json',
  };
  if (includeOpenrouter) {
    // OpenRouter, DIRECT (no monkey proxy). baseURL + real apiKey override
    // Banana's built-in openrouter provider so any model id forwards upstream.
    const models = await openrouterConfigModels();
    override.provider = {
      openrouter: {
        ...(Object.keys(models).length ? { models } : {}),
        options: {
          baseURL: OPENROUTER_BASE_URL,
          apiKey: resolveOpenRouterKey(),
        },
      },
    };
  }
  // Local provider. Banana exposes a large real tool surface; LM Studio's
  // llama.cpp grammar compiler rejects validation-only bounds in those JSON
  // schemas before inference. A loopback proxy strips only those bounds while
  // preserving the tools themselves and their runtime MCP validation.
  const localModels = await localConfigModels();
  if (Object.keys(localModels).length) {
    const localProxyBaseUrl = await ensureLocalLlmProxy(LOCAL_VLLM_BASE_URL);
    override.provider = override.provider || {};
    override.provider.local = {
      name: 'Local (LM Studio)',
      options: { baseURL: localProxyBaseUrl, apiKey: 'local' },
      models: localModels,
    };
  }
  // Fireworks provider — DIRECT, openai-compatible, using the PERSONAL key.
  // Registered with auto-discovered models so `fireworks/<id>` picks route.
  const fireworksModels = resolveFireworksKey() ? await fireworksConfigModels() : {};
  if (Object.keys(fireworksModels).length) {
    override.provider = override.provider || {};
    override.provider.fireworks = {
      name: 'Fireworks',
      options: { baseURL: FIREWORKS_BASE_URL, apiKey: resolveFireworksKey() },
      models: fireworksModels,
    };
  }
  if (Object.keys(mirroredMcp).length) override.mcp = mirroredMcp;
  const hasOverride =
    includeOpenrouter ||
    Object.keys(localModels).length > 0 ||
    Object.keys(fireworksModels).length > 0 ||
    Object.keys(mirroredMcp).length > 0;

  const existingRaw = (
    process.env.BANANA_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT
  )?.trim();
  if (!existingRaw) return hasOverride ? JSON.stringify(override) : null;

  let existing: any;
  try {
    existing = parseJsoncObject(existingRaw);
  } catch {
    console.warn(
      '[banana-runner] existing BANANA_CONFIG_CONTENT is not valid JSON/JSONC, ignoring it and using generated Banana override only',
    );
    return hasOverride ? JSON.stringify(override) : null;
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return hasOverride ? JSON.stringify(override) : null;
  }

  // Merge so the existing config's other providers, and even openrouter's
  // own `models`/extra `options`, are kept — only baseURL + apiKey are
  // forced to the proxy values.
  const existingProvider =
    existing.provider && typeof existing.provider === 'object' ? existing.provider : {};
  const existingOpenrouter =
    existingProvider.openrouter && typeof existingProvider.openrouter === 'object'
      ? existingProvider.openrouter
      : {};
  const existingOptions =
    existingOpenrouter.options && typeof existingOpenrouter.options === 'object'
      ? existingOpenrouter.options
      : {};
  const existingMcp = existing.mcp && typeof existing.mcp === 'object' ? existing.mcp : {};
  const existingOpenrouterModels =
    existingOpenrouter.models && typeof existingOpenrouter.models === 'object'
      ? existingOpenrouter.models
      : {};
  const overrideOpenrouterModels =
    override.provider?.openrouter?.models && typeof override.provider.openrouter.models === 'object'
      ? override.provider.openrouter.models
      : {};

  const merged: any = { ...existing, ...override };
  if (includeOpenrouter || override.provider?.local || override.provider?.fireworks) {
    merged.provider = {
      ...existingProvider,
      ...(includeOpenrouter
        ? {
            openrouter: {
              ...existingOpenrouter,
              options: {
                ...existingOptions,
                ...override.provider.openrouter.options,
              },
              ...(Object.keys(overrideOpenrouterModels).length || Object.keys(existingOpenrouterModels).length
                ? { models: { ...overrideOpenrouterModels, ...existingOpenrouterModels } }
                : {}),
            },
          }
        : {}),
      // The local (vLLM) + fireworks providers are generated fresh each build —
      // no existing merge needed; just carry them through so they aren't dropped.
      ...(override.provider?.local ? { local: override.provider.local } : {}),
      ...(override.provider?.fireworks ? { fireworks: override.provider.fireworks } : {}),
    };
  }
  if (Object.keys(mirroredMcp).length || Object.keys(existingMcp).length) {
    // Operator-supplied Banana MCP config wins over the mirrored Claude stack,
    // so a deploy can disable or replace one server without editing code.
    merged.mcp = {
      ...mirroredMcp,
      ...existingMcp,
      ...localMcpBananaServers(), // reserved built-ins cannot be shadowed by stale private config
    };
  }
  return JSON.stringify(merged);
}

/** Map an image media type to a file extension for the temp file banana reads.
 *  Falls back to the bare subtype (sans any `+suffix`) so an uncommon image
 *  type still produces a usable, sanitized extension. */
function imageExtension(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/gif') return 'gif';
  if (mediaType === 'image/webp') return 'webp';
  const subtype = mediaType.split('/')[1]?.split('+')[0] ?? 'img';
  return subtype.replace(/[^a-z0-9]/gi, '') || 'img';
}

/** Parse a model id into the SDK's { providerID, modelID } shape. Split on the
 *  FIRST '/': everything before is the provider, everything after (joined back
 *  with '/') is the model. So `monkey/silverback` -> {monkey, silverback} and
 *  `openrouter/anthropic/claude-3.7-sonnet` -> {openrouter, anthropic/claude-3.7-sonnet}. */
export function parseModel(modelId: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!modelId || typeof modelId !== 'string') return undefined;
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash < 1 || slash >= trimmed.length - 1) return undefined;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

function isSecretLikeKey(key: string): boolean {
  return /(?:key|token|secret|password|pass|authorization|bearer|credential|cookie|session)/i.test(key);
}

function looksLikeOpaqueToken(value: string): boolean {
  if (value.length < 48) return false;
  if (/^https?:\/\//i.test(value)) return false;
  return /^[A-Za-z0-9._~+=-]+$/.test(value);
}

function redactToolText(text: string): string {
  return text
    .replace(/([A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*=)(?:"[^"]*"|'[^']*'|[^"'`\s]+)/gi, '$1<redacted>')
    .replace(/((?:--|-)(?:api-?)?key|(?:--|-)?token|(?:--|-)?secret|(?:--|-)?password)(=|\s+)(?:"[^"]*"|'[^']*'|[^"'`\s]+)/gi, '$1$2<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/("(?:api[_-]?key|token|secret|password|authorization|bearer|cookie)"\s*:\s*")([^"]+)(")/gi, '$1<redacted>$3')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>')
    .replace(/\b(?:sk|ghp|github_pat|glpat|dop|dpl|rk)_[A-Za-z0-9_=-]{20,}\b/g, '<redacted-token>')
    .replace(/\b[A-Za-z0-9+/=_-]{64,}\b/g, '<redacted-token>');
}

function redactToolValue(value: unknown, keyHint = ''): unknown {
  if (typeof value === 'string') {
    if (isSecretLikeKey(keyHint) || looksLikeOpaqueToken(value)) return '<redacted>';
    return redactToolText(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactToolValue(item, keyHint));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactToolValue(child, key);
    }
    return out;
  }
  return value;
}

function stringifyToolInput(input: unknown): string {
  if (input === undefined) return '';
  try {
    return JSON.stringify(redactToolValue(input));
  } catch {
    return JSON.stringify(redactToolText(String(input)));
  }
}

function isMeaningfulToolInput(inputText: string): boolean {
  return inputText !== '' && inputText !== '{}' && inputText !== 'null';
}

function truncateToolText(text: string, max = 1200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 32)}\n... [truncated ${text.length - max + 32} chars]`;
}

function normalizedCompactionCandidate(text: string): string {
  return text.trimStart().toLowerCase();
}

const COMPACTION_SUMMARY_OPEN = '<summary>';
const COMPACTION_SUMMARY_CLOSE = '</summary>';

type SummaryPrefix =
  | { status: 'open' }
  | { status: 'closed'; endIndex: number; trailing: string };

function parseSummaryPrefix(text: string): SummaryPrefix | null {
  const leading = text.length - text.trimStart().length;
  const lower = text.slice(leading).toLowerCase();
  if (!lower.startsWith(COMPACTION_SUMMARY_OPEN)) return null;
  const closeIndex = lower.indexOf(COMPACTION_SUMMARY_CLOSE, COMPACTION_SUMMARY_OPEN.length);
  if (closeIndex < 0) return { status: 'open' };
  const endIndex = leading + closeIndex + COMPACTION_SUMMARY_CLOSE.length;
  return { status: 'closed', endIndex, trailing: text.slice(endIndex) };
}

function looksLikeCompactionSummary(text: string): boolean {
  const summary = parseSummaryPrefix(text);
  return summary?.status === 'closed' && summary.trailing.trim() === '';
}

function reconcileTextSnapshot(snapshot: string, observed: string): string {
  if (!snapshot) return observed;
  if (!observed) return snapshot;
  if (snapshot === observed) return snapshot;
  if (snapshot.startsWith(observed)) return snapshot;
  if (observed.startsWith(snapshot)) return observed;
  const max = Math.min(snapshot.length, observed.length);
  for (let overlap = max; overlap > 0; overlap -= 1) {
    if (snapshot.endsWith(observed.slice(0, overlap))) {
      return snapshot + observed.slice(overlap);
    }
  }
  return snapshot + observed;
}

// ── BananaServer: the module-level singleton ─────────────────────────────
//
// Owns the persistent `banana serve` child, the shared SDK client, and the
// single global SSE subscription. All BananaSessions share it. Each event on
// the stream is fanned out to the owning session by sessionID.

class BananaServer {
  private child: ChildProcess | null = null;
  private password = '';
  private servePort = pickServePort();
  /** Resolves once the server is reachable. Recreated on each (re)start. */
  private readyPromise: Promise<void> | null = null;
  private dead = false;
  private starting = false;
  /** Incremented on every (re)start so a stale per-cwd SSE loop from a prior
   *  serve generation knows to exit instead of fighting the new one. */
  private generation = 0;

  currentGeneration(): number {
    return this.generation;
  }
  /** banana sessionID -> the BananaSession that owns it. */
  private readonly routes = new Map<string, BananaSession>();
  /** Directories with an active SSE subscription. The SDK pins `/event` to a
   *  directory, so a single global stream would only ever carry events for the
   *  server cwd. We run one subscription per distinct session cwd instead. */
  private readonly eventLoops = new Set<string>();
  /** When the serve child died, the next ensure() restarts after this delay. */
  private restartBackoffMs = 0;
  private lastDeathAtMs = 0;
  /** Config signature used by the currently running serve process. */
  private configSignature = '';
  /** Rejects the in-flight start promise when a config-change restart supersedes it. */
  private startReject: ((e: Error) => void) | null = null;

  /** Lazily start (or restart) the serve process. Resolves when reachable.
   *  `caller` is the session driving this ensure() (mid-send, not yet streaming
   *  on the serve); it is excluded from the "is a sibling turn live?" check so a
   *  chat can still pick up a config change for its OWN next turn. */
  async ensure(projectPathHint?: string, caller?: BananaSession): Promise<void> {
    const configContent = await bananaConfigContent({ projectPathHint, cli: caller?.cli });
    // Compare on a canonical signature: ~/.claude.json and OpenRouter's catalog
    // can return semantically identical content with shuffled key/row order,
    // which would otherwise restart the serve and wipe every chat's context.
    const configSignature = canonicalConfigSignature(configContent);
    if (this.readyPromise && !this.dead) {
      if (configSignature !== this.configSignature) {
        // A config-change restart SIGTERMs the shared serve and fails every
        // in-flight turn (onServerDeath). Never do that out from under another
        // chat's live turn — keep the running serve and let the new config take
        // effect on the next idle (re)start. The per-turn model rides on the
        // prompt, so the caller's turn still runs correctly on the old serve.
        if (anyBananaTurnBusyExcept(caller)) {
          console.warn('[banana serve] config changed but a sibling chat turn is live; deferring serve restart to avoid killing its work');
          return this.readyPromise;
        }
        this.restartForConfigChange();
      } else {
        return this.readyPromise;
      }
    }
    if (this.dead) {
      // Small backoff between restarts so a crash-looping binary doesn't spin.
      const since = Date.now() - this.lastDeathAtMs;
      if (this.restartBackoffMs > 0 && since < this.restartBackoffMs) {
        await new Promise((r) => setTimeout(r, this.restartBackoffMs - since));
      }
      this.dead = false;
      this.readyPromise = null;
    }
    if (!this.readyPromise) {
      this.readyPromise = this.start(configContent, configSignature);
    }
    const waitingOn = this.readyPromise;
    try {
      await waitingOn;
    } catch (err) {
      if (this.readyPromise === waitingOn) {
        this.dead = true;
        this.readyPromise = null;
        this.starting = false;
        this.configSignature = '';
        this.startReject = null;
        this.lastDeathAtMs = Date.now();
        this.restartBackoffMs = Math.min(Math.max(this.restartBackoffMs * 2, 1000), 15_000);
      }
      throw err;
    }
  }

  private restartForConfigChange(): void {
    this.generation += 1;
    this.configSignature = '';
    this.starting = false;
    const rejectStart = this.startReject;
    this.startReject = null;
    if (rejectStart) rejectStart(new Error('banana serve start superseded by config change'));
    this.eventLoops.clear();
    const owners = new Set(this.routes.values());
    this.routes.clear();
    this.readyPromise = null;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      terminateProcessTree(child, 'SIGTERM');
      setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL');
      }, 3000).unref();
    }
    for (const session of owners) {
      session.onServerDeath('config changed, restarting banana serve');
    }
  }

  /** The shared SDK client, bound to a per-session directory. The SDK sends
   *  the directory as a header/query param, so one client per cwd is cheap. */
  clientFor(directory: string) {
    return this.clientForPort(directory, this.servePort);
  }

  private clientForPort(directory: string, port: number) {
    return createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      directory,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`banana:${this.password}`).toString('base64'),
      },
    });
  }

  /** Register a session under its banana sessionID so the per-cwd event loop
   *  can fan events out to it. Safe to call repeatedly with the same id.
   *  Lazily starts an SSE subscription for the session's cwd if one is not
   *  already running, so events for that directory actually reach us. */
  registerRoute(bananaSessionId: string, session: BananaSession): void {
    this.routes.set(bananaSessionId, session);
    this.ensureEventLoop(session.cwd);
  }

  unregisterRoute(bananaSessionId: string): void {
    if (this.routes.get(bananaSessionId)) this.routes.delete(bananaSessionId);
  }

  isAlive(): boolean {
    return !this.dead && this.child !== null && this.child.exitCode === null;
  }

  notePromptTransportFailure(reason: string): void {
    // A single prompt's transport error does NOT prove the shared serve is
    // dead. If another chat's turn is still streaming, the process is plainly
    // alive — SIGTERMing it here (handleDeath -> onServerDeath) would abort that
    // sibling's long-running work, which is exactly the cross-chat data loss we
    // must avoid. The caller already failed its own turn; skip the restart. If
    // the serve really is dead, the sibling's stall watchdog ends its turn and
    // the next ensure() validates the session and restarts cleanly.
    if (anyBananaTurnBusyExcept()) {
      console.warn(`[banana serve] prompt transport failure but a sibling chat turn is live; NOT restarting serve to preserve its work: ${reason}`);
      return;
    }
    console.warn(`[banana serve] prompt transport failure, restarting serve: ${reason}`);
    this.handleDeath(`prompt transport failure: ${reason}`);
  }

  shutdown(): void {
    this.dead = true;
    this.readyPromise = null;
    const child = this.child;
    if (child) {
      terminateProcessTree(child, 'SIGTERM');
      setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL');
      }, 3000).unref();
      this.child = null;
    }
  }

  // ── private ────────────────────────────────────────────────

  private async start(configContent: string | null, configSignature: string): Promise<void> {
    if (this.starting) {
      // A concurrent ensure() is already starting; wait on its promise.
      if (this.readyPromise) return this.readyPromise;
    }
    await ensureBananaGlobalInstructionsLinked();
    await ensureBananaCommandsLinked();
    this.starting = true;
    this.password = randomBytes(24).toString('hex');
    const port = this.servePort;
    // New serve generation — any SSE loop from a prior generation will exit.
    this.generation += 1;
    const generation = this.generation;
    this.configSignature = configSignature;

    const bin = resolveBananaBin();
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
    // Build the spawn env: always a random BANANA_SERVER_PASSWORD. Full provider
    // catalogs go through BANANA_CONFIG (file path) — BANANA_CONFIG_CONTENT is
    // too large once OpenRouter's full model list is registered (~150KB → E2BIG).
    const serveEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BANANA_SERVER_PASSWORD: this.password,
    };
    // Drop any parent inline config so it cannot fight the file we just wrote
    // (and so a stale env blob cannot reintroduce the E2BIG path).
    delete serveEnv.BANANA_CONFIG_CONTENT;
    delete serveEnv.OPENCODE_CONFIG_CONTENT;
    if (configContent) {
      const configPath = await writeBananaServeConfig(configContent);
      serveEnv.BANANA_CONFIG = configPath;
      // Prefer our generated file over any parent OPENCODE_CONFIG path.
      delete serveEnv.OPENCODE_CONFIG;
    }
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      // Never run unsecured: inject a random Basic-auth password.
      env: serveEnv,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    console.log(`[banana serve] spawning ${bin} on 127.0.0.1:${port} pid=${child.pid ?? '-'}`);

    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    this.startReject = rejectReady;

    let settled = false;
    const isCurrentServe = () => this.child === child && this.generation === generation;
    const clearStartReject = () => {
      if (this.startReject === rejectReady) this.startReject = null;
    };
    const markReady = () => {
      if (!isCurrentServe()) return;
      if (settled) return;
      settled = true;
      this.starting = false;
      this.restartBackoffMs = 0;
      clearStartReject();
      console.log(`[banana serve] ready on 127.0.0.1:${port}`);
      resolveReady();
      // Restart an SSE loop for every cwd that still has a live route, so a
      // serve restart reconnects streaming for in-progress conversations.
      const cwds = new Set(Array.from(this.routes.values()).map((s) => s.cwd));
      for (const cwd of cwds) this.ensureEventLoop(cwd);
    };
    const markFailed = (msg: string) => {
      if (!isCurrentServe()) return;
      if (settled) {
        // Already running and then it died — handled by the close handler.
        return;
      }
      settled = true;
      this.starting = false;
      clearStartReject();
      console.warn(`[banana serve] failed to start: ${msg}`);
      // Drive a full death so the next ensure() can restart through the normal
      // backoff path. Without this the rejected readyPromise would stick around
      // and brick Banana until the whole node process restarts.
      this.handleDeath(`startup failure: ${msg}`);
      rejectReady(new Error(`banana serve failed to start: ${msg}`));
    };

    const readyLine = new RegExp(
      `Banana Code server listening on http://127\\.0\\.0\\.1:${port}`,
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (!settled && readyLine.test(chunk)) markReady();
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) console.warn(`[banana serve stderr] ${text.slice(0, 400)}`);
    });

    child.on('error', (err) => {
      if (this.child !== child || this.generation !== generation) return;
      markFailed(err.message);
      this.handleDeath(`spawn error: ${err.message}`);
    });
    child.on('close', (code, signal) => {
      if (this.child !== child || this.generation !== generation) return;
      console.warn(`[banana serve] closed code=${code} signal=${signal ?? '-'}`);
      if (!settled) markFailed(`exited code=${code} before ready`);
      this.handleDeath(`process exited code=${code} signal=${signal ?? '-'}`);
    });

    // Backstop readiness: even without the log line, poll config.get() until
    // it answers. Whichever path resolves first wins.
    void this.pollReady(port, markReady, markFailed, () => settled);

    return ready;
  }

  /** Poll `sdk.config.get()` until it succeeds (covers a serve build whose
   *  ready log line ever changes). Gives up after ~30s. */
  private async pollReady(
    port: number,
    markReady: () => void,
    markFailed: (msg: string) => void,
    isSettled: () => boolean,
  ): Promise<void> {
    const client = this.clientForPort(process.cwd(), port);
    const deadline = Date.now() + 30_000;
    while (!isSettled()) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) return;
      try {
        const res = await client.config.get();
        if (!res.error) {
          markReady();
          return;
        }
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        markFailed('readiness poll timed out after 30s');
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** Mark the server dead, fail every in-flight turn, and clear routes so the
   *  next send() lazily restarts. Kills the child if it is somehow still alive
   *  (e.g. a readiness-poll timeout where the process never answered but did
   *  not exit) so a stuck serve does not linger holding the port. */
  private handleDeath(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.starting = false;
    this.lastDeathAtMs = Date.now();
    this.restartBackoffMs = Math.min(Math.max(this.restartBackoffMs * 2, 1000), 15_000);
    this.readyPromise = null;
    // Drop all SSE-loop bookkeeping — the loops detect the generation bump /
    // dead flag and exit on their own; ensureEventLoop must be free to start
    // fresh ones after the next restart.
    this.eventLoops.clear();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      terminateProcessTree(child, 'SIGTERM');
      // SIGKILL backstop if SIGTERM doesn't take it down promptly.
      setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL');
      }, 3000).unref();
    }
    const nextPort = pickServePort(this.servePort);
    if (nextPort !== this.servePort) {
      console.warn(`[banana serve] switching port ${this.servePort} -> ${nextPort}`);
      this.servePort = nextPort;
    }
    const owners = new Set(this.routes.values());
    this.routes.clear();
    for (const session of owners) {
      session.onServerDeath(reason);
    }
  }

  /** Start an SSE subscription for `cwd` if one is not already running. The
   *  SDK pins `/event` to a directory, so each distinct session cwd needs its
   *  own stream — a single global loop would silently drop events for every
   *  repo other than the server process cwd. */
  private ensureEventLoop(cwd: string): void {
    if (this.dead) return;
    if (this.eventLoops.has(cwd)) return;
    this.eventLoops.add(cwd);
    void this.runEventLoop(cwd, this.generation);
  }

  /** One SSE loop, scoped to a single directory. Every event is fanned out to
   *  the owning BananaSession by sessionID. Reconnects if the stream ends
   *  while the server is alive; exits on death or a serve-generation bump. */
  private async runEventLoop(cwd: string, generation: number): Promise<void> {
    try {
      while (!this.dead && this.generation === generation) {
        const client = this.clientFor(cwd);
        try {
          // The v2 /event stream is directory-scoped — subscribe() with no
          // directory delivers events only for the serve process cwd, so a
          // session in any other repo would never see its turn events and
          // hang forever. Pass the loop's cwd explicitly.
          const events = await client.event.subscribe({ directory: cwd });
          for await (const event of events.stream) {
            if (this.dead || this.generation !== generation) break;
            this.fanOut(event as Event);
          }
        } catch (err) {
          if (this.dead || this.generation !== generation) break;
          console.warn(`[banana serve] event stream error (${cwd}): ${(err as Error).message}`);
        }
        if (this.dead || this.generation !== generation) break;
        // Stream ended but the server is (apparently) still alive — reconnect
        // after a short pause.
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      // Only release the slot if it still belongs to this generation; a newer
      // ensureEventLoop may already have re-added it after a restart.
      if (this.generation === generation) this.eventLoops.delete(cwd);
    }
  }

  /** Route one SSE event to its owning session by sessionID. Events without a
   *  resolvable sessionID (server-global noise) are dropped. */
  private fanOut(event: Event): void {
    const sessionId = extractSessionId(event);
    if (!sessionId) return;
    const session = this.routes.get(sessionId);
    if (!session) return;
    session.handleServerEvent(event);
  }
}

/** Pull the owning sessionID out of any SSE event shape. */
function extractSessionId(event: Event): string | null {
  const props = (event as { properties?: Record<string, unknown> }).properties;
  if (!props) return null;
  if (typeof props.sessionID === 'string') return props.sessionID;
  if (typeof props.sessionId === 'string') return props.sessionId;
  // message.part.* carry it on the nested part.
  const part = props.part as { sessionID?: unknown; sessionId?: unknown } | undefined;
  if (part && typeof part.sessionID === 'string') return part.sessionID;
  if (part && typeof part.sessionId === 'string') return part.sessionId;
  // message.updated carries it on info.
  const info = props.info as { sessionID?: unknown; sessionId?: unknown } | undefined;
  if (info && typeof info.sessionID === 'string') return info.sessionID;
  if (info && typeof info.sessionId === 'string') return info.sessionId;
  return null;
}

/** The single shared server instance for this app process. */
const bananaServer = new BananaServer();

// ── BananaSession ────────────────────────────────────────────────────────

export class BananaSession {
  readonly key: string;
  /** Durable-history key — engine-free for agent home threads (threadKey.ts). */
  readonly logKey: string;
  /** Model of the most recent turn — stamped onto persisted events. */
  private turnModel: string | null = null;
  private turnEffort: string | null = null;
  readonly cli: CliKind;
  readonly cwd: string;
  readonly chatId: string;
  /** Next turn seeds persona + rolling compact + last 50 (fresh opencode thread). */
  private seedWindowOnNextTurn = false;
  private sessionIdWrite: Promise<void> = Promise.resolve();

  private queueSessionId(id: string): Promise<void> {
    this.sessionIdWrite = this.sessionIdWrite.then(
      () => setSessionId(this.cli, this.cwd, id, this.chatId),
      () => setSessionId(this.cli, this.cwd, id, this.chatId),
    );
    return this.sessionIdWrite;
  }

  private consumeWindowSeed(): boolean {
    return this.seedWindowOnNextTurn;
  }

  private ackWindowSeed(): Promise<void> {
    if (!this.seedWindowOnNextTurn) return Promise.resolve();
    this.seedWindowOnNextTurn = false;
    return clearRotation(this.logKey);
  }

  /** Forever-thread compaction check — see server/src/chat/compaction.ts. */
  private async maybeCompact(): Promise<void> {
    try {
      await maybeAutoCompact({
        key: this.logKey,
        cli: this.cli,
        chatId: this.chatId,
        events: this.eventLog,
        isBusy: () => this.busy,
        emit: (ev) => this.emit(ev as SessionEvent),
        rotate: async () => {
          this.seedWindowOnNextTurn = true;
          await this.clearSavedThreadId('forever-window rotate');
          bankRotation(this.logKey);
          return false;
        },
      });
    } catch (err) {
      console.warn(`[chat banana] compaction check failed for ${this.logKey}:`, (err as Error).message);
    }
  }
  private listeners = new Set<Listener>();
  private subscriberCount = 0;
  /** banana sessionID, captured on create, persisted for resume. */
  private threadId: string | null = null;
  private threadServeGeneration: number | null = null;
  private busy = false;
  private dead = false;
  private eventLog: SeqEvent[] = [];
  private nextSeq = 1;
  /** Assistant message ids already used by this long-lived banana session.
   *  Prevents delayed events from a previous prompt from rendering into the
   *  next prompt once a reused opencode session goes quiet. */
  private seenMessageIds = new Set<string>();
  private lastActivityAtMs = Date.now();
  /** Per-turn streaming state — non-null only while busy. */
  private turn: BananaTurnState | null = null;
  /** Stall watchdog handle for the active turn. */
  private watchdog: NodeJS.Timeout | null = null;
  /** Cumulative silence (ms) tolerated so far while a tool was open and
   *  unfinished. Reset to 0 by any real streaming activity; only grows when the
   *  watchdog re-arms itself because a tool is still legitimately running. */
  private toolStallWaitedMs = 0;
  /** Cleanup for the current turn's image temp dir — runs once the turn ends
   *  (success, failure, or shutdown). Null when the turn sent no images. */
  private turnCleanup: (() => void) | null = null;
  /** Set true the moment this turn wiped its threadId (serve restart / stale
   *  session). The send path uses it to decide whether to inject a transcript
   *  recap so the brand-new opencode session inherits the prior chat's context
   *  instead of starting cold and asking "who's her?" half-way through. */
  private wipedThisTurn = false;
  /** Set when this TARDIS process rebuilt a BananaSession from the persisted
   *  event log but intentionally discarded the old opencode session id. */
  private recoverContextOnNextTurn = false;
  /** Persistent serve means readiness is per-server, not per-session. */
  readonly ready: Promise<boolean> = Promise.resolve(true);

  constructor(cwd: string, chatId: string, threadId: string | null, opts: BananaSessionOptions = {}) {
    this.cwd = cwd;
    this.chatId = chatId;
    this.cli = opts.cli ?? 'banana';
    this.key = keyOf(this.cli, cwd, chatId);
    this.logKey = logKeyFor(this.cli, cwd, chatId);
    this.threadId = threadId;
    this.recoverContextOnNextTurn = opts.recoverContextOnNextTurn === true;

    // Mirror the claude/codex path: rehydrate eventLog from disk so a server
    // restart between turns doesn't strand a reconnecting client.
    try {
      const restored = loadEventLogSync(this.logKey);
      if (restored.events.length > 0) {
        this.eventLog = restored.events;
        this.nextSeq = restored.nextSeq;
        console.log(
          `[chat banana] restored ${restored.events.length} event(s) from disk for ${this.logKey} (nextSeq=${this.nextSeq})`,
        );
      }
    } catch (err) {
      console.warn(`[chat banana] event-log restore failed for ${this.logKey}:`, (err as Error).message);
    }
    void compactEventLog(this.logKey, compactedThroughSeq(this.logKey));
    // A different brain spoke last on this thread — mark the handover. Use the
    // complete durable history: the 2,000-event replay tail can be less than one
    // tool-heavy turn. The seed below covers context; opencode threads are never
    // resumed across engines anyway.
    const durableHistory = opts.durableHistory ?? loadEventLogForCompactionSync(this.logKey);
    const history = durableHistory.length ? durableHistory : this.eventLog;
    const priorEngine = lastEngineOf(history);
    if (priorEngine && priorEngine !== this.cli) {
      console.warn(
        `[chat banana] model switch on ${this.logKey}: ${priorEngine} → ${this.cli} — seeding compact+50 from the thread log`,
      );
      this.emit({
        type: 'event',
        event: { type: '_engine_switch', from: priorEngine, to: this.cli, ts: Date.now() },
      } as SessionEvent);
    }
    // Never exec-resume a week of opencode history. Seed compact(history − last50) + last 50.
    const visible = extractVisibleTurns(history);
    if (isRotationOwed(this.logKey) || visible.length > WINDOW_TURNS) {
      this.seedWindowOnNextTurn = true;
      this.threadId = null;
      void this.queueSessionId('');
      console.warn(
        `[chat banana] seeding compact+50 for ${this.logKey} (visible=${visible.length}, owed=${isRotationOwed(this.logKey)})`,
      );
    } else if (visible.length > 0) {
      this.seedWindowOnNextTurn = true;
    }

    // If we already know our banana sessionID, register the route up front so
    // a turn started elsewhere (or events that arrive before send) still land.
    if (this.threadId) bananaServer.registerRoute(this.threadId, this);
  }

  subscribe(fn: Listener, sinceSeq = -1, countSubscriber = true): () => void {
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

  latestSeq(): number {
    return latestEventLogSeq(this.logKey, this.nextSeq - 1);
  }

  isAlive(): boolean {
    return !this.dead;
  }

  isBusy(): boolean {
    return this.busy;
  }

  activeSelection(): { model?: string; effort?: string } {
    return {
      model: this.turnModel ?? undefined,
      effort: this.turnEffort ?? undefined,
    };
  }

  sessionId(): string | null {
    return this.threadId;
  }

  listenerCount(): number {
    return this.subscriberCount;
  }

  lastActivityAt(): number {
    return this.lastActivityAtMs;
  }

  shutdown(): void {
    this.dead = true;
    this.clearWatchdog();
    // Drop any image temp dir so a shutdown mid-turn does not leak it. The
    // cleanup lives on the turn once a turn exists, and on turnCleanup during
    // the pre-turn setup window — clear both.
    this.turn?.cleanup();
    this.turnCleanup?.();
    this.turnCleanup = null;
    // If a turn is mid-flight (stop / steer / tab close), tell the banana
    // server to abort it too. Without this the prompt keeps running server
    // side and its late events could leak into a future turn of this session.
    if (this.busy && this.threadId) this.abortServerTurn();
    if (this.threadId) bananaServer.unregisterRoute(this.threadId);
  }

  /** Fire-and-forget abort of the in-flight server-side prompt for this
   *  session. Best-effort: failures are logged, not surfaced. */
  private abortServerTurn(): void {
    const sessionID = this.threadId;
    if (!sessionID) return;
    void (async () => {
      try {
        const client = bananaServer.clientFor(this.cwd);
        await client.session.abort({ sessionID });
      } catch (err) {
        console.warn(`[chat banana] session.abort failed: ${(err as Error).message}`);
      }
    })();
  }

  private async clearSavedThreadId(reason: string): Promise<void> {
    const old = this.threadId;
    if (!old) return;
    console.warn(`[chat banana] clearing stale session ${old}: ${reason}`);
    bananaServer.unregisterRoute(old);
    this.threadId = null;
    this.threadServeGeneration = null;
    this.wipedThisTurn = true;
    await this.queueSessionId('');
  }

  private quarantineThread(reason: string): void {
    const old = this.threadId;
    if (!old) return;
    console.warn(`[chat banana] quarantining session ${old}: ${reason}`);
    bananaServer.unregisterRoute(old);
    this.threadId = null;
    this.threadServeGeneration = null;
    this.recoverContextOnNextTurn = true;
    void setSessionId(this.cli, this.cwd, '', this.chatId).catch((err) => {
      console.warn(`[chat banana] failed to persist quarantined session: ${(err as Error).message}`);
    });
  }

  private latestAssistantTextFromLog(): string {
    const openText = new Map<number, string>();
    let pendingAssistant = '';
    let latestAssistant = '';

    const flushAssistant = () => {
      const finalChunks: string[] = [];
      for (const chunk of openText.values()) finalChunks.push(chunk);
      openText.clear();
      const trailing = finalChunks.join('').trim();
      const body = (pendingAssistant + (trailing ? `\n${trailing}` : '')).trim();
      pendingAssistant = '';
      if (body && !looksLikeCompactionSummary(body)) latestAssistant = body;
    };

    for (const se of this.eventLog) {
      const wrapper = se.ev;
      if (wrapper.type !== 'event') continue;
      const ev = (wrapper as { type: 'event'; event: any }).event;
      if (!ev || typeof ev !== 'object') continue;

      if (ev.type === '_user_echo') {
        flushAssistant();
        latestAssistant = '';
        continue;
      }

      if (ev.type !== 'stream_event' || !ev.event || typeof ev.event !== 'object') continue;
      const inner = ev.event as { type?: unknown; index?: unknown; delta?: any; content_block?: any };
      if (inner.type === 'content_block_start' && typeof inner.index === 'number') {
        if (inner.content_block?.type === 'text') openText.set(inner.index, '');
        continue;
      }
      if (inner.type === 'content_block_delta' && typeof inner.index === 'number') {
        if (inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string' && openText.has(inner.index)) {
          openText.set(inner.index, (openText.get(inner.index) ?? '') + inner.delta.text);
        }
        continue;
      }
      if (inner.type === 'content_block_stop' && typeof inner.index === 'number') {
        const finished = openText.get(inner.index);
        if (finished !== undefined) {
          openText.delete(inner.index);
          const trimmed = finished.trim();
          if (trimmed) pendingAssistant = pendingAssistant ? `${pendingAssistant}\n${trimmed}` : trimmed;
        }
      }
    }
    flushAssistant();
    return latestAssistant;
  }

  private approvedGmailDraftForText(text: string): ApprovedGmailDraft | null {
    if (!isExplicitEmailApprovalText(text)) return null;
    const latestAssistant = this.latestAssistantTextFromLog();
    if (!looksLikeEmailDraftText(latestAssistant)) return null;
    return extractEmailDraft(latestAssistant);
  }

  async send(text: string, images?: ChatImage[], opts: BananaSendOptions = {}): Promise<void> {
    if (opts.signal?.aborted) return;
    if (this.busy) {
      // Internal team delivery retries at the natural boundary. Do not leak a
      // transient admission race into the human transcript as a provider error.
      if (!opts.peerFrom) {
        this.emit({
          type: 'error',
          message: 'banana is still answering — wait for the current turn to finish',
        });
      }
      return;
    }
    this.busy = true;
    this.wipedThisTurn = false;
    if (opts.hidden) this.emit({ type: 'turnStart' });
    const recoverContextThisTurn = this.recoverContextOnNextTurn;
    const historyThroughSeq = this.latestSeq();
    const fallbackHistory = this.eventLog.slice();
    const gmailApprovedDraft = opts.hidden ? null : this.approvedGmailDraftForText(text);
    // Echo for reconnect replay (banana's events don't re-emit the user prompt).
    // Internal auto-continues are intentionally hidden; they are just TARDIS
    // nudging Banana past an opencode compaction summary.
    if (opts.peerFrom) {
      this.emit({ type: 'turnStart' });
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
    } else if (!opts.hidden) {
      let attachments: Array<{ id: string; mediaType: string }>;
      try {
        attachments = opts.skipAttachments ? [] : await saveChatAttachments(images);
      } catch (error) {
        this.busy = false;
        throw error;
      }
      if (opts.signal?.aborted || this.dead) {
        this.busy = false;
        return;
      }
      await flushEventLog(this.logKey);
      if (opts.signal?.aborted || this.dead) {
        this.busy = false;
        return;
      }
      try {
        this.emit({
          type: 'event',
          event: { type: '_user_echo', text, imageCount: images?.length ?? 0, attachments, clientMsgId: opts.clientMsgId, ts: Date.now() },
        });
      } catch (error) {
        this.busy = false;
        throw error;
      }
      noteUserTurn(this.logKey); // compaction cadence (monotonic)
      noteAgentLane(this.chatId, this.cli); // historical lane diagnostics
    }

    // Vision adapter: a text-only OpenRouter model (or any local LM Studio chat
    // model) can't read a native image, so route pasted images through the local
    // LM Studio vision model and inject a text description instead. Done BEFORE
    // the turn state / stall watchdog is armed so the (up to 90s) describe call
    // can't trip the watchdog. When adapted, `visionPromptText` carries the
    // rewritten prompt and we skip writing the native file:// parts entirely.
    let visionPromptText: string | null = null;
    if (images?.length && getVisionMode() !== 'off') {
      const supportsImages = await bananaModelSupportsImages(this.cli, opts.model);
      const result = await adaptImagesForTextModel({ text, images, modelSupportsImages: supportsImages });
      if (result.adapted) {
        visionPromptText = result.text;
        if (result.note) {
          console.log(`[chat banana] vision adapter: ${result.note}`);
          this.emit({
            type: 'event',
            event: { type: '_vision_adapter', images: images.length, note: result.note, ts: Date.now() },
          });
        }
      }
      if (this.dead) {
        this.busy = false;
        return;
      }
    }

    // Write image attachments to temp files; banana's prompt parts reference
    // them by file:// URL (the same mechanism the run path uses). The temp dir
    // is torn down when this turn ends. `cleanupImages` is idempotent (the
    // null-out makes a second call a no-op) and swallows rm failures so a
    // cleanup error can never crash the process with an unhandled rejection.
    // It is held on `turnCleanup` only for the pre-turn-state window (an early
    // setup failure or a shutdown before the turn object exists); once the
    // turn object is built it owns the cleanup, so a stale idle event for a
    // previous turn can never delete this turn's files.
    let imageTempDir: string | null = null;
    const cleanupImages = () => {
      const dir = imageTempDir;
      imageTempDir = null;
      if (dir) {
        void rm(dir, { recursive: true, force: true }).catch((err) => {
          console.warn(`[chat banana] image temp cleanup failed (${dir}): ${(err as Error).message}`);
        });
      }
    };
    this.turnCleanup = cleanupImages;

    const fileParts: Array<{ type: 'file'; url: string; filename: string; mime: string }> = [];
    try {
      if (images?.length && visionPromptText === null) {
        imageTempDir = await mkdtemp(join(tmpdir(), 'rivendell-banana-images-'));
        for (const [index, image] of images.entries()) {
          if (!image.mediaType.startsWith('image/')) {
            throw new Error(`unsupported image media type: ${image.mediaType}`);
          }
          const ext = imageExtension(image.mediaType);
          const filename = `image-${index + 1}.${ext}`;
          const path = join(imageTempDir, filename);
          await writeFile(path, Buffer.from(image.base64, 'base64'));
          fileParts.push({
            type: 'file',
            url: pathToFileURL(path).href,
            filename,
            mime: image.mediaType,
          });
        }
      }
    } catch (err) {
      this.failTurn(`image preparation failed: ${(err as Error).message}`);
      return;
    }
    // The session was shut down (tab close / stop) while images were being
    // written. Bail before touching the server so banana never receives URLs
    // for a temp dir shutdown() already deleted.
    if (this.dead) {
      this.turnCleanup?.();
      this.turnCleanup = null;
      this.busy = false;
      return;
    }

    // 1. Make sure the shared serve process is up.
    try {
      await bananaServer.ensure(this.cwd, this);
    } catch (err) {
      this.failTurn(`banana serve unavailable: ${(err as Error).message}`);
      return;
    }
    if (this.dead) {
      this.turnCleanup?.();
      this.turnCleanup = null;
      this.busy = false;
      return;
    }

    const client = bananaServer.clientFor(this.cwd);
    const serveGeneration = bananaServer.currentGeneration();

    // 2. Reuse the saved sessionID only while this exact `banana serve`
    //    generation owns it. `session.get()` can report old ids after a restart
    //    even though prompting them hangs with no SSE events, so a generation
    //    mismatch is treated as unsafe and recovered via transcript recap.
    if (this.threadId && this.threadServeGeneration !== serveGeneration) {
      await this.clearSavedThreadId('banana serve restarted');
    } else if (this.threadId) {
      const staleReason = await validateSessionExists(client, this.threadId);
      if (staleReason) await this.clearSavedThreadId(staleReason);
    }

    // 3. Reuse the validated sessionID, or create a new one with the plan ruleset.
    if (!this.threadId) {
      try {
        const created = await client.session.create({
          title: text.slice(0, 50) + (text.length > 50 ? '...' : ''),
          permission: PLAN_RULESET,
        });
        const newId = created.data?.id;
        if (!newId) {
          this.failTurn('banana session.create returned no id');
          return;
        }
        // Fresh/Stop may have retired this lane while session.create was in
        // flight. Never let that obsolete completion restore a native id after
        // the engine-neutral thread reset has cleared every provider lane.
        if (this.dead) return;
        this.threadId = newId;
        this.threadServeGeneration = serveGeneration;
        await this.queueSessionId(newId);
        this.emit({ type: 'event', event: { type: 'system', subtype: 'init', session_id: newId } });
      } catch (err) {
        this.failTurn(`banana session.create failed: ${(err as Error).message}`);
        return;
      }
    }
    await this.refreshPermissionRules(client);
    if (this.dead) {
      this.turnCleanup?.();
      this.turnCleanup = null;
      this.busy = false;
      return;
    }

    // 4. Register the route so the shared event loop fans events to us.
    bananaServer.registerRoute(this.threadId, this);

    // 5. Open per-turn streaming state and arm the stall watchdog. The image
    //    cleanup moves onto the turn object now, so only this turn's own end
    //    (completeTurn / failTurn) tears its files down — a stale idle for a
    //    prior turn can no longer reach them.
    this.turn = {
      messageId: synth('msg'),
      nextBlockIndex: 0,
      messageStarted: false,
      parts: new Map(),
      bufferedDeltas: new Map(),
      assistantMessageId: null,
      promptAccepted: false,
      peerDeliveryId: opts.peerDeliveryId,
      recoveryRecapUsed: false,
      sawToolUse: false,
      currentMessageVisibleContent: false,
      currentMessageHiddenCompactionSummary: false,
      model: opts.model,
      voiceMode: opts.voiceMode === true,
      autoContinueDepth: opts.autoContinueDepth ?? 0,
      blockedSideEffectContinueDepth: opts.blockedSideEffectContinueDepth ?? opts.blockedSearchContinueDepth ?? 0,
      gmailApprovedDraft,
      usage: null,
      done: false,
      cleanup: cleanupImages,
    };
    this.turnCleanup = null;
    this.armWatchdog();

    // 6. Fire the prompt. `prompt` resolves when the turn completes server
    //    side, but we drive the UI off the streamed events; the turn formally
    //    ends on the `session.status: idle` event. We still await to surface a
    //    request-level failure (auth, model not found, etc.).
    //
    //    If this turn had to wipe the opencode session (serve restart, stale
    //    id), prepend the recap of the prior conversation to the prompt text
    //    so the brand-new session inherits context. Slash commands are expanded
    //    into prompt text here so Banana sees Claude/project commands too.
    // Engine boundary: each banana cli must run ONLY its own provider's models,
    // so a turn never silently routes elsewhere (e.g. leaking a local-intended
    // prompt to the cloud, or falling back to Banana's built-in — now dead —
    // monkey default). Pin a missing/foreign id to that engine's default.
    //   banana-local      -> whatever vLLM has loaded (else a local/* error id)
    //   banana-fireworks  -> a fireworks/* id (FIREWORKS_DEFAULT_MODEL)
    //   banana            -> an openrouter/* id (OPENROUTER_DEFAULT_MODEL)
    let requestedModelId = opts?.model;
    const requestedProvider = parseModel(requestedModelId)?.providerID;
    if (this.cli === 'banana-local') {
      if (requestedProvider !== 'local') {
        const st = await localVllmStatus();
        requestedModelId = `local/${st.loaded ?? 'no-model-loaded'}`;
      }
    } else if (this.cli === 'banana-fireworks') {
      if (requestedProvider !== 'fireworks') {
        requestedModelId = FIREWORKS_DEFAULT_MODEL;
      }
    } else if (this.cli === 'banana') {
      // OpenRouter engine: anything not openrouter/* (missing, stale monkey/*,
      // local/*, fireworks/*) pins to the OpenRouter default.
      if (requestedProvider !== 'openrouter') {
        requestedModelId = OPENROUTER_DEFAULT_MODEL;
      }
    }
    const model = parseModel(requestedModelId);
    this.turnModel = requestedModelId ?? null;
    this.turnEffort = opts.effort ?? null;
    const slashCommand = await parseBananaSlashCommand(text, this.cwd);
    const needsContextRecovery = this.wipedThisTurn || recoverContextThisTurn;
    const seedWindow = this.consumeWindowSeed() || needsContextRecovery;
    const commandExpandedText = visionPromptText ?? (slashCommand ? expandBananaSlashCommand(slashCommand) : text);
    const seed = seedWindow
      ? await peekEnginePrimerThroughSeq(this.logKey, historyThroughSeq, fallbackHistory)
      : '';
    const personaScope = personaPromptFor(this.chatId);
    const personaPrefix = personaScope ? `${personaScope}\n\n---\n\n` : '';
    const conversationGuidance = conversationGuidanceForTurn({
      chatId: this.chatId, logKey: this.logKey, historyThroughSeq,
      peerFrom: opts.peerFrom,
      peerFromRole: opts.peerFromRole,
      hidden: opts.hidden,
    });
    const effectiveText = `${computerGuidance(this.chatId, agentForChatId(this.chatId)?.name ?? 'Companion', !opts.peerFrom && opts.peerFromRole !== 'automation')}\n\n${personaPrefix}${seed ? `${seed}\n\n---\n\n` : ''}${conversationGuidance ? `${conversationGuidance}\n\n` : ''}${opts.voiceMode ? `${THREAD_VOICE_STYLE_ADDENDUM}\n\n` : ''}${commandExpandedText}`;
    if (seed) {
      this.turn.recoveryRecapUsed = true;
      this.emit({
        type: 'event',
        event: { type: '_context_recovered', chars: seed.length, ts: Date.now() },
      });
    } else if (recoverContextThisTurn) {
      this.recoverContextOnNextTurn = false;
    }
    const localDirective = this.cli === 'banana-local'
      ? localThinkingDirective(requestedModelId, opts?.effort)
      : null;
    const promptText = localDirective ? `${localDirective}\n${effectiveText}` : effectiveText;
    const providerVariant = this.cli !== 'banana-local' && opts?.effort ? opts.effort : undefined;
    const thisTurn = this.turn;
    const promptKind = slashCommand ? 'command' : 'prompt';
    try {
      const res = await client.session.prompt({
        sessionID: this.threadId,
        ...(model ? { model } : {}),
        // Per-request reasoning effort. The SDK prompt client only forwards a
        // fixed key set and silently DROPS `options` — but it does forward
        // `variant`. Banana maps the model's effort variant (low|medium|high) to
        // providerOptions: {reasoning:{effort}} for the OpenRouter provider,
        // {reasoningEffort} for openai-compatible. A model with no matching
        // variant is a safe no-op.
        ...(providerVariant ? { variant: providerVariant } : {}),
        parts: [...fileParts, { type: 'text' as const, text: promptText }],
      });
      if (res.error) {
        const message = errorText(res.error);
        if (this.turn === thisTurn && !thisTurn.done) {
          if (isPromptTransportFailure(message) && this.turnHasServerActivity(thisTurn)) {
            console.warn(
              `[chat banana] ${promptKind} transport returned error after stream activity; keeping turn alive (${message})`,
            );
            return;
          }
          this.failTurn(isPromptTransportFailure(message)
            ? `banana ${promptKind} failed: local Banana server connection failed, restarting for the next turn (${message})`
            : `banana ${promptKind} failed: ${message}`);
          if (isPromptTransportFailure(message)) {
            bananaServer.notePromptTransportFailure(message);
          }
        }
      }
      // The prompt was accepted by the server. Mark THIS turn so a
      // `session.status idle` is now honored as completion (guarded against
      // the turn having already settled and been replaced). This must happen
      // after `res.error` handling so a failed response with no streamed
      // activity does not count as activity merely because the response came
      // back.
      if (this.turn === thisTurn && !thisTurn.done) {
        this.markPromptAccepted(thisTurn);
      }
    } catch (err) {
      if (this.turn === thisTurn && !thisTurn.done) {
        const message = errorText(err);
        if (
          isPromptTransportFailure(message) &&
          this.turnHasServerActivity(thisTurn)
        ) {
          console.warn(
            `[chat banana] ${promptKind} transport ended after stream activity; keeping turn alive (${message})`,
          );
          return;
        }
        this.failTurn(isPromptTransportFailure(message)
          ? `banana ${promptKind} failed: local Banana server connection failed, restarting for the next turn (${message})`
          : `banana ${promptKind} failed: ${message}`);
        if (isPromptTransportFailure(message)) {
          bananaServer.notePromptTransportFailure(message);
        }
      }
    }
  }

  // ── server-event entry points ──────────────────────────────

  /** Called by BananaServer when its serve child dies. Fail any in-flight
   *  turn so the UI shows an error instead of freezing. */
  onServerDeath(reason: string): void {
    if (this.busy && this.turn && !this.turn.done) {
      // The serve process died under an in-flight turn. failTurn() emits error +
      // result, but neither is an assistant turn, so the model window would come
      // back blank and the next turn would report it did nothing. Leave a
      // durable marker first. See crashTombstone.ts.
      try {
        const killed = /SIGKILL|code=137/.test(reason);
        this.emit(crashTombstoneEvent(crashTombstoneText({
          cli: 'banana',
          cwd: this.cwd,
          sessionId: this.threadId,
          code: killed ? 137 : null,
          signal: killed ? 'SIGKILL' : null,
        })));
      } catch (err) {
        console.warn('[banana] tombstone emit failed:', (err as Error).message);
      }
      this.failTurn(`banana server stopped: ${reason}`);
    }
  }

  /** Called by BananaServer's fan-out for every event whose sessionID is ours. */
  handleServerEvent(event: Event): void {
    if (!this.busy || !this.turn || this.turn.done) return;
    const state = this.turn;

    switch (event.type) {
      case 'message.updated': {
        const info = event.properties.info;
        if (info.role !== 'assistant') return;
        if (state.assistantMessageId && state.assistantMessageId !== info.id) {
          if (!this.trySwitchAssistantMessage(info.id, state)) return;
        } else {
          if (!this.tryAnchorAssistantMessage(info.id, state)) return;
        }
        // The turn has a real assistant message — a later idle is now its own.
        this.markPromptAccepted(state);
        this.armWatchdog();
        this.ensureMessageStart(state);
        return;
      }
      case 'message.part.updated': {
        const part = event.properties.part as { messageID?: unknown } | undefined;
        const messageID = part && typeof part.messageID === 'string' ? part.messageID : undefined;
        // Do NOT anchor from a part.updated: a part carries no role, and the
        // user message's own text part can arrive first — anchoring to it
        // would render the prompt straight back as the answer. Anchoring is
        // driven by deltas (only the assistant streams) and by an assistant
        // message.updated. Drop part.updateds until the turn anchors; the
        // text reconciler backfills their content from a later snapshot.
        if (!this.belongsToTurn(messageID, state, false)) return;
        this.armWatchdog();
        this.handlePartUpdated(event.properties.part, state);
        return;
      }
      case 'message.part.delta': {
        // Deltas only ever stream for the assistant message — a user message
        // is created whole and never streamed. So the first delta reliably
        // identifies this turn's assistant message; anchor to it.
        if (!this.belongsToTurn(event.properties.messageID, state, true)) return;
        this.armWatchdog();
        this.handlePartDelta(event.properties.partID, event.properties.field, event.properties.delta, state);
        return;
      }
      case 'session.error': {
        if (event.properties.sessionID && event.properties.sessionID !== this.threadId) return;
        this.armWatchdog();
        this.failTurn(`banana session error: ${errorText(event.properties.error)}`);
        return;
      }
      case 'session.status': {
        if (event.properties.sessionID !== this.threadId) return;
        this.armWatchdog();
        if (event.properties.status.type === 'idle') {
          // Only honor idle once this turn's prompt was accepted (or the turn
          // anchored). A trailing idle from the PREVIOUS prompt — the banana
          // session is reused — can otherwise land before this turn's prompt
          // is accepted and fake-complete it before the real answer streams.
          if (!state.promptAccepted) return;
          this.completeTurn(state);
        }
        return;
      }
      case 'session.idle': {
        const props = event.properties as { sessionID?: unknown; sessionId?: unknown };
        const sessionID = typeof props.sessionID === 'string'
          ? props.sessionID
          : (typeof props.sessionId === 'string' ? props.sessionId : undefined);
        if (sessionID && sessionID !== this.threadId) return;
        this.armWatchdog();
        if (!state.promptAccepted) return;
        this.completeTurn(state);
        return;
      }
      case 'permission.asked': {
        if (event.properties.sessionID !== this.threadId) return;
        this.armWatchdog();
        void this.replyToPermission(event.properties);
        return;
      }
      default:
        return;
    }
  }

  /** True if a part event belongs to the current turn.
   *
   *  `mayAnchor` is true ONLY for message.part.delta: a delta is emitted just
   *  for the assistant message (a user message is created whole, never
   *  streamed), so the first delta reliably anchors the turn. A part.updated
   *  carries no role and the user message's own text part can arrive first,
   *  so it must never anchor — it is dropped until a delta (or an assistant
   *  message.updated) anchors the turn; the text reconciler then backfills
   *  the snapshot content.
   *
   *  A part event with no usable messageID is dropped: it cannot be proven to
   *  belong to this turn, and accepting it would let a message-less user
   *  part.updated render the prompt back as the answer — the exact bug the
   *  delta-driven anchoring closes. */
  private belongsToTurn(
    messageID: string | undefined,
    state: BananaTurnState,
    mayAnchor: boolean,
  ): boolean {
    if (typeof messageID !== 'string' || !messageID) return false;
    if (!state.assistantMessageId) {
      if (!mayAnchor) return false;
      // First delta of the turn — adopt it as the turn anchor. The turn now
      // has a real assistant message, so a later idle is its own.
      return this.tryAnchorAssistantMessage(messageID, state);
    }
    if (state.assistantMessageId === messageID) return true;
    return mayAnchor ? this.trySwitchAssistantMessage(messageID, state) : false;
  }

  private tryAnchorAssistantMessage(messageID: unknown, state: BananaTurnState): boolean {
    if (typeof messageID !== 'string' || !messageID) return false;
    if (this.seenMessageIds.has(messageID)) return false;
    state.assistantMessageId = messageID;
    this.markPromptAccepted(state);
    this.rememberSeenMessageId(messageID);
    this.ensureMessageStart(state);
    return true;
  }

  /** Switch to a later assistant message in the same turn. Required for MCP
   *  tool use: opencode emits a tool_use assistant message, then a second
   *  assistant message with the final answer after tool_result blocks. */
  private trySwitchAssistantMessage(messageID: string, state: BananaTurnState): boolean {
    if (messageID === state.assistantMessageId) return true;
    if (this.seenMessageIds.has(messageID)) return false;
    if (!state.sawToolUse) {
      this.rememberSeenMessageId(messageID);
      return false;
    }
    if (this.hasOpenBlocks(state)) return false;

    state.assistantMessageId = messageID;
    state.messageId = synth('msg');
    state.nextBlockIndex = 0;
    state.messageStarted = false;
    state.currentMessageVisibleContent = false;
    state.currentMessageHiddenCompactionSummary = false;
    state.parts.clear();
    state.bufferedDeltas.clear();
    this.markPromptAccepted(state);
    this.rememberSeenMessageId(messageID);
    this.ensureMessageStart(state);
    return true;
  }

  private rememberSeenMessageId(messageID: string): void {
    if (this.seenMessageIds.has(messageID)) return;
    this.seenMessageIds.add(messageID);
    if (this.seenMessageIds.size > 256) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest !== undefined) this.seenMessageIds.delete(oldest);
    }
  }

  private hasOpenBlocks(state: BananaTurnState): boolean {
    for (const rec of state.parts.values()) {
      if (rec.started && !rec.closed) return true;
    }
    return false;
  }

  private turnHasServerActivity(state: BananaTurnState): boolean {
    return (
      state.promptAccepted ||
      state.messageStarted ||
      state.assistantMessageId !== null ||
      state.parts.size > 0 ||
      state.bufferedDeltas.size > 0 ||
      state.sawToolUse ||
      state.usage !== null
    );
  }

  private markPromptAccepted(state: BananaTurnState): void {
    if (!state.promptAccepted && state.peerDeliveryId) {
      this.emit({
        type: 'event',
        event: { type: 'peer_delivery_accepted', deliveryId: state.peerDeliveryId, ts: Date.now() },
      });
    }
    state.promptAccepted = true;
    if (state.recoveryRecapUsed) {
      this.recoverContextOnNextTurn = false;
      this.ackWindowSeed();
    }
  }

  // ── streaming normalization ────────────────────────────────

  private visibleTextStart(rec: PartRecord, state: BananaTurnState): void {
    if (rec.started) return;
    rec.index = state.nextBlockIndex++;
    rec.started = true;
    state.currentMessageVisibleContent = true;
    this.emitStream({
      type: 'content_block_start',
      index: rec.index,
      content_block: { type: 'text', text: '' },
    });
  }

  private flushPendingText(rec: PartRecord, state: BananaTurnState, sourceLength?: number): void {
    const pending = rec.pendingText ?? '';
    this.visibleTextStart(rec, state);
    if (pending) {
      rec.emittedLen = sourceLength ?? pending.length;
      rec.pendingText = '';
      this.emitStream({
        type: 'content_block_delta',
        index: rec.index,
        delta: { type: 'text_delta', text: pending },
      });
    }
  }

  private maybeHideOrHoldText(
    rec: PartRecord,
    text: string,
    state: BananaTurnState,
    ended = false,
  ): 'empty' | 'hidden' | 'held' | 'visible' {
    rec.pendingText = text;

    if (!text) {
      if (!ended) return 'held';
      rec.pendingText = '';
      rec.emittedLen = 0;
      return 'empty';
    }

    const lower = normalizedCompactionCandidate(text);
    const summary = parseSummaryPrefix(text);
    if (summary?.status === 'open') {
      if (!ended) return 'held';
      this.flushPendingText(rec, state, text.length);
      return 'visible';
    }
    if (summary?.status === 'closed') {
      const trailing = summary.trailing.trimStart();
      if (trailing) {
        rec.pendingText = trailing;
        this.flushPendingText(rec, state, text.length);
        return 'visible';
      }
      if (!ended) return 'held';
      rec.hidden = true;
      rec.pendingText = '';
      rec.emittedLen = text.length;
      state.currentMessageHiddenCompactionSummary = true;
      console.warn(`[chat banana] hiding internal opencode compact summary for ${this.key}`);
      return 'hidden';
    }

    if (
      lower.length <= COMPACTION_SUMMARY_OPEN.length &&
      COMPACTION_SUMMARY_OPEN.startsWith(lower) &&
      !ended
    ) {
      return 'held';
    }
    this.flushPendingText(rec, state, text.length);
    return 'visible';
  }

  /** message.part.updated — a part was created or progressed. Open answer text
   *  blocks on first sight, suppress reasoning scratchpad parts, flush any
   *  deltas that arrived early, and on time.end close the block. Tool parts
   *  get the v1 tool handling.
   *  `part` is the SDK `Part` union; it is read structurally here. */
  private handlePartUpdated(part: any, state: BananaTurnState): void {
    if (!part || typeof part !== 'object') return;
    this.ensureMessageStart(state);
    const partID: string = typeof part.id === 'string' ? part.id : '';
    const type: string = typeof part.type === 'string' ? part.type : '';

    if (type === 'step-finish' && part.tokens && typeof part.tokens === 'object') {
      const t = part.tokens as Record<string, unknown>;
      const input = Number(t.input ?? 0);
      const output = Number(t.output ?? 0);
      const cache = (t.cache && typeof t.cache === 'object' ? t.cache : {}) as Record<string, unknown>;
      state.usage = {
        input_tokens: Math.max(0, input),
        cache_read_input_tokens: Math.max(0, Number(cache.read ?? 0)),
        cache_creation_input_tokens: Math.max(0, Number(cache.write ?? 0)),
        output_tokens: Math.max(0, output),
      };
      return;
    }

    if (type === 'reasoning') {
      if (!partID) return;
      let rec = state.parts.get(partID);
      if (!rec) {
        rec = { index: -1, kind: 'reasoning', started: false, emittedLen: 0, closed: false };
        state.parts.set(partID, rec);
      }
      if (typeof part.text === 'string') rec.emittedLen = part.text.length;
      state.bufferedDeltas.delete(partID);
      const ended = part.time && typeof part.time === 'object' && part.time.end != null;
      if (ended) rec.closed = true;
      return;
    }

    if (type === 'text') {
      if (!partID) return;
      let rec = state.parts.get(partID);
      // The block is already closed. A repeated or replayed final snapshot for
      // the same partID lands here; ignore it so the answer is not re-emitted
      // as a duplicate block.
      if (rec && rec.closed) return;
      if (!rec) {
        rec = { index: -1, kind: 'text', started: false, emittedLen: 0, closed: false };
        state.parts.set(partID, rec);
      }

      const buffered = state.bufferedDeltas.get(partID);
      const bufferedText = buffered?.length ? buffered.join('') : '';
      if (buffered?.length) {
        state.bufferedDeltas.delete(partID);
      }
      const ended = part.time && typeof part.time === 'object' && part.time.end != null;

      if (rec.hidden) {
        if (typeof part.text === 'string') rec.emittedLen = Math.max(rec.emittedLen, part.text.length);
      } else if (!rec.started) {
        const snapshotText = typeof part.text === 'string' ? part.text : '';
        const observedText = `${rec.pendingText ?? ''}${bufferedText}`;
        const text = reconcileTextSnapshot(snapshotText, observedText);
        const decision = this.maybeHideOrHoldText(rec, text, state, Boolean(ended));
        if (decision === 'held') return;
      }
      // Reconcile against the snapshot. `part.text` is the full accumulated
      // text of this block; streaming deltas are an optimization layered on
      // top. Emitting only the un-emitted remainder here means a dropped or
      // pre-anchor delta can never lose text — every snapshot backfills it.
      if (!rec.hidden && rec.started && typeof part.text === 'string' && part.text.length > rec.emittedLen) {
        const remainder = part.text.slice(rec.emittedLen);
        rec.emittedLen = part.text.length;
        this.emitStream({
          type: 'content_block_delta',
          index: rec.index,
          delta: { type: 'text_delta', text: remainder },
        });
      }
      // A text/reasoning part with time.end is finished — close its block
      // once. The record is kept (not deleted) with `closed = true` so a
      // later duplicate snapshot for this partID cannot recreate it.
      if (ended) {
        rec.closed = true;
        if (!rec.hidden && rec.started) {
          this.emitStream({ type: 'content_block_stop', index: rec.index });
        }
      }
      return;
    }

    if (type === 'tool') {
      this.handleToolPart(part, state);
      return;
    }

    // step-start and other part types — nothing to normalize.
  }

  /** message.part.delta — incremental token text. The delta only carries
   *  partID + field, so route it via the partID -> block-record map built from
   *  prior message.part.updated events. Buffer it if the part isn't open yet. */
  private handlePartDelta(partID: string, field: string, delta: string, state: BananaTurnState): void {
    if (field !== 'text' || typeof delta !== 'string' || !delta) return;
    const rec = state.parts.get(partID);
    if (!rec) {
      // Delta raced ahead of its part-created event — buffer until it lands.
      const buf = state.bufferedDeltas.get(partID) ?? [];
      buf.push(delta);
      state.bufferedDeltas.set(partID, buf);
      return;
    }
    if (rec.kind === 'reasoning') {
      rec.emittedLen += delta.length;
      return;
    }
    if (rec.kind !== 'text') return;
    // The block was already closed (a late delta after content_block_stop).
    // Dropping it keeps the closed block immutable on the frontend.
    if (rec.closed) return;
    if (rec.hidden) {
      rec.emittedLen += delta.length;
      return;
    }
    if (!rec.started) {
      const text = (rec.pendingText ?? '') + delta;
      const decision = this.maybeHideOrHoldText(rec, text, state);
      if (decision !== 'visible') return;
      return;
    }
    // Advance emittedLen so the part.updated snapshot reconciler emits only
    // the remainder past what these deltas already streamed.
    rec.emittedLen += delta.length;
    this.emitStream({
      type: 'content_block_delta',
      index: rec.index,
      delta: { type: 'text_delta', text: delta },
    });
  }

  /** Tool parts: open a tool_use block on `running`, then on completed/error
   *  close it and emit a synthetic user tool_result the way v1 / claude do. */
  private handleToolPart(part: any, state: BananaTurnState): void {
    state.sawToolUse = true;
    const callID: string = typeof part.callID === 'string' ? part.callID : (typeof part.id === 'string' ? part.id : synth('call'));
    const toolName: string = typeof part.tool === 'string' ? part.tool : 'tool';
    const stateBlock = part.state ?? {};
    const status: string = typeof stateBlock.status === 'string' ? stateBlock.status : '';
    const partID: string = typeof part.id === 'string' ? part.id : callID;

    let rec = state.parts.get(partID);
    if (rec?.closed) return;
    if (!rec && (status === 'running' || status === 'pending' || status === 'completed' || status === 'error')) {
      const index = state.nextBlockIndex++;
      rec = { index, kind: 'tool', started: true, emittedLen: 0, closed: false };
      state.parts.set(partID, rec);
      state.currentMessageVisibleContent = true;
      const toolUseId = synth('tool');
      rec.toolUseId = toolUseId;
      rec.toolName = toolName;
      this.emitStream({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: toolUseId, name: toolName },
      });
    }

    if (!rec) return;
    rec.toolName = rec.toolName ?? toolName;
    this.captureToolInput(rec, stateBlock);
    if (status === 'running' || status === 'pending' || status === 'error') {
      const gmailCall = gmailSideEffectCall(toolName, stateBlock.input);
      if (gmailCall && !rec.approvedGmailSideEffect) {
        if (state.gmailApprovedDraft && approvedDraftMatchesCall(state.gmailApprovedDraft, gmailCall)) {
          rec.approvedGmailSideEffect = true;
          state.gmailApprovedDraft = null;
        } else {
          const gmailMessage = gmailSideEffectBlockMessage(toolName, stateBlock.input, state.gmailApprovedDraft);
          if (gmailMessage) {
            this.emitStoredToolInput(rec);
            console.warn(`[chat banana] ${gmailMessage}`);
            this.abortServerTurn();
            this.failTurn(gmailMessage, gmailMessage);
            this.continueAfterBlockedSideEffect(gmailMessage, state);
            return;
          }
        }
      }
    }

    if (status === 'running' || status === 'pending') {
      return;
    }

    if (rec && (status === 'completed' || status === 'error')) {
      const toolUseId: string = rec.toolUseId ?? synth('tool');
      this.emitStoredToolInput(rec);
      rec.closed = true;
      this.emitStream({ type: 'content_block_stop', index: rec.index });
      const output: string = status === 'completed'
        ? (typeof stateBlock.output === 'string' ? stateBlock.output : '')
        : (typeof stateBlock.error === 'string' ? stateBlock.error : 'tool error');
      this.emit({
        type: 'event',
        event: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: redactToolText(output) }] },
            ],
          },
        },
      });
    }
  }

  private captureToolInput(rec: PartRecord, stateBlock: any): void {
    const inputText = stringifyToolInput(stateBlock?.input);
    if (!isMeaningfulToolInput(inputText)) return;
    rec.inputText = inputText;
  }

  private emitStoredToolInput(rec: PartRecord): void {
    const inputText = rec.inputText;
    if (!inputText || !isMeaningfulToolInput(inputText)) return;
    if (rec.emittedLen === 0) {
      rec.emittedLen = inputText.length;
      this.emitStream({
        type: 'content_block_delta',
        index: rec.index,
        delta: { type: 'input_json_delta', partial_json: inputText },
      });
      return;
    }

    if (inputText.length <= rec.emittedLen) {
      return;
    }
    const delta = inputText.slice(rec.emittedLen);
    rec.emittedLen = inputText.length;
    this.emitStream({
      type: 'content_block_delta',
      index: rec.index,
      delta: { type: 'input_json_delta', partial_json: delta },
    });
  }

  private async refreshPermissionRules(client: any): Promise<void> {
    if (!this.threadId) return;
    try {
      await client.session.update({ sessionID: this.threadId, permission: PLAN_RULESET });
    } catch (err) {
      console.warn(`[chat banana] session.permission update failed: ${(err as Error).message}`);
    }
  }

  /** Auto-reply to a permission request. Banana chat runs unsandboxed
   *  (skip-permissions equivalent), so the default reply is 'once'. */
  private async replyToPermission(request: PermissionRequest): Promise<void> {
    const planMode = process.env.RIVENDELL_BANANA_PLAN_MODE === 'true';
    const gmailMessage = gmailSideEffectPermissionMessage(request, this.turn?.gmailApprovedDraft ?? null);
    const rejectMessage = gmailMessage;
    if (rejectMessage) console.warn(`[chat banana] ${rejectMessage}`);
    try {
      const client = bananaServer.clientFor(this.cwd);
      await client.permission.reply({
        requestID: request.id,
        reply: planMode || rejectMessage ? 'reject' : 'once',
        ...(rejectMessage ? { message: rejectMessage } : {}),
      });
    } catch (err) {
      console.warn(`[chat banana] permission.reply failed: ${(err as Error).message}`);
    }
  }

  // ── turn lifecycle ─────────────────────────────────────────

  /** Lazily emit the synthetic message_start the reducer expects per turn. */
  private ensureMessageStart(state: BananaTurnState): void {
    if (state.messageStarted) return;
    state.messageStarted = true;
    this.emitStream({
      type: 'message_start',
      message: { id: state.messageId, role: 'assistant' },
    });
  }

  /** Normal turn end: session.status went idle. Close any dangling blocks,
   *  then either auto-continue past an internal compaction summary or emit the
   *  synthetic result + turnEnd. Does NOT touch the shared server. */
  private completeTurn(state: BananaTurnState): void {
    if (state.done) return;
    state.done = true;
    this.finalizePendingTextBlocks(state);
    const shouldAutoContinue =
      state.currentMessageHiddenCompactionSummary &&
      !state.currentMessageVisibleContent &&
      state.autoContinueDepth < 1;
    this.clearWatchdog();
    // Tear down this turn's image temp dir now that the turn is over.
    state.cleanup();
    this.closeDanglingBlocks(state, 'Banana finished before this block closed.');
    if (shouldAutoContinue) {
      this.continueAfterHiddenCompaction(state);
      return;
    }
    this.emit({
      type: 'event',
      event: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: this.threadId ?? undefined,
        usage: state.usage ?? undefined,
      },
    });
    this.busy = false;
    this.turn = null;
    this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
    // Forever-thread housekeeping (success path only — error paths retry on
    // the next clean turn end).
    void this.maybeCompact();
  }

  private continueAfterHiddenCompaction(state: BananaTurnState): void {
    this.emit({
      type: 'event',
      event: { type: '_context_compacted', ts: Date.now(), autoContinue: true },
    });
    const model = state.model;
    const autoContinueDepth = state.autoContinueDepth + 1;
    this.turn = null;
    this.busy = false;
    if (this.dead) {
      this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
      return;
    }
    void this.send(
      'Continue the previous task from where you left off. The last assistant message was an internal context summary; do not repeat it or output any <summary> block.',
      undefined,
      { model, hidden: true, voiceMode: state.voiceMode, autoContinueDepth },
    ).catch((err) => {
      if (!this.dead) this.failTurn(`banana hidden continue failed: ${(err as Error).message}`);
    });
  }

  private continueAfterBlockedSideEffect(message: string, state: BananaTurnState): void {
    if (this.dead || state.blockedSideEffectContinueDepth >= 1) return;
    const model = state.model;
    const blockedSideEffectContinueDepth = state.blockedSideEffectContinueDepth + 1;
    void this.send(
      [
        'Continue the previous task from where you left off.',
        message,
        'Do not retry that Gmail send/reply in this turn.',
        'Show the user the full email draft with From, To, Subject, and Body, then wait for explicit approval in a later message before sending.',
      ].join(' '),
      undefined,
      { model, hidden: true, voiceMode: state.voiceMode, blockedSideEffectContinueDepth },
    ).catch((err) => {
      if (!this.dead) this.failTurn(`banana blocked-side-effect continue failed: ${(err as Error).message}`);
    });
  }

  /** Abnormal turn end: an error, a stall, or the server died. Emits an error,
   *  a synthetic result, and turnEnd so the UI recovers. */
  private failTurn(message: string, toolFallback?: string): void {
    const state = this.turn;
    if (state) {
      if (state.done) return;
      state.done = true;
      this.closeDanglingBlocks(state, toolFallback ?? 'Banana stopped before this block closed.');
    }
    this.clearWatchdog();
    // Tear down the failed turn's image temp dir. Once the turn object exists
    // it owns the cleanup; before that (an early setup failure) it is still on
    // turnCleanup. Run whichever applies.
    if (state) {
      state.cleanup();
    } else {
      this.turnCleanup?.();
    }
    this.turnCleanup = null;
    this.emit({ type: 'error', message, code: 'BANANA_TURN_FAILED', retryable: true });
    this.emit({
      type: 'event',
      event: {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: this.threadId ?? undefined,
        usage: state?.usage ?? undefined,
      },
    });
    this.busy = false;
    this.turn = null;
    this.emit({ type: 'turnEnd', sessionId: this.threadId ?? undefined });
  }

  /** Close every still-open claude block (text/reasoning/tool) so the front-end
   *  reducer doesn't leave them spinning. Records already closed (a text block
   *  that saw its time.end) are skipped — their content_block_stop already
   *  went out. */
  private closeDanglingBlocks(state: BananaTurnState, toolFallback: string): void {
    for (const [, rec] of state.parts) {
      if (rec.kind === 'reasoning') continue;
      if (rec.hidden || !rec.started) continue;
      if (rec.closed) continue;
      rec.closed = true;
      if (rec.kind === 'tool') this.emitStoredToolInput(rec);
      this.emitStream({ type: 'content_block_stop', index: rec.index });
      if (rec.kind === 'tool') {
        const toolUseId: string = rec.toolUseId ?? synth('tool');
        this.emit({
          type: 'event',
          event: {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: [{ type: 'text', text: this.danglingToolResultText(rec, toolFallback) }],
                },
              ],
            },
          },
        });
      }
    }
    state.parts.clear();
    state.bufferedDeltas.clear();
  }

  private danglingToolResultText(rec: PartRecord, fallback: string): string {
    const lines = [fallback];
    if (rec.toolName) lines.push(`Tool: ${rec.toolName}`);
    const input = this.formatToolInputForDisplay(rec);
    if (input) lines.push(`Input: ${input}`);
    return lines.join('\n');
  }

  private finalizePendingTextBlocks(state: BananaTurnState): void {
    for (const rec of state.parts.values()) {
      if (rec.kind !== 'text' || rec.closed || rec.hidden || rec.started) continue;
      const text = rec.pendingText ?? '';
      this.maybeHideOrHoldText(rec, text, state, true);
      rec.closed = true;
      if (!rec.hidden && rec.started) {
        this.emitStream({ type: 'content_block_stop', index: rec.index });
      }
    }
  }

  private formatToolInputForDisplay(rec: PartRecord): string {
    if (!rec.inputText) return '';
    let text = rec.inputText;
    try {
      const parsed = JSON.parse(rec.inputText) as Record<string, unknown>;
      if (rec.toolName === 'bash' && typeof parsed.command === 'string') {
        text = parsed.command;
      }
    } catch {}
    return truncateToolText(redactToolText(text));
  }

  private hasOpenTool(state: BananaTurnState): boolean {
    for (const rec of state.parts.values()) {
      if (rec.kind === 'tool' && !rec.closed) return true;
    }
    return false;
  }

  private describeOpenTools(state: BananaTurnState): string {
    const tools: string[] = [];
    for (const rec of state.parts.values()) {
      if (rec.kind !== 'tool' || rec.closed) continue;
      const name = rec.toolName ?? 'tool';
      const input = this.formatToolInputForDisplay(rec);
      tools.push(input ? `${name}: ${input}` : name);
    }
    if (tools.length === 0) return '';
    return tools.length === 1 ? `Stuck tool: ${tools[0]}` : `Stuck tools: ${tools.join('; ')}`;
  }

  // ── stall watchdog ─────────────────────────────────────────

  // `keepToolWait` is set only when the watchdog re-arms itself because a tool
  // is still legitimately running — every other caller is real streaming
  // activity, which resets the cumulative tool-silence budget.
  private armWatchdog(keepToolWait = false): void {
    this.clearWatchdog();
    if (!keepToolWait) this.toolStallWaitedMs = 0;
    const timeoutMs = stallTimeoutMs();
    this.watchdog = setTimeout(() => {
      if (!this.busy || !this.turn || this.turn.done) return;
      // A tool running in its own context (e.g. `task` → subagent) emits no
      // parent-stream events while it works. That silence is expected, not a
      // stall, so don't abort — re-arm and keep waiting, up to a much larger
      // cumulative ceiling that still catches a genuinely wedged tool.
      if (this.hasOpenTool(this.turn)) {
        this.toolStallWaitedMs += timeoutMs;
        const toolCeiling = toolStallTimeoutMs();
        if (this.toolStallWaitedMs < toolCeiling) {
          console.log(
            `[chat banana] tool still running after ${Math.round(this.toolStallWaitedMs / 1000)}s of parent-stream silence cwd=${this.cwd} (${this.describeOpenTools(this.turn)}) — not a stall, still waiting (ceiling ${Math.round(toolCeiling / 1000)}s)`,
          );
          this.armWatchdog(true);
          return;
        }
      }
      const elapsedMs = this.hasOpenTool(this.turn)
        ? Math.max(timeoutMs, this.toolStallWaitedMs)
        : timeoutMs;
      const hadServerActivity = this.turnHasServerActivity(this.turn);
      const detail = this.describeOpenTools(this.turn);
      const message = [
        `banana stalled - no output for ${Math.round(elapsedMs / 1000)}s, the turn was aborted`,
        detail,
      ].filter(Boolean).join('\n');
      console.warn(
        `[chat banana] stall watchdog fired after ${elapsedMs}ms of silence cwd=${this.cwd}${detail ? ` (${detail})` : ''}`,
      );
      // Abort the stuck prompt on the server too so its late events can't leak
      // into the next turn, then end this turn locally. The shared serve
      // process is never killed — only this session's prompt.
      this.abortServerTurn();
      if (!hadServerActivity) {
        void this.clearSavedThreadId('banana stalled before server activity');
      }
      this.failTurn(message, 'Banana aborted this tool after the stall watchdog fired.');
    }, timeoutMs);
    this.watchdog.unref();
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  // ── emit helpers ───────────────────────────────────────────

  ingestExternalEvent(se: SeqEvent): void {
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    for (const fn of this.listeners) fn(se);
  }

  private emit(msg: SessionEvent): void {
    msg = redactComputerImages(msg);
    if (isPlumbingEvent(msg)) return;
    this.lastActivityAtMs = Date.now();
    const se: SeqEvent = { seq: this.reserveSeq(), ev: msg };
    const persisted = { ...se, eng: this.cli, ...(this.turnModel ? { mdl: this.turnModel } : {}) };
    const durableUserEcho = msg.type === 'event' && msg.event?.type === '_user_echo';
    if (durableUserEcho && !appendEventLogSync(this.logKey, persisted)) {
      throw new Error('could not durably accept the user message');
    }
    this.eventLog.push(se);
    if (this.eventLog.length > EVENT_BUFFER_SIZE) {
      this.eventLog.splice(0, this.eventLog.length - EVENT_BUFFER_SIZE);
    }
    // Don't persist events emitted after shutdown — late child-close output
    // must not repollute a freshly-cleared log (would resurrect a reset thread).
    if (!durableUserEcho && !this.dead) appendEventLog(this.logKey, persisted);
    for (const fn of this.listeners) fn(se);
  }

  /** Emit a claude `stream_event`-wrapped event (the incremental shape). */
  private emitStream(event: Record<string, unknown>): void {
    this.emit({ type: 'event', event: { type: 'stream_event', event } });
  }
}

/** The plan ruleset passed to session.create — same shape run.ts uses: deny
 *  questions and plan enter/exit so the chat path never blocks on prompts. */
const PLAN_RULESET: PermissionRuleset = [
  { permission: 'question', action: 'deny', pattern: '*' },
  { permission: 'plan_enter', action: 'deny', pattern: '*' },
  { permission: 'plan_exit', action: 'deny', pattern: '*' },
];

/** Best-effort extraction of a human message from a banana error object. */
function errorText(error: unknown): string {
  if (!error) return 'banana reported an error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const data = e.data as Record<string, unknown> | undefined;
    if (data && typeof data.message === 'string') return data.message;
    if (typeof e.message === 'string') return e.message;
    if (typeof e.name === 'string') return String(e.name);
    try { return JSON.stringify(error); } catch { return 'banana reported an error'; }
  }
  return String(error);
}

function isPromptTransportFailure(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR|socket|terminated/i.test(message);
}

function keyOf(cli: CliKind, cwd: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  return normalized === 'main' ? `${cli}|${cwd}` : `${cli}|${cwd}|${normalized}`;
}

/** Manager keyed by cwd + chat id, matching the claude/codex session maps. */
const bananaSessions = new Map<string, BananaSession>();

export function publishBananaExternalEvent(logKey: string, se: SeqEvent): void {
  for (const session of bananaSessions.values()) {
    if (session.logKey === logKey) session.ingestExternalEvent(se);
  }
}

/** See markBusyLanesRestarting in runner.ts. */
export function markBusyBananaLanesRestarting(signal: string): number {
  let marked = 0;
  for (const s of bananaSessions.values()) {
    if (!s.isBusy()) continue;
    try {
      const session = s as unknown as { logKey: string; reserveSeq(): number; cli: string };
      if (appendEventLogSync(session.logKey, {
        seq: session.reserveSeq(),
        ev: restartMarkerEvent(signal) as never,
        eng: session.cli,
      })) marked++;
    } catch (err) {
      console.warn(`[tardis] restart tombstone failed for ${s.key}:`, (err as Error).message);
    }
  }
  return marked;
}

/** True if any live BananaSession other than `except` has an in-flight turn.
 *  The `banana serve` process is shared by EVERY chat, so any teardown of it
 *  (config-change restart, prompt-transport-failure death) aborts every live
 *  turn at once via onServerDeath -> failTurn. Callers that would restart the
 *  serve must first check this and defer, or a hiccup/close in one chat will
 *  silently kill a long-running task in another. Function declaration so it can
 *  be referenced from BananaServer methods defined earlier in the file. */
function anyBananaTurnBusyExcept(except?: BananaSession): boolean {
  for (const session of bananaSessions.values()) {
    if (session === except) continue;
    if (session.isBusy()) return true;
  }
  return false;
}

export function activeBananaSessions(): {
  cli: CliKind;
  cwd: string;
  chatId: string;
  busy: boolean;
  sessionId: string | null;
  lastActivityAt: number;
}[] {
  return Array.from(bananaSessions.values()).map((s) => ({
    cli: s.cli,
    cwd: s.cwd,
    chatId: s.chatId,
    busy: s.isBusy(),
    sessionId: s.sessionId(),
    lastActivityAt: s.lastActivityAt(),
  }));
}

export function pruneIdleBananaSessions(ttlMs: number, now = Date.now()): number {
  let pruned = 0;
  for (const [key, session] of bananaSessions) {
    if (session.isBusy()) continue;
    if (session.listenerCount() > 0) continue;
    if (now - session.lastActivityAt() < ttlMs) continue;
    session.shutdown();
    bananaSessions.delete(key);
    pruned += 1;
  }
  return pruned;
}

export async function getOrCreateBananaSession(opts: {
  repoPath: string;
  chatId?: string;
  cli?: CliKind;
}): Promise<BananaSession> {
  const cwd = opts.repoPath;
  const chatId = opts.chatId || 'main';
  const cli = opts.cli ?? 'banana';
  const key = keyOf(cli, cwd, chatId);
  const existing = bananaSessions.get(key);
  if (existing && existing.isAlive()) {
    await flushEventLog(existing.logKey);
    const priorEngine = lastEngineOf(loadEventLogSync(existing.logKey).events);
    if (!existing.isBusy() && priorEngine && priorEngine !== cli) {
      // Another brain advanced the shared thread. Recreate Banana so its next
      // prompt seeds from that durable context instead of its stale session.
      bananaSessions.delete(key);
      existing.shutdown();
    } else {
      return existing;
    }
  }

  // Banana/opencode session ids are not reliable across `banana serve` or
  // Node process restarts. The session can still be returned by session.get
  // but hang forever on session.prompt with no SSE events. Keep continuity
  // while the in-memory BananaSession is alive, but always start fresh after
  // a process restart / idle prune.
  let recoverContextOnNextTurn = false;
  if (await getSessionId(cli, cwd, chatId)) {
    recoverContextOnNextTurn = true;
    await setSessionId(cli, cwd, '', chatId);
    console.warn(
      `[chat banana] ignoring persisted opencode session after process restart for ${key}; will recover context from event log on next turn`,
    );
  }
  const logKey = logKeyFor(cli, cwd, chatId);
  await flushEventLog(logKey);
  const durableHistory = loadEventLogForCompactionSync(logKey);
  const session = new BananaSession(cwd, chatId, null, {
    recoverContextOnNextTurn,
    cli,
    durableHistory,
  });
  bananaSessions.set(key, session);
  return session;
}

export function shutdownAllBananaSessions(): void {
  for (const s of bananaSessions.values()) s.shutdown();
  bananaSessions.clear();
  // The persistent serve process is shared by every session — tear it down
  // once all sessions are gone.
  bananaServer.shutdown();
  shutdownLocalLlmProxy();
}

/** Kill the in-flight banana turn but keep the session id saved for resume. */
export function interruptBanana(opts: { repoPath: string; chatId?: string; cli?: CliKind }): void {
  const cwd = opts.repoPath;
  const key = keyOf(opts.cli ?? 'banana', cwd, opts.chatId || 'main');
  const s = bananaSessions.get(key);
  if (s) {
    s.shutdown();
    bananaSessions.delete(key);
  }
}

/** Drop the stored session id so the next banana turn starts a fresh session. */
export async function freshStartBanana(opts: {
  repoPath: string;
  chatId?: string;
  cli?: CliKind;
}): Promise<BananaSession> {
  const cwd = opts.repoPath;
  const chatId = opts.chatId || 'main';
  const cli = opts.cli ?? 'banana';
  const key = keyOf(cli, cwd, chatId);
  const existing = bananaSessions.get(key);
  if (existing) {
    existing.shutdown();
    bananaSessions.delete(key);
  }
  await setSessionId(cli, cwd, '', chatId);
  // Wipe the durable log before the new session loads it, so a reset thread
  // can't be resurrected by a full (sinceSeq=0) replay from an empty client.
  const logKey = logKeyFor(cli, cwd, chatId);
  // Delete external compact memory before the visible transcript, so a remote
  // failure leaves the old thread coherent and Fresh can be retried safely.
  await clearThreadMemory(logKey, chatId);
  await clearEventLog(logKey);
  const session = new BananaSession(cwd, chatId, null, { cli, durableHistory: [] });
  bananaSessions.set(key, session);
  return session;
}
