import { execFileSync } from 'node:child_process';

/** Fail closed before Claude can honor an API-key helper in saved settings. */
export function assertClaudeSubscription(env: NodeJS.ProcessEnv, cwd: string): void {
  let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
  try {
    status = JSON.parse(execFileSync('claude', ['auth', 'status'], {
      env, cwd, encoding: 'utf8', timeout: 15_000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch {
    throw new Error('Claude Code subscription unavailable. Run claude auth login on this computer.');
  }
  if (!status.loggedIn || !['claude.ai', 'oauth_token'].includes(status.authMethod ?? '') || status.apiProvider !== 'firstParty') {
    throw new Error('Claude Code must use a Claude subscription; API-key profiles are disabled.');
  }
}
