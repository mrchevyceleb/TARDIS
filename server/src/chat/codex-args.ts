/** TARDIS owns teammate identity, routing, durability, and cycle guards.
 * Codex's unrelated native multi-agent runtime creates a second `/root/...`
 * roster and exposes `send_message`, which looks deceptively correct but cannot
 * reach TARDIS teammates. Keep that competing bus out of every agent turn. */
export function codexRivendellIsolationArgs(): string[] {
  return ['--disable', 'multi_agent'];
}

export function buildCodexAppServerArgs(mcpArgs: readonly string[]): string[] {
  return [
    'app-server',
    '--listen', 'stdio://',
    ...codexRivendellIsolationArgs(),
    '-c', 'model_auto_compact_token_limit=200000',
    '-c', 'model_auto_compact_token_limit_scope="total"',
    ...mcpArgs,
  ];
}


export function shouldRetryEmptyCodexTurn(input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  producedAgentMessage: boolean;
  sawActionableItem: boolean;
  sawTurnCompleted: boolean;
  stderr: string;
  transientProjectConfigError: boolean;
  retryDepth: number;
}): boolean {
  return input.retryDepth < 1
    && (input.code !== 0 || !input.sawTurnCompleted)
    && !input.producedAgentMessage
    && !input.sawActionableItem
    && !input.stderr.trim()
    && !input.transientProjectConfigError
    && input.signal !== 'SIGKILL'
    && input.code !== 137;
}
