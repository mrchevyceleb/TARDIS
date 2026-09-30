// Client-version refusals should reach the coordinator on the first failed turn.

const STATUS_GATE_PATTERN = /(?:^\s*(?:[A-Za-z]*Error:\s*)?426\s*(?::|-|Upgrade Required|\{|$)|\b(?:HTTP|status(?:[\s_]*code)?|[A-Za-z]*error(?:\s*code)?)['"\s]*[:=(]?\s*426\b)/i;
const VERSION_GATE_PATTERN = /\b(?:client|CLI|Codex|Claude Code)\b[^\n]{0,100}\b(?:outdated|too old|upgrade required|needs an update|newer version[^\n]{0,40}required|please (?:update|upgrade))\b|\b(?:outdated|upgrade required|please (?:update|upgrade)|requires? a newer version)\b[^\n]{0,100}\b(?:client|CLI|Codex|Claude Code)\b|\bupdate to version\s+\d/i;

const ALERT_COOLDOWN_MS = 60 * 60_000;
const lastAlertAt = new Map<string, number>();

/** True when a provider error text says the client or its version is refused. */
export function isProviderGateFailure(text: string): boolean {
  return STATUS_GATE_PATTERN.test(text) || VERSION_GATE_PATTERN.test(text);
}

function oneLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function easternClock(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms)) + ' ET';
}

export type GateAlertDeps = {
  now: () => number;
  deliver: (input: { to: string; text: string }) => Promise<{ delivered: boolean; reason?: string }>;
};

function defaultDeps(): GateAlertDeps {
  return {
    now: () => Date.now(),
    deliver: async ({ to, text }) => {
      const { deliverTeamMessage } = await import('../chat/teamBus.ts');
      return deliverTeamMessage({ from: 'TARDIS', to, text, wait: false });
    },
  };
}

/** Call from a lane's failure path. Sends at most one alert per provider per hour,
 *  and only for gate-style failures; anything else returns false and does nothing. */
export function noteProviderGateFailure(provider: string, lane: string | (() => string), detail: string, overrides: Partial<GateAlertDeps> = {}): boolean {
  try {
  if (!isProviderGateFailure(detail)) return false;
  const deps = { ...defaultDeps(), ...overrides };
  const now = deps.now();
  const key = provider.toLowerCase();
  const last = lastAlertAt.get(key);
  if (last !== undefined && now - last < ALERT_COOLDOWN_MS) return true;
  const text = `Provider gate: ${provider} refused a turn for ${oneLine(typeof lane === 'function' ? lane() : lane, 40) || 'a lane'} at ${easternClock(now)} because its client version needs updating. `
    + `Other lanes using this client may also fail. Check the lane's provider diagnostics and client version setting. `
    + `(One alert per provider per hour.)`;
  lastAlertAt.set(key, now);
  void Promise.resolve().then(() => deps.deliver({ to: 'chief-of-staff', text })).then((result) => {
    if (!result.delivered) throw new Error(result.reason || 'delivery was not accepted');
  }).catch(() => {
    // A failed alert must not be remembered as sent: the next failure tries again.
    if (lastAlertAt.get(key) === now) lastAlertAt.delete(key);
    console.warn('[provider-gate] alert not delivered');
  });
  return true;
  } catch {
    console.warn('[provider-gate] alert could not be prepared');
    return false;
  }
}

/** Test and proof-harness reset. */
export function resetProviderGateAlerts(): void {
  lastAlertAt.clear();
}
