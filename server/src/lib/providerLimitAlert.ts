import type { TerminalProviderError } from '../chat/providerErrors.ts';

const sent = new Map<string, { at: number; attempt: symbol }>();
const ALL_FULL = 'claude-all-full';
type Delivery = (text: string) => Promise<{ delivered: boolean }>;
const deliver: Delivery = async (text) => {
  const { deliverTeamMessage } = await import('../chat/teamBus.ts');
  return deliverTeamMessage({ from: 'TARDIS', to: 'chief-of-staff', text, wait: false });
};

export function clearAllClaudeAccountsFullAlert(): void { sent.delete(ALL_FULL); }

/** One alert per profile/reset, or per outage when no account has room. */
export function noteProviderUsageLimit(account: string, lane: string, error: TerminalProviderError, send: Delivery = deliver, now = Date.now(), movedTo?: string): void {
  if (!error.usageLimit) return;
  const window = error.resetTime ?? 'reset unknown';
  const key = movedTo ? JSON.stringify([account, error.limitKind ?? 'usage', window]) : ALL_FULL;
  if (movedTo) clearAllClaudeAccountsFullAlert();
  const cooldown = error.limitKind === 'weekly' || error.limitKind === 'monthly' ? 7 * 24 * 3_600_000 : error.resetTime ? 24 * 3_600_000 : 5 * 3_600_000;
  for (const [entryKey, entry] of sent) if (entryKey !== ALL_FULL && now - entry.at >= 7 * 24 * 3_600_000) sent.delete(entryKey);
  if (key !== ALL_FULL && sent.has(key) && now - sent.get(key)!.at >= cooldown) sent.delete(key);
  if (sent.has(key)) return;
  const attempt = Symbol();
  sent.set(key, { at: now, attempt });
  const name = lane.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 40);
  const text = movedTo
    ? `Claude account ${account} reached its ${error.limitKind ?? 'usage'} limit. Moved ${name} and every other lane using that account to ${movedTo}. The failed turn is retrying with the same brain. Saved account preferences return after reset.${error.resetTime ? ` Reset: ${error.resetTime}.` : ''}`
    : `All signed-in Claude accounts are full or have no confirmed room. ${name} could not run on ${account}. ${error.resetTime ? `It resets at ${error.resetTime}.` : 'Try again after a usage window resets.'}${error.limitKind === 'monthly' ? ' Check the monthly spend limit at claude.ai/settings/usage.' : ''} No brain was changed.`;
  void Promise.resolve().then(() => send(text)).then((result) => {
    if (!result.delivered) throw new Error('not accepted');
  }).catch(() => {
    if (sent.get(key)?.attempt === attempt) sent.delete(key);
    console.warn('[provider-limit] alert not delivered');
  });
}
