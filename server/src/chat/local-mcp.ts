import { DESK_OWNER_NAME, DEVICE_MCP_SCRIPT, HEADLESS_MCP_SCRIPT, PORT, TEAM_MCP_SCRIPT } from '../config.ts';
import { COMPUTER_MCP_TOKEN } from '../devices/context.ts';
import { headlessLaneToken } from '../headless/pool.ts';

/** Reserved built-ins, independent of global/private MCP configs. Banana uses
 * one server across threads: computer identity comes from signed turn context,
 * never a mutable process-wide RIVENDELL_AGENT_NAME. */
export function localMcpServers(agentName?: string, opts: { replyNow?: boolean; unnamedLane?: boolean } = {}) {
  // A chat with no stable name may carry a placeholder agentName for the team MCP (Codex uses 'Teammate'). The
  // headless MCP must never treat that placeholder as an identity, or every such chat would share one browser.
  const headlessAgent = opts.unnamedLane ? undefined : agentName;
  // The canonical (trimmed, capped) owner name, so the tools advertise exactly
  // the name the Desk API accepts as the owner.
  const base = { RIVENDELL_TEAM_URL: `http://127.0.0.1:${PORT}`, RIVENDELL_OWNER_NAME: DESK_OWNER_NAME };
  return {
    'rivendell-team': { type: 'stdio', command: 'node', args: [TEAM_MCP_SCRIPT],
      // reply_now is advertised only to lanes whose runner posts it as a message (Claude).
      env: { ...base, ...(agentName ? { RIVENDELL_AGENT_NAME: agentName } : {}), ...(opts.replyNow ? { RIVENDELL_REPLY_NOW: '1' } : {}) } },
    'rivendell-device': { type: 'stdio', command: 'node', args: [DEVICE_MCP_SCRIPT],
      env: { ...base, RIVENDELL_COMPUTER_MCP_TOKEN: COMPUTER_MCP_TOKEN } },
    // Per-lane headless Chromium; the lane name picks the profile and its token only works for that name.
    'rivendell-headless': { type: 'stdio', command: 'node', args: [HEADLESS_MCP_SCRIPT],
      env: { ...base, RIVENDELL_HEADLESS_TOKEN: headlessLaneToken(headlessAgent), ...(headlessAgent ? { RIVENDELL_AGENT_NAME: headlessAgent } : {}) } },
  };
}
export function localMcpCodexArgs(agentName?: string, opts: { unnamedLane?: boolean } = {}): string[] {
  return Object.entries(localMcpServers(agentName, opts)).flatMap(([name, server]) => [
    '-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
    '-c', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`,
    ...Object.entries(server.env).flatMap(([key, value]) => ['-c', `mcp_servers.${name}.env.${key}=${JSON.stringify(value)}`]),
  ]);
}
export function localMcpBananaServers() {
  return Object.fromEntries(Object.entries(localMcpServers()).map(([name, server]) => [name, {
    type: 'local' as const, command: [server.command, ...server.args], environment: server.env,
  }]));
}
