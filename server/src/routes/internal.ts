import { Router } from 'express';
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
