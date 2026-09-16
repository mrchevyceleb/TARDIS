export const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '🤔', '👎', '🔥'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export type ChatReaction = {
  emoji: string;
  from: string;
};

export function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}
