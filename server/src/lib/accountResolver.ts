import { subscriptionEnvironment } from '../chat/subscription-policy.ts';
// Optional source of truth for which Claude Code / Codex profile a workspace
// uses. A fresh clone uses each CLI's normal profile. Operators can explicitly
// opt into a map with RIVENDELL_ACCOUNT_MAP; TARDIS never discovers an
// unrelated account configuration from the home directory.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

interface Account {
  claude_config_dir: string;
  codex_home: string;
}
interface AccountMap {
  accounts: Record<string, Account>;
  default_account: string;
  rules: Array<{ prefix: string; account: string }>;
}

const HOME = homedir();
const MAP_PATH = process.env.RIVENDELL_ACCOUNT_MAP?.trim() || '';
const DEFAULT_CLI_ACCOUNT = process.env.RIVENDELL_DEFAULT_CLI_ACCOUNT?.trim() || '';
const claudeMaxRetries = () =>
  process.env.RIVENDELL_CLAUDE_MAX_RETRIES?.trim()
  || process.env.CLAUDE_CODE_MAX_RETRIES?.trim()
  || '1';

let cached: AccountMap | null = null;
function loadMap(): AccountMap | null {
  if (!MAP_PATH) return null;
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as AccountMap;
    return cached;
  } catch (err) {
    // Not cached on failure → retried on the next call, so a transient read/parse
    // error self-heals instead of being stuck (wrong account) until restart.
    console.warn(`[accountResolver] could not load ${MAP_PATH}: ${(err as Error).message}`);
    return null;
  }
}

/** Which named profile owns this path; null if no map is configured. */
export function resolveAccount(cwd: string): string | null {
  const map = loadMap();
  if (!map) return null;
  const abs = resolvePath(cwd);
  const rel =
    abs === HOME ? '' : abs.startsWith(HOME + '/') ? abs.slice(HOME.length + 1) : abs;
  const rule = map.rules.find((r) => rel === r.prefix || rel.startsWith(r.prefix + '/'));
  return rule?.account ?? map.default_account;
}

/**
 * Env for spawning a CLI on an EXPLICITLY NAMED account, overriding the directory
 * rules. TARDIS uses this to bind a companion (not a directory) to an account:
 * A custom/private picker may bind a lane to a named profile. The per-directory
 * `accountEnv` below remains authoritative for ordinary lanes. If a named
 * profile is missing from the configured map we fail closed and refuse to
 * launch rather than silently falling back to another profile.
 */
export function accountEnvForAccount(account: string, cwd: string): NodeJS.ProcessEnv {
  const map = loadMap();
  const a = map ? map.accounts[account] : undefined;
  const env: NodeJS.ProcessEnv = {
    ...subscriptionEnvironment(process.env),
    CLAUDE_CODE_MAX_RETRIES: claudeMaxRetries(),
  };
  // Bill the SUBSCRIPTION selected below (CLAUDE_CONFIG_DIR for claude, CODEX_HOME
  // for codex), never a metered provider key. A present key silently overrides the
  // chosen subscription (this quietly billed metered API $ on every spawn), so
  // scrub them from every spawn env we hand to the CLI:
  //   ANTHROPIC_API_KEY/_AUTH_TOKEN -> would override the Claude subscription
  //   OPENAI_API_KEY                -> would override the Codex ChatGPT subscription
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  if (a) {
    env.SAMWISE_ACCOUNT = account;
    env.CLAUDE_CONFIG_DIR = join(HOME, a.claude_config_dir);
    env.CODEX_HOME = join(HOME, a.codex_home);
    return env;
  }
  throw new Error(
    `[accountResolver] configured account "${account}" is unavailable; refusing to launch a CLI under a different profile (cwd="${cwd}")`,
  );
}

/**
 * Env for spawning a CLI in `cwd`: layers the right CLAUDE_CONFIG_DIR / CODEX_HOME
 * for that workspace over process.env. If the map is missing or the account is
 * unknown, returns process.env unchanged (safe no-op fallback).
 */
