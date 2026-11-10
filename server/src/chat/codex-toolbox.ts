import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';

type Server = { command?: unknown; url?: unknown };

function assistantServer(file: string): Server {
  try {
    const config = parse(readFileSync(file, 'utf8'));
    const servers = config.mcp_servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
    const server = (servers as Record<string, unknown>)['assistant-mcp'];
    return server && typeof server === 'object' && !Array.isArray(server) ? server : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Disable only assistant-mcp using Codex's native override. Parse real TOML
 *  (comments, quoted keys and inline tables all work) from system, user, cwd,
 *  and .codex configs from the repo root through the working directory.
 *  Project-only servers get an inert transport because Codex skips untrusted
 *  project configs (including cwd/config.toml): enabled=false alone would create
 *  an invalid, transport-less server. Never copy a configured URL (possibly
 *  credential-bearing) into argv. */
export function codexToolboxArgs(
  fullToolbox: boolean, home: string, cwd: string, systemConfig = '/etc/codex/config.toml',
): string[] {
  if (fullToolbox) return [];
  const globalServer = {
    ...assistantServer(systemConfig), ...assistantServer(join(home, 'config.toml')),
  };
  const directories: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    directories.unshift(dir);
    if (existsSync(join(dir, '.git'))) break;
    if (dirname(dir) === dir) {
      // Outside a repository Codex uses the working directory as project root.
      directories.splice(0, directories.length - 1);
      break;
    }
  }
  const server = directories.reduce<Server>((merged, dir) => ({
    ...merged, ...assistantServer(join(dir, '.codex', 'config.toml')),
  }), { ...globalServer, ...assistantServer(join(cwd, 'config.toml')) });
  if (typeof server.command !== 'string' && typeof server.url !== 'string') return [];
  const args = ['-c', 'mcp_servers.assistant-mcp.enabled=false'];
  if (typeof globalServer.command !== 'string' && typeof globalServer.url !== 'string') {
    const key = typeof server.command === 'string' ? 'command' : 'url';
    const value = key === 'command' ? 'node' : 'http://127.0.0.1:9/disabled';
    args.push('-c', `mcp_servers.assistant-mcp.${key}=${JSON.stringify(value)}`);
  }
  return args;
}
