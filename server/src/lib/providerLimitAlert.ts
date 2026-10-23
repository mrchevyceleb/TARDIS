import type { TerminalProviderError } from '../chat/providerErrors.ts';

const sent = new Map<string, { at: number; attempt: symbol }>();
type Delivery = (text: string) => Promise<{ delivered: boolean }>;
const deliver: Delivery = async (text) => {
  const { deliverTeamMessage } = await import('../chat/teamBus.ts');
  return deliverTeamMessage({ from: 'TARDIS', to: 'chief-of-staff', text, wait: false });
};

/** One alert per actual CLI profile and reset window, shared across its lanes. */
export function noteProviderUsageLimit(account: string, lane: string, error: TerminalProviderError, send: Delivery = deliver, now = Date.now()): void {
  if (!error.usageLimit) return;
  const window = error.resetTime ?? 'reset unknown';
  const key = JSON.stringify([account, error.limitKind ?? 'usage', window]);
  const cooldown = error.limitKind === 'weekly' || error.limitKind === 'monthly' ? 7 * 24 * 3_600_000 : error.resetTime ? 24 * 3_600_000 : 5 * 3_600_000;
  for (const [entryKey, entry] of sent) if (now - entry.at >= 7 * 24 * 3_600_000) sent.delete(entryKey);
  if (sent.has(key) && now - sent.get(key)!.at >= cooldown) sent.delete(key);
  if (sent.has(key)) return;
  const attempt = Symbol();
  sent.set(key, { at: now, attempt });
  const name = lane.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 40);
  const text = error.limitKind === 'monthly'
    ? `Claude's monthly spend limit is reached (first failed lane: ${name}). Raise it at claude.ai/settings/usage; other lanes on the same account may also fail. No account or brain was changed. One alert per account and window.`
    : `Claude's subscription usage window is full (first failed lane: ${name}). ${error.resetTime ? `It resets at ${error.resetTime}.` : 'No reset time was supplied.'} Other lanes on the same account may also fail. No account or brain was changed. One alert per account and reset window.`;
  void Promise.resolve().then(() => send(text)).then((result) => {
    if (!result.delivered) throw new Error('not accepted');
  }).catch(() => {
    if (sent.get(key)?.attempt === attempt) sent.delete(key);
    console.warn('[provider-limit] alert not delivered');
  });
}
