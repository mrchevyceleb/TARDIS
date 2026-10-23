import { JsonStore, type StoredRecord } from '../lib/jsonStore.ts';

type ThreadResetRecord = StoredRecord & {
  resetAt: number;
  taskId?: string;
  taskState?: 'resetting' | 'complete';
  taskResetAt?: number;
  /** Per-task reset outcomes for this thread, keyed by durable task id.
   *  One entry per wiped task, so a later task completing never makes an
   *  earlier completed task look owed again (Codex verify round 6). */
  taskResets?: Record<string, { state: 'resetting' | 'complete'; resetAt: number }>;
};

export type ThreadResetTaskState = {
  taskId: string;
  state: 'resetting' | 'complete';
  resetAt: number;
};

const store = new JsonStore<ThreadResetRecord>('thread-resets.json', []);
let writeQueue: Promise<void> = Promise.resolve();
const memoryEpochs = new Map<string, number>();
const memoryTaskResets = new Map<string, Map<string, ThreadResetTaskState>>();
const resetListeners = new Set<(logKey: string, resetAt: number) => void>();

/** In-memory reset epoch for this log key: durable writes update it before
 *  any destructive work, and a process restart relearns it from the store. */
export function threadResetEpoch(logKey: string): number {
  return memoryEpochs.get(logKey) ?? 0;
}

/** Adopt durable epochs loaded at boot (register.ts loads the store before
 *  admitting chat sockets; programmatic Fresh reads the same map). */
export function noteThreadResetEpochs(epochs: Map<string, number>): void {
  for (const [logKey, resetAt] of epochs) {
    memoryEpochs.set(logKey, Math.max(memoryEpochs.get(logKey) ?? 0, resetAt));
  }
}

export function threadResetTaskState(logKey: string, taskId: string): ThreadResetTaskState | undefined {
  return memoryTaskResets.get(logKey)?.get(taskId);
}

export function noteThreadResetTaskState(logKey: string, state: ThreadResetTaskState): ThreadResetTaskState {
  let perTask = memoryTaskResets.get(logKey);
  if (!perTask) { perTask = new Map(); memoryTaskResets.set(logKey, perTask); }
  perTask.set(state.taskId, state);
  return state;
}

export function noteThreadResetEpoch(logKey: string, resetAt: number): number {
  const next = Math.max(resetAt, memoryEpochs.get(logKey) ?? 0);
  memoryEpochs.set(logKey, next);
  for (const fn of resetListeners) {
    try { fn(logKey, next); } catch { /* a bad listener never blocks a reset */ }
  }
  return next;
}

/** Subscribe to committed reset epochs (the WS layer broadcasts freshStarted
 *  from here, so a non-UI Fresh reaches connected clients too). */
export function subscribeThreadResetEpochs(fn: (logKey: string, resetAt: number) => void): () => void {
  resetListeners.add(fn);
  return () => { resetListeners.delete(fn); };
}

/** Load durable Fresh generations before chat sockets begin admitting work. */
export async function loadThreadResetEpochs(): Promise<Map<string, number>> {
  const records = await store.list();
  const epochs = new Map<string, number>();
  for (const record of records) {
    if (typeof record.id !== 'string' || !record.id) continue;
    if (!Number.isFinite(record.resetAt) || record.resetAt <= 0) continue;
    epochs.set(record.id, Math.max(epochs.get(record.id) ?? 0, record.resetAt));
    const perTask = new Map<string, ThreadResetTaskState>();
    if (typeof record.taskId === 'string' && record.taskId
      && (record.taskState === 'resetting' || record.taskState === 'complete')
      && Number.isFinite(record.taskResetAt) && (record.taskResetAt ?? 0) > 0) {
      perTask.set(record.taskId, {
        taskId: record.taskId,
        state: record.taskState,
        resetAt: record.taskResetAt as number,
      });
    }
    if (record.taskResets && typeof record.taskResets === 'object') {
      for (const [taskId, entry] of Object.entries(record.taskResets)) {
        if ((entry?.state === 'resetting' || entry?.state === 'complete') && Number.isFinite(entry.resetAt) && entry.resetAt > 0) {
          perTask.set(taskId, { taskId, state: entry.state, resetAt: entry.resetAt });
        }
      }
    }
    if (perTask.size) memoryTaskResets.set(record.id, perTask);
  }
  return epochs;
}

