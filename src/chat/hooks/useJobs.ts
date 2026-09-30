// Background jobs (job_start): the per-chat list, the all-agents summary the
// left rail badge reads, and the Stop action. Server side: server/src/routes/jobs.ts.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from '../../data/api';

export type JobState = 'running' | 'finished' | 'failed' | 'stopped' | 'timed-out' | 'lost';

export type JobView = {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  state: JobState;
  command: string;
  /** Server epoch ms. */
  startedAt: number;
  endedAt: number | null;
  /** Wall time as of the poll: start to now while running, start to end after. */
  elapsedMs: number;
  exitCode: number | null;
  stoppedBy: 'user' | 'agent' | 'timeout' | null;
  timeoutMin: number;
  lastLine: string;
};

/** How long an ended job stays in the chat's list. */
export const RECENT_JOB_MS = 4 * 60_000;
const CHAT_POLL_MS = 4_000;
const SUMMARY_POLL_MS = 5_000;

const enc = encodeURIComponent;

/** Agent home threads are `bot-<agentId>`; anything else has no jobs. */
export function agentIdFromChatId(chatId: string | undefined): string | undefined {
  return chatId && chatId.startsWith('bot-') && chatId.length > 4 ? chatId.slice(4) : undefined;
}

const jobsKey = (agentId: string) => ['jobs', 'agent', agentId] as const;
const SUMMARY_KEY = ['jobs', 'summary'] as const;

type JobsResponse = { jobs: JobView[] };

/** Polling shared by both hooks. TanStack pauses interval refetches while the
 *  tab is hidden, and `refetchOnWindowFocus: 'always'` catches up on return. */
const POLL = { refetchIntervalInBackground: false, refetchOnWindowFocus: 'always', staleTime: 1_000, retry: false } as const;

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch { /* not JSON */ }
  return text || `${response.status} ${response.statusText}`;
}

export type StopResult = { ok: true } | { ok: false; error: string };

export function useJobs(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: jobsKey(agentId ?? ''),
    queryFn: ({ signal }) => apiJson<JobsResponse>(`/api/jobs?agentId=${enc(agentId ?? '')}`, { signal, cache: 'no-store' }),
    enabled: Boolean(agentId),
    refetchInterval: CHAT_POLL_MS,
    ...POLL,
  });
  const jobs = query.data?.jobs;
  const fetchedAt = query.dataUpdatedAt;

  // Ended jobs age out of the list without a new poll: a slow tick re-derives
  // them, and only while one is still inside the window.
  const [now, setNow] = useState(() => Date.now());
  const hasEnded = Boolean(jobs?.some((job) => job.state !== 'running'));
  useEffect(() => { setNow(Date.now()); }, [fetchedAt]);
  useEffect(() => {
    if (!hasEnded) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [hasEnded]);

  const running = useMemo(
    () => (jobs ?? []).filter((job) => job.state === 'running').sort((a, b) => b.startedAt - a.startedAt),
    [jobs],
  );
  const recent = useMemo(
    () => (jobs ?? [])
      .filter((job) => job.state !== 'running' && job.endedAt !== null && now - job.endedAt < RECENT_JOB_MS)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
    [jobs, now],
  );

  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const stopJob = useCallback(async (id: string): Promise<StopResult> => {
    if (!agentId) return { ok: false, error: 'no agent' };
    setStopping((prev) => new Set(prev).add(id));
    try {
      const response = await fetch(`/api/jobs/${enc(id)}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: 'user' }),
      });
      // 409 means it already ended on its own: the refetch below shows how.
      if (!response.ok && response.status !== 409) return { ok: false, error: await readError(response) };
      if (response.ok) {
        const { job } = await response.json() as { job?: JobView };
        if (job) {
          queryClient.setQueryData<JobsResponse>(jobsKey(agentId), (old) => (
            old ? { jobs: old.jobs.map((item) => (item.id === job.id ? job : item)) } : old
          ));
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message || 'could not reach the server' };
    } finally {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    }
  }, [agentId, queryClient]);

  return { jobs: jobs ?? [], running, recent, fetchedAt, stopping, stopJob };
}

/** Tail of one job's output. Polls only while the row is open and the job runs. */
export function useJobLog(jobId: string, enabled: boolean, live: boolean, lines = 60) {
  return useQuery({
    queryKey: ['jobs', 'log', jobId, lines],
    queryFn: ({ signal }) => apiJson<{ id: string; tail: string }>(`/api/jobs/${enc(jobId)}/log?lines=${lines}`, { signal, cache: 'no-store' }),
    enabled,
    refetchInterval: live ? CHAT_POLL_MS : false,
    ...POLL,
  });
}

export type JobsSummaryEntry = {
  running: number;
  /** Name of the newest running job. */
  latest: string;
  /** Its last output line (may be empty). */
  latestLine: string;
};

const EMPTY_SUMMARY: Map<string, JobsSummaryEntry> = new Map();

/** One request for every agent's running jobs (the rail badge). Polls every 5s
 *  while the tab is visible. Agents with nothing running are not in the map. */
export function useJobsSummary(enabled = true): Map<string, JobsSummaryEntry> {
  const query = useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: ({ signal }) => apiJson<JobsResponse>('/api/jobs?active=1', { signal, cache: 'no-store' }),
    enabled,
    refetchInterval: SUMMARY_POLL_MS,
    ...POLL,
  });
  const jobs = query.data?.jobs;
  return useMemo(() => {
    if (!jobs?.length) return EMPTY_SUMMARY;
    const summary = new Map<string, JobsSummaryEntry>();
    // Newest first, so the first job seen per agent is its latest.
    for (const job of [...jobs].filter((item) => item.state === 'running').sort((a, b) => b.startedAt - a.startedAt)) {
      const entry = summary.get(job.agentId);
      if (entry) entry.running += 1;
      else summary.set(job.agentId, { running: 1, latest: job.name, latestLine: job.lastLine });
    }
    return summary;
  }, [jobs]);
}
