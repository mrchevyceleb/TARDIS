// Refreshes the testers' pinned Slack lists from the board's own records.
//
// The pinned message lives in Slack, so it can only change through the
// Slack API. That API is reached through assistant-mcp, and the QA board
// stays silent when any part of that path is unconfigured: the deployment
// names a channel per tester (RIVENDELL_QA_SLACK_CHANNELS, id=channel
// pairs). TARDIS keeps what it last attempted per tester in its own private
// store, plus the message id whenever a send was actually confirmed.
//
// What the tool never does: it never asks Matt to approve a held draft and
// never sends as Matt. The lane's Slack identity is held behind Matt's
// review gate by design (assistant-mcp parks every send as a draft unless a
// person approves it), so an automatic refresh must also never park a
// draft per card change: while sends are held, an unchanged list is never
// re-attempted (the store remembers the last attempted text), and a changed
// list is attempted at most once per distinct text. There is no edit-in-
// place call on that tool (slack_send_message posts; nothing updates an
// existing message), so a refresh posts the current list and the newest
// post is the list Sam pins. The board stays the truth throughout: these
// lists render from the same records as the board, and a stale or held pin
// never disagrees with a board anyone can open.

import { JsonStore } from './jsonStore.ts';
import { callMcp } from './mcp.ts';
import { STATE_DIR } from '../config.ts';
import { QA_TESTERS, qaBoard, qaPinnedList, type QaTesterId } from './qaBoard.ts';

export type QaPinRecord = {
  id: string;
  tester: QaTesterId;
  channel: string;
  /** Message id of the last confirmed post, when one ever landed. */
  messageTs?: string;
  /** The exact list text that message shows. */
  text?: string;
  /** The last list text a refresh attempted, sent or held. While sends are
   *  held this is what stops every card change from parking another draft:
   *  an unchanged list is never attempted twice. */
  lastAttemptedText?: string;
  createdAt?: string;
  updatedAt?: string;
};

const pinStore = new JsonStore<QaPinRecord>('qa-slack-pins.json', [], STATE_DIR);

function splitEnv(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Deployment configuration, never code: comma-separated id=channel pairs
 *  for sud, edgar and martin. Any other shape is ignored, so a partial or
 *  malformed value simply leaves that tester's pin unrefreshed. */
export function qaSlackChannels(): Partial<Record<QaTesterId, string>> {
  const channels: Partial<Record<QaTesterId, string>> = {};
  for (const pair of splitEnv('RIVENDELL_QA_SLACK_CHANNELS')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const id = pair.slice(0, eq).trim().toLowerCase();
    const channel = pair.slice(eq + 1).trim();
    if (channel && QA_TESTERS.some((t) => t.id === id)) channels[id as QaTesterId] = channel;
  }
  return channels;
}

/** assistant-mcp's real result shapes: a held send returns
 *  { held: true, draftId }; a confirmed send returns
 *  { success: true, channel, timestamp }. A throw means nothing is known
 *  (the draft may or may not have parked), which the caller treats as
 *  "attempt unknown" and never re-parks blindly. */
type SlackSendResult = {
  held?: boolean;
  draftId?: string;
  success?: boolean;
  timestamp?: string;
  channel?: string;
};

type SlackTool = (tool: string, payload: unknown) => Promise<SlackSendResult>;

/** The real Slack path: assistant-mcp's held-draft gate is never bypassed. */
const realSlackTool: SlackTool = (tool, payload) => callMcp<SlackSendResult>(tool, payload);

async function refreshQaPinsWith(slacker: SlackTool): Promise<{ refreshed: QaTesterId[]; held: QaTesterId[] }> {
  const channels = qaSlackChannels();
  const board = await qaBoard();
  const refreshed: QaTesterId[] = [];
  const held: QaTesterId[] = [];

  for (const tester of QA_TESTERS) {
    const channel = channels[tester.id];
    if (!channel) continue;
    const text = qaPinnedList(tester.id, board[tester.id]);
    // Read inside the serialized pass: refreshes are chained (below), so
    // this always sees the record the previous refresh left behind.
    const records = await pinStore.list();
    const record = records.find((r) => r.tester === tester.id && r.channel === channel);

    // The pin already shows exactly this list, or this exact list was
    // already attempted and is sitting in Matt's held drafts: another call
    // would only park a duplicate and change nothing.
    if (record?.text === text || record?.lastAttemptedText === text) continue;

    // slack_send_message posts a new message; there is no edit call, so
    // each landed refresh is a fresh post and the stored id names the
    // newest one (the one Sam pins). approved:false is the whole point:
    // the refresh never bypasses Matt's review gate.
    let sent: SlackSendResult;
    try {
      sent = await slacker('slack', {
        action: 'slack_send_message',
        params: { channel, text, approved: false },
      });
    } catch {
      // The call may have parked a draft before failing (a timeout after
      // the insert). Nothing is recorded, so this exact text is attempted
      // at most once more, never swept: the next attempt only happens when
      // the list actually changes or a person lands an outcome.
      held.push(tester.id);
      continue;
    }
    if (sent?.success === true && sent.timestamp) {
      if (record) await pinStore.update(record.id, { channel, messageTs: sent.timestamp, text, lastAttemptedText: text });
      else await pinStore.create({ tester: tester.id, channel, messageTs: sent.timestamp, text, lastAttemptedText: text });
      refreshed.push(tester.id);
    } else {
      // Parked as a draft, refused, or unconfigured: nothing reached Slack.
      // Remember the attempt so the next sweep does not park it again.
      if (record) await pinStore.update(record.id, { channel, lastAttemptedText: text });
      else await pinStore.create({ tester: tester.id, channel, lastAttemptedText: text });
      held.push(tester.id);
    }
  }
  return { refreshed, held };
}

let refreshChain: Promise<unknown> = Promise.resolve();

/** Refresh every configured tester's pin from the live board. Best-effort
 *  by design: the board mutation already succeeded, and a Slack path that
 *  is absent, hold-gated or down must never fail the request that moved a
 *  card. Callers log the held list instead of treating it as an error.
 *  Refreshes are chained through one promise so two card changes close
 *  together can never both read "no record yet" and double-post. */
export function refreshQaPins(): Promise<{ refreshed: QaTesterId[]; held: QaTesterId[] }> {
  const run = refreshChain.then(async () => {
    try {
      return await refreshQaPinsWith(realSlackTool);
    } catch {
      return { refreshed: [], held: QA_TESTERS.map((t) => t.id) };
    }
  });
  refreshChain = run.then(() => undefined, () => undefined);
  return run;
}

export const qaPinsForTest = { refreshQaPinsWith };
