#!/usr/bin/env node
/**
 * Pre-restart check (Matt's standing rule, Oct 13 2026): prove the exact
 * commit we are about to restart onto actually works BEFORE restarting the
 * live service.
 *
 * What it does, in order:
 *   1. Resolves the target commit (default: origin/main after a fetch).
 *   2. Checks that commit out into a throwaway worktree and typechecks it.
 *   3. Boots it as an isolated side copy on a spare port against a COPY of
 *      the TARDIS state dir — never the live files, never the live port.
 *      The side copy runs lanes-and-engines only (RIVENDELL_SIDE_COPY=1):
 *      no routine prompts, job watches, Desk nudges, phone alerts, computer
 *      control, model-catalog pollers, optional MCP proxies, xAI OAuth
 *      priming, cron pausing, durable team delivery or agent prewarm, so a
 *      check boot can never message anyone or touch another system.
 *   4. Waits for /api/health and requires busyTurns 0.
 *   5. With --message: opens the chat websocket against a SYNTHETIC probe
 *      workspace (never a live repo) whose durable log is seeded with a high
 *      sequence watermark, sends one real message, and passes only if it
 *      renders with a FRESH seq ABOVE the watermark (the Oct 7 duplicate-drop
 *      class) and a real reply comes back.
 *   6. Replay leg (with --message): reconnects the websocket and requires
 *      the probe turn to replay exactly once with the SAME seqs (no
 *      duplicate, no re-allocation) — the reload/catch-up path.
 *   7. Team leg (with --message): seeds two probe agents in the COPIED
 *      roster and requires one team_message between their probe lanes to
 *      arrive and get the exact reply back — inside the side copy, never
 *      outside it (agent engines spawn in the probe sandbox via
 *      ELROND_WORKSPACE_PATH).
 *   8. Prints PASS or FAIL with the target commit and the live HEAD (the
 *      rollback point), then tears the side copy down — including on SIGINT
 *      and SIGTERM.
 *
 * Usage:
 *   node scripts/pre-restart-check.mjs [commit-ish] [--port 8199] [--message] [--keep]
 *
 * Run it from the LIVE repository checkout (it uses this repo's git and
 * node_modules; the target commit's tree is checked out in a throwaway
 * worktree).
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

// Declared before the port validation below: fail() writes it, and a
// top-level let below the validation would throw a TDZ ReferenceError
// instead of the intended diagnostic.
let failedMsg = null;

if (PORT === 8091) fail('Refusing to run on the live port 8091.');
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) fail(`Bad --port ${PORT}.`);

const T0 = Date.now();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tardis-prerestart-'));
const srcDir = path.join(tmp, 'src');
const stateDir = path.join(tmp, 'state');
const probeWs = path.join(tmp, 'probe-ws');
const bootLog = path.join(tmp, 'boot.log');
let child = null;
let teardownPromise = null; // one shared teardown: every caller awaits the same run
let pass = false;
let interrupted = false; // set SYNCHRONOUSLY on a signal, before any await
let targetSha = '';
let liveHead = '';

// Signals tear the side copy down too: `finally` alone never runs on a
// default SIGINT/SIGTERM death, and a leaked child/worktree is exactly the
// kind of mess this check exists to prevent.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // Synchronous flag: the finally block's exit (registered first on the
    // shared teardown promise) must not be able to report PASS after a
    // signal cancelled the run.
    interrupted = true;
    console.error(`[check] ${sig} received — tearing down`);
    void teardown().finally(() => {
      // The main finally may never run (it can still be awaiting health or a
      // reply), so the retained-log path is printed HERE or it could be
      // undiscoverable.
      console.error(`\nFAIL — interrupted by ${sig}; logs kept in ${tmp}`);
      process.exit(1);
    });
  });
}

const big = ['event-logs', 'uploads', 'headless', 'attachments', 'backups', 'sessions',
  'artifacts', 'jobs', 'scratch', 'scratch-shots', 'autosam-qa-local', 'sift', 'dev-plan',
  'voice-previews', 'thread-compacts-archive'];

try {
  // 1. Resolve commits.
  run('git', ['fetch', 'origin', 'main'], REPO);
  targetSha = execFileSync('git', ['rev-parse', `${TARGET}^{commit}`], { cwd: REPO, encoding: 'utf8' }).trim();
  liveHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  step(`target ${targetSha.slice(0, 10)} (live HEAD ${liveHead.slice(0, 10)} is the rollback point)`);

  // 2. Throwaway worktree + typecheck of the exact commit. The live boot runs
  //    the TS directly through tsx (scripts/start.sh -> npm start), and the
  //    side copy boots the exact same way below.
  run('git', ['worktree', 'add', '--detach', srcDir, targetSha], REPO);
  const liveLock = fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8');
  const tgtLock = fs.readFileSync(path.join(srcDir, 'package-lock.json'), 'utf8');
  if (liveLock !== tgtLock) fail('Lockfile differs from the live tree; run the build with a real install first.');
  // Standing rule (Max, Oct 14 11:14): a side copy NEVER symlinks the live
  // checkout's node_modules (an npm ci through such a symlink emptied the
  // live tree once), and never hardlinks either (an in-place write in the
  // copy would still change the live files). A real copy: 249MB on NVMe,
  // a few seconds, fully isolated.
  run('cp', ['-a', path.join(REPO, 'node_modules'), path.join(srcDir, 'node_modules')]);
  // The live server workspace keeps its own node_modules for non-hoisted
  // versions; copy it when present so the side copy resolves exactly what
  // production resolves (the root tree alone can resolve differently).
  if (fs.existsSync(path.join(REPO, 'server', 'node_modules'))) {
    run('cp', ['-a', path.join(REPO, 'server', 'node_modules'), path.join(srcDir, 'server', 'node_modules')]);
  } else {
    run('cp', ['-a', path.join(REPO, 'node_modules'), path.join(srcDir, 'server', 'node_modules')]);
  }
  step('typechecking the server...');
  run('npm', ['run', 'build', '--workspace', 'server'], srcDir, path.join(tmp, 'build.log'));
  step('typecheck green');

  // 3. Copy state (selective: the copy must be fast; everything the check
  //    exercises — desk, roster, personas, compaction state, lane config —
  //    is small; the excluded bulk is logs and media no gated-off subsystem
  //    ever reads). The probe lane's own log is seeded below.
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

  // 4. A synthetic probe workspace: the probe engine's cwd is never a live
  //    repo, so no unproven code or unexpected agent behavior can touch real
  //    workspace files or follow real workspace instructions.
  fs.mkdirSync(probeWs, { recursive: true });
  fs.writeFileSync(path.join(probeWs, 'AGENTS.md'),
    'Sandbox workspace for the TARDIS pre-restart check. Answer the user directly and briefly. Do not use tools. Do not touch anything outside this directory.\n');

  // 4b. Two probe agents in the COPIED roster: the team round trip runs
  //     between two probe lanes whose engines live in the probe sandbox
  //     (ELROND_WORKSPACE_PATH in the boot env below), never a live
  //     workspace, and the copy is torn down with everything else. Filtered
  //     by id so a reused state can never double-seed them.
  const personasDir = path.join(stateDir, 'personas');
  const agentsFile = path.join(personasDir, 'agents.json');
  let roster = { agents: [] };
  try { roster = JSON.parse(fs.readFileSync(agentsFile, 'utf8')); } catch { /* fresh copy */ }
  if (!Array.isArray(roster.agents)) roster.agents = [];
  roster.agents = roster.agents.filter((a) => a?.id !== 'restart-check-a' && a?.id !== 'restart-check-b');
  // Random per-run suffix in the NAME: /api/team/message routes by display
  // name, so a copied-roster agent that happens to share a probe's name
  // could win resolution and run a real (non-probe, possibly non-Claude)
  // agent instead. A per-run suffix makes that collision impossible; the id
  // filter above keeps a re-used state dir from double-seeding.
  const probeSuffix = Math.random().toString(16).slice(2, 6);
  const PROBE_A = `Pre-Restart Probe A ${probeSuffix}`;
  const PROBE_B = `Pre-Restart Probe B ${probeSuffix}`;
  for (const [id, name] of [['restart-check-a', PROBE_A], ['restart-check-b', PROBE_B]]) {
    roster.agents.push({ id, name, role: 'pre-restart check probe (side copy only)', engine: 'claude', home: `bot-${id}`, createdAt: Date.now() });
  }
  fs.mkdirSync(personasDir, { recursive: true });
  fs.writeFileSync(agentsFile, JSON.stringify(roster, null, 2) + '\n');

  // 5. Seed the probe lane's durable log with a high sequence watermark, so
  //    the message test exercises allocation ABOVE an existing high-water
  //    mark — the Oct 7 duplicate-drop class — instead of an empty log.
  const CHAT = 'restart-check';
  const WATERMARK = 5000;
  const laneKey = `claude|${probeWs}|${CHAT}`;
  const logFile = path.join(stateDir, 'event-logs', `${laneKey.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`);
  const seededLines = [];
  for (let seq = WATERMARK - 4; seq <= WATERMARK; seq++) {
    seededLines.push(JSON.stringify({
      seq,
      at: Date.now() - 60_000,
      ev: { type: 'event', event: { type: '_user_echo', text: `seed-${seq}`, clientMsgId: `seed-${seq}` } },
    }));
  }
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `${seededLines.join('\n')}\n`);

  // 6. Boot the side copy: lanes and engines only.
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    RIVENDELL_STATE_DIR: stateDir,
    RIVENDELL_SIDE_COPY: '1',
    // Agent engines (the team leg's recipient) spawn in the probe sandbox,
    // never in a live workspace: a check boot must not follow real
    // workspace instructions no matter which lane a delivery targets.
    ELROND_WORKSPACE_PATH: probeWs,
  };
  delete env.RIVENDELL_PREWARM_AGENTS;
  child = spawn('node', ['--import', 'tsx', 'src/index.ts'], { cwd: path.join(srcDir, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(bootLog);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let earlyExit = null;
  child.on('exit', (code) => { earlyExit = code; });

  const health = await waitHealthy(PORT, 150_000, () => earlyExit);
  if (health.busyTurns !== 0) fail(`busyTurns ${health.busyTurns} on a fresh side copy — lanes are running; see ${bootLog}`);
  const sideCopyLine = fs.readFileSync(bootLog, 'utf8').includes('[side-copy]');
  if (!sideCopyLine) fail('side-copy gate did not engage (no [side-copy] boot line) — see ' + bootLog);
  step(`healthy on :${PORT} (busyTurns 0, side-copy gate engaged)`);

  // 7. One real message through the seeded probe lane.
  if (MESSAGE) {
    const reply = await messageRoundTrip(PORT, probeWs, CHAT, WATERMARK);
    step(`probe lane round trip ok (reply: ${reply.text.slice(0, 60)}, watermark ${WATERMARK} -> echo ${reply.echoSeq} -> result ${reply.resultSeq})`);

    // 7b. Replay: a reconnect must replay the probe turn exactly once, with
    //     the SAME seqs — a reload path that drops, doubles or re-allocates
    //     events would break the client on a real reload.
    await replayCheck(PORT, probeWs, CHAT, WATERMARK, reply.clientMsgId, reply.echoSeq, reply.resultSeq);
    step(`replay ok: the reconnect replays the probe message once with the same seqs (echo ${reply.echoSeq}, result ${reply.resultSeq}), no duplicates`);

    // 7c. One team_message between the two probe lanes, entirely inside the
    //     side copy: no real agent, no outside system, exact reply required.
    const team = await teamRoundTrip(PORT, PROBE_A, PROBE_B);
    step(`team round trip ok (reply: ${JSON.stringify(String(team.reply).slice(0, 40))})`);
  }

  pass = true;
} catch (err) {
  if (!failedMsg) fail(String(err.message || err));
} finally {
  await teardown();
  const elapsed = Math.round((Date.now() - T0) / 1000);
  const ok = pass && !interrupted;
  console.log(ok
    ? `\nPASS — ${targetSha.slice(0, 10)} boots clean${MESSAGE ? ' and answers the probe lane above a 5000-seq watermark, replays it once with the same seqs, and completes a probe-to-probe team round trip' : ''} in ${elapsed}s.`
      + `\nRollback point if the live restart fails: ${liveHead.slice(0, 10)}.`
      + (KEEP ? `\nKept for inspection: ${tmp}` : '')
    : interrupted
      ? `\nFAIL — interrupted by signal before completion (logs kept in ${tmp}).`
      : `\nFAIL — see the output above (logs kept in ${tmp}).`);
  // Cleanup only after the verdict is decided and printed: interrupted or
  // failed runs keep their logs exactly as the report above promises.
  if (ok && !KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  process.exit(ok ? 0 : 1);
}

function teardown() {
  // Memoized: a signal arriving while the finally-block teardown is already
  // running must await THAT teardown, not return immediately and exit before
  // the child is killed and the worktree removed.
  if (!teardownPromise) teardownPromise = doTeardown();
  return teardownPromise;
}

async function doTeardown() {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 8000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
  }
  try { execFileSync('git', ['worktree', 'remove', '--force', srcDir], { cwd: REPO, stdio: 'ignore' }); } catch {}
  // The tmp dir is NOT removed here: the finally block decides after the
  // final verdict (an interrupted run must keep its logs, and the report
  // must be able to say where they are).
}

function step(msg) { console.log(`[check] ${msg}`); }
function fail(msg) {
  if (failedMsg) throw new Error(failedMsg); // already reported; just unwind
  failedMsg = msg;
  console.error(`[check] FAIL: ${msg}`);
  throw new Error(msg);
}
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

async function waitHealthy(port, timeoutMs, earlyExit) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = earlyExit();
    if (code !== null) fail(`side copy exited early (code ${code}) — see ${bootLog}`);
    if (Date.now() > deadline) fail(`health never came up within ${Math.round(timeoutMs / 1000)}s — see ${bootLog}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(1000);
  }
}

/** One real message through the seeded probe lane: it must render with a
 *  FRESH seq ABOVE the watermark (the Oct 7 duplicate-drop class) and get a
 *  real reply. Frames arrive as {type:'stream', event:{...}, seq, at}. */
async function messageRoundTrip(port, repo, chatId, watermark) {
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

  const clientMsgId = `restart-check-${Date.now().toString(36)}`;
  ws.send(JSON.stringify({ type: 'hello', cli: 'claude', repo, chatId, sinceSeq: watermark, visible: false }));
  // The hello barrier settles before the send is admitted; a short settle
  // wait avoids the handshake-pending bounce on a cold lane.
  await sleep(2500);
  ws.send(JSON.stringify({ type: 'send', chatId, text: 'This is the pre-restart check. Reply with exactly the word CHECKED and nothing else.', clientMsgId }));

  const echo = await next((m) => m.type === 'stream' && m.event?.type === '_user_echo' && m.event?.clientMsgId === clientMsgId, 60_000, 'the message rendering in the event stream');
  const echoSeq = typeof echo.seq === 'number' ? echo.seq : 0;
  if (!echoSeq) fail('the echo carried no seq — cannot prove fresh seqs');
  if (echoSeq <= watermark) fail(`the echo rendered at seq ${echoSeq}, at or below the ${watermark} watermark — the Oct 7 duplicate-drop class`);
  const echoIdx = frames.indexOf(echo);

  const reply = await next((m) => m.type === 'stream' && m.event?.type === 'result', 180_000, 'a completed turn (result)');
  if (reply.event?.is_error !== false) fail('the probe-lane turn did not complete cleanly: ' + JSON.stringify(reply.event).slice(0, 200));
  const resultSeq = typeof reply.seq === 'number' ? reply.seq : 0;
  if (!resultSeq || resultSeq <= echoSeq) fail(`the result seq (${resultSeq}) is not fresh above the echo (${echoSeq})`);
  const text = collectAssistantText(frames.slice(echoIdx));
  // Exact match: a loose contains-test would pass on refusals like
  // "NOT CHECKED" that merely mention the word.
  if (text.trim() !== 'CHECKED') fail(`the reply was not exactly CHECKED (got: ${JSON.stringify(text.slice(0, 120))})`);
  try { ws.close(); } catch {}
  return { text, echoSeq, resultSeq, clientMsgId };
}

function collectAssistantText(frames) {
  let deltaText = '';
  let resultText = '';
  let sawResultString = false;
  for (const m of frames) {
    if (m.type !== 'stream' || !m.event) continue;
    if (m.event.type === 'stream_event' && m.event.event?.type === 'content_block_delta' && m.event.event.delta?.type === 'text_delta') {
      deltaText += m.event.event.delta.text ?? '';
    }
    if (m.event.type === 'result' && typeof m.event.result === 'string') {
      resultText = m.event.result;
      sawResultString = true;
    }
  }
  // The result event is the authoritative final text; the deltas are the
  // streaming preview of the same content, so concatenating both would
  // double it (a live dry run caught exactly "CHECKEDCHECKED"). An observed
  // string result wins even when EMPTY: a malformed empty final result must
  // fail the probe, not silently pass on the streamed deltas.
  return (sawResultString ? resultText : deltaText).trim();
}

/** Replay leg: reconnect and replay the lane above the watermark. The
 *  probe turn must come back EXACTLY once per event with the SAME seqs
 *  (a duplicate or re-allocation would drop or double messages on a real
 *  reload). */
async function replayCheck(port, repo, chatId, sinceSeq, clientMsgId, echoSeq, resultSeq) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const frames = [];
  ws.onmessage = (ev) => {
    try { frames.push(JSON.parse(ev.data)); } catch { /* not a frame */ }
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('replay websocket never opened')), 20_000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('replay websocket error')); };
  });
  ws.send(JSON.stringify({ type: 'hello', cli: 'claude', repo, chatId, sinceSeq, visible: false }));
  // The WS protocol has no replay-complete barrier, so close on quiet: hold
  // the socket until no frame has arrived for 2s (a slow but valid replay
  // simply holds longer instead of false-failing a fixed window, and a
  // straggler duplicate still lands inside the window), with a hard cap so
  // a chatty or broken lane cannot hang the check.
  await new Promise((resolve) => {
    const started = Date.now();
    let lastArrival = 0;
    let seen = 0;
    const pump = () => {
      if (frames.length > seen) { seen = frames.length; lastArrival = Date.now(); }
      if ((seen > 0 && Date.now() - lastArrival >= 2000) || Date.now() - started >= 20000) {
        resolve(undefined);
        return;
      }
      setTimeout(pump, 100);
    };
    setTimeout(pump, 100);
  });
  try { ws.close(); } catch {}
  const echoes = frames.filter((m) => m.type === 'stream' && m.event?.type === '_user_echo' && m.event?.clientMsgId === clientMsgId);
  if (echoes.length !== 1) fail(`replay sent the probe message ${echoes.length} times (expected exactly 1)`);
  if (echoes[0].seq !== echoSeq) fail(`replay re-allocated the echo seq (${echoes[0].seq} vs the original ${echoSeq})`);
  // Count result frames by kind, not by seq: the lane above the watermark
  // holds exactly one turn, so ANY second result frame is a duplicate —
  // including one re-allocated to a different sequence, which a seq-only
  // filter would let slip past.
  const results = frames.filter((m) => m.type === 'stream' && m.event?.type === 'result');
  if (results.length !== 1) fail(`replay sent the turn result ${results.length} times (expected exactly 1)`);
  if (results[0].seq !== resultSeq) fail(`replay re-allocated the result seq (${results[0].seq} vs the original ${resultSeq})`);
  return { echoSeq: echoes[0].seq, resultSeq };
}

/** Team leg: one team_message between the two seeded probe lanes, entirely
 *  inside the side copy. The recipient's engine runs in the probe sandbox;
 *  the wait path returns its exact reply, which must be TEAMOK. */
async function teamRoundTrip(port, fromName, toName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  let res;
  let body = null;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/team/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromName,
        to: toName,
        text: 'This is the TARDIS pre-restart check. Reply with exactly the word TEAMOK and nothing else.',
        wait: true,
      }),
      signal: controller.signal,
    });
    body = await res.json().catch(() => null);
  } catch (err) {
    fail(`team round trip request failed: ${String(err.message || err).split('\n')[0]}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || !body?.delivered) {
    fail(`team round trip was not delivered (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  if (String(body.reply ?? '').trim() !== 'TEAMOK') {
    fail(`team round trip reply was not exactly TEAMOK (got: ${JSON.stringify(String(body.reply ?? '').slice(0, 120))})`);
  }
  return body;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
