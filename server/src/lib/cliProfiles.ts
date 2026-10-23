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
  const selected = claudeAccountPool.select(id, profiles.map(item => item.id));
  return selected === id ? preferred : { ...profiles.find(item => item.id === selected)!.env };
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
 * answering keeps that turn's original profile until its boundary. */
export async function backgroundSubscriptionEnv(cwd: string, agentName: string, chatId: string): Promise<NodeJS.ProcessEnv> {
  const { peekThreadSession } = await import('../chat/runner.ts');
  const env = backgroundAccountEnv(cwd, agentName);
  const claude = subscriptionEnvForLane('claude', cwd, chatId, agentName);
  const codex = subscriptionEnvForLane('codex', cwd, chatId, agentName);
  env.CLAUDE_CONFIG_DIR = cliProfileForEnv('claude', claude);
  env.CODEX_HOME = cliProfileForEnv('codex', codex);
  env.SAMWISE_ACCOUNT = claude.SAMWISE_ACCOUNT;
  const active = peekThreadSession({ cli: 'claude', repoPath: cwd, chatId });
  if (active?.isBusy() && 'subscriptionProfile' in active) {
    const profile = active.subscriptionProfile();
    if (profile && ['claude', 'assistant'].includes(active.cli)) env.CLAUDE_CONFIG_DIR = profile;
    if (profile && ['codex', 'codex-personal'].includes(active.cli)) env.CODEX_HOME = profile;
  }
  return env;
}
