import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assistantAdminJson } from './assistantAdmin.ts';
import { ELROND_WORKSPACE_PATH } from '../config.ts';

export type RivendellTask = {
  id: string;
  title: string;
  project: string;
  status: 'in_hand' | 'in_progress' | 'horizon' | 'delegated' | 'done';
  due: string;
  dueDate?: string | null;
  priority: 'low' | 'medium' | 'high';
  repo?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
};

export type RivendellEmail = {
  id: string;
  from: string;
  subject: string;
  account: string;
  age: string;
  unread: boolean;
  status: 'needs_reply' | 'drafted' | 'filed' | 'watching';
  draftBody?: string;
  updatedAt?: string;
};

export type RivendellFamilyItem = {
  id: string;
  title: string;
  area: 'todo' | 'bill' | 'debt' | 'budget' | 'meal';
  owner: string;
  due: string;
  amount?: string;
  completed?: boolean;
  updatedAt?: string;
};

export type CronRuntime = 'railway' | 'local';
export type CronAiModel = 'claude' | 'codex' | 'mandrill';
export type CronPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'plan';

export type RivendellCronJob = {
  id: string;
  name: string;
  description?: string;
  schedule: string;
  target: string;
  actionType?: string;
  prompt?: string;
  aiModel?: CronAiModel;
  /** Full companion engine id (assistant/claude/codex/banana/banana-fireworks/banana-local/zai/xai). */
  engine?: string;
  /** Specific model id for the engine (glm-5.3, claude-opus-4-8, gpt-5.5, an OpenRouter/LM Studio id). */
  modelId?: string;
  /** Model-specific Codex effort stored in action_config.reasoning_effort. */
  reasoningEffort?: string;
  serviceTier?: string;
  repo?: string;
  toolName?: string;
  deliveryChannel?: string;
  maxTokens?: number;
  status: 'active' | 'paused' | 'failed';
  /** True when the schedule is disabled, independent of the last run's pass/fail status. */
  paused?: boolean;
  runtime: CronRuntime;
  cwd?: string;
  permissionMode?: CronPermissionMode;
  source?: 'assistant-mcp' | 'autosam' | 'observed';
  sourceLabel?: string;
  readOnly?: boolean;
  lastRun: string;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  lastRunError?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type RivendellQueueJob = {
  id: string;
  created_at: string;
  status: 'queued' | 'running' | 'needs_review' | 'done' | 'failed' | 'cancelled';
  skill: string;
  source?: string;
  source_ref?: string;
  repo?: string;
  prompt?: string;
  result?: unknown;
  error?: string;
  needs_review_reason?: string;
  completed_at?: string;
};

type AdminTask = {
  id: string;
  project?: string | null;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  due_date?: string | null;
  file_path?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
};

type AdminEmail = {
  id: string;
  threadId?: string;
  account?: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  labelIds?: string[];
  isUnread?: boolean;
};

type AdminCron = {
  id: string;
  name?: string | null;
  description?: string | null;
  cron_expression?: string | null;
  action_type?: string | null;
  action_config?: Record<string, unknown> | null;
  enabled?: boolean | null;
  runtime?: string | null;
  last_run_at?: string | null;
  last_run_status?: string | null;
  last_run_error?: string | null;
  delivery_channel?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

const DEFAULT_NO_REPO_CWD = ELROND_WORKSPACE_PATH;
const OBSERVED_JOBS_FILE = process.env.RIVENDELL_OBSERVED_JOBS_FILE?.trim() || '';

type SamQueueTask = {
  id: string;
  title?: string | null;
  project?: string | null;
  status?: string | null;
  priority?: string | null;
  pr_url?: string | null;
  failure_reason?: string | null;
  auto_merge_blocked_reason?: string | null;
  origin_system?: string | null;
  origin_url?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export async function fetchAdminTasks(): Promise<RivendellTask[]> {
  const data = await assistantAdminJson<{ tasks?: AdminTask[] }>('/admin/api/tasks');
  return (data.tasks ?? []).map(mapTask).sort(sortTasks);
}

export async function createAdminTask(input: {
  title?: string;
  project?: string;
  due?: string;
  priority?: string;
  status?: RivendellTask['status'];
}): Promise<RivendellTask> {
  const payload = {
    title: input.title || 'New task',
    project: input.project || 'Personal',
    due_date: normalizeDueDate(input.due),
    priority: normalizePriority(input.priority),
  };
  const created = await assistantAdminJson<{ task: AdminTask }>('/admin/api/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (input.status && input.status !== 'horizon') {
    return updateAdminTask(created.task.id, { status: input.status });
  }
  return mapTask(created.task);
}

export async function updateAdminTask(
  id: string,
  updates: Partial<RivendellTask>,
): Promise<RivendellTask> {
  const payload: Record<string, unknown> = {};
  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.project !== undefined) payload.project = updates.project;
  if (updates.priority !== undefined) payload.priority = normalizePriority(updates.priority);
  if (updates.due !== undefined) payload.due_date = normalizeDueDate(updates.due);
  if (updates.status !== undefined) payload.status = toAdminTaskStatus(updates.status);

  const data = await assistantAdminJson<{ task: AdminTask }>(`/admin/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return mapTask(data.task);
}

export async function deleteAdminTask(id: string): Promise<void> {
  await assistantAdminJson(`/admin/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function fetchAdminEmails(): Promise<RivendellEmail[]> {
  const params = new URLSearchParams({
    maxResults: '50',
    query: 'in:inbox',
  });
  const data = await assistantAdminJson<{ messages?: AdminEmail[] }>(`/admin/api/email/messages?${params}`);
  return (data.messages ?? []).map(mapEmail);
}

export async function fetchAdminFamily(): Promise<RivendellFamilyItem[]> {
  const [todos, bills, debts, budget, meals] = await Promise.allSettled([
    assistantAdminJson<{ todos?: any[] }>('/admin/api/family/todos'),
    assistantAdminJson<{ bills?: any[] }>('/admin/api/family/bills'),
    assistantAdminJson<{ debts?: any[] }>('/admin/api/family/debts'),
    assistantAdminJson<{ budget?: any }>('/admin/api/family/budget'),
    assistantAdminJson<{ meals?: any[] }>('/admin/api/family/meals'),
  ]);

  const items: RivendellFamilyItem[] = [];
  if (todos.status === 'fulfilled') {
    items.push(...(todos.value.todos ?? []).map((todo) => ({
      id: `todo:${todo.id}`,
      title: todo.title || 'Family task',
      area: 'todo' as const,
      owner: todo.assignee || 'Family',
      due: todo.due_date ? dueLabel(todo.due_date) : todo.recurring_day || 'open',
      completed: Boolean(todo.completed),
      updatedAt: todo.updated_at || todo.created_at,
    })));
  }
  if (bills.status === 'fulfilled') {
    items.push(...(bills.value.bills ?? []).map((bill) => ({
      id: `bill:${bill.id}`,
      title: bill.name || 'Bill',
      area: 'bill' as const,
      owner: bill.category || 'Home',
      due: bill.period || 'recurring',
      amount: money(bill.amount),
      updatedAt: bill.updated_at || bill.created_at,
    })));
  }
  if (debts.status === 'fulfilled') {
    items.push(...(debts.value.debts ?? []).map((debt) => ({
      id: `debt:${debt.id}`,
      title: debt.account_name || 'Debt',
      area: 'debt' as const,
      owner: debt.who || 'Family',
      due: debt.status || `priority ${debt.priority ?? ''}`.trim(),
      amount: money(debt.balance),
      updatedAt: debt.updated_at || debt.created_at,
    })));
  }
  if (budget.status === 'fulfilled' && budget.value.budget) {
    const row = budget.value.budget;
    items.push({
      id: `budget:${row.id || row.month || 'current'}`,
      title: `Budget ${row.month || 'current month'}`,
      area: 'budget',
      owner: 'Family',
      due: row.month || 'current',
      amount: money(row.surplus),
      updatedAt: row.updated_at || row.created_at,
    });
  }
  if (meals.status === 'fulfilled') {
    items.push(...(meals.value.meals ?? []).slice(0, 12).map((meal) => ({
      id: `meal:${meal.id}`,
      title: meal.name || 'Meal',
      area: 'meal' as const,
      owner: meal.meal_type || 'Meal',
      due: meal.day_of_week || meal.week_start || 'planned',
      updatedAt: meal.updated_at || meal.created_at,
    })));
  }

  return items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function updateAdminFamilyItem(id: string, body: Record<string, unknown>): Promise<RivendellFamilyItem> {
  const [kind, rawId] = splitTypedId(id);
  if (kind !== 'todo') throw new Error(`${kind} items are read-only in this room for now`);
  const data = await assistantAdminJson<{ todo: any }>(`/admin/api/family/todos/${encodeURIComponent(rawId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return {
    id: `todo:${data.todo.id}`,
    title: data.todo.title || 'Family task',
    area: 'todo',
    owner: data.todo.assignee || 'Family',
    due: data.todo.due_date ? dueLabel(data.todo.due_date) : data.todo.recurring_day || 'open',
    completed: Boolean(data.todo.completed),
    updatedAt: data.todo.updated_at || data.todo.created_at,
  };
}

export async function createAdminFamilyTodo(input: Record<string, unknown>): Promise<RivendellFamilyItem> {
  const data = await assistantAdminJson<{ todo: any }>('/admin/api/family/todos', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return {
    id: `todo:${data.todo.id}`,
    title: data.todo.title || 'Family task',
    area: 'todo',
    owner: data.todo.assignee || 'Family',
    due: data.todo.due_date ? dueLabel(data.todo.due_date) : data.todo.recurring_day || 'open',
    completed: Boolean(data.todo.completed),
    updatedAt: data.todo.updated_at || data.todo.created_at,
  };
}

export async function fetchAdminCronJobs(): Promise<RivendellCronJob[]> {
  const observed = readObservedCronJobs();
  try {
    const data = await assistantAdminJson<{ jobs?: AdminCron[] }>('/admin/api/cron/jobs');
    return [...observed, ...(data.jobs ?? []).map(mapCron)];
  } catch (error) {
    // A local observed scheduler is useful even when no optional admin backend
    // is configured. Preserve upstream errors only when there is no local data.
    if (observed.length > 0) return observed;
    throw error;
  }
}

export async function updateAdminCronJob(id: string, updates: Partial<RivendellCronJob>): Promise<RivendellCronJob> {
  const payload: Record<string, unknown> = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.schedule !== undefined) payload.cron_expression = updates.schedule;
  if (updates.actionType !== undefined) payload.action_type = updates.actionType;
  if (updates.deliveryChannel !== undefined) payload.delivery_channel = updates.deliveryChannel;
  if (updates.status !== undefined) payload.enabled = updates.status === 'active';
  if (updates.runtime !== undefined) payload.runtime = updates.runtime;
  const actionConfig = actionConfigFromCron(updates);
  if (actionConfig) payload.action_config = actionConfig;

  const data = await assistantAdminJson<{ job: AdminCron }>(`/admin/api/cron/jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return mapCron(data.job);
}

export async function createAdminCronJob(input: Partial<RivendellCronJob>): Promise<RivendellCronJob> {
  const data = await assistantAdminJson<{ job: AdminCron }>('/admin/api/cron/jobs', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name || 'TARDIS schedule',
      description: input.description || '',
      cron_expression: input.schedule || '0 9 * * *',
      action_type: input.actionType || 'ai_prompt',
      action_config: actionConfigFromCron(input) || { prompt: 'TARDIS scheduled task', max_tokens: 1024 },
      delivery_channel: input.deliveryChannel || 'log_only',
      enabled: input.status !== 'paused',
      runtime: input.runtime || 'railway',
    }),
  });
  return mapCron(data.job);
}

export async function deleteAdminCronJob(id: string): Promise<void> {
  await assistantAdminJson(`/admin/api/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function runAdminCronJob(id: string): Promise<unknown> {
  return assistantAdminJson(`/admin/api/cron/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' });
}

export type RivendellCronRun = {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  result: unknown;
  error: string | null;
};

type AdminCronExecution = {
  id?: string;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  result?: unknown;
  error_message?: string | null;
};

/**
 * Execution history for a cron job. The upstream stores every run in
 * `scheduled_jobs`; we project it to the clean shape the Forge renders.
 */
export async function fetchAdminCronHistory(id: string, limit = 15): Promise<RivendellCronRun[]> {
  const data = await assistantAdminJson<{ executions?: AdminCronExecution[] }>(
    `/admin/api/cron/jobs/${encodeURIComponent(id)}/history?limit=${limit}`,
  );
  return (data.executions ?? []).map(mapCronRun);
}

function mapCronRun(e: AdminCronExecution): RivendellCronRun {
  const startedAt = e.started_at ? new Date(e.started_at).getTime() : null;
  const completedAt = e.completed_at ? new Date(e.completed_at).getTime() : null;
  return {
    id: e.id || `${e.started_at || ''}-${e.status || ''}`,
    status: e.status || 'unknown',
    startedAt: e.started_at || null,
    completedAt: e.completed_at || null,
    durationMs: startedAt && completedAt ? Math.max(0, completedAt - startedAt) : null,
    result: e.result,
    error: e.error_message || null,
  };
}

export async function fetchAdminCalendarEvents(): Promise<unknown> {
  return assistantAdminJson('/admin/api/calendar/events');
}

export async function fetchAdminDocs(): Promise<unknown[]> {
  const data = await assistantAdminJson<{ docs?: unknown[] }>('/admin/api/docs');
  return data.docs ?? [];
}

export async function fetchAdminQueueJobs(): Promise<RivendellQueueJob[]> {
  const data = await assistantAdminJson<{
    ready_to_merge?: SamQueueTask[];
    deploy_failed?: SamQueueTask[];
    failed_early?: SamQueueTask[];
    other?: SamQueueTask[];
  }>('/admin/api/sam-queue');

  return [
    ...(data.ready_to_merge ?? []).map((task) => mapSamQueue(task, 'needs_review', 'ready-to-merge')),
    ...(data.deploy_failed ?? []).map((task) => mapSamQueue(task, 'failed', 'deploy-failed')),
    ...(data.failed_early ?? []).map((task) => mapSamQueue(task, 'failed', 'failed-early')),
    ...(data.other ?? []).map((task) => mapSamQueue(task, mapQueueStatus(task.status), 'samwise')),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

function mapTask(task: AdminTask): RivendellTask {
  return {
    id: task.id,
    title: task.title || 'Untitled task',
    project: task.project || 'Personal',
    status: fromAdminTaskStatus(task.status),
    due: dueLabel(task.due_date),
    dueDate: task.due_date ? task.due_date.slice(0, 10) : null,
    priority: fromAdminPriority(task.priority),
    repo: task.file_path || undefined,
    createdAt: task.created_at || undefined,
    updatedAt: task.updated_at || undefined,
    completedAt: task.completed_at || null,
  };
}

function fromAdminTaskStatus(status?: string | null): RivendellTask['status'] {
  if (status === 'completed' || status === 'cancelled' || status === 'done') return 'done';
  if (status === 'blocked') return 'delegated';
  if (status === 'in_progress') return 'in_progress';
  // "pending" = owned/ready (In Hand). "not_started" = backlog (Horizon).
  if (status === 'pending' || status === 'in_hand') return 'in_hand';
  if (status === 'not_started' || status === 'horizon') return 'horizon';
  return 'horizon';
}

function toAdminTaskStatus(status: RivendellTask['status']): string {
  if (status === 'done') return 'completed';
  if (status === 'delegated') return 'blocked';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'in_hand') return 'pending';
  // horizon
  return 'not_started';
}

function fromAdminPriority(priority?: string | null): RivendellTask['priority'] {
  if (priority === 'urgent' || priority === 'high') return 'high';
  if (priority === 'low') return 'low';
  return 'medium';
}

function normalizePriority(priority?: string): 'low' | 'medium' | 'high' | 'urgent' {
  if (priority === 'high') return 'high';
  if (priority === 'low') return 'low';
  return 'medium';
}

function sortTasks(a: RivendellTask, b: RivendellTask): number {
  const order = ['horizon', 'in_hand', 'in_progress', 'delegated', 'done'];
  const statusDelta = order.indexOf(a.status) - order.indexOf(b.status);
  if (statusDelta) return statusDelta;
  return dueRank(a.due) - dueRank(b.due);
}

function mapEmail(email: AdminEmail): RivendellEmail {
  const unread = Boolean(email.isUnread);
  return {
    id: email.id || email.threadId || `${email.account}:${email.subject}`,
    from: fromName(email.from || ''),
    subject: email.subject || '(no subject)',
    account: email.account || 'mail',
    age: email.date ? timeAgo(email.date) : 'unknown',
    unread,
    status: email.labelIds?.includes('DRAFT') ? 'drafted' : unread ? 'needs_reply' : 'filed',
    updatedAt: email.date,
  };
}

function mapCron(job: AdminCron): RivendellCronJob {
  const actionType = job.action_type || 'ai_prompt';
  const prompt = typeof job.action_config?.prompt === 'string' ? job.action_config.prompt : undefined;
  const aiModel = normalizeCronModel(job.action_config?.model, job.runtime);
  const engine = typeof job.action_config?.engine === 'string' ? job.action_config.engine : undefined;
  const modelId = typeof job.action_config?.model_id === 'string' ? job.action_config.model_id : undefined;
  const reasoningEffort = typeof job.action_config?.reasoning_effort === 'string'
    ? job.action_config.reasoning_effort
    : undefined;
  const repo = normalizeOptionalString(job.action_config?.repo);
  const toolName = typeof job.action_config?.tool_name === 'string' ? job.action_config.tool_name : undefined;
  const maxTokens = typeof job.action_config?.max_tokens === 'number' ? job.action_config.max_tokens : undefined;
  const cwd = normalizeOptionalString(job.action_config?.cwd);
  const permissionMode = typeof job.action_config?.permission_mode === 'string'
    ? (job.action_config.permission_mode as CronPermissionMode)
    : undefined;
  const runtime: CronRuntime = job.runtime === 'local' ? 'local' : 'railway';
  const toolTarget =
    toolName || (actionType === 'ai_prompt' && prompt ? 'AI prompt' : actionType || 'scheduled job');
  return {
    id: job.id,
    name: job.name || 'Scheduled job',
    description: job.description || undefined,
    schedule: job.cron_expression || 'manual',
    target: toolTarget,
    actionType,
    prompt,
    aiModel,
    engine,
    modelId,
    reasoningEffort,
    serviceTier: typeof job.action_config?.service_tier === 'string' ? job.action_config.service_tier : undefined,
    repo,
    toolName,
    deliveryChannel: job.delivery_channel || undefined,
    maxTokens,
    paused: job.enabled === false,
    status: job.enabled === false ? 'paused' : job.last_run_status === 'failed' ? 'failed' : 'active',
    runtime,
    cwd,
    permissionMode,
    source: 'assistant-mcp',
    sourceLabel: 'Forge',
    lastRun: job.last_run_at ? timeAgo(job.last_run_at) : 'never',
    lastRunAt: job.last_run_at || null,
    lastRunStatus: job.last_run_status || null,
    lastRunError: job.last_run_error || null,
    createdAt: job.created_at || undefined,
    updatedAt: job.updated_at || undefined,
  };
}

function observedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeObservedCronJob(value: unknown): RivendellCronJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = observedString(record, 'id');
  const name = observedString(record, 'name');
  const schedule = observedString(record, 'schedule');
  if (!id || !name || !schedule) return null;
  const isPaused = record.paused === true || record.status === 'paused';
  const status: RivendellCronJob['status'] = isPaused
    ? 'paused'
    : record.status === 'failed' ? 'failed' : 'active';
  const runtime: CronRuntime = record.runtime === 'railway' ? 'railway' : 'local';
  const aiModel = record.aiModel === 'claude' || record.aiModel === 'codex' || record.aiModel === 'mandrill'
    ? record.aiModel
    : undefined;
  const permissionMode = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan']
    .includes(String(record.permissionMode))
    ? record.permissionMode as CronPermissionMode
    : undefined;
  return {
    id,
    name,
    schedule,
    target: observedString(record, 'target') || name,
    description: observedString(record, 'description'),
    actionType: observedString(record, 'actionType'),
    prompt: observedString(record, 'prompt'),
    aiModel,
    engine: observedString(record, 'engine'),
    modelId: observedString(record, 'modelId'),
    reasoningEffort: observedString(record, 'reasoningEffort'),
    serviceTier: observedString(record, 'serviceTier'),
    repo: observedString(record, 'repo'),
    toolName: observedString(record, 'toolName'),
    deliveryChannel: observedString(record, 'deliveryChannel'),
    maxTokens: typeof record.maxTokens === 'number' && Number.isFinite(record.maxTokens) ? record.maxTokens : undefined,
    status,
    paused: isPaused,
    runtime,
    cwd: observedString(record, 'cwd'),
    permissionMode,
    source: 'observed',
    sourceLabel: observedString(record, 'sourceLabel') || 'Observed',
    readOnly: true,
    lastRun: observedString(record, 'lastRun') || 'observed externally',
    lastRunAt: observedString(record, 'lastRunAt') || null,
    lastRunStatus: observedString(record, 'lastRunStatus') || null,
    lastRunError: observedString(record, 'lastRunError') || null,
    createdAt: observedString(record, 'createdAt'),
    updatedAt: observedString(record, 'updatedAt'),
  };
}

function readObservedCronJobs(): RivendellCronJob[] {
  if (!OBSERVED_JOBS_FILE || !isAbsolute(OBSERVED_JOBS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(OBSERVED_JOBS_FILE, 'utf8')) as { jobs?: unknown };
    if (!Array.isArray(parsed.jobs)) return [];
    return parsed.jobs.map(normalizeObservedCronJob).filter((job): job is RivendellCronJob => job !== null);
  } catch (error) {
    console.warn(`[assistantData] could not read observed jobs file: ${(error as Error).message}`);
    return [];
  }
}

function actionConfigFromCron(input: Partial<RivendellCronJob>): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  if (input.prompt !== undefined) config.prompt = input.prompt;
  if (input.aiModel !== undefined) config.model = input.aiModel;
  // Full engine + specific model — what the local cron runner dispatches on.
  if (input.engine !== undefined) config.engine = input.engine;
  if (input.modelId !== undefined) config.model_id = input.modelId;
  if (input.reasoningEffort !== undefined) config.reasoning_effort = input.reasoningEffort;
  if (input.serviceTier !== undefined) config.service_tier = input.serviceTier;
  const repo = normalizeOptionalString(input.repo);
  const cwd = normalizeOptionalString(input.cwd);
  if (repo !== undefined) config.repo = repo;
  if (input.toolName !== undefined) config.tool_name = input.toolName;
  if (input.maxTokens !== undefined) config.max_tokens = Number(input.maxTokens) || 1024;
  // Local-runtime ai_prompt jobs need cwd (where claude -p runs) and an
  // optional permission_mode. Stored inside action_config because that's
  // where the cron engine reads them.
  if (cwd !== undefined) config.cwd = cwd;
  if (cwd === undefined && repo !== undefined) config.cwd = repo;
  if (cwd === undefined && repo === undefined && input.runtime === 'local' && input.actionType === 'ai_prompt') {
    config.cwd = DEFAULT_NO_REPO_CWD;
  }
  if (input.permissionMode !== undefined) config.permission_mode = input.permissionMode;
  return Object.keys(config).length ? config : null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeCronModel(value: unknown, runtime?: string | null): CronAiModel {
  if (value === 'claude' || value === 'codex' || value === 'mandrill') return value;
  if (typeof value === 'string' && value.toLowerCase() === 'codes') return 'codex';
  if (runtime === 'local') return 'claude';
  return 'mandrill';
}

function mapSamQueue(task: SamQueueTask, status: RivendellQueueJob['status'], skill: string): RivendellQueueJob {
  return {
    id: `sam:${task.id}`,
    created_at: task.updated_at || task.created_at || new Date().toISOString(),
    status,
    skill,
    source: task.origin_system || 'samwise',
    source_ref: task.pr_url || task.origin_url || task.id,
    repo: task.project || undefined,
    prompt: task.title || 'Samwise task',
    error: task.failure_reason || undefined,
    needs_review_reason: task.auto_merge_blocked_reason || (status === 'needs_review' ? 'Ready for review.' : undefined),
  };
}

function mapQueueStatus(status?: string | null): RivendellQueueJob['status'] {
  if (status === 'running' || status === 'in_progress') return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'done' || status === 'completed') return 'done';
  if (status === 'cancelled' || status === 'archived') return 'cancelled';
  return 'queued';
}

function splitTypedId(id: string): [string, string] {
  const index = id.indexOf(':');
  if (index === -1) return ['todo', id];
  return [id.slice(0, index), id.slice(index + 1)];
}

function normalizeDueDate(value?: string): string {
  const raw = (value || '').trim().toLowerCase();
  const today = startOfToday();
  if (!raw || raw === 'today' || raw === 'overdue') return isoDay(today);
  if (raw === 'tomorrow') return isoDay(addDays(today, 1));
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return isoDay(today);
}

function dueLabel(value?: string | null): string {
  if (!value) return 'unscheduled';
  const day = parseDay(value);
  if (!day) return value;
  const diff = Math.round((day.getTime() - startOfToday().getTime()) / 86_400_000);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff < 7) return new Intl.DateTimeFormat([], { weekday: 'long' }).format(day);
  return new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(day);
}

function dueRank(label: string): number {
  if (label === 'overdue') return -1;
  if (label === 'today') return 0;
  if (label === 'tomorrow') return 1;
  return 10;
}

function parseDay(value: string): Date | null {
  const match = value.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

function startOfToday(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fromName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*<?/);
  return match ? match[1].trim().replace(/"/g, '') : from.split('@')[0] || 'Unknown';
}

function timeAgo(value: string): string {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return value;
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(new Date(ts));
}

function money(value: unknown): string | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);
}
