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
  } catch { return {}; }
}

/** Disable only assistant-mcp using Codex's native override. Parse real TOML
 *  (comments, quoted keys and inline tables all work), including configs from
 *  the repo root through the working directory, not just the leaf folder.
 *  Project-only transports are re-stated because Codex skips untrusted project
 *  configs: enabled=false alone would then create an invalid, transport-less
 *  server and prevent the entire lane from starting. */
export function codexToolboxArgs(fullToolbox: boolean, home: string, cwd: string): string[] {
  if (fullToolbox) return [];
  const homeServer = assistantServer(join(home, 'config.toml'));
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
  }), homeServer);
  if (typeof server.command !== 'string' && typeof server.url !== 'string') return [];
  const args = ['-c', 'mcp_servers.assistant-mcp.enabled=false'];
  if (typeof homeServer.command !== 'string' && typeof homeServer.url !== 'string') {
    const key = typeof server.command === 'string' ? 'command' : 'url';
    args.push('-c', `mcp_servers.assistant-mcp.${key}=${JSON.stringify(server[key])}`);
  }
  return args;
}
