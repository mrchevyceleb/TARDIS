import { Router } from 'express';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asyncHandler } from './helpers.ts';
import { ASSISTANT_ADMIN_TOKEN, ELROND_WORKSPACE_PATH } from '../config.ts';
import { getOrCreateSession, activeClaudeSessions, type CliKind } from '../chat/runner.ts';
import { activeCodexSessions } from '../chat/codex-runner.ts';
import { assertSubscriptionEngine } from '../chat/subscription-policy.ts';
import { agentForChatId, brainForAgent } from '../chat/agents.ts';

export const internalRouter = Router();

// Localhost-only callers (the assistant-cron runtime) hit these. Not part of
// the SPA and intentionally NOT under /api so the Forge/admin surfaces never
// proxy to them. Every route is gated by MCP_AUTH_TOKEN (same secret the admin
// API uses; both TARDIS and the cron runtime source it from Doppler).

const WORKSPACE = ELROND_WORKSPACE_PATH;
const RUN_TIMEOUT_MS = Number(process.env.RIVENDELL_CRON_LLM_TIMEOUT_MS) || 280_000;
const DEBUG = process.env.RIVENDELL_CRON_LLM_DEBUG === '1';

/** Internal subscription-backed agentic runner. Existing durable history is
 * retained; automation yields while a conversation is active. *
 *  POST /internal/cron-llm-run
 *    header: x-internal-token: <MCP_AUTH_TOKEN>
 *    body:   { prompt: string, cwd?: string, model?: string, chatId?: string }
 *    -> { ok: true, result: string, durationMs: number }
 *       { ok: false, error: string, partial?: string, durationMs: number } */
internalRouter.post(
  '/cron-llm-run',
  asyncHandler(async (req, res) => {
    const token = req.header('x-internal-token');
    if (!ASSISTANT_ADMIN_TOKEN || token !== ASSISTANT_ADMIN_TOKEN) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { prompt, cwd, model, chatId, engine = 'claude', effort } = req.body || {};
    try { assertSubscriptionEngine(engine); } catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); return; }
    if ([...activeClaudeSessions(), ...activeCodexSessions()].some((session) => session.busy)) {
      res.status(409).json({ ok: false, error: 'Agent work is active. Scheduled work should retry after conversations finish.' }); return;
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt (string) is required' });
      return;
    }
    const repoPath = typeof cwd === 'string' && cwd.trim() ? cwd : WORKSPACE;
    const sessionChatId = typeof chatId === 'string' && chatId.trim() ? chatId : 'cron-run';
    const started = Date.now();

    // Agent home threads keep their canonical brain; standalone cron threads
    // use the requested subscription. No Fresh/reset and no history deletion.
    const agent = agentForChatId(sessionChatId);
    const brain = agent ? brainForAgent(agent) : { engine, model, effort };
    let session;
    try {
      session = await getOrCreateSession({ repoPath, chatId: sessionChatId, cli: brain.engine as CliKind, model: brain.model, effort: brain.effort });
      if (session.isBusy()) { res.status(409).json({ ok: false, error: 'This thread is busy; retry later.' }); return; }
    } catch (err: any) {
      res
        .status(502)
        .json({ ok: false, error: `session start failed: ${err?.message || err}`, durationMs: Date.now() - started });
      return;
    }

    let text = '';
    let errMsg: string | null = null;
    let timedOut = false;
    let settled = false;
    const seenTypes: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const finish = () => {
      if (!settled) {
        settled = true;
        resolveDone();
      }
    };

    // Subscribe BEFORE send so we capture every event of this turn. Assistant
    // text streams wrapped as ev.event = { type:'stream_event', event:{...} };
    // visible answer text is inner content_block_delta text_delta chunks. The
    // synthetic 'result' event at turn-end carries no text, so we accumulate
    // deltas. turnEnd/error end the wait; a watchdog bounds the whole run.
    const off = session.subscribe((se: any) => {
      const ev = se?.ev;
      if (!ev || typeof ev !== 'object') return;
      if (DEBUG) {
        const t =
          String(ev.type) +
          (ev.event?.type ? `/${ev.event.type}` : '') +
          (ev.event?.event?.type ? `/${ev.event.event.type}` : '');
        seenTypes.push(t);
      }
      if (ev.type === 'error') {
        errMsg = typeof ev.message === 'string' ? ev.message : 'subscription turn error';
        finish();
        return;
      }
      if (ev.type === 'turnEnd') {
        finish();
        return;
      }
      if (ev.type === 'event' && ev.event?.type === 'stream_event') {
        const inner = ev.event.event;
        if (
          inner?.type === 'content_block_delta' &&
          inner.delta?.type === 'text_delta' &&
          typeof inner.delta.text === 'string'
        ) {
          text += inner.delta.text;
        }
      }
    });

    const watchdog = setTimeout(() => {
      timedOut = true;
      finish();
    }, RUN_TIMEOUT_MS);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    try {
      // send() dispatches the prompt; the tool-use loop (auto tool execution)
      // then runs async, streaming events until turnEnd.
      await session.send(prompt, undefined, { model: brain.model, effort: brain.effort, peerFrom: 'automation' });
    } catch (err: any) {
      errMsg = `send failed: ${err?.message || err}`;
      finish();
    }

    await done;
    clearTimeout(watchdog);
    off();

    const durationMs = Date.now() - started;
    if (DEBUG) {
      console.log(
        `[internal cron-llm-run] ${sessionChatId} ${durationMs}ms ev:${seenTypes.join(',') || '(none)'}`,
      );
    }

    if (timedOut) {
      res
        .status(504)
        .json({ ok: false, error: `timed out after ${RUN_TIMEOUT_MS}ms`, partial: text, durationMs });
      return;
    }
    if (errMsg) {
      res.status(502).json({ ok: false, error: errMsg, partial: text, durationMs });
      return;
    }
    res.json({ ok: true, result: text.trim(), durationMs });
  }),
);

