import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { contentRouter } from './routes/content.ts';
import { dictationRouter } from './routes/dictation.ts';
import { integrationsRouter } from './routes/integrations.ts';
import { setupRouter } from './routes/setup.ts';
import { contentGatewayRouter } from './routes/contentGateway.ts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSISTANT_ADMIN_BASE_URL, ASSISTANT_ADMIN_TOKEN, DESK_ROOM_ENABLED, ELROND_WORKSPACE_PATH, HOST, PORT, PREWARM_AGENTS, STATIC_DIR, WORKER_RUNNER } from './config.ts';
import { quiesceChat, registerChat } from './chat/register.ts';
import { getOrCreateSession, isClaudeFamilyCli, type CliKind } from './chat/runner.ts';
import { brainForAgent, cliForAgentEngine, ensureAgents, listAgents } from './chat/agents.ts';
import { resumeQueuedTeamDeliveries } from './chat/teamBus.ts';
import { agentsRouter } from './routes/agents.ts';
import { teamRouter } from './routes/team.ts';
import { channelsRouter } from './routes/channels.ts';
import { headlessRouter } from './routes/headless.ts';
import { closeAllHeadlessLanes } from './headless/pool.ts';
import { jobsRouter } from './routes/jobs.ts';
import { routinesRouter } from './routes/routines.ts';
import { messagePinsRouter } from './routes/messagePins.ts';
import { railLayoutRouter } from './routes/railLayout.ts';
import { deliverDeskAnswer, deskRouter } from './routes/desk.ts';
import { startDeskNotifier } from './lib/deskNotify.ts';
import { registerVoiceCalls } from './voice/grokCall.ts';
import { registerDeviceBridge } from './devices/bridge.ts';
import { voicePreviewRouter } from './voice/preview.ts';
import { chatAttachmentsRouter } from './routes/chatAttachments.ts';
import { startRoutineScheduler } from './chat/routines.ts';
import { startJobWatchScheduler } from './chat/jobWatches.ts';
import { startJobScheduler } from './chat/jobs.ts';
import { ensureXaiProxy, shutdownXaiProxy } from './chat/xai-proxy.ts';
import { registerScribeSocket } from './worker/scribe.ts';
import { startWorkerQueue, stopWorkerQueue } from './worker/queue.ts';
import { startWorkspaceWatcher, stopWorkspaceWatcher } from './lib/workspaceWatcher.ts';
import { startDeskHygieneScheduler } from './lib/deskHygiene.ts';
import { startRestartWake } from './lib/restartWake.ts';
import { tasksRouter } from './routes/tasks.ts';
import { calendarRouter } from './routes/calendar.ts';
import { emailRouter } from './routes/email.ts';
import { familyRouter } from './routes/family.ts';
import { docsRouter } from './routes/docs.ts';
import { plRouter } from './routes/pl.ts';
import { cronRouter, pauseRetiredCronJobs } from './routes/cron.ts';
import { messagesRouter } from './routes/messages.ts';
import { pinsRouter } from './routes/pins.ts';
import { weavingsRouter } from './routes/weavings.ts';
import { scribeRouter } from './routes/scribe.ts';
import { summaryRouter } from './routes/summary.ts';
import { artifactsRouter } from './routes/artifacts.ts';
import { mcpRouter } from './routes/mcp.ts';
import { filesRouter } from './routes/files.ts';
import { devicesRouter } from './routes/devices.ts';
import { robotsRouter } from './routes/robots.ts';
import { jarvisRouter } from './routes/jarvis.ts';
import { internalRouter } from './routes/internal.ts';
import { xaiOauthRouter } from './routes/xai-oauth.ts';
import { primeXaiOauthToken } from './chat/runner.ts';
import { migrateAgentThreadLogs } from './chat/threadMigrate.ts';
import { markBackgroundWorkEndedByRestart, markBusyLanesRestarting, activeClaudeSessions } from './chat/runner.ts';
import { markPendingProviderContinuesInterrupted } from './chat/providerSwitch.ts';
import { flushAllEventChains } from './chat/event-log-store.ts';
import { markBusyCodexLanesRestarting, activeCodexSessions } from './chat/codex-runner.ts';
import { markBusyBananaLanesRestarting, activeBananaSessions } from './chat/banana-runner.ts';
import { computerOwnerKey, setComputerOwnerTurnProbe } from './devices/context.ts';

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  next();
});
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '25mb' }));

