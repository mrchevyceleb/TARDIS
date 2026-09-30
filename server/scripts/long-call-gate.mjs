#!/usr/bin/env node
/**
 * Long foreground call gate (a PreToolUse + PostToolUse hook for Claude Code,
 * Codex and Pi; the Pi extension server/pi/long-call-gate.ts calls this script).
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
 * usage: node long-call-gate.mjs <pre|post> [agent name] [--exit2] [--engine=<name>]
 *        (hook JSON on stdin)
 *
 * Scope: TARDIS agents only. The hook does nothing unless the agent identity is
 * known: the explicit [agent name] argument (Claude: TARDIS passes it in the
 * per-spawn --settings) or RIVENDELL_LONG_CALL_GATE_AGENT in the environment
 * (Codex and Pi: TARDIS sets it on the spawn env of agent threads, so a global
 * hook config stays inert for every other Codex or Pi run on the machine).
 *
 * Fail open: any error, bad input or timeout allows the call. The only ways this
 * script ever stops a call are its own deliberate deny paths below.
 *
 * --exit2   block with exit code 2 and the reason on stderr (Codex). Its hook
 *           shell is a login shell, so profile noise on stdout could corrupt
 *           deny JSON; stderr + exit 2 cannot be misread as "allow".
 * Escape hatch for a false positive: add a `# foreground-ok` comment to the command.
 * Emergency off: RIVENDELL_LONG_CALL_GATE=off in the server environment.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const allow = () => process.exit(0);
// Fail open no matter what goes wrong below.
process.on('uncaughtException', allow);
process.on('unhandledRejection', allow);
setTimeout(allow, 5000);

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = argv.filter((a) => a.startsWith('--'));
const mode = positional[0] === 'post' ? 'post' : 'pre';
const who = process.env.RIVENDELL_LONG_CALL_GATE_AGENT || positional[1] || '';
const engine = flags.find((f) => f.startsWith('--engine='))?.slice('--engine='.length) || 'claude';
const exit2 = flags.includes('--exit2');
const STATE = process.env.RIVENDELL_STATE_DIR || join(homedir(), '.rivendell');
const NUDGE_S = Number(process.env.RIVENDELL_LONG_CALL_NUDGE_S) || 60;
const SLEEP_LIMIT_S = 30;
const START_DIR = join(tmpdir(), 'tardis-longcall');
const LOG_FILE = join(STATE, 'long-calls.jsonl');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_COMMAND_CHARS = 20_000;

let rawCommand = '';

function log(entry) {
  try {
    mkdirSync(STATE, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) return;
    appendFileSync(LOG_FILE, `${JSON.stringify({ ts: new Date().toISOString(), agent: who, engine, ...entry, command: rawCommand.slice(0, 240) })}\n`);
  } catch { /* logging never blocks a call */ }
}

/** Synchronous write to the hook's stdout: process.exit right after an async
 *  pipe write can truncate the JSON and make a deny silently not apply. */
function emit(payload) {
  const text = `${JSON.stringify(payload)}\n`;
  try { writeFileSync(1, text); } catch { process.stdout.write(text); }
}

function deny(reason) {
  if (exit2) {
    try { writeFileSync(2, `${reason}\n`); } catch { process.stderr.write(`${reason}\n`); }
    process.exit(2);
  }
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  process.exit(0);
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

function classify(command, depth = 0) {
  // A trailing `&` (not `&&`) backgrounds the last statement: it returns at once.
  if (depth === 0 && /(?:^|[^&])&\s*(?:disown\s*)?$/.test(strip(command).trim())) return null;
  // A shell wrapper hides its payload inside quotes: bash -lc '...', sh -c "...", eval '...'.
  if (depth < 2) {
    for (const m of command.matchAll(/\b(?:ba|z|k|da)?sh\s+(?:-[a-zA-Z]*c[a-zA-Z]*)\s+(['"])([\s\S]*?)\1|\beval\s+(['"])([\s\S]*?)\3/g)) {
      const inner = classify(m[2] ?? m[4] ?? '', depth + 1);
      if (inner) return inner;
    }
  }
  // Quoted strings and heredoc bodies are data; a comment is not a command.
  const s = strip(command).replace(/(^|\s)#[^\n]*/g, '$1');
  for (const m of s.matchAll(/(?:^|[;&|(){}\s])sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?![\w.])/g)) {
    const seconds = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's']);
    if (seconds >= SLEEP_LIMIT_S) return `a ${m[1]}${m[2] || 's'} sleep`;
  }
  for (const rule of RULES) if (rule.re.test(s)) return rule.label;
  return null;
}

/** The shell command of a hook payload. Codex may hand argv as an array
 *  (["bash", "-lc", "<script>"]): use the script itself so quoting survives. */
function commandOf(toolInput) {
  const c = toolInput.command ?? toolInput.cmd ?? '';
  if (Array.isArray(c)) {
    const parts = c.map(String);
    if (parts.length >= 3 && /^(?:ba|z|k|da)?sh$/.test(basename(parts[0])) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(parts[1])) return parts[2];
    return parts.map((p) => (/^[\w./:=@%+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(' ');
  }
  return String(c);
}

function readStdin(limit = 1_000_000) {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { if (data.length < limit) data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  if (!who) return; // not a TARDIS agent: stay out of the way
  if (process.env.RIVENDELL_LONG_CALL_GATE === 'off') return;

  let input;
  try { input = JSON.parse((await readStdin()) || '{}'); } catch { return; }
  if (!input || typeof input !== 'object') return;
  const tool = String(input.tool_name ?? '');
  if (!/^(bash|shell|local_shell|exec_command|exec)$/i.test(tool)) return;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  rawCommand = commandOf(toolInput).slice(0, MAX_COMMAND_CHARS);
  const callId = String(input.tool_use_id ?? input.call_id ?? '').replace(/[^\w.-]/g, '').slice(0, 80);

  if (mode === 'pre') {
    if (toolInput.run_in_background === true) return;
    const bypass = /(?:^|\s)#\s*foreground-ok\b/.test(rawCommand);
    const hit = bypass ? null : classify(rawCommand);
    if (bypass) log({ kind: 'bypass', rule: classify(rawCommand.replace(/#\s*foreground-ok\b/g, '')) ?? 'not-matched' });
    if (hit) {
      log({ kind: 'block', rule: hit });
      deny(
        `Blocked: this looks like a long-running command (${hit}). Do not run it as a foreground call: while you sit in it, nobody can reach you. ` +
        'Start it with the job_start tool instead (a short name plus the same command, cwd if needed), then keep working or end your turn. ' +
        'A job result arrives in your thread when it ends. If it really is a quick one-off, run it again with "# foreground-ok" at the end of the command.',
      );
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
    return;
  }

  // post
  if (!callId) return;
  const file = join(START_DIR, callId);
  try {
    const started = Number(readFileSync(file, 'utf8'));
    rmSync(file, { force: true });
    const seconds = (Date.now() - started) / 1000;
    if (Number.isFinite(seconds) && seconds >= NUDGE_S) {
      log({ kind: 'slow', seconds: Math.round(seconds) });
      emit({
        hookSpecificOutput: {
          hookEventName: input.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse',
          additionalContext:
            `That command held you for ${fmt(seconds)}. While you are inside one foreground call nobody can reach you. ` +
            'Anything that takes more than about 30 seconds should be started with job_start so you stay free to answer people.',
        },
      });
    }
  } catch { /* no start record: nothing to nudge */ }
}

try {
  await main();
} catch {
  /* fail open */
}
process.exit(0);
