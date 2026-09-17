/** Explicit per-installation integration hub. No global credential discovery. */
export function officeMcpConfig(env: NodeJS.ProcessEnv = process.env) {
  const base = env.TARDIS_OFFICE_MCP_URL?.trim();
  if (!base) return null;
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/', '/mcp', '/mcp/'].includes(url.pathname)) {
    throw new Error('TARDIS_OFFICE_MCP_URL must be an HTTPS service root or /mcp endpoint');
  }
  if (!env.TARDIS_OFFICE_MCP_TOKEN?.trim()) throw new Error('TARDIS_OFFICE_MCP_TOKEN is required');
  return { base: url.origin, url: `${url.origin}/mcp`, token: env.TARDIS_OFFICE_MCP_TOKEN.trim() };
}
export function officeMcpServers() {
  const config = officeMcpConfig();
  return config ? { 'office-mcp': { type: 'http' as const, url: config.url, headers: { Authorization: 'Bearer ${TARDIS_OFFICE_MCP_TOKEN}' } } } : {};
}
export function officeMcpCodexArgs() {
  const config = officeMcpConfig();
  return config ? ['-c', `mcp_servers.office-mcp.url=${JSON.stringify(config.url)}`, '-c', 'mcp_servers.office-mcp.bearer_token_env_var="TARDIS_OFFICE_MCP_TOKEN"'] : [];
}