const CONTENT_ROOM_ENABLED =
  (process.env.RIVENDELL_CONTENT_ROOM?.trim().toLowerCase() ?? '') !== 'off';

// A computer context stays valid past its idle window while its owner's turn is still running.
setComputerOwnerTurnProbe((owner) =>
  [...activeClaudeSessions(), ...activeCodexSessions(), ...activeBananaSessions()].some((s) => computerOwnerKey(s.cwd, s.chatId) === owner && s.busy));

app.get('/api/health', (_req, res) => {
  const claudeSessions = activeClaudeSessions();
  const busyTurns =
    claudeSessions.filter((s) => s.busy).length +
    activeCodexSessions().filter((s) => s.busy).length +
    activeBananaSessions().filter((s) => s.busy).length;
  const backgroundLanes = claudeSessions
    .filter((s) => s.backgroundTasks?.length)
    .map((s) => ({ cli: s.cli, chatId: s.chatId, tasks: s.backgroundTasks!.length }));
  res.json({
    ok: true,
    app: 'rivendell',
    brand: 'tardis',
    port: PORT,
    workerRunner: WORKER_RUNNER,
    /** In-flight turns right now. A restart kills them mid-flight — deploys
     *  MUST check this is 0 (or accept the tombstone) before bouncing. */
    busyTurns,
    /** Background shells/subagents running inside Claude lanes. A restart ends
     *  them too (each lane gets a note naming what ended), so check this with
     *  busyTurns before bouncing. */
    backgroundTasks: backgroundLanes.reduce((sum, lane) => sum + lane.tasks, 0),
    backgroundLanes,
    /** The Content rooms are a per-deployment surface, not core TARDIS. An
     *  instance that does not run the content engine hides them entirely.
     *  Opt-out rather than opt-in so an existing deployment keeps working
     *  until its own env says otherwise. */
    contentRoom: CONTENT_ROOM_ENABLED,
    /** The Desk room (Needs you + agent work board). On by default;
     *  RIVENDELL_DESK_ROOM=off hides it. */
    deskRoom: DESK_ROOM_ENABLED,
    ts: Date.now(),
  });
});

