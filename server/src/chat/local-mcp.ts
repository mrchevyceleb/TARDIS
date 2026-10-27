import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DESK_OWNER_NAME, DEVICE_MCP_SCRIPT, HEADLESS_MCP_SCRIPT, PORT, stateDir, TEAM_MCP_SCRIPT } from '../config.ts';
import { COMPUTER_MCP_TOKEN } from '../devices/context.ts';
import { headlessLaneToken } from '../headless/pool.ts';

export const MCP_SECRET_ENV_KEYS = ['RIVENDELL_COMPUTER_MCP_TOKEN', 'RIVENDELL_HEADLESS_TOKEN'] as const;
const SECRET_ENV_KEYS = new Set<string>(MCP_SECRET_ENV_KEYS);
const GROK_IMAGINE_MCP_SCRIPT = process.env.RIVENDELL_GROK_IMAGINE_MCP?.trim()
  || join(homedir(), 'GLOBAL-AGENT-CONFIGS', 'extensions', 'grok-imagine-mcp', 'index.mjs');

/** Runtime MCP tokens passed to Codex's environment for `mcp_servers.<name>.env_vars`
 *  expansion while excluded from Codex shell subprocesses via
 *  `shell_environment_policy.exclude`, keeping tokens off process command lines
 *  (`ps` / `/proc/<pid>/cmdline`) and out of agent shell commands (card-667aa9). */
export function localMcpSecretEnv(agentName?: string, opts: { unnamedLane?: boolean } = {}): Record<string, string> {
  if (process.env.RIVENDELL_SIDE_COPY === '1') return {};
  const headlessAgent = opts.unnamedLane ? undefined : agentName;
  return {
    RIVENDELL_COMPUTER_MCP_TOKEN: COMPUTER_MCP_TOKEN,
    RIVENDELL_HEADLESS_TOKEN: headlessLaneToken(headlessAgent),
  };
}

/** Write a mode-0600 MCP config file for Claude `--mcp-config <path>` so runtime
 *  MCP tokens stay out of both `claude`'s command-line arguments (`argv`) and
 *  `claude`'s top-level process environment (preventing inheritance by Bash tool
 *  subprocesses). */
export function writeClaudeMcpConfigFile(key: string, configJson: string): string {
  const dir = join(stateDir(), 'mcp-configs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
  const target = join(dir, `mcp-${digest}.json`);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, configJson, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
  return target;
}

/** Reserved built-ins, independent of global/private MCP configs. Banana uses
 * one server across threads: computer identity comes from signed turn context,
 * never a mutable process-wide RIVENDELL_AGENT_NAME. */
export function localMcpServers(agentName?: string, opts: { replyNow?: boolean; unnamedLane?: boolean; backgroundLane?: boolean; owner?: string; agentId?: string } = {}) {
  // A chat with no stable name may carry a placeholder agentName for the team MCP (Codex uses 'Teammate'). The
  // headless MCP must never treat that placeholder as an identity, or every such chat would share one browser.
  const headlessAgent = opts.unnamedLane ? undefined : agentName;
  // The canonical (trimmed, capped) owner name, so the tools advertise exactly
  // the name the Desk API accepts as the owner.
  const base = { RIVENDELL_TEAM_URL: `http://127.0.0.1:${PORT}`, RIVENDELL_OWNER_NAME: DESK_OWNER_NAME };
  return {
    'rivendell-team': { type: 'stdio', command: 'node', args: [TEAM_MCP_SCRIPT],
      // Every engine can explicitly publish an owner reply through the host.
      // RIVENDELL_AGENT_LANE lets jobs, watches and handoffs report back to the lane that started them.
      // RIVENDELL_AGENT_ID is the stable roster id, so owner-isolated tools
      // (commitments) never resolve identity through a mutable display name.
      env: { ...base, ...(agentName ? { RIVENDELL_AGENT_NAME: agentName } : {}), ...(opts.agentId ? { RIVENDELL_AGENT_ID: opts.agentId } : {}), RIVENDELL_REPLY_NOW: '1', ...(!opts.replyNow || opts.agentId ? { RIVENDELL_REPLY_NOW_HOST: '1' } : {}), ...(opts.backgroundLane ? { RIVENDELL_AGENT_LANE: 'bg' } : {}) } },
    'rivendell-device': { type: 'stdio', command: 'node', args: [DEVICE_MCP_SCRIPT],
      // The owner env binds this shim's calls to its lane: computer_start
      // refuses a context whose owner lane is not the caller. Banana's serve
      // process shares one server across threads, so it passes no owner and
      // keeps the signed-context-only identity.
      env: { ...base, RIVENDELL_COMPUTER_MCP_TOKEN: COMPUTER_MCP_TOKEN, ...(opts.owner ? { RIVENDELL_COMPUTER_OWNER: opts.owner } : {}) } },
    // Per-lane headless Chromium; the lane name picks the profile and its token only works for that name.
    'rivendell-headless': { type: 'stdio', command: 'node', args: [HEADLESS_MCP_SCRIPT],
      env: { ...base, RIVENDELL_HEADLESS_TOKEN: headlessLaneToken(headlessAgent), ...(headlessAgent ? { RIVENDELL_AGENT_NAME: headlessAgent } : {}) } },
    // The team's image and video maker (Matt, Oct 27 2026), billed to his SuperGrok
    // plan through the OAuth token TARDIS keeps refreshed.
    ...(existsSync(GROK_IMAGINE_MCP_SCRIPT) ? { 'grok-imagine': { type: 'stdio', command: 'node', args: [GROK_IMAGINE_MCP_SCRIPT], env: {} as Record<string, string> } } : {}),
  };
}
export function localMcpCodexArgs(agentName?: string, opts: { unnamedLane?: boolean; owner?: string; agentId?: string } = {}): string[] {
  const serverArgs = Object.entries(localMcpServers(agentName, opts)).flatMap(([name, server]) => {
    const envEntries = Object.entries(server.env);
    const publicEnv = envEntries.filter(([key]) => !SECRET_ENV_KEYS.has(key));
    const secretVars = envEntries.filter(([key]) => SECRET_ENV_KEYS.has(key)).map(([key]) => key);
    return [
      '-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
      '-c', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`,
      ...publicEnv.flatMap(([key, value]) => ['-c', `mcp_servers.${name}.env.${key}=${JSON.stringify(value)}`]),
      ...(secretVars.length ? ['-c', `mcp_servers.${name}.env_vars=${JSON.stringify(secretVars)}`] : []),
    ];
  });
  return [
    ...serverArgs,
    '-c', `shell_environment_policy.exclude=${JSON.stringify(MCP_SECRET_ENV_KEYS)}`,
  ];
}
export function localMcpBananaServers() {
  return Object.fromEntries(Object.entries(localMcpServers()).map(([name, server]) => [name, {
    type: 'local' as const, command: [server.command, ...server.args], environment: server.env,
  }]));
}
