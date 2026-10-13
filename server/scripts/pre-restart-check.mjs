#!/usr/bin/env node
/**
 * Pre-restart check (Matt's standing rule, Oct 13 2026): prove the exact
 * commit we are about to restart onto actually works BEFORE restarting the
 * live service.
 *
 * What it does, in order:
 *   1. Resolves the target commit (default: origin/main after a fetch).
 *   2. Checks that commit out into a throwaway worktree and builds it.
 *   3. Boots it as an isolated side copy on a spare port against a COPY of
 *      the TARDIS state dir — never the live files, never the live port.
 *      The side copy runs lanes-and-engines only (RIVENDELL_SIDE_COPY=1):
 *      no routine prompts, job watches, Desk nudges, phone alerts, computer
 *      control, cron pausing, durable team delivery or agent prewarm, so it
 *      can never message anyone or touch another system.
 *   4. Waits for /api/health and requires busyTurns 0.
 *   5. With --message: opens the chat websocket, sends one real message
 *      through a throwaway test lane, and passes only if the message renders
 *      in the event stream with FRESH seqs (the Oct 7 duplicate-drop bug
 *      class) and a real reply comes back.
 *   6. Prints PASS or FAIL with the target commit and the live HEAD (the
 *      rollback point), then tears the whole side copy down.
 *
 * Usage:
 *   node scripts/pre-restart-check.mjs [commit-ish] [--port 8199] [--message] [--keep]
 *
 * Run it from the LIVE repository checkout (it uses this repo's git and
 * node_modules; the target commit's tree is built in the throwaway worktree).
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const LIVE_STATE = process.env.RIVENDELL_STATE_DIR || path.join(homedir(), '.rivendell');

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const MESSAGE = args.includes('--message');
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 8199;
const TARGET = args.find((a) => !a.startsWith('--') && a !== String(PORT)) || 'origin/main';

if (PORT === 8091) fail('Refusing to run on the live port 8091.');
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) fail(`Bad --port ${PORT}.`);

const T0 = Date.now();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tardis-prerestart-'));
const srcDir = path.join(tmp, 'src');
const stateDir = path.join(tmp, 'state');
const bootLog = path.join(tmp, 'boot.log');
let child = null;
let pass = false;
let targetSha = '';
let liveHead = '';

const big = ['event-logs', 'uploads', 'headless', 'attachments', 'backups', 'sessions',
  'artifacts', 'jobs', 'scratch', 'scratch-shots', 'autosam-qa-local', 'sift', 'dev-plan',
  'voice-previews', 'thread-compacts-archive'];

try {
  // 1. Resolve commits.
  run('git', ['fetch', 'origin', 'main'], REPO);
  targetSha = execFileSync('git', ['rev-parse', `${TARGET}^{commit}`], { cwd: REPO, encoding: 'utf8' }).trim();
  liveHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  step(`target ${targetSha.slice(0, 10)} (live HEAD ${liveHead.slice(0, 10)} is the rollback point)`);

  // 2. Throwaway worktree + build of the exact commit.
  run('git', ['worktree', 'add', '--detach', srcDir, targetSha], REPO);
  const liveLock = fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8');
  const tgtLock = fs.readFileSync(path.join(srcDir, 'package-lock.json'), 'utf8');
  if (liveLock !== tgtLock) fail('Lockfile differs from the live tree; run the build with a real install first.');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(srcDir, 'node_modules'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(srcDir, 'server', 'node_modules'));
  step('building the server...');
  run('npm', ['run', 'build', '--workspace', 'server'], srcDir, path.join(tmp, 'build.log'));
  step('build green');

  // 3. Copy state (selective: the copy must be fast; everything the check
  //    exercises — desk, roster, personas, compaction state, lane config —
  //    is small; the excluded bulk is logs and media no gated-off subsystem
  //    ever reads).
  fs.cpSync(LIVE_STATE, stateDir, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(LIVE_STATE, s);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (big.includes(top)) return false;
      try { return fs.statSync(s).size <= 8 * 1024 * 1024; } catch { return true; }
    },
  });
  step(`state copied to ${stateDir} (${mb(stateDir)} MB)`);

  // 4. Boot the side copy: lanes and engines only.
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    RIVENDELL_STATE_DIR: stateDir,
    RIVENDELL_SIDE_COPY: '1',
  };
  delete env.RIVENDELL_PREWARM_AGENTS;
  child = spawn('node', ['dist/index.js'], { cwd: path.join(srcDir, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(bootLog);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code) => { if (!pass) fail(`side copy exited early (code ${code}) — see ${bootLog}`); });

  const health = await waitHealthy(PORT, 150_000);
  if (health.busyTurns !== 0) fail(`busyTurns ${health.busyTurns} on a fresh side copy — lanes are running; see ${bootLog}`);
  const sideCopyLine = fs.readFileSync(bootLog, 'utf8').includes('[side-copy]');
  if (!sideCopyLine) fail('side-copy gate did not engage (no [side-copy] boot line) — see ' + bootLog);
  step(`healthy on :${PORT} (busyTurns 0, side-copy gate engaged)`);

  // 5. One real message through a throwaway test lane.
  if (MESSAGE) {
    const reply = await messageRoundTrip(PORT);
    step(`test lane round trip ok (reply: ${reply.text.slice(0, 60)}, seq ${reply.echoSeq} -> ${reply.replySeq})`);
  }

  pass = true;
} catch (err) {
  fail(String(err.message || err));
} finally {
  // 6. Report + teardown (always, pass or fail).
  const elapsed = Math.round((Date.now() - T0) / 1000);
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 8000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
  }
  try { run('git', ['worktree', 'remove', '--force', srcDir], REPO, undefined, true); } catch {}
  if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  console.log(pass
    ? `\nPASS — ${targetSha.slice(0, 10)} boots clean${MESSAGE ? ' and answers a test lane' : ''} in ${elapsed}s.`
      + `\nRollback point if the live restart fails: ${liveHead.slice(0, 10)}.`
      + (KEEP ? `\nKept for inspection: ${tmp}` : '')
    : `\nFAIL — see the output above (logs kept in ${tmp}).`);
  process.exit(pass ? 0 : 1);
}

function step(msg) { console.log(`[check] ${msg}`); }
function fail(msg) { console.error(`[check] FAIL: ${msg}`); throw new Error(msg); }
function mb(dir) {
  let n = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isFile() ? fs.statSync(path.join(dir, e.name)).size : 0; } catch {}
  return Math.round(n / 1024 / 1024);
}
function run(cmd, cmdArgs, cwd, toFile, quiet) {
  try {
    if (toFile) execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: ['ignore', fs.openSync(toFile, 'w'), fs.openSync(toFile, 'a')] });
    else execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: quiet ? 'ignore' : 'pipe' });
  } catch (err) {
    fail(`${cmd} ${cmdArgs.join(' ')} failed: ${String(err.message).split('\n')[0]}`);
  }
}

async function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) fail(`health never came up within ${Math.round(timeoutMs / 1000)}s — see ${bootLog}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(1000);
  }
}

/** One real message through a throwaway probe lane: it must render with a
 *  FRESH seq (the Oct 7 duplicate-drop class) and get a real reply. */