app.use('/api/summary', summaryRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/email', emailRouter);
app.use('/api/family', familyRouter);
app.use('/api/docs', docsRouter);
app.use('/api/pl', plRouter);
app.use('/api/pins', pinsRouter);
app.use('/api/cron', cronRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/weavings', weavingsRouter);
app.use('/api/scribe', scribeRouter);
app.use('/api/artifacts', artifactsRouter);
app.use('/api/mcp', mcpRouter);
app.use('/api/files', filesRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/robots', robotsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/team', teamRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/headless', headlessRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/routines', routinesRouter);
app.use('/api/message-pins', messagePinsRouter);
app.use('/api/rail-layout', railLayoutRouter);
app.use('/api/desk', deskRouter);
app.use('/api/jarvis', jarvisRouter);
app.use('/api/voice-preview', voicePreviewRouter);
app.use('/api/chat/attachments', chatAttachmentsRouter);
// Localhost-only headless runner (cron agentic loop). Gated by MCP_AUTH_TOKEN.
app.use('/internal', internalRouter);

// xAI SuperGrok OAuth login page (browser, one-time). Mounted before the SPA
// fallback so GET /xai-oauth serves the connector instead of index.html.
app.use('/xai-oauth', xaiOauthRouter);

const server = createServer(app);
// Big-file chat uploads stream their whole body slowly (a multi-GB file from
// a phone can take well over the 300s default). On Node 25 the requestTimeout
// deadline is measured from request start with no reset on body data, and a
// 30s connections checker 408s any request past it, so even an
// actively-flowing multi-GB body longer than the deadline is cut mid-stream.
// Per-route scoping is not possible: the checker is server-level and
// req.socket.setTimeout does not participate (pinned empirically and against
// the Node 25 parser source). The checker expires a request at
// max(headersTimeout, requestTimeout); headersTimeout keeps its 60s
// construction clamp, so slow-header connections are still capped at 60s
// while the request deadline becomes this value.
server.requestTimeout = 6 * 60 * 60 * 1000;
app.use('/api/content', contentRouter);
app.use('/api/dictation', dictationRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/setup', setupRouter);
app.use('/internal/content/v1', contentGatewayRouter);
// Start the xAI transform proxy before chat registers so its base URL is
// resolved before any xAI chat session can spawn. Non-fatal: a failure logs
// and xAI turns surface a clear error instead of crashing the server.
try {
  await ensureXaiProxy();
} catch (err) {
  console.warn(`[tardis] xAI proxy failed to start: ${(err as Error).message}`);
}
// Prime the SuperGrok OAuth token (refresh now if near expiry, then background
// refresh every 30m) so xAI chat turns use the subscription, not API credits.
await primeXaiOauthToken();
ensureAgents(); // seed the agent store (one Chief of Staff)
try {
  const mig = migrateAgentThreadLogs();
  if (!mig.skipped) console.log(`[thread-migrate] merged ${mig.migrated} agent thread(s)`);
} catch (err) {
  console.warn(`[thread-migrate] failed: ${(err as Error).message}`);
}
const stopChat = await registerChat(app, server);
registerVoiceCalls(server);
registerDeviceBridge(server);
startRoutineScheduler(); // agent-scoped routine scheduler (30s tick)
startJobWatchScheduler(); // background job watches (10s tick): pid/file/command → agent wake
startJobScheduler(); // job_start jobs (5s tick): exit records → agent job-result
// Needs-you phone alerts and digests, plus answer delivery retries (60s tick).
if (DESK_ROOM_ENABLED) startDeskNotifier({ retryAnswer: (id) => deliverDeskAnswer(id) });
registerScribeSocket(server);
startWorkerQueue();
startWorkspaceWatcher();
startDeskHygieneScheduler(); // Desk card hygiene (60s tick): stale-card nudges at 8/10/12/2/4 ET
startRestartWake(); // once, ~25s after boot: wake the lanes the last restart cut mid-turn

if (existsSync(STATIC_DIR)) {
  // index.html must always revalidate — a heuratively-cached shell pins the
  // browser to old hashed bundles until a hard refresh. Hashed assets stay
  // indefinitely cacheable.
  app.use(express.static(STATIC_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(resolve(STATIC_DIR, 'index.html'));
  });
}

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

let tearingDown = false;
let agentPrewarm: Promise<void> | null = null;
/** How many agent lanes the boot prewarm overlaps the ready waits for (see
 *  the admission comment at the prewarm loop). */
const PREWARM_CHUNK = 3;

server.listen(PORT, HOST, () => {
  if (ASSISTANT_ADMIN_BASE_URL && ASSISTANT_ADMIN_TOKEN) {
    void pauseRetiredCronJobs().catch(() => console.warn('[cron] Could not check retired TARDIS schedules at startup.'));
  }
  console.log(`tardis listening on http://${HOST}:${PORT}`);
  void resumeQueuedTeamDeliveries().then((count) => {
    if (count > 0) console.log(`[team] resumed ${count} durable queued ${count === 1 ? 'delivery' : 'deliveries'}`);
  }).catch((error) => {
    console.warn('[team] could not resume durable delivery queue:', (error as Error).message);
  });
  if (!PREWARM_AGENTS) {
    console.log('[chat prewarm] disabled (set RIVENDELL_PREWARM_AGENTS=true to opt in)');
    return;
  }
  // Teammates are always-on office lanes. Prewarm every persistent
  // Claude-family agent exactly once at boot (never from hello/reconnect
  // storms), using each lane's last proven model/effort. Max goes first in the
  // list, while independent lanes initialize concurrently.
  agentPrewarm = (async () => {
    const agents = listAgents().sort((a, b) =>
      Number(b.id === 'chief-of-staff') - Number(a.id === 'chief-of-staff'));
    // Bounded-parallel admission: spawns stay sequential — Max is still
    // genuinely first, and each process is running (and allocating) before
    // the memory guard is consulted for the next spawn, exactly like the old
    // fully serial loop — but the slow ready waits (30-70s of MCP startup
    // each) now overlap within chunks instead of adding up. Admission was
    // fully serial across 11 agents at one boot (10:50:24 to 10:55:14), which
    // together with the synchronous whole-log parse per spawn held HTTP for
    // minutes.
    for (let i = 0; i < agents.length; i += PREWARM_CHUNK) {
      if (tearingDown) break;
      const chunk = agents.slice(i, i + PREWARM_CHUNK);
      const warms: Array<{ name: string; ready: Promise<void> }> = [];
      for (const agent of chunk) {
        if (tearingDown) break;
        try {
          if (typeof agent?.name !== 'string' || typeof agent?.home !== 'string' || !agent.home) {
            throw new Error('invalid agent record');
          }
          const brain = brainForAgent(agent);
          const cli = cliForAgentEngine(brain.engine) as CliKind;
          if (!isClaudeFamilyCli(cli)) continue;
          const chatKey = agent.home;
          if (tearingDown) break;
          const session = await getOrCreateSession({
            cli,
            repoPath: ELROND_WORKSPACE_PATH,
            chatId: chatKey,
            model: brain.model,
            effort: brain.effort,
            recycleOnMismatch: true,
          });
          if (tearingDown) {
            session.shutdown('prewarm-teardown');
            break;
          }
          if ('prewarm' in session && typeof session.prewarm === 'function') {
            const ready = session.prewarm();
            // Attach a rejection handler immediately: the logging handlers
            // are only attached at the Promise.all below, and a fast reject
            // while this loop is still awaiting another getOrCreateSession
            // would otherwise race an unhandledRejection (process-fatal on
            // modern Node defaults). The Promise.all handlers still run.
            ready.catch(() => {});
            warms.push({ name: agent.name, ready });
          } else if (!tearingDown) {
            console.log(`[chat prewarm] ${agent.name} is ready`);
          }
        } catch (err) {
          if (!tearingDown) console.warn(`[chat prewarm] ${String(agent?.name || agent?.id || 'agent')} could not prewarm:`, (err as Error).message);
        }
      }
      if (warms.length) {
        await Promise.all(warms.map((w) => w.ready.then(
          () => { if (!tearingDown) console.log(`[chat prewarm] ${w.name} is ready`); },
          (err) => { if (!tearingDown) console.warn(`[chat prewarm] ${w.name} could not prewarm:`, (err as Error).message); },
        )));
      }
    }
  })().finally(() => {
    agentPrewarm = null;
  });
});

const tearDown = (signal: NodeJS.Signals) => {
  if (tearingDown) return; // a second SIGTERM/SIGINT must not re-mark or re-launch shutdown
  tearingDown = true;
  console.warn(`[tardis] received ${signal}, shutting down (pid=${process.pid}, uptime=${Math.round(process.uptime())}s)`);
  // Deadline now, not after the flush: a stuck write chain must not hang exit.
  setTimeout(() => process.exit(0), 2500).unref();
  // Quiesce first: no new turns after this point, so nothing starts after the
  // busy lanes are tombstoned.
  quiesceChat();
  try {
    const marked =
      markBusyLanesRestarting(signal) +
      markBusyCodexLanesRestarting(signal) +
      markBusyBananaLanesRestarting(signal);
    if (marked > 0) console.warn(`[tardis] marked ${marked} busy lane(s) with the restart tombstone`);
  } catch (err) {
    console.warn('[tardis] restart tombstone failed:', (err as Error).message);
  }
  try {
    const noted = markBackgroundWorkEndedByRestart();
    if (noted > 0) console.warn(`[tardis] noted ended background work in ${noted} lane(s)`);
  } catch (err) {
    console.warn('[tardis] background-work note failed:', (err as Error).message);
  }
  try {
    const cut = markPendingProviderContinuesInterrupted();
    if (cut > 0) console.warn(`[tardis] noted ${cut} GLM continue(s) the restart interrupted`);
  } catch (err) {
    console.warn('[tardis] provider-continue note failed:', (err as Error).message);
  }
  // Stop all sessions NOW so no new events enqueue after the flush below.
  stopWorkerQueue();
  stopWorkspaceWatcher();
  console.warn('[tardis] shutdown: sessions stopping…');
  stopChat();
  console.warn('[tardis] shutdown: sessions stopped, flushing logs');
  void (async () => {
    // Close headless Chromium gracefully (not SIGKILL on exit) so fresh logins reach the profile.
    const headlessClosed = closeAllHeadlessLanes().catch(() => {});
    // Everything is quiesced and sessions are dead — the chains are final.
    try { await flushAllEventChains(); } catch { /* best effort */ }
    await Promise.race([headlessClosed, new Promise((resolve) => setTimeout(resolve, 1200))]);
    console.warn('[tardis] shutdown: logs flushed, closing http');
    shutdownXaiProxy();
    server.close(() => process.exit(0));
  })();
};

process.on('SIGINT', () => tearDown('SIGINT'));
process.on('SIGTERM', () => tearDown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[tardis] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[tardis] unhandledRejection:', reason);
});
