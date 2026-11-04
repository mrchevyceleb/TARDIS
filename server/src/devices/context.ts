import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { JsonStore } from '../lib/jsonStore.ts';
import { bareChatId } from '../chat/threadKey.ts';
import { robotGuidance } from './robots.ts';

// Only TARDIS-spawned MCPs can invoke input APIs. This is not a general app
// login; it prevents a page on the trusted console from minting agent identity.
export const COMPUTER_MCP_TOKEN = randomBytes(32).toString('hex');
const secret = randomBytes(32);
// `expires` is the idle window (60 minutes from the start of the owner's turn). A context
// whose owner is still mid-turn stays valid past it, up to `hardExpires`, so a long turn
// can still reacquire the desktop after its first lease runs out.
const CONTEXT_IDLE_MS = 60 * 60_000;
const CONTEXT_HARD_MS = 6 * 60 * 60_000;
const contexts = new Map<string, { nonce: string; expires: number; hardExpires: number; human: boolean }>();
let ownerTurnRunning: (owner: string) => boolean = () => false;
export function setComputerOwnerTurnProbe(probe: (owner: string) => boolean): void { ownerTurnRunning = probe; }
/** Whether the owner's turn is running right now (the probe above). Lease
 *  takeover uses this: a control whose holder has no running turn was left
 *  behind when that turn died, so it can be let go. */
export function computerOwnerTurnRunning(owner: string): boolean { return ownerTurnRunning(owner); }

/** The computer-control owner identity: workspace + full chatId. A bare chatId
 *  is not unique across repos (`main` exists in every workspace, so two repos'
 *  same-named lanes would otherwise share one context), and threadLogKey is
 *  wrong here because bareChatId collapses an agent's background lane into its
 *  home lane — for computer control those are two live sessions that must
 *  never share a context. Engine-free, so a model switch keeps the same owner.
 *  JSON-encoded so the pair is injective: raw `|`-joining would let a pipe in
 *  one component collide with a pipe in the other. Nothing parses the key;
 *  every consumer (maps, the signed body, shim env, HTTP header) treats it as
 *  an opaque string. */
export function computerOwnerKey(cwd: string, chatId: string): string { return JSON.stringify([cwd, chatId]); }
/** The per-thread device selection key. The selection is the human's statement
 *  about the whole thread, so both lanes of an agent share it (unlike contexts
 *  and grants, which are per-lane): the workspace plus the BARE chatId. A
 *  missing repo (legacy clients send only the chatId) keeps the legacy bare
 *  key, so desktops that have not updated yet keep working. */
export function computerSelectionKey(repo: string | undefined, chatId: string): string {
  const bare = bareChatId(chatId);
  return repo ? computerOwnerKey(repo, bare) : bare;
}
/** The selection for a thread: the workspace-qualified entry when the client
 *  knows the repo. A repo-aware client reads ONLY that entry — a miss means
 *  no explicit selection (the default), never a legacy bare entry another
 *  workspace's old client wrote under the shared bare key. Only a legacy
 *  client (no repo) reads the bare key, which is its whole identity. */