export function accountEnv(cwd: string): NodeJS.ProcessEnv {
  // Private/multi-profile deployments may explicitly pin TARDIS's CLI lanes
  // while public defaults continue to use the normal local profile.
  if (DEFAULT_CLI_ACCOUNT) return accountEnvForAccount(DEFAULT_CLI_ACCOUNT, cwd);
  const map = loadMap();
  const account = resolveAccount(cwd);
  const env: NodeJS.ProcessEnv = {
    ...subscriptionEnvironment(process.env),
    CLAUDE_CODE_MAX_RETRIES: claudeMaxRetries(),
  };
  // Bill the SUBSCRIPTION selected below (CLAUDE_CONFIG_DIR for claude, CODEX_HOME
  // for codex), never a metered provider key. A present key silently overrides the
  // chosen subscription (this quietly billed metered API $ on every spawn), so
  // scrub them from every spawn env we hand to the CLI:
  //   ANTHROPIC_API_KEY/_AUTH_TOKEN -> would override the Claude subscription
  //   OPENAI_API_KEY                -> would override the Codex ChatGPT subscription
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  const a = map && account ? map.accounts[account] : undefined;
  if (a) {
    env.SAMWISE_ACCOUNT = account!;
    env.CLAUDE_CONFIG_DIR = join(HOME, a.claude_config_dir);
    env.CODEX_HOME = join(HOME, a.codex_home);
    return env;
  }
  // Unresolved account (map missing / unreadable / unknown). Fail CLOSED: do not
  // inherit a stray CLAUDE_CONFIG_DIR / CODEX_HOME that could route work through
  // the wrong account — scrub them so the CLIs use their own ~/.claude / ~/.codex
  // default deterministically, and log it loudly.
  if (map) {
    console.warn(`[accountResolver] configured account map has no usable profile for cwd="${cwd}"; using the default CLI profile`);
  }
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  env.SAMWISE_ACCOUNT = 'default';
  return env;
}

// Per-agent account pin (Matt, Oct 8 2026): named teammates run on their own
// subscription (Riley and Tim on Matt's mjohnst Claude sub) instead of the shared
// default. Format: RIVENDELL_AGENT_ACCOUNTS="riley=mjohnst,tim=mjohnst".
// Resolved AFTER the explicit `__acct__` chatId pin and BEFORE the default, so a
// lane-level pin always wins. Fail closed on config errors: a malformed pair
// ("riley:mjohnst", "riley=") or duplicate agent key throws rather than letting
// a typo silently route a pinned agent back onto the default/shared profile;
// a well-formed pin whose account is missing from the map throws inside
// accountEnvForAccount. With the env unset this is a no-op for every agent.
export function accountForAgent(agentName: string | null | undefined): string | null {
  const raw = process.env.RIVENDELL_AGENT_ACCOUNTS;
  if (!agentName || !raw) return null;
  const wanted = agentName.trim().toLowerCase();
  if (!wanted) return null;
  let match: string | null = null;
  const seen = new Set<string>();
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    const key = eq > 0 ? pair.slice(0, eq).trim().toLowerCase() : '';
    const value = eq > 0 ? pair.slice(eq + 1).trim() : '';
    if (!key || !value) {
      throw new Error(
        `[accountResolver] malformed RIVENDELL_AGENT_ACCOUNTS pair "${pair.trim()}" (expected name=account, e.g. riley=mjohnst); refusing to resolve agent account pins`,
      );
    }
    if (seen.has(key)) {
      throw new Error(
        `[accountResolver] duplicate agent "${key}" in RIVENDELL_AGENT_ACCOUNTS; refusing an ambiguous account pin`,
      );
    }
    seen.add(key);
    if (key === wanted && match === null) match = value;
  }
  return match;
}

// Legacy/custom account-pinned chat lanes carry the chosen profile inside the
// chatId as a `__acct__<account>` suffix. Here we pull it back out at spawn time so the
// CLI launches under that exact account regardless of the repo path. The client
// (useChat.ts) MUST use the same `__acct__` separator. Null for normal lanes,
// which keep the per-repo account-map resolution.
const CHAT_ID_ACCOUNT_RE = /__acct__([a-z0-9-]+)$/i;
export function accountFromChatId(chatId: string | undefined | null): string | null {
  if (!chatId) return null;
  const match = CHAT_ID_ACCOUNT_RE.exec(chatId);
  return match ? match[1].toLowerCase() : null;
}
