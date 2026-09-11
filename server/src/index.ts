import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ELROND_WORKSPACE_PATH, HOST, PORT, PREWARM_AGENTS, STATIC_DIR, WORKER_RUNNER } from './config.ts';
import { quiesceChat, registerChat } from './chat/register.ts';
import { getOrCreateSession, isClaudeFamilyCli, type CliKind } from './chat/runner.ts';
import { brainForAgent, cliForAgentEngine, ensureAgents, listAgents } from './chat/agents.ts';
import { resumeQueuedTeamDeliveries } from './chat/teamBus.ts';
import { agentsRouter } from './routes/agents.ts';
import { teamRouter } from './routes/team.ts';
import { routinesRouter } from './routes/routines.ts';
import { messagePinsRouter } from './routes/messagePins.ts';
import { registerVoiceCalls } from './voice/grokCall.ts';
import { registerDeviceBridge } from './devices/bridge.ts';
import { voicePreviewRouter } from './voice/preview.ts';
import { chatAttachmentsRouter } from './routes/chatAttachments.ts';
import { startRoutineScheduler } from './chat/routines.ts';
import { ensureXaiProxy, shutdownXaiProxy } from './chat/xai-proxy.ts';
import { registerScribeSocket } from './worker/scribe.ts';
import { startWorkerQueue, stopWorkerQueue } from './worker/queue.ts';
import { startWorkspaceWatcher, stopWorkspaceWatcher } from './lib/workspaceWatcher.ts';
import { tasksRouter } from './routes/tasks.ts';
import { calendarRouter } from './routes/calendar.ts';
import { emailRouter } from './routes/email.ts';
import { familyRouter } from './routes/family.ts';
import { docsRouter } from './routes/docs.ts';
import { plRouter } from './routes/pl.ts';
import { cronRouter } from './routes/cron.ts';
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
import { markBusyLanesRestarting, activeClaudeSessions } from './chat/runner.ts';
import { flushAllEventChains } from './chat/event-log-store.ts';
import { markBusyCodexLanesRestarting, activeCodexSessions } from './chat/codex-runner.ts';
import { markBusyBananaLanesRestarting, activeBananaSessions } from './chat/banana-runner.ts';

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

app.get('/api/health', (_req, res) => {
  const busyTurns =
    activeClaudeSessions().filter((s) => s.busy).length +
    activeCodexSessions().filter((s) => s.busy).length +
    activeBananaSessions().filter((s) => s.busy).length;
  res.json({
    ok: true,
    app: 'rivendell',
    brand: 'tardis',
    port: PORT,
    workerRunner: WORKER_RUNNER,
    /** In-flight turns right now. A restart kills them mid-flight — deploys
     *  MUST check this is 0 (or accept the tombstone) before bouncing. */
    busyTurns,
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
app.use('/api/routines', routinesRouter);
app.use('/api/message-pins', messagePinsRouter);
app.use('/api/jarvis', jarvisRouter);
app.use('/api/voice-preview', voicePreviewRouter);
app.use('/api/chat/attachments', chatAttachmentsRouter);
// Localhost-only headless runner (cron agentic loop). Gated by MCP_AUTH_TOKEN.
app.use('/internal', internalRouter);

// xAI SuperGrok OAuth login page (browser, one-time). Mounted before the SPA
// fallback so GET /xai-oauth serves the connector instead of index.html.
app.use('/xai-oauth', xaiOauthRouter);

const server = createServer(app);
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
registerScribeSocket(server);
startWorkerQueue();
startWorkspaceWatcher();

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

server.listen(PORT, HOST, () => {
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
    // Sequential admission makes Max genuinely first and lets the memory guard
    // observe each already-spawned process before deciding on the next one.
    for (const agent of agents) {
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
          await session.prewarm();
        }
        if (!tearingDown) console.log(`[chat prewarm] ${agent.name} is ready`);
      } catch (err) {
        if (!tearingDown) console.warn(`[chat prewarm] ${String(agent?.name || agent?.id || 'agent')} could not prewarm:`, (err as Error).message);
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
  // Stop all sessions NOW so no new events enqueue after the flush below.
  stopWorkerQueue();
  stopWorkspaceWatcher();
  console.warn('[tardis] shutdown: sessions stopping…');
  stopChat();
  console.warn('[tardis] shutdown: sessions stopped, flushing logs');
  void (async () => {
    // Everything is quiesced and sessions are dead — the chains are final.
    try { await flushAllEventChains(); } catch { /* best effort */ }
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
