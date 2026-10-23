import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_ROOT, STATE_DIR } from '../config.ts';
import { bareChatId, isAgentThread } from '../chat/threadKey.ts';
import { subscriptionEnvironment } from '../chat/subscription-policy.ts';
import { accountEnv, accountEnvForAccount, accountForAgent, accountFromChatId, configuredAccountNames, backgroundAccountEnv } from './accountResolver.ts';
import { JsonStore } from './jsonStore.ts';
import { claudeAccountPool } from './claudeAccountPool.ts';

export type AccountEngine = 'claude' | 'codex';
export type CliProfile = { id: string; engine: AccountEngine; path: string; env: NodeJS.ProcessEnv };
type ManagedProfile = { id: string; engine: AccountEngine };
type Choice = { id: string; profileId: string };
const managedStore = new JsonStore<ManagedProfile>('cli-profiles.json', []);
const routingCache = new Map<string, { signature: string; identity: string }>();
const choicesStore = new JsonStore<Choice>('cli-account-choices.json', []);

function readRecords<T>(name: string): T[] {
  try {
    const data = JSON.parse(readFileSync(join(STATE_DIR, name), 'utf8'));
    if (!Array.isArray(data)) throw new Error('Invalid account settings.');
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('The saved account settings could not be read.', { cause: error });
  }
}

export function cliProfileId(engine: AccountEngine, path: string): string {
  const absolute = resolve(path);
  const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
  return `${engine}-${createHash('sha256').update(canonical).digest('hex').slice(0, 20)}`;
}

export function cliProfileForEnv(engine: AccountEngine, env: NodeJS.ProcessEnv): string {
  return engine === 'claude' ? env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    : env.CODEX_HOME || join(homedir(), '.codex');
}

