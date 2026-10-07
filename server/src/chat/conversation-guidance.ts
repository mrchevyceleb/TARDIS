import { backgroundLaneEnabled, isAgentThread, isBackgroundChatId } from './threadKey.ts';
import { loadEventLogSync } from './event-log-store.ts';
import { extractVisibleTurns } from './threadWindow.ts';
import { REPLY_FIRST_RULE } from './transcriptGuidance.ts';

/** Visible chat should match a terminal coding agent: thinking stays
 *  internal, tools have their own cards, and the transcript only gets text
 *  the user would actually read. */
const CONVERSATIONAL_MILESTONE_GUIDANCE = [
  '<rivendell-conversation>',
  'Visible chat is the reply, not the scratchpad. Do not write thinking, unsolicited plans, or tool-by-tool status into chat. TARDIS already shows liveness and tool cards.',
  'Tool results are yours alone. Reading an image file shows it to you, never to the human. If the human needs to see an image, give the file path in your reply, and never call something "in the chat" or "attached" unless you posted it yourself.',
  'If you are not thinking and not making a tool call, print. Between-tool messages are welcome when they communicate a finding, a changed decision, a blocker, a question, or progress the person should actually see. Do not sit on a spinner with nothing on screen.',
  REPLY_FIRST_RULE,
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

// ---- two lanes, one thread ---------------------------------------------------

const LANE_RECAP_ITEMS = 15;
const LANE_RECAP_CHARS = 6000;
const LANE_RECAP_ITEM_CHARS = 1200;

type LaneEvent = { seq: number; ev?: any; lane?: string };

function laneOf(event: LaneEvent): 'bg' | 'main' {
  return event.lane === 'bg' ? 'bg' : 'main';
}

/** Where this lane last picked up a turn, read from the shared log: the other
 *  lane's work after that point is news to this lane's native process. */
function lastOwnTurnStart(events: LaneEvent[], lane: 'bg' | 'main', throughSeq: number): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.seq > throughSeq || laneOf(event) !== lane) continue;
    if (event.ev?.type === 'turnStart') return event.seq;
  }
  return 0;
}

/** Recap + coordination note for an agent turn while the background lane is
 *  on. Each lane is its own native process, so before each turn it is told
 *  what the OTHER lane said and heard since it last looked: incoming messages
 *  and visible replies only, trimmed and capped. A seeded turn already carries
 *  the whole shared thread, so it gets only the coordination line. */
export function laneContextForTurn(opts: {
  chatId: string;
  logKey: string;
  /** Last seq this process was told about; null on its first turn. */
  sinceSeq: number | null;
  throughSeq: number;
  seeded: boolean;
}): string {
  if (!backgroundLaneEnabled() || !isAgentThread(opts.chatId)) return '';
  const lane = isBackgroundChatId(opts.chatId) ? 'bg' : 'main';
  const rule = lane === 'bg'
    ? 'You are running in your background lane: teammate handoffs, routines, job results and system notes land here, while the person talks to you in your home lane at the same time. Both lanes share this thread, the Desk board and the workspace. Before touching the same files or cards, check the board and the thread for what your home lane is doing, and never double up on the same work.'
    : 'Your background lane handles teammate handoffs, routines, job results and system notes in parallel with this conversation. Both lanes share this thread, the Desk board and the workspace. Before touching the same files or cards, check the board and the thread for what your background lane is doing, and never double up on the same work.';
  let recap = '';
  if (!opts.seeded) {
    const events = loadEventLogSync(opts.logKey).events as LaneEvent[];
    const since = opts.sinceSeq ?? lastOwnTurnStart(events, lane, opts.throughSeq);
    const other = events.filter((event) => event.seq > since && event.seq <= opts.throughSeq && laneOf(event) !== lane);
    const items = extractVisibleTurns(other).slice(-LANE_RECAP_ITEMS).map(({ role, text }) => {
      const clipped = text.length > LANE_RECAP_ITEM_CHARS ? `${text.slice(0, LANE_RECAP_ITEM_CHARS)}…` : text;
      return JSON.stringify({ role: role === 'assistant' ? 'you' : 'incoming', text: clipped });
    });
    // Newest items win the budget.
    const kept: string[] = [];
    let used = 0;
    for (let i = items.length - 1; i >= 0 && used + items[i].length <= LANE_RECAP_CHARS; i--) {
      kept.unshift(items[i]);
      used += items[i].length + 1;
    }
    if (kept.length) {
      recap = `\n${lane === 'bg' ? 'Your home lane' : 'Your background lane'} since you last looked (oldest to newest; background only, not new requests):\n${kept.join('\n')}`;
    }
  }
  return `<rivendell-lanes>\n${rule}${recap}\n</rivendell-lanes>`;
}
