import { JsonStore, type StoredRecord } from '../lib/jsonStore.ts';

type ThreadResetRecord = StoredRecord & {
  resetAt: number;
  taskId?: string;
  taskState?: 'resetting' | 'complete';
  taskResetAt?: number;
};

export type ThreadResetTaskState = {
  taskId: string;
  state: 'resetting' | 'complete';
  resetAt: number;
};

const store = new JsonStore<ThreadResetRecord>('thread-resets.json', []);
let writeQueue: Promise<void> = Promise.resolve();
const memoryEpochs = new Map<string, number>();
const memoryTaskResets = new Map<string, ThreadResetTaskState>();
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

export function threadResetTaskState(logKey: string): ThreadResetTaskState | undefined {
  return memoryTaskResets.get(logKey);
}

export function noteThreadResetTaskState(logKey: string, state: ThreadResetTaskState): ThreadResetTaskState {
  memoryTaskResets.set(logKey, state);
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
    if (typeof record.taskId === 'string' && record.taskId
      && (record.taskState === 'resetting' || record.taskState === 'complete')
      && Number.isFinite(record.taskResetAt) && (record.taskResetAt ?? 0) > 0) {
      memoryTaskResets.set(record.id, {
        taskId: record.taskId,
        state: record.taskState,
        resetAt: record.taskResetAt as number,
      });
    }
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
 *  earlier task's completed reset. */
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
    const next: ThreadResetRecord = {
      ...(existing ?? {}),
      id: logKey,
      resetAt: existing?.resetAt ?? 0,
      taskId,
      taskState: state,
      taskResetAt: resetAt,
      updatedAt: new Date(resetAt).toISOString(),
    };
    if (index >= 0) records[index] = next;
    else records.push(next);
    await store.replace(records);
    committed = noteThreadResetTaskState(logKey, { taskId, state, resetAt });
  };
  writeQueue = writeQueue.then(write, write);
  await writeQueue;
  return committed;
}