export function computerTargetFor(repo: string | undefined, chatId: string): string {
  return computerTarget(computerSelectionKey(repo, chatId));
}
const targets = new Map<string, string>();
const store = new JsonStore<{ id: string; device: string }>('computer-targets.json', []);
let writes: Promise<unknown> = Promise.resolve();
export async function loadComputerTargets(): Promise<void> {
  for (const row of await store.list()) targets.set(row.id, row.device);
}
export async function setComputerTarget(chatId: string, device: string): Promise<void> {
  const save = async () => {
    const next = new Map(targets);
    if (device) next.set(chatId, device); else next.delete(chatId);
    await store.replace([...next].map(([id, value]) => ({ id, device: value })));
    targets.clear(); for (const [id, value] of next) targets.set(id, value);
  };
  const done = writes.then(save, save); writes = done.catch(() => {}); await done;
}
export function computerTarget(chatId: string): string { return targets.get(chatId) ?? ''; }
export function configuredDefaultComputer(): string { return process.env.RIVENDELL_COMPUTER_DEFAULT_DEVICE?.trim() ?? ''; }
export function backgroundComputerAllowed(): boolean { return process.env.RIVENDELL_COMPUTER_ALLOW_BACKGROUND === 'true'; }
function sign(body: string): string { return createHmac('sha256', secret).update(body).digest('base64url'); }
export function validComputerMcpToken(value: string | undefined): boolean {
  const got = Buffer.from(value ?? ''); const want = Buffer.from(COMPUTER_MCP_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}
export function readComputerContext(token: unknown): { owner: string; chatId: string; selection?: string; label: string; human: boolean } {
  if (typeof token !== 'string' || token.length > 3000) throw new Error('Current turn computer context is required.');
  const [body, signature, extra] = token.split('.');
  const got = Buffer.from(signature ?? ''); const want = Buffer.from(sign(body));
  if (extra || got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('Invalid computer context.');
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!Number.isFinite(data.expires) || typeof data.owner !== 'string' || !data.owner || typeof data.label !== 'string' || data.label.length > 100) throw new Error('Invalid computer context.');
  const now = Date.now();
  const expired = () => new Error('Expired computer context (one lasts 60 minutes from the start of its turn, or while that turn keeps running). Use the context at the top of your newest turn.');
  if (data.expires < now) throw expired();
  const current = contexts.get(data.owner);
  // Named so a lane that was handed someone else's context can tell it is not its own.
  if (!current || current.nonce !== data.nonce) throw new Error(`Computer context superseded: this one was issued to ${data.label}'s turn, and it stops working the moment that lane starts a new turn or is interrupted. A context cannot be handed to another lane. Use the "computer_start context for this turn" line at the top of your own prompt. If your own prompt has none, tell whoever asked you the exact error.`);
  if (current.expires < now && !ownerTurnRunning(data.owner)) throw expired();
  // `chatId` and `selection` let callers key the per-thread device selection
  // (workspace + bare chatId) without parsing the owner. Bodies minted before
  // those fields fall back: chatId to the owner, which was the bare chatId;
  // selection to absent, and callers fall back to the bare chatId themselves.
  return { owner: data.owner, chatId: typeof data.chatId === 'string' && data.chatId ? data.chatId : data.owner, selection: typeof data.selection === 'string' && data.selection ? data.selection : undefined, label: data.label, human: data.human === true };
}
/** The owner's turn was interrupted: its signed context stops working at once,
 *  so a tool call still in flight from that turn cannot open a new grant. The
 *  next turn mints a fresh one in computerGuidance. */
export function revokeComputerContext(owner: string): void {
  contexts.delete(owner);
}
/** `sameTurn` is a message delivered into a turn that is already running (a steer).
 *  It re-issues the context that turn already holds, so the token it carries and any
 *  token a subagent of that turn was handed stay valid. A new turn, a steer that changes
 *  who is speaking (human or not), or an interrupted turn (context revoked) mints a
 *  fresh one and supersedes the old as before.
 *
 *  Every lane gets this block on every turn (Matt, Nov 3): only the device line, the
 *  signed token and the policy line ride per turn. The static computer-use rules live
 *  in the rivendell-device computer_start tool description, which the agent already
 *  reads, so a fresh lane's first computer_start works without a re-arm turn. */
export function computerGuidance(cwd: string, chatId: string, label: string, human = true, sameTurn = false): string {
  const now = Date.now();
  const owner = computerOwnerKey(cwd, chatId);
  for (const [ownerKey, context] of contexts) if (context.hardExpires <= now) contexts.delete(ownerKey);
  const held = sameTurn ? contexts.get(owner) : undefined;
  const context = held && held.human === human && held.hardExpires > now
    ? { ...held, expires: now + CONTEXT_IDLE_MS }
    : { nonce: randomBytes(16).toString('hex'), expires: now + CONTEXT_IDLE_MS, hardExpires: now + CONTEXT_HARD_MS, human };
  contexts.set(owner, context); // a later peer turn cannot replay this owner's earlier human context
  // The signed copy carries the hard cap; the idle window lives in the map above.
  const body = Buffer.from(JSON.stringify({ owner, chatId, selection: computerSelectionKey(cwd, chatId), label: label.slice(0, 100), human, nonce: context.nonce, expires: context.hardExpires })).toString('base64url');
  const selected = computerTargetFor(cwd, chatId);
  const deviceLine = selected
    ? `The user explicitly selected device ${JSON.stringify(selected)} for this thread.`
    : configuredDefaultComputer()
      ? `The operator configured default desktop ${JSON.stringify(configuredDefaultComputer())}. Omit device on computer_start to use it. Never silently fall back to the local PC if it is offline.`
      : 'No default desktop is configured. List devices and identify the requested machine; ask only if the target is genuinely ambiguous.';
  const policyLine = human ? '' : backgroundComputerAllowed()
    ? 'Standing operator permission covers assigned background/peer work on configured computers. Yield to human conversations; never preempt another controller.'
    : 'Background desktop starts are disabled by operator policy; do not reuse an earlier human context to evade that policy.';
  return [
    '<rivendell-computer>',
    deviceLine,
    `Your computer_start context for this turn (do not echo): ${body}.${sign(body)}`,
    policyLine,
    '</rivendell-computer>',
    // A linked robot body rides on the same rivendell-device MCP; the block is
    // empty (and free) whenever no robot is online.
    robotGuidance(),
  ].filter(Boolean).join('\n');
}
