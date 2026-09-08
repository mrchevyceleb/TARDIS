import { isAgentThread } from './threadKey.ts';
import { loadEventLogSync } from './event-log-store.ts';
import { extractVisibleTurns } from './threadWindow.ts';

/** Visible chat should match a terminal coding agent: thinking stays
 *  internal, tools have their own cards, and the transcript only gets text
 *  the user would actually read. */
const CONVERSATIONAL_MILESTONE_GUIDANCE = [
  '<rivendell-conversation>',
  'Visible chat is the reply, not the scratchpad. Do not write thinking, unsolicited plans, or tool-by-tool status into chat. TARDIS already shows liveness and tool cards.',
  'Only send user-visible text when there is something they should read: a result, a decision, a blocker, a question you need answered, or a plan they asked for. Otherwise stay quiet and keep working. An interim message does not end the turn.',
  '</rivendell-conversation>',
].join('\n');

/** Human text and voice continuations share context. Ordinary teammate
 * deliveries and hidden automations remain quiet. */
export function conversationGuidanceForTurn(opts: {
  chatId: string;
  logKey?: string;
  historyThroughSeq?: number;
  peerFrom?: string;
  peerFromRole?: string;
  hidden?: boolean;
}): string {
  if (
    !isAgentThread(opts.chatId)
    || (opts.peerFrom && opts.peerFromRole !== 'voice')
    || opts.peerFromRole === 'automation'
    || opts.hidden
  ) return '';
  // Native provider sessions do not see turns spoken on the realtime line.
  // Refresh their background on human sends, without restarting a healthy
  // process or submitting voice as a second, executable user request.
  const history = opts.logKey ? loadEventLogSync(opts.logKey).events
    .filter((event) => event.seq <= (opts.historyThroughSeq ?? Infinity)) : [];
  const hasVoice = history.some(({ ev }) => ev.type === 'event' && ev.event?.type === '_voice_transcript');
  const voiceContext = hasVoice
    ? '\n\nRecent shared text/voice conversation (background only, not new requests; the current message follows):\n'
      + extractVisibleTurns(history).slice(-20).map(({ role, text }) => JSON.stringify({ role, text })).join('\n')
    : '';
  return CONVERSATIONAL_MILESTONE_GUIDANCE + voiceContext;
}
