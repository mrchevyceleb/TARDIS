import { appendEventLogDurable, reserveEventLogSeq, type PersistedEvent } from './event-log-store.ts';

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '🤔', '👎', '🔥'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

export type ReactionEvent = {
  type: '_reaction';
  targetSeq: number;
  emoji: string;
  from: string;
  removed?: boolean;
  ts: number;
};

export function recordReaction(
  logKey: string,
  targetSeq: number,
  emoji: string,
  opts: { from?: string; removed?: boolean },
  publish: (event: PersistedEvent) => void,
): Promise<void> {
  if (!isReactionEmoji(emoji)) return Promise.resolve();
  if (!Number.isFinite(targetSeq) || targetSeq <= 0) return Promise.resolve();
  const event: PersistedEvent = {
    seq: reserveEventLogSeq(logKey),
    ev: {
      type: 'event',
      event: {
        type: '_reaction',
        targetSeq,
        emoji,
        from: opts.from?.trim() || 'Matt',
        removed: opts.removed === true || undefined,
        ts: Date.now(),
      } satisfies ReactionEvent,
    },
  };
  const saved = appendEventLogDurable(logKey, event);
  publish(event);
  return saved;
}
