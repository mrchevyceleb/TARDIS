// Owner flag digests (Matt, Oct 14, card-d7bf78 b): past-due commitment
// raises and Desk silence nudges go to their owner as ONE digest message
// every 30 minutes instead of one message per item. Each source (the
// commitment sweep, the Desk hygiene tick) owns one digest instance with its
// own delivery path; entries queue per owner, and the flush delivers a
// single combined message. Only a successful flush clears its entries, so a
// failed delivery retries in the next window. In-memory only: a restart can
// drop an unflushed digest, which the next cycle re-raises.

export type FlagDigest = {
  queue(ownerId: string, text: string, onDelivered?: () => void): void;
  flush(): Promise<void>;
};

const DIGEST_INTERVAL_MS = 30 * 60_000;

export function createFlagDigest(deliver: (ownerId: string, text: string) => Promise<boolean>): FlagDigest {
  const states = new Map<string, { entries: { text: string; onDelivered?: () => void }[]; lastFlushMs: number }>();
  return {
    queue(ownerId, text, onDelivered) {
      const state = states.get(ownerId) ?? { entries: [], lastFlushMs: 0 };
      state.entries.push({ text, onDelivered });
      states.set(ownerId, state);
    },
    async flush() {
      const now = Date.now();
      for (const [ownerId, state] of states) {
        if (!state.entries.length) continue;
        if (now - state.lastFlushMs < DIGEST_INTERVAL_MS) continue;
        const ok = await deliver(ownerId, ['[TARDIS] Flag digest (one message per 30 minutes; act on each line):', ...state.entries.map((entry) => entry.text)].join('\n'));
        if (!ok) continue;
        for (const entry of state.entries) entry.onDelivered?.();
        state.entries = [];
        state.lastFlushMs = now;
      }
    },
  };
}
