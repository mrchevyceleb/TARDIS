import { JsonStore, type StoredRecord } from '../lib/jsonStore.ts';

type ThreadResetRecord = StoredRecord & {
  resetAt: number;
};

const store = new JsonStore<ThreadResetRecord>('thread-resets.json', []);
let writeQueue: Promise<void> = Promise.resolve();
const memoryEpochs = new Map<string, number>();
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
    const next: ThreadResetRecord = {
      id: logKey,
      resetAt: nextResetAt,
      updatedAt: new Date(nextResetAt).toISOString(),
    };
    const index = records.findIndex((record) => record.id === logKey);
    if (index >= 0) records[index] = next;
    else records.push(next);
    await store.replace(records);
    committed = noteThreadResetEpoch(logKey, nextResetAt);
  };
  writeQueue = writeQueue.then(write, write);
  await writeQueue;
  return committed || noteThreadResetEpoch(logKey, resetAt);
}
