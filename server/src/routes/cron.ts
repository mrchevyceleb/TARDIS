import { Router } from 'express';
import {
  createAdminCronJob,
  deleteAdminCronJob,
  fetchAdminCronJobs,
  fetchAdminCronHistory,
  runAdminCronJob,
  updateAdminCronJob,
  type RivendellCronJob,
} from '../lib/assistantData.ts';
import { emitScribe } from '../worker/scribe.ts';
import { asyncHandler } from './helpers.ts';
import { CRON_LOCAL_TRIGGER_URL } from '../config.ts';
import { defaultAgentBrain } from '../chat/agents.ts';

export const cronRouter = Router();

const CRON_SUBSCRIPTIONS = new Set(['assistant', 'claude', 'codex', 'codex-personal', 'xai']);
// Only canonical scheduler identifiers may execute without an explicit edit.
// Accepted input aliases are normalized by subscriptionCronPayload first.
const CRON_RUNTIME_SUBSCRIPTIONS = new Set(['assistant', 'codex', 'xai']);

export function isSubscriptionCronEngine(engine: string | undefined): boolean {
  return Boolean(engine && CRON_RUNTIME_SUBSCRIPTIONS.has(engine));
}

function validateCronEnginePayload(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'request body must be an object';
  const payload = body as Record<string, unknown>;
  if (payload.engine !== undefined && (typeof payload.engine !== 'string' || !CRON_SUBSCRIPTIONS.has(payload.engine))) return 'Choose Claude Code, Codex, or Grok for scheduled work.';
  return null;
}

/** The remote scheduler's historical Claude identifier is `assistant`. Pin a
 * supported engine so a missing field cannot trigger its metered API default. */
export function subscriptionCronPayload(input: Partial<RivendellCronJob>, current?: RivendellCronJob): Partial<RivendellCronJob> {
  const saved = input.engine ?? current?.engine;
  const engine = saved && CRON_SUBSCRIPTIONS.has(saved) ? saved : 'assistant';
  const canonical = engine === 'assistant' || engine === 'claude' ? 'claude' : engine === 'codex-personal' ? 'codex' : engine;
  const defaults = defaultAgentBrain(canonical);
  const changed = !saved || !CRON_SUBSCRIPTIONS.has(saved) || (input.engine !== undefined && input.engine !== current?.engine);
  return {
    ...current,
    ...input,
    status: input.status ?? (current?.paused ? 'paused' : 'active'),
    engine: canonical === 'claude' ? 'assistant' : canonical,
    aiModel: canonical === 'codex' ? 'codex' : 'claude',
    ...(changed ? { modelId: input.modelId ?? defaults.model, reasoningEffort: input.reasoningEffort ?? defaults.effort } : {}),
  };
}

/** Only explicit project ownership is enough to change an upstream schedule.
 * `sourceLabel: Forge` is not ownership: the admin list also contains fleet work. */
export function isTardisOwnedCron(job: RivendellCronJob): boolean {
  return !job.readOnly && job.source === 'assistant-mcp' && (
    /^(?:TARDIS|Rivendell)(?:\s|$)/i.test(job.name)
    || /(?:^|[\\/])(?:TARDIS|Rivendell)(?:[\\/]|$)/i.test(job.repo ?? job.cwd ?? '')
    || /\[(?:TARDIS|Rivendell) schedule\]/i.test(job.description ?? '')
  );
}

/** Best-effort startup migration pauses retired app schedules instead of
 * silently scheduling work on a different account. Explicit edits select a
 * new subscription. Unrelated fleet schedules remain untouched. */
export async function pauseRetiredCronJobs(jobs?: RivendellCronJob[]): Promise<RivendellCronJob[]> {
  const rows = jobs ?? await fetchAdminCronJobs();
  return Promise.all(rows.map(async (job) => {
    if (!isTardisOwnedCron(job) || job.actionType !== 'ai_prompt' || job.paused || isSubscriptionCronEngine(job.engine)) return job;
    try { return await updateAdminCronJob(job.id, { status: 'paused' }); }
    catch { console.warn('[cron] Could not pause a retired TARDIS schedule; its upstream configuration needs attention.'); return job; }
  }));
}

