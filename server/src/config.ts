import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileProviderErrorMessage, isTransientFileProviderError } from './lib/fileProvider.ts';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute path to the team-bus MCP. `npm --workspace server` sets cwd to
 *  `server/`, so `join(process.cwd(), 'server/scripts/...')` resolves to a
 *  missing `server/server/scripts` path and every agent’s team_message dies. */
function resolveServerScript(envPath: string | undefined, filename: string): string {
  if (envPath) return envPath;
  const candidates = [
    join(APP_ROOT, 'server', 'scripts', filename),
    join(process.cwd(), 'scripts', filename),
    join(process.cwd(), 'server', 'scripts', filename),
  ];
  const resolved = candidates.find((p) => existsSync(p)) ?? candidates[0];
  if (!existsSync(resolved)) console.warn(`[config] server script missing at ${resolved}`);
  return resolved;
}

export const TEAM_MCP_SCRIPT = resolveServerScript(
  process.env.RIVENDELL_TEAM_MCP,
  'team-mcp.mjs',
);

/** Tools for the user's own computers, reached through the desktop app. */
export const DEVICE_MCP_SCRIPT = resolveServerScript(
  process.env.RIVENDELL_DEVICE_MCP,
  'device-mcp.mjs',
);

/** Codex app-server → exec-JSONL adapter. App-server is required for true
 * same-turn `turn/steer`; `codex exec` cannot accept a second prompt. */
export const CODEX_APP_TURN_SCRIPT = resolveServerScript(
  process.env.RIVENDELL_CODEX_APP_TURN,
  'codex-app-turn.mjs',
);

export const PORT = Number(process.env.PORT || process.env.RIVENDELL_PORT) || 8091;
// Safe-by-default: TARDIS exposes filesystem and agent-control APIs and has
// no app-layer login. Bind loopback unless the operator explicitly opts into a
// trusted network interface (Tailscale Serve can still proxy to 127.0.0.1).
export const HOST = process.env.HOST || '127.0.0.1';
export const STATE_DIR = process.env.RIVENDELL_STATE_DIR || join(homedir(), '.rivendell');
export const STATIC_DIR = process.env.RIVENDELL_STATIC_DIR || resolve(APP_ROOT, 'dist');
export const ELROND_WORKSPACE_PATH =
  process.env.ELROND_WORKSPACE_PATH ||
  join(homedir(), 'ASSISTANT-HUB');

// Optional compatibility path for operators who intentionally share an MCP
// dotenv file. Never crawl a neighboring repository for credentials by default.
export const ASSISTANT_MCP_ENV_PATH = process.env.ASSISTANT_MCP_ENV_PATH || '';

// OneDrive's fileproviderd intermittently locks files under
// ~/Library/CloudStorage/OneDrive-Personal/* — readFileSync then throws
// EAGAIN / EDEADLK / EBUSY and crashes the whole server before it even gets
// to bind a port. KeepAlive then restarts us into the same crash. Retry the
// read with a short backoff so a sync race doesn't kill the startup.
function readFileWithLockRetry(path: string): string | null {
  if (!existsSync(path)) return null;
  let lastErr: NodeJS.ErrnoException | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      lastErr = e;
      if (!isTransientFileProviderError(err)) throw err;
      const wait = 100 * (attempt + 1);
      const end = Date.now() + wait;
      while (Date.now() < end) { /* busy-wait — startup, no event loop yet */ }
    }
  }
  console.warn(`[config] readFileWithLockRetry gave up on ${path}: ${fileProviderErrorMessage(lastErr)}`);
  return null;
}

function dotenvValue(key: string): string {
  const text = readFileWithLockRetry(ASSISTANT_MCP_ENV_PATH);
  if (!text) return '';
  const match = text.match(new RegExp(`^${key}=([^\\n\\r]*)`, 'm'));
  if (!match) return '';
  return match[1].trim().replace(/^["']|["']$/g, '');
}

export const ASSISTANT_ADMIN_BASE_URL =
  process.env.ASSISTANT_ADMIN_BASE_URL ||
  process.env.ASSISTANT_MCP_ADMIN_URL ||
  '';

export const ASSISTANT_ADMIN_TOKEN =
  process.env.ASSISTANT_ADMIN_TOKEN ||
  process.env.MCP_AUTH_TOKEN ||
  dotenvValue('MCP_AUTH_TOKEN');

// Loopback trigger for an optional local cron runner.
// runtime=local cron jobs can only be run on demand by the local runner (the
// Railway server refuses them with a runtime mismatch), so the Forge run-now
// route posts local jobs here instead of to ASSISTANT_ADMIN_BASE_URL.
export const CRON_LOCAL_TRIGGER_URL =
  process.env.CRON_LOCAL_TRIGGER_URL || 'http://127.0.0.1:8771';

export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
export const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  '';

// Default MCP base URL to the same Railway server that serves /admin/api.
// Both endpoints share the same auth token, so co-locating them removes a
// whole class of "callMcp not configured" silent failures.
// callMcp appends `/tools/call`, which the assistant server mounts at its
// ROOT, not under `/mcp`. Only the TARDIS_OFFICE_MCP_URL branch used to strip
// a trailing `/mcp`; on a box configured through ASSISTANT_MCP_URL (…/mcp)
// every callMcp went to `/mcp/tools/call` and 404'd — silently breaking the
// compaction memory hook and any routine gate. Normalise whichever wins.
const stripMcpSuffix = (url: string | undefined): string | undefined =>
  url?.trim().replace(/\/+$/, '').replace(/\/mcp$/, '') || undefined;
export const MCP_BASE_URL =
  stripMcpSuffix(process.env.TARDIS_OFFICE_MCP_URL) ||
  stripMcpSuffix(process.env.RAILWAY_MCP_URL) ||
  stripMcpSuffix(process.env.ASSISTANT_MCP_URL) ||
  stripMcpSuffix(process.env.MCP_BASE_URL) ||
  ASSISTANT_ADMIN_BASE_URL;

export const MCP_BEARER_TOKEN =
  process.env.TARDIS_OFFICE_MCP_TOKEN ||
  process.env.ASSISTANT_MCP_TOKEN ||
  process.env.MCP_BEARER_TOKEN ||
  process.env.RAILWAY_MCP_TOKEN ||
  ASSISTANT_ADMIN_TOKEN ||
  '';

// Optional Railway redeploy integration. Explicit configuration is required;
// TARDIS never borrows a developer's global Railway CLI credential.
export const RAILWAY_API_TOKEN =
  process.env.RAILWAY_API_TOKEN ||
  process.env.RAILWAY_TOKEN ||
  '';
export const RAILWAY_SERVICE_ID = process.env.RAILWAY_SERVICE_ID || '';
export const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID || '';

export const PREWARM_AGENTS = process.env.RIVENDELL_PREWARM_AGENTS === 'true';
export const WORKER_ENABLED = process.env.RIVENDELL_WORKER_ENABLED !== 'false';
export const WORKER_RUNNER = process.env.RIVENDELL_WORKER_RUNNER || 'dry-run';
export const WORKER_POLL_MS = Number(process.env.RIVENDELL_WORKER_POLL_MS) || 10_000;