function managedProfile(id: string, engine: AccountEngine): CliProfile {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid saved account.');
  const path = join(STATE_DIR, 'cli-profiles', id, engine);
  const env = subscriptionEnvironment(process.env);
  env[engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = path;
  env.SAMWISE_ACCOUNT = `tardis-${id}`;
  return { id: cliProfileId(engine, path), engine, path, env };
}

/** No credential discovery: only operator-configured profiles and sign-ins
 * created through this app are eligible. Paths never come from the browser. */
export function cliProfiles(): CliProfile[] {
  const found = new Map<string, CliProfile>();
  for (const name of configuredAccountNames()) {
    const env = name ? accountEnvForAccount(name, APP_ROOT) : accountEnv(APP_ROOT);
    for (const engine of ['claude', 'codex'] as const) {
      const path = cliProfileForEnv(engine, env);
      const id = cliProfileId(engine, path);
      if (!found.has(id)) found.set(id, { id, engine, path, env });
    }
  }
  for (const record of readRecords<ManagedProfile>('cli-profiles.json')) {
    if (record.engine !== 'claude' && record.engine !== 'codex') throw new Error('Invalid saved account.');
    const profile = managedProfile(record.id, record.engine);
    found.set(profile.id, profile);
  }
  return [...found.values()];
}

function choiceKey(engine: AccountEngine, cwd: string, chatId: string): string {
  return `${engine}|${isAgentThread(chatId) ? bareChatId(chatId) : `${resolve(cwd)}|${chatId}`}`;
}

export function subscriptionEnvForLane(engine: AccountEngine, cwd: string, chatId: string, agentName?: string): NodeJS.ProcessEnv {
  const preferred = preferredSubscriptionEnv(engine, cwd, chatId, agentName);
  if (engine !== 'claude') return preferred;
  const profiles = cliProfiles().filter(item => item.engine === 'claude');
  const id = cliProfileId('claude', cliProfileForEnv('claude', preferred));
  const peers = claudePoolPeers(id, profiles);
  const selected = claudeAccountPool.select(id, peers.map(item => item.id));
  return selected === id ? preferred : { ...peers.find(item => item.id === selected)!.env };
}

/** Claude logins are billed in separate pools (Matt, Oct 23 2026: the game
 *  studio runs on his own money, Rally work on the company's), so failover
 *  never moves a lane into another pool's account. Pools are account-map names,
 *  `RIVENDELL_CLAUDE_ACCOUNT_POOLS="mjohnst,mattio|kim,tardis"`. A lane whose
 *  preferred login is in no pool only fails over to other unpooled logins. */
export function claudePoolGroups(): Set<string>[] | null {
  const raw = process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS?.trim();
  if (!raw) return null;
  const idOf = (name: string): string | null => {
    try { return cliProfileId('claude', cliProfileForEnv('claude', accountEnvForAccount(name, APP_ROOT))); } catch { return null; }
  };
  const groups = raw.split('|').map(group => group.split(',').map(name => name.trim()).filter(Boolean).map(idOf));
  // A misspelled name must never widen a pool: the config is unusable.
  if (groups.some(group => !group.length || group.includes(null))) return null;
  const pools = groups.map(group => new Set(group as string[]));
  // An account in two pools would bridge them, and `find` would silently
  // pick the first: the config is unusable, not order-dependent.
  const seen = new Set<string>();
  for (const pool of pools) for (const id of pool) {
    if (seen.has(id)) return null;
    seen.add(id);
  }
  return pools;
}

function claudePoolPeers(preferredId: string, profiles: CliProfile[]): CliProfile[] {
  const pools = claudePoolGroups();
  if (!pools) {
    // Pools are configured but unusable (or unset): never fail over blind.
    // With no pool config at all the old single-pool behaviour applies only
    // when the operator never set the variable; a set-but-broken value fails
    // closed to the preferred login alone.
    return process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS?.trim()
      ? profiles.filter(profile => profile.id === preferredId)
      : profiles;
  }
  const mine = pools.find(pool => pool.has(preferredId));
  const pooled = new Set(pools.flatMap(pool => [...pool]));
  return profiles.filter(profile => mine ? mine.has(profile.id) : !pooled.has(profile.id));
}

/** True when a Claude profile may bill work whose own lane lives in another
 *  pool. Detached work (jobs, watch commands, reviews) has no turn to borrow
 *  a profile from: it resolves its account from its working directory and the
 *  agent's pin/choice exactly like a turn would, then checks the pool. When
 *  pools are configured, a profile outside that pool (or outside every pool
 *  while the lane's own login is pooled) must never be handed to the job, or
 *  `claude -p` inside it silently bills the wrong money (Felix's Candy review,
 *  Oct 23 2026: a game-lane job ran on the default ~/.claude, Rally money).
 *  With no pool config there is nothing to check against. */
export function claudeProfileInLanePool(profileDir: string, lanePreferredDir: string): boolean {
  if (resolve(profileDir) === resolve(lanePreferredDir)) return true;
  const pools = claudePoolGroups();
  if (!pools) return !process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS?.trim();
  const id = cliProfileId('claude', profileDir);
  const laneId = cliProfileId('claude', lanePreferredDir);
  const mine = pools.find(pool => pool.has(laneId));
  if (mine) return mine.has(id);
  const pooled = new Set(pools.flatMap(pool => [...pool]));
  return !pooled.has(id);
}

export function preferredSubscriptionEnv(engine: AccountEngine, cwd: string, chatId: string, agentName?: string): NodeJS.ProcessEnv {
  const legacyPin = accountFromChatId(chatId);
  if (legacyPin) return accountEnvForAccount(legacyPin, cwd);
  const choice = readRecords<Choice>('cli-account-choices.json').find(item => item.id === choiceKey(engine, cwd, chatId));
  if (choice) {
    const profile = cliProfiles().find(item => item.engine === engine && item.id === choice.profileId);
    if (!profile) throw new Error('The selected account is unavailable. Choose a signed-in account.');
    return { ...profile.env };
  }
  const pinned = accountFromChatId(chatId) ?? accountForAgent(agentName);
  return pinned ? accountEnvForAccount(pinned, cwd) : accountEnv(cwd);
}

/** Stable identity, excluding access/refresh tokens. A sign-in to a different
 * identity in the same native directory must retire an idle warm worker. */
export function subscriptionRoutingKey(engine: AccountEngine, env: NodeJS.ProcessEnv): string {
  const profile = cliProfileForEnv(engine, env);
  const id = cliProfileId(engine, profile);
  const previous = routingCache.get(id);
  let signature = '';
  try { const st = statSync(join(profile, engine === 'claude' ? '.credentials.json' : 'auth.json')); signature = `${st.mtimeMs}:${st.size}`; } catch { /* A transient read must not recycle a healthy worker. */ }
  let identity = previous?.identity || 'not-signed-in';
  if (previous && previous.signature === signature) return `${id}:${previous.identity}`;
  try {
    if (engine === 'claude') {
      const account = JSON.parse(readFileSync(join(profile, '.claude.json'), 'utf8')).oauthAccount;
      identity = JSON.stringify([account?.accountUuid, account?.organizationUuid, account?.emailAddress]);
    } else {
      const auth = JSON.parse(readFileSync(join(profile, 'auth.json'), 'utf8'));
      const jwt = JSON.parse(Buffer.from(String(auth.tokens?.id_token || '').split('.')[1] || '', 'base64url').toString());
      identity = JSON.stringify([auth.tokens?.account_id, jwt.sub, jwt.email]);
    }
  } catch { return `${id}:${identity}`; }
  identity = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  routingCache.set(id, { signature, identity });
  return `${id}:${identity}`;
}

/** A transient credential-file read must not look like an account change. The
 * profile path still has to match; once both identities are known, they must
 * match too so a real re-login recycles the warm worker. */
export function subscriptionRoutingKeysMatch(current: string, desired: string): boolean {
  if (current === desired) return true;
  const split = (value: string) => {
    const at = value.lastIndexOf(':');
    return at < 0 ? { profile: value, identity: '' } : { profile: value.slice(0, at), identity: value.slice(at + 1) };
  };
  const left = split(current);
  const right = split(desired);
  return left.profile === right.profile
    && (left.identity === 'not-signed-in' || right.identity === 'not-signed-in');
}

export function subscriptionEmail(engine: AccountEngine, env: NodeJS.ProcessEnv): string | null {
  try {
    const profile = cliProfileForEnv(engine, env);
    const email = engine === 'claude'
      ? JSON.parse(readFileSync(join(profile, '.claude.json'), 'utf8')).oauthAccount?.emailAddress
      : JSON.parse(Buffer.from(String(JSON.parse(readFileSync(join(profile, 'auth.json'), 'utf8')).tokens?.id_token || '').split('.')[1] || '', 'base64url').toString()).email;
    return typeof email === 'string' && email.length < 180 ? email.replace(/[\x00-\x1f\x7f]/g, '') : null;
  } catch { return null; }
}

export async function chooseCliProfile(engine: AccountEngine, cwd: string, chatId: string, profileId: string): Promise<void> {
  if (!cliProfiles().some(profile => profile.engine === engine && profile.id === profileId)) throw new Error('Choose one of the available accounts.');
  const id = choiceKey(engine, cwd, chatId);
  await choicesStore.modify(items => [...items.filter(item => item.id !== id), { id, profileId }]);
}

export async function createLoginProfile(engine: AccountEngine): Promise<CliProfile & { managedId: string }> {
  const managedId = randomUUID();
  const profile = managedProfile(managedId, engine);
  await mkdir(profile.path, { recursive: true, mode: 0o700 });
  return { ...profile, managedId };
}

export async function registerLoginProfile(managedId: string, engine: AccountEngine): Promise<void> {
  managedProfile(managedId, engine); // Validate before persisting.
  await managedStore.modify(items => items.some(item => item.id === managedId) ? items : [...items, { id: managedId, engine }]);
}

/** New detached work follows the saved choices. Work started by a turn already
 * answering keeps that turn's original profile until its boundary.
 *
 * `cwd` is the work's own working directory, never a stand-in workspace: the
 * account map resolves by directory, so resolving detached work from anywhere
 * else bills it to whatever account that other directory maps to. Callers
 * pass the directory the command will actually run in. */
export async function backgroundSubscriptionEnv(cwd: string, agentName: string, chatId: string): Promise<NodeJS.ProcessEnv> {
  const { peekThreadSessions } = await import('../chat/runner.ts');
  const { sessionDirectory } = await import('../chat/sessionPolicy.ts');
  const env = backgroundAccountEnv(cwd, agentName);
  const claude = subscriptionEnvForLane('claude', cwd, chatId, agentName);
  const codex = subscriptionEnvForLane('codex', cwd, chatId, agentName);
  env.CLAUDE_CONFIG_DIR = cliProfileForEnv('claude', claude);
  env.CODEX_HOME = cliProfileForEnv('codex', codex);
  env.SAMWISE_ACCOUNT = claude.SAMWISE_ACCOUNT;
  // A busy turn's live profile may be borrowed only when it bills to the same
  // pool this detached work belongs to. A lane can hold sessions in more than
  // one directory (its configured home plus wherever a job's cwd resolved),
  // and borrowing across pools is exactly how a game-lane review ended up on
  // Rally money. When the borrow is refused the job keeps its own lane's
  // resolved profile, which is always in-pool by construction.
  const laneDir = sessionDirectory(chatId, cwd);
  for (const active of peekThreadSessions({ cli: 'claude', repoPath: cwd, chatId }, laneDir)) {
    if (!active.busy) continue;
    if (active.claudeProfile && ['claude', 'assistant'].includes(active.cli)
      && claudeProfileInLanePool(active.claudeProfile, cliProfileForEnv('claude', claude))) { env.CLAUDE_CONFIG_DIR = active.claudeProfile; break; }
  }
  return env;
}