cronRouter.get('/', asyncHandler(async (_req, res) => {
  try {
    res.json(await pauseRetiredCronJobs(await fetchAdminCronJobs()));
  } catch (err: any) {
    res.status(502).json({ error: `cron upstream failed: ${err?.message || 'unknown error'}` });
  }
}));

// Execution history for a job. runtime=local jobs run on the local cron runner
// but still log every execution to `scheduled_jobs`, so this works for both
// runtimes. Read-only proxy to assistant-mcp /admin/api/cron/jobs/:id/history.
cronRouter.get('/:id/history', asyncHandler(async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string || '15', 10) || 15, 1), 50);
    res.json({ runs: await fetchAdminCronHistory(String(req.params.id), limit) });
  } catch (err: any) {
    res.status(502).json({ error: `cron history failed: ${err?.message || 'unknown error'}` });
  }
}));

cronRouter.post('/', asyncHandler(async (req, res) => {
  const validationError = validateCronEnginePayload(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  try {
    const job = await createAdminCronJob(subscriptionCronPayload(req.body));
    res.status(201).json(job);
  } catch (err: any) {
    res.status(502).json({ error: `cron create failed: ${err?.message || 'unknown error'}` });
  }
}));

cronRouter.post('/:id/run-now', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  try {
    // runtime=local jobs can only be triggered on the local runner; the Railway
    // server refuses them ("runtime is local but this process is railway").
    // Look up the job's runtime and route accordingly.
    const jobs = await fetchAdminCronJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) { res.status(404).json({ error: 'cron job not found' }); return; }
    if (job.readOnly) { res.status(403).json({ error: 'This schedule is managed externally.' }); return; }
    if (!isSubscriptionCronEngine(job.engine)) { res.status(409).json({ error: 'This saved schedule uses a retired engine. Edit it and select a subscription before running it.' }); return; }
    const runtime = job.runtime ?? 'railway';

    if (runtime === 'local') {
      const resp = await fetch(`${CRON_LOCAL_TRIGGER_URL}/run/${encodeURIComponent(id)}`, {
        method: 'POST',
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`local runner ${resp.status}: ${body.slice(0, 200)}`);
      }
    } else {
      await runAdminCronJob(id);
    }

    await emitScribe({ level: 'system', text: `manual cron run requested: ${id} (${runtime})` });
    res.status(202).json({ ok: true, runtime });
  } catch (err: any) {
    res.status(502).json({ error: `cron run failed: ${err?.message || 'unknown error'}` });
  }
}));

cronRouter.patch('/:id', asyncHandler(async (req, res) => {
  const validationError = validateCronEnginePayload(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  try {
    const current = (await fetchAdminCronJobs()).find((job) => job.id === String(req.params.id));
    if (!current) { res.status(404).json({ error: 'cron job not found' }); return; }
    if (current.readOnly) { res.status(403).json({ error: 'This schedule is managed externally.' }); return; }
    const job = await updateAdminCronJob(String(req.params.id), subscriptionCronPayload(req.body, current));
    if (!job) {
      res.status(404).json({ error: 'cron job not found' });
      return;
    }
    res.json(job);
  } catch (err: any) {
    res.status(502).json({ error: `cron update failed: ${err?.message || 'unknown error'}` });
  }
}));

cronRouter.delete('/:id', asyncHandler(async (req, res) => {
  try {
    await deleteAdminCronJob(String(req.params.id));
    res.status(204).end();
  } catch (err: any) {
    res.status(502).json({ error: `cron delete failed: ${err?.message || 'unknown error'}` });
  }
}));
