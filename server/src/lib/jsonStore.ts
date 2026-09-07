import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';

export type StoredRecord = { id: string; createdAt?: string; updatedAt?: string };

export class JsonStore<T extends StoredRecord> {
  private readonly path: string;
  private readonly directory: string;

  constructor(fileName: string, private readonly seed: T[], directory = STATE_DIR) {
    this.directory = directory;
    this.path = join(directory, fileName);
  }

  async list(): Promise<T[]> {
    return this.read();
  }

  async create(input: Omit<Partial<T>, 'id'> & { id?: string }): Promise<T> {
    const now = new Date().toISOString();
    const item = { id: input.id ?? randomUUID(), createdAt: now, updatedAt: now, ...input } as T;
    const items = await this.read();
    await this.write([item, ...items]);
    return item;
  }

  async update(id: string, patch: Partial<T>): Promise<T | null> {
    const items = await this.read();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const next = { ...items[index], ...patch, id, updatedAt: new Date().toISOString() } as T;
    items[index] = next;
    await this.write(items);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const items = await this.read();
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) return false;
    await this.write(next);
    return true;
  }

  async replace(items: T[]): Promise<T[]> {
    await this.write(items);
    return items;
  }

  private async read(): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.write(this.seed);
      return [...this.seed];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in ${this.path}; refusing to overwrite stored data`, { cause: error });
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid JSON array in ${this.path}; refusing to overwrite stored data`);
    }
    return parsed as T[];
  }

  private async write(items: T[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    let handleOpen = true;
    try {
      await handle.writeFile(`${JSON.stringify(items, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handleOpen = false;
      await rename(temporaryPath, this.path);
      // Best effort directory fsync makes the rename durable on POSIX. Some
      // platforms do not permit opening directories, so the atomic rename is
      // still the fallback guarantee there.
      let directory: Awaited<ReturnType<typeof open>> | null = null;
      try {
        directory = await open(this.directory, 'r');
        await directory.sync();
      } catch { /* platform does not expose directory fsync */ }
      finally { await directory?.close().catch(() => {}); }
    } catch (error) {
      if (handleOpen) await handle.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
