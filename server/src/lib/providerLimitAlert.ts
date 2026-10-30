import type { TerminalProviderError } from '../chat/providerErrors.ts';

const sent = new Map<string, { at: number; attempt: symbol }>();
const ALL_FULL = 'claude-all-full';
type Delivery = (text: string) => Promise<{ delivered: boolean }>;
const deliver: Delivery = async (text) => {
  const { deliverTeamMessage } = await import('../chat/teamBus.ts');
  return deliverTeamMessage({ from: 'TARDIS', to: 'chief-of-staff', text, wait: false });
};

const isAllFull = (key: string) => key.startsWith(`["${ALL_FULL}"`);
export function clearAllClaudeAccountsFullAlert(): void { for (const key of sent.keys()) if (isAllFull(key)) sent.delete(key); }

/** One alert per profile/reset, or per reset window when no account has room.
 * Room on some other account doesn't end the outage for a lane whose pool is
 * still full (game lanes can't use the Rally logins), so only a real move or
 * a new reset window re-arms it, never a usage poll (Oct 30 2026: Riley's
 * same 5pm notice woke Max three times in a few minutes). */
export function noteProviderUsageLimit(account: string, lane: string, error: TerminalProviderError, send: Delivery = deliver, now = Date.now(), movedTo?: string): void {
  if (!error.usageLimit) return;
  const window = error.resetTime ?? 'reset unknown';
  const key = movedTo ? JSON.stringify([account, error.limitKind ?? 'usage', window]) : JSON.stringify([ALL_FULL, window]);
  if (movedTo) clearAllClaudeAccountsFullAlert();
  // A session window is five hours, and its reset label ("5:00 PM") carries no
  // date, so an all-full key must lapse within one window or tomorrow's outage
  // with the same label would stay silent.
  const long = error.limitKind === 'weekly' || error.limitKind === 'monthly';
  const cooldown = long ? 7 * 24 * 3_600_000 : error.resetTime && movedTo ? 24 * 3_600_000 : 5 * 3_600_000;
  for (const [entryKey, entry] of sent) if (now - entry.at >= 7 * 24 * 3_600_000) sent.delete(entryKey);
  if (sent.has(key) && now - sent.get(key)!.at >= cooldown) sent.delete(key);
  if (sent.has(key)) return;
  const attempt = Symbol();
  sent.set(key, { at: now, attempt });
  const name = lane.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 40);
  const text = movedTo
    ? `One Claude subscription reached its ${error.limitKind ?? 'usage'} limit. Moved ${name} and every other lane using it to another signed-in account with room. The failed turn is retrying with the same brain, and saved account choices return after reset.${error.resetTime ? ` Reset: ${error.resetTime}.` : ''}`
    : `All signed-in Claude accounts are full or have no confirmed room. ${name} stayed on its saved account because there is nowhere safe to move it. ${error.resetTime ? `That usage window resets at ${error.resetTime}.` : 'Try again after a usage window resets.'}${error.limitKind === 'monthly' ? ' Check the monthly spend limit at claude.ai/settings/usage.' : ''} No brain was changed.`;
  void Promise.resolve().then(() => send(text)).then((result) => {
    if (!result.delivered) throw new Error('not accepted');
  }).catch(() => {
    if (sent.get(key)?.attempt === attempt) sent.delete(key);
    console.warn('[provider-limit] alert not delivered');
  });
}