/** Persist the reset generation before destructive Fresh work starts. Calls are
 * serialized so simultaneous resets on different threads cannot lose a row.
 * Resolves to the epoch actually committed (the max of the request, the
 * durable row and this process's memory), and publishes it to subscribers. */
export async function persistThreadResetEpoch(logKey: string, resetAt: number): Promise<number> {
  let committed = 0;
  const write = async () => {
    const records = await store.list();
    const nextResetAt = Math.max(
      resetAt,
      records.find((record) => record.id === logKey)?.resetAt ?? 0,
      memoryEpochs.get(logKey) ?? 0,
    );
    const index = records.findIndex((record) => record.id === logKey);
    const next: ThreadResetRecord = {
      ...(index >= 0 ? records[index] : {}),
      id: logKey,
      resetAt: nextResetAt,
      updatedAt: new Date(nextResetAt).toISOString(),
    };
    if (index >= 0) records[index] = next;
    else records.push(next);
    await store.replace(records);
    committed = noteThreadResetEpoch(logKey, nextResetAt);
  };
  writeQueue = writeQueue.then(write, write);
  await writeQueue;
  return committed || noteThreadResetEpoch(logKey, resetAt);
}

/** Persist one task's reset state before and after the destructive wipe.
 *  The state is keyed by the durable task id, never by agent or sender: a
 *  crash between the epoch commit and completion leaves `resetting` behind,
 *  so the queued task resumes its wipe after restart instead of delivering
 *  into a half-erased thread. A different task id is never suppressed by an
 *  earlier task's completed reset, and completing one task never rewrites
 *  another task's outcome: every task keeps its own entry in the per-task
 *  map (Codex verify round 6, Oct 23 2026: the single-slot form made an
 *  earlier completed task look owed again once a later task overwrote it). */
const TASK_RESET_KEEP = 32;
export async function persistThreadResetTaskState(
  logKey: string,
  taskId: string,
  resetAt: number,
  state: ThreadResetTaskState['state'],
): Promise<ThreadResetTaskState> {
  let committed: ThreadResetTaskState = { taskId, state, resetAt };
  const write = async () => {
    const records = await store.list();
    const index = records.findIndex((record) => record.id === logKey);
    const existing = index >= 0 ? records[index] : undefined;
    const taskResets: Record<string, { state: 'resetting' | 'complete'; resetAt: number }> = { ...(existing?.taskResets ?? {}) };
    // Seed the legacy single-slot entry so older builds' outcomes survive.
    if (!taskResets[taskId] && existing?.taskId && (existing.taskState === 'resetting' || existing.taskState === 'complete') && Number.isFinite(existing.taskResetAt) && (existing.taskResetAt ?? 0) > 0) {
      taskResets[existing.taskId] = { state: existing.taskState, resetAt: existing.taskResetAt as number };
    }
    taskResets[taskId] = { state, resetAt };
    // Bound the map: keep the newest outcomes (by reset time), never the
    // in-flight one just written.
    const ids = Object.keys(taskResets).sort((a, b) => (taskResets[a].resetAt - taskResets[b].resetAt));
    while (ids.length > TASK_RESET_KEEP) {
      const oldest = ids.shift()!;
      if (oldest !== taskId) delete taskResets[oldest];
    }
    const next: ThreadResetRecord = {
      ...(existing ?? {}),
      id: logKey,
      resetAt: existing?.resetAt ?? 0,
      taskResets,
      updatedAt: new Date(resetAt).toISOString(),
    };
    // The single-slot fields now merely mirror the latest task so older
    // builds reading this file keep working.
    next.taskId = taskId; next.taskState = state; next.taskResetAt = resetAt;
    if (index >= 0) records[index] = next;
    else records.push(next);
    await store.replace(records);
    committed = noteThreadResetTaskState(logKey, { taskId, state, resetAt });
  };
  writeQueue = writeQueue.then(write, write);
  await writeQueue;
  return committed;
}
