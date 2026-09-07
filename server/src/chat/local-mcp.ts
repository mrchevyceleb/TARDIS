import { DEVICE_MCP_SCRIPT, PORT, TEAM_MCP_SCRIPT } from '../config.ts';
import { COMPUTER_MCP_TOKEN } from '../devices/context.ts';

/** Reserved built-ins, independent of global/private MCP configs. Banana uses
 * one server across threads: computer identity comes from signed turn context,
 * never a mutable process-wide RIVENDELL_AGENT_NAME. */
export function localMcpServers(agentName?: string) {
  const base = { RIVENDELL_TEAM_URL: `http://127.0.0.1:${PORT}` };
  return {
    'rivendell-team': { type: 'stdio', command: 'node', args: [TEAM_MCP_SCRIPT],
      env: { ...base, ...(agentName ? { RIVENDELL_AGENT_NAME: agentName } : {}) } },
    'rivendell-device': { type: 'stdio', command: 'node', args: [DEVICE_MCP_SCRIPT],
      env: { ...base, RIVENDELL_COMPUTER_MCP_TOKEN: COMPUTER_MCP_TOKEN } },
  };
}
export function localMcpCodexArgs(agentName?: string): string[] {
  return Object.entries(localMcpServers(agentName)).flatMap(([name, server]) => [
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
