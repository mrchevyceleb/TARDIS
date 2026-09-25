import { isAgentThread } from './threadKey.ts';
import { loadEventLogSync } from './event-log-store.ts';
import { extractVisibleTurns } from './threadWindow.ts';

/** Visible chat should match a terminal coding agent: thinking stays
 *  internal, tools have their own cards, and the transcript only gets text
 *  the user would actually read. */
const CONVERSATIONAL_MILESTONE_GUIDANCE = [
  '<rivendell-conversation>',
  'Visible chat is the reply, not the scratchpad. Do not write thinking, unsolicited plans, or tool-by-tool status into chat. TARDIS already shows liveness and tool cards.',
  'Tool results are yours alone. Reading an image file shows it to you, never to the human. If the human needs to see an image, give the file path in your reply, and never call something "in the chat" or "attached" unless you posted it yourself.',
  'If you are not thinking and not making a tool call, print. Between-tool messages are welcome when they communicate a finding, a changed decision, a blocker, a question, or progress the person should actually see. Do not sit on a spinner with nothing on screen.',
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
  const voiceReplyRule = opts.peerFromRole === 'voice'
    ? '\n\n<rivendell-voice-reply>\nThis turn already has a spoken answer on the call. Do not write a second, different answer in Hall. Keep working silently. Only post in this thread if the caller needs something they cannot hear: a result, a blocker, or a question.\n</rivendell-voice-reply>'
    : '';
  return CONVERSATIONAL_MILESTONE_GUIDANCE + voiceContext + voiceReplyRule;
}
