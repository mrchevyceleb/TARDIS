// /api/jobs — background jobs (job_start tool and the per-chat jobs list).

import { Router } from 'express';
import { asyncHandler } from './helpers.ts';
import { listAgents } from '../chat/agents.ts';
import { createJob, getJob, jobLastLine, jobLogTail, listJobs, stopJob, type Job } from '../chat/jobs.ts';

export const jobsRouter = Router();

/** Jobs endpoints never expose the script text or wake bookkeeping. */
function view(job: Job, names: Map<string, string>) {
  const end = job.endedAt ?? Date.now();
  return {
    id: job.id,
    agentId: job.agentId,
    agentName: names.get(job.agentId) ?? '',
    name: job.name,
    state: job.state,
    command: job.command.slice(0, 300),
    startedAt: job.startedAt,
    endedAt: job.endedAt ?? null,
    elapsedMs: Math.max(0, end - job.startedAt),
    exitCode: job.exitCode ?? null,
    stoppedBy: job.stoppedBy ?? null,
    timeoutMin: job.timeoutMin,
    lastLine: jobLastLine(job),
  };
}

// Running jobs plus recently ended ones (default: last 2h). ?agentId= filters
// to one agent's chat; ?active=1 keeps only running jobs.
jobsRouter.get('/', asyncHandler(async (req, res) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
  const activeOnly = req.query.active === '1';
  const recentMs = 2 * 60 * 60_000;
  const names = new Map(listAgents().map((a) => [a.id, a.name]));
  const now = Date.now();
  const jobs = (await listJobs())
    .filter((j) => names.has(j.agentId))
    .filter((j) => !agentId || j.agentId === agentId)
    .filter((j) => j.state === 'running' || (!activeOnly && now - (j.endedAt ?? now) < recentMs))
    .sort((a, b) => b.startedAt - a.startedAt);
  res.json({ jobs: jobs.map((j) => view(j, names)) });
}));

jobsRouter.post('/', asyncHandler(async (req, res) => {
  const { agentId, name, command, cwd, timeoutMin } = req.body ?? {};
  if (typeof agentId !== 'string' || !agentId.trim()) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  try {
    const job = await createJob({ agentId, name, command, cwd, timeoutMin });
    res.status(201).json({ job: view(job, new Map(listAgents().map((a) => [a.id, a.name]))) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}));

jobsRouter.get('/:id/log', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = await getJob(id);
  if (!job) {
    res.status(404).json({ error: 'unknown job' });
    return;
  }
  res.json({ id, tail: jobLogTail(id, Math.min(400, Math.max(1, Number(req.query.lines) || 60))) });
}));

// by=user (the UI's Stop) wakes the agent with a stopped result; by=agent
// (the job_stop tool) does not, the caller already knows.
jobsRouter.post('/:id/stop', asyncHandler(async (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const by = req.body?.by === 'agent' ? 'agent' : 'user';
  const job = await stopJob(id, by);
  if (!job) {
    res.status(409).json({ error: 'not running (already ended, or unknown)' });
    return;
  }
  res.json({ job: view(job, new Map(listAgents().map((a) => [a.id, a.name]))) });
}));
