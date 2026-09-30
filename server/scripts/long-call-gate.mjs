#!/usr/bin/env node
/**
 * Long foreground call gate (a Claude Code / Codex PreToolUse + PostToolUse hook).
 *
 * A teammate sitting inside one long foreground shell call cannot be reached:
 * a person's message waits until the call returns. Long work belongs in
 * job_start (a background job the agent is woken from). This hook:
 *
 *   pre   blocks OBVIOUSLY long foreground shell commands up front (sleeps and
 *         polling loops, builds, renders, big installs, deploy and CI watchers,
 *         review CLIs) with an error that says exactly how to start it with
 *         job_start. Everything else is allowed and timed.
 *   post  after any shell call that ran 60s or longer, adds a one-line nudge
 *         to the tool result. Never kills or interrupts a running call.
 *
 * Both paths append one JSON line per offender to <state>/long-calls.jsonl so
 * the block list can grow from real data.
 *
 * usage: node long-call-gate.mjs <pre|post> <agent name>   (hook JSON on stdin)
 * Escape hatch for a false positive: end the command with `# foreground-ok`.
 * Emergency off: RIVENDELL_LONG_CALL_GATE=off in the server environment.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2] === 'post' ? 'post' : 'pre';
const who = process.argv[3] || 'unknown';
const STATE = process.env.RIVENDELL_STATE_DIR || join(homedir(), '.rivendell');
const NUDGE_S = Number(process.env.RIVENDELL_LONG_CALL_NUDGE_S) || 60;
const SLEEP_LIMIT_S = 30;
const START_DIR = join(tmpdir(), 'tardis-longcall');
const LOG_FILE = join(STATE, 'long-calls.jsonl');
const LOG_MAX_BYTES = 5 * 1024 * 1024;

if (process.env.RIVENDELL_LONG_CALL_GATE === 'off') process.exit(0);

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const tool = String(input.tool_name ?? '');
if (!/^(bash|shell|local_shell|exec_command|exec)$/i.test(tool)) process.exit(0);
const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
const rawCommand = Array.isArray(toolInput.command) ? toolInput.command.join(' ') : String(toolInput.command ?? toolInput.cmd ?? '');
const callId = String(input.tool_use_id ?? input.call_id ?? '').replace(/[^\w.-]/g, '').slice(0, 80);

function log(entry) {
  try {
    mkdirSync(STATE, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) return;
    appendFileSync(LOG_FILE, `${JSON.stringify({ ts: new Date().toISOString(), agent: who, ...entry, command: rawCommand.slice(0, 240) })}\n`);
  } catch { /* logging never blocks a call */ }
}

function fmt(seconds) {
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Quoted strings and heredoc bodies are data, not commands. */
function strip(command) {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, ' ')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const RULES = [
  { label: 'a polling loop (until/while ... sleep)', re: /\b(?:until|while)\b[^\n]*(?:;|\n)[\s\S]*?\bdo\b[\s\S]*?\bsleep\b/ },
  { label: 'a CI or deploy watcher', re: /\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b[^\n;&|]*--watch\b|\brailway\s+up\b(?![^\n;&|]*--detach)/ },
  { label: 'a build', re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build(?::[\w:-]+)?|ci)\b|\b(?:npx\s+)?tauri\s+build\b|\bcargo\s+(?:build|install)\b|\bdocker\s+(?:compose\s+)?build\b|\bxcodebuild\b|\bswift\s+build\b|\bgradlew?\s+(?:assemble|build)\b/ },
  { label: 'a full install', re: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\s*(?:$|[;&|)]|--)/ },
  { label: 'a render', re: /\bhyperframes\s+render\b|\bremotion\s+render\b|\bblender\s+(?:-b|--background)\b/ },
  { label: 'a full test run', re: /\bplaywright\s+test\b|\bnpm\s+run\s+test:(?:all|full|e2e|ci)\b/ },
  { label: 'a review CLI (run it as a job and read its output file when the result arrives)', re: /\bcodex\s+(?:exec|review)\b|\bclaude\s+(?:[^\n;&|]*\s)?-p\b/ },
];

function classify(command) {
  const s = strip(command);
  // A trailing `&` (not `&&`) backgrounds the last statement: it returns at once.
  if (/(?:^|[^&])&\s*(?:disown\s*)?$/.test(s.trim())) return null;
  for (const m of s.matchAll(/(?:^|[;&|(){}\s])sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?![\w.])/g)) {
    const seconds = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's']);
    if (seconds >= SLEEP_LIMIT_S) return `a ${m[1]}${m[2] || 's'} sleep`;
  }
  for (const rule of RULES) if (rule.re.test(s)) return rule.label;
  return null;
}

if (mode === 'pre') {
  if (toolInput.run_in_background === true) process.exit(0);
  const bypass = /#\s*foreground-ok\s*$/.test(rawCommand.trim());
  const hit = bypass ? null : classify(rawCommand);
  if (bypass) log({ kind: 'bypass', rule: classify(rawCommand.replace(/#\s*foreground-ok\s*$/, '')) ?? 'not-matched' });
  if (hit) {
    log({ kind: 'block', rule: hit });
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Blocked: this looks like a long-running command (${hit}). Do not run it as a foreground call: while you sit in it, nobody can reach you. ` +
          'Start it with the job_start tool instead (a short name plus the same command, cwd if needed), then keep working or end your turn. ' +
          'A job result arrives in your thread when it ends. If it really is a quick one-off, run it again with "# foreground-ok" at the end of the command.',
      },
    })}\n`);
    process.exit(0);
  }
  // Time it for the 60s nudge. Sweep start files that never got a result.
  if (callId) {
    try {
      mkdirSync(START_DIR, { recursive: true });
      const now = Date.now();
      for (const f of readdirSync(START_DIR)) {
        try { if (now - statSync(join(START_DIR, f)).mtimeMs > 6 * 3600_000) rmSync(join(START_DIR, f), { force: true }); } catch { /* raced */ }
      }
      writeFileSync(join(START_DIR, callId), String(now));
    } catch { /* timing is best effort */ }
  }
  process.exit(0);
}

// post
if (callId) {
  const file = join(START_DIR, callId);
  try {
    const started = Number(readFileSync(file, 'utf8'));
    rmSync(file, { force: true });
    const seconds = (Date.now() - started) / 1000;
    if (Number.isFinite(seconds) && seconds >= NUDGE_S) {
      log({ kind: 'slow', seconds: Math.round(seconds) });
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `That command held you for ${fmt(seconds)}. While you are inside one foreground call nobody can reach you. ` +
            'Anything that takes more than about 30 seconds should be started with job_start so you stay free to answer people.',
        },
      })}\n`);
    }
  } catch { /* no start record: nothing to nudge */ }
}
process.exit(0);
