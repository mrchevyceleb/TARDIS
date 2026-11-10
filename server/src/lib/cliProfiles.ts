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

const longLivedTokenVerdicts = new Map<string, 'valid' | 'invalid'>();
/** Share definitive provider evidence with synchronous lane/routing decisions.
 * Unknown network results never invent authentication or clear a rejection. */
export function recordLongLivedTokenVerdict(token: string, verdict: 'valid' | 'invalid' | 'unknown'): void {
  if (verdict !== 'unknown') longLivedTokenVerdicts.set(createHash('sha256').update(token).digest('hex'), verdict);
}

/** A Claude login refreshed by many lanes at once rotates its refresh token
 *  under them, and the native CLI wipes the login on the losing refresh. A
 *  long-lived token from `claude setup-token` never rotates, so lanes spawned
 *  on a profile that holds one authenticate with it and never refresh. The
 *  file (`<profile>/.long-lived-oauth-token`, mode 600) is the account email on
 *  line one and the token on line two. It applies while the profile is signed
 *  in as that account, and also when the profile holds no signed-in account at
 *  all — the wipe this whole mechanism exists to prevent takes the .claude.json
 *  account with it, and the token, not the login, is then the profile's source
 *  of truth. Only a re-login to a DIFFERENT account keeps the token out, so a
 *  re-login never bills the old one. The profile's own credentials stay for
 *  the usage reader and the idle renewal, the only remaining refreshers. */
export function longLivedClaudeToken(profileDir: string): { email: string; token: string } | null {
  try {
    const [email, token] = readFileSync(join(profileDir, '.long-lived-oauth-token'), 'utf8').split('\n').map(line => line.trim());
    if (email && email.includes('@') && /^sk-ant-oat[\w-]+$/.test(token ?? '')) return { email, token: token! };
  } catch { /* No token for this profile: the CLI uses its own login. */ }
  return null;
}

/** The token decides identity only when the profile is CONFIRMED not signed in
 *  as someone else: an absent account file, or one with no account on it. Any
 *  other failure — unreadable, half-written, malformed — must refuse the
 *  token, or a profile that quietly signed in as B would keep billing A. */
function longLivedTokenAccountMatches(token: { email: string }, profileDir: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(profileDir, '.claude.json'), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false;
    const account = saved.oauthAccount;
    if (account == null) return true;
    if (typeof account !== 'object' || Array.isArray(account)) return false;
    const signedIn = account.emailAddress;
    // Missing identity is a wipe; a malformed identity is not permission to bill.
    return signedIn == null || (typeof signedIn === 'string' && signedIn.toLowerCase() === token.email.toLowerCase());
  } catch { return false; }
}

/** A token must have positive provider evidence before it can replace a login. */
export function longLivedTokenApplies(token: { email: string; token: string }, profileDir: string): boolean {
  return longLivedTokenVerdicts.get(createHash('sha256').update(token.token).digest('hex')) === 'valid'
    && longLivedTokenAccountMatches(token, profileDir);
}

/** Probe independently of previous verdicts, so a rejection can be rechecked
 * after the probe cache's TTL. Cold starts wait for evidence before injection. */
export async function withVerifiedLongLivedClaudeToken(
  env: NodeJS.ProcessEnv, profileDir: string,
  verifyToken?: (token: string) => Promise<'valid' | 'invalid' | 'unknown'>,
): Promise<NodeJS.ProcessEnv> {
  const token = longLivedClaudeToken(profileDir);
  if (token && longLivedTokenAccountMatches(token, profileDir)) {
    const verify = verifyToken ?? (await import('./cliAccounts.ts')).probeLongLivedClaudeToken;
    recordLongLivedTokenVerdict(token.token, await verify(token.token));
  }
  return withLongLivedClaudeToken(env, profileDir);
}

export function withLongLivedClaudeToken(env: NodeJS.ProcessEnv, profileDir: string): NodeJS.ProcessEnv {
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const token = longLivedClaudeToken(profileDir);
  if (token && longLivedTokenApplies(token, profileDir)) env.CLAUDE_CODE_OAUTH_TOKEN = token.token;
  return env;
}

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
 *  never moves a lane into another pool's account. Pools are ordered account-map
 *  names, `RIVENDELL_CLAUDE_ACCOUNT_POOLS="mjohnst,mattio,kim|tardis,kim"`: a
 *  lane fails over in that order (Matt, Oct 30 2026: games go mjohnst, then
 *  matt@, then mtjohnston42). Pools may share a backup account; a lane belongs
 *  to the pool where its preferred login sits earliest, so Rally's `kim` lanes
 *  stay in Rally's pool even though games can borrow `kim` last. A lane whose
 *  preferred login is in no pool only fails over to other unpooled logins. */
export function claudePoolGroups(): string[][] | null {
  const raw = process.env.RIVENDELL_CLAUDE_ACCOUNT_POOLS?.trim();
  if (!raw) return null;
  const idOf = (name: string): string | null => {
    try { return cliProfileId('claude', cliProfileForEnv('claude', accountEnvForAccount(name, APP_ROOT))); } catch { return null; }
  };
  const groups = raw.split('|').map(group => group.split(',').map(name => name.trim()).filter(Boolean).map(idOf));
  // A misspelled name must never widen a pool: the config is unusable.
  if (groups.some(group => !group.length || group.includes(null))) return null;
  return groups.map(group => [...new Set(group as string[])]);
}