// ---- Riley game-watch gate source -------------------------------------------

const execFileAsync = promisify(execFileCb);
const RILEY_PULSE_BIN = join(homedir(), 'bin', 'riley-pulse');
const RILEY_WATCH_STATE = join(homedir(), 'ASSISTANT-HUB', 'projects', 'stone-labs-games', 'watch-state.json');
let rileyDeltaInFlight: Promise<Array<{ id: string; kind: string; text: string }>> | null = null;

/** Deterministic "what changed" read for the gated 5-minute Game studio watch
 *  (see chat/routineGate.ts). Runs the SAME pulse script the agent's step 1
 *  ran — its cursor advances exactly once per tick — surfaces due watch-state
 *  pending items, and flags the :05 hourly-checks window. An empty array means
 *  quiet. Any failure is a 503 so the gate fails OPEN to the full agent turn.
 *  Lines carry only chat ids and short labels, never chat content.
 *    GET /internal/riley-watch-delta
 *    header: x-internal-token: <MCP_AUTH_TOKEN> */
internalRouter.get(
  '/riley-watch-delta',
  asyncHandler(async (req, res) => {
    const token = req.header('x-internal-token');
    if (!ASSISTANT_ADMIN_TOKEN || token !== ASSISTANT_ADMIN_TOKEN) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (rileyDeltaInFlight) {
      // Share the in-flight run instead of failing: a 503 here would fail the
      // gate open and the agent's own pulse could run concurrently with ours.
      try {
        res.json(await rileyDeltaInFlight);
      } catch {
        res.status(503).json({ error: 'riley-pulse failed' });
      }
      return;
    }
    // Read watch-state BEFORE the pulse: its read has no side effect, so a 503
    // here can never come after the pulse cursor advanced. An unreadable state
    // file must not read as quiet.
    let pendingItems: Array<{ after?: string; what?: string }>;
    try {
      pendingItems = ((JSON.parse(readFileSync(RILEY_WATCH_STATE, 'utf8')) as { pending?: Array<{ after?: string; what?: string }> }).pending) ?? [];
    } catch {
      res.status(503).json({ error: 'watch-state unreadable' });
      return;
    }
    const run = (async () => {
      const r = await execFileAsync(RILEY_PULSE_BIN, { timeout: 55_000, maxBuffer: 1 << 20 });
      const items: Array<{ id: string; kind: string; text: string }> = [];
      (r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
        items.push({ id: `pulse-${i}-${createHash('sha1').update(line).digest('hex').slice(0, 8)}`, kind: 'pulse', text: line.slice(0, 300) });
      });
      for (const p of pendingItems) {
        if (typeof p.after === 'string' && Date.parse(p.after) <= Date.now()) {
          items.push({ id: `pending-${createHash('sha1').update(String(p.what ?? '')).digest('hex').slice(0, 8)}`, kind: 'pending', text: String(p.what ?? 'due pending item').slice(0, 300) });
        }
      }
      // The :05 hourly-checks window (prompt section B; the 9:05 slot also
      // posts the morning roll-up). Local minutes; the scheduler is local too.
      const now = new Date();
      if (now.getMinutes() >= 5 && now.getMinutes() <= 9) {
        items.push({ id: `hourly-${now.toISOString().slice(0, 13)}`, kind: 'hourly', text: 'Hourly checks window: run section B now (Steam/PS/Xbox/Nintendo mail, Pengi clips); on the 9:05 ET slot also post the morning roll-up (section C).' });
      }
      return items;
    })();
    rileyDeltaInFlight = run;
    try {
      res.json(await run);
    } catch (err) {
      res.status(503).json({ error: `riley-pulse failed: ${(err as Error).message.slice(0, 120)}` });
    } finally {
      rileyDeltaInFlight = null;
    }
  }),
);