async function messageRoundTrip(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const frames = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    frames.push(msg);
    for (const w of [...waiters]) w(msg);
  };
  const next = (pred, timeoutMs, what) => new Promise((resolve, reject) => {
    const found = frames.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
    waiters.push((msg) => { if (pred(msg)) { clearTimeout(timer); resolve(msg); } });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket never opened')), 20_000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
  });

  const CHAT = 'restart-check';
  const REPO_HUB = '/home/mrchevyceleb/ASSISTANT-HUB';
  const clientMsgId = `restart-check-${Date.now().toString(36)}`;
  ws.send(JSON.stringify({ type: 'hello', cli: 'claude', repo: REPO_HUB, chatId: CHAT, sinceSeq: -1, visible: false }));
  // The hello barrier settles before the send is admitted; a short settle
  // wait avoids the handshake-pending bounce on a cold lane.
  await sleep(2500);
  ws.send(JSON.stringify({ type: 'send', chatId: CHAT, text: 'This is the pre-restart check. Reply with exactly the word CHECKED and nothing else.', clientMsgId }));

  const echo = await next((m) => (m.type === 'event' && m.event?.type === '_user_echo' && m.event?.clientMsgId === clientMsgId)
    || (m.type === '_user_echo' && m.clientMsgId === clientMsgId), 60_000, 'the message rendering in the event stream');
  const echoSeq = echo.seq ?? echo.event?.seq ?? 0;
  if (!echoSeq) fail('the echo carried no seq — cannot prove fresh seqs');

  const reply = await next((m) => m.type === 'result', 180_000, 'a completed turn (result)');
  if (reply.is_error) fail('the test-lane turn failed: ' + JSON.stringify(reply).slice(0, 200));
  const text = collectAssistantText(frames);
  if (!/CHECKED/i.test(text)) fail(`the reply did not contain CHECKED (got: ${JSON.stringify(text.slice(0, 120))})`);
  const replySeq = Math.max(...frames.filter((m) => typeof m.seq === 'number').map((m) => m.seq));
  if (replySeq <= echoSeq) fail(`no fresh seqs after the echo (echo ${echoSeq}, max ${replySeq}) — the Oct 7 duplicate-drop class`);
  try { ws.close(); } catch {}
  return { text, echoSeq, replySeq };
}

function collectAssistantText(frames) {
  let out = '';
  for (const m of frames) {
    const inner = m.event ?? m;
    if (m.type === 'stream_event' && inner?.event?.type === 'content_block_delta' && inner.event.delta?.type === 'text_delta') {
      out += inner.event.delta.text ?? '';
    }
    if (m.type === 'result' && typeof m.result === 'string') out += m.result;
  }
  return out.trim();
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