/** The ordered pool a lane bills: the one where its preferred login comes
 *  first (earliest position, then earliest pool). */
function lanePool(pools: string[][], laneId: string): string[] | undefined {
  let best: string[] | undefined;
  for (const pool of pools) {
    const at = pool.indexOf(laneId);
    if (at >= 0 && (!best || at < best.indexOf(laneId))) best = pool;
  }
  return best;
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
  const mine = lanePool(pools, preferredId);
  if (mine) return mine.flatMap(id => profiles.filter(profile => profile.id === id));
  const pooled = new Set(pools.flat());
  return profiles.filter(profile => !pooled.has(profile.id));
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
  const mine = lanePool(pools, cliProfileId('claude', lanePreferredDir));
  if (mine) return mine.includes(id);
  return !pools.flat().includes(id);
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

/** Stable identity, excluding rotating access/refresh tokens but including
 * the year token workers hold for their lifetime. Real credential changes
 * retire idle workers; transient account-file reads never do. */
export function subscriptionRoutingKey(engine: AccountEngine, env: NodeJS.ProcessEnv): string {
  const profile = cliProfileForEnv(engine, env);
  const id = cliProfileId(engine, profile);
  const previous = routingCache.get(id);
  let signature = '';
  try { const st = statSync(join(profile, engine === 'claude' ? '.credentials.json' : 'auth.json')); signature = `${st.mtimeMs}:${st.size}`; } catch { /* A transient read must not recycle a healthy worker. */ }
  if (engine === 'claude') {
    // On a wiped profile the year-token file is the only identity-bearing
    // credential left, and .claude.json decides which credential applies, so
    // both feed the signature: replacing token A with token B, or a re-login
    // that changes which account lanes bill, must retire warm workers instead
    // of repainting the panel while they keep running.
    for (const name of ['.long-lived-oauth-token', '.claude.json']) {
      try { signature += `|${name}:${createHash('sha256').update(readFileSync(join(profile, name))).digest('hex')}`; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `${id}:${previous?.identity || 'not-signed-in'}`;
        signature += `|${name}:absent`;
      }
    }
    const token = longLivedClaudeToken(profile);
    signature += `|token-applies:${token ? longLivedTokenApplies(token, profile) : false}`;
  }
  let identity = previous?.identity || 'not-signed-in';
  if (previous && previous.signature === signature) return `${id}:${previous.identity}`;
  try {
    if (engine === 'claude') {
      let account: { accountUuid?: unknown; organizationUuid?: unknown; emailAddress?: unknown } | undefined;
      try { account = JSON.parse(readFileSync(join(profile, '.claude.json'), 'utf8')).oauthAccount; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const token = longLivedClaudeToken(profile);
      const applies = token ? longLivedTokenApplies(token, profile) : false;
      // An applicable token is the credential lanes actually bill, so its
      // fingerprint rides the identity even beside a saved account: swapping
      // or revoking it must retire warm workers still holding the old one.
      const fingerprint = applies ? createHash('sha256').update(token!.token).digest('hex').slice(0, 16) : undefined;
      if (account && typeof account.emailAddress === 'string') {
        identity = JSON.stringify([account.accountUuid, account.organizationUuid, account.emailAddress, fingerprint]);
      } else if (applies) {
        identity = JSON.stringify(['long-lived-token', token!.email, fingerprint]);
      } else {
        // Confirmed absence of every credential, never a stale previous
        // identity: workers holding the removed token must be retired.
        routingCache.set(id, { signature, identity: 'signed-out' });
        return `${id}:signed-out`;
      }
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

/** A transient credential-file read must not look like an account change: the
 * profile path still has to match, and an UNKNOWN identity ('not-signed-in')
 * borrows the other side's. A CONFIRMED sign-out ('signed-out') is a real
 * change — a worker still holding the removed token or login must go. */
export function subscriptionRoutingKeysMatch(current: string, desired: string): boolean {
  if (current === desired) return true;
  const split = (value: string) => {
    const at = value.lastIndexOf(':');
    return at < 0 ? { profile: value, identity: '' } : { profile: value.slice(0, at), identity: value.slice(at + 1) };
  };
  const left = split(current);
  const right = split(desired);
  if (left.identity === 'signed-out' || right.identity === 'signed-out') return false;
  return left.profile === right.profile
    && (left.identity === right.identity
      || left.identity === 'not-signed-in' || right.identity === 'not-signed-in');
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
  // Pool membership comes from the lane's own preference, never from the
  // failover pick: a game lane that fell back to a shared backup is still a
  // game lane and must not borrow a Rally session.
  const laneHome = cliProfileForEnv('claude', preferredSubscriptionEnv('claude', cwd, chatId, agentName));
  for (const active of peekThreadSessions({ cli: 'claude', repoPath: cwd, chatId }, laneDir)) {
    if (!active.busy) continue;
    if (active.claudeProfile && ['claude', 'assistant'].includes(active.cli)
      && claudeProfileInLanePool(active.claudeProfile, laneHome)) { env.CLAUDE_CONFIG_DIR = active.claudeProfile; break; }
  }
  return withVerifiedLongLivedClaudeToken(env, env.CLAUDE_CONFIG_DIR!);
}
