/**
 * Secrets and loopback ports that stay the same across a server restart.
 *
 * Engines now outlive the server (lib/laneHost.ts). An engine carries what the
 * server gave it at spawn: the team MCP's lane token, the headless and computer
 * MCP tokens, the xAI proxy credential, and the loopback URL of the proxy its
 * API calls go through. Minted fresh per process, every one of those went stale
 * the moment a new server started, and a surviving engine could no longer reach
 * its provider or its tools. They are kept per installation (STATE_DIR) instead.
 *
 * Synchronous on purpose: the secrets are module-level constants, read at import.
 * The file is the same trust boundary as the processes that hold the values
 * (this OS user), mode 0600.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { dirname, join } from 'node:path';
import { STATE_DIR } from '../config.ts';

type ContinuityFile = { version: 1; secrets: Record<string, string>; ports: Record<string, number> };

const file = () => join(STATE_DIR, 'runtime-continuity.json');

function load(): ContinuityFile {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<ContinuityFile>;
    if (parsed.version === 1) return { version: 1, secrets: { ...parsed.secrets }, ports: { ...parsed.ports } };
  } catch { /* first run, or unreadable: start fresh */ }
  return { version: 1, secrets: {}, ports: {} };
}

function save(state: ContinuityFile): void {
  try {
    mkdirSync(dirname(file()), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tmp, file());
  } catch (error) {
    // Still works for this process; engines just will not survive the next restart.
    console.warn(`[continuity] could not save ${file()}: ${(error as Error).message}`);
  }
}

/** A secret that stays the same for this installation. */
export function stableSecret(name: string, bytes = 32): Buffer {
  const state = load();
  const saved = state.secrets[name];
  if (typeof saved === 'string' && /^[0-9a-f]+$/.test(saved) && saved.length === bytes * 2) return Buffer.from(saved, 'hex');
  const value = randomBytes(bytes);
  state.secrets[name] = value.toString('hex');
  save(state);
  return value;
}

/** Listen on 127.0.0.1 at the port this listener used last time, so engines
 *  that outlived the last server still reach it. Takes any free port when that
 *  one is busy (and remembers the new one). */
export async function listenOnStablePort(server: Server, name: string, host = '127.0.0.1'): Promise<number> {
  const saved = load().ports[name];
  const attempt = (port: number) => new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  let port: number;
  try {
    port = await attempt(Number.isInteger(saved) && saved > 0 ? saved : 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !saved) throw error;
    console.warn(`[continuity] ${name} port ${saved} is taken; engines started before this restart cannot reach ${name}`);
    port = await attempt(0);
  }
  if (port !== saved) {
    const state = load();
    state.ports[name] = port;
    save(state);
  }
  return port;
}
