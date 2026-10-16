// Group channels: named rooms of teammates, Slack-style smallest version.
// A channel is a name plus member teammates; posts land in the channel's
// history for everyone. This file owns only the data (store + queries);
// fan-out delivery and reply routing layer on top of it later.

import { JsonStore } from '../lib/jsonStore.ts';
import { MAX_TEXT, agentLaneKeys, deliverTeamMessage, dropQueuedChannelDeliveries, liveChannelTurnLanesByName, teamRoster } from './teamBus.ts';
import { activeChatSessions, interruptSession } from './runner.ts';
import { laneChatId } from './threadKey.ts';
import { chatAttachmentPath } from '../routes/chatAttachments.ts';

export type Channel = { id: string; name: string; members: string[]; createdAt?: string; updatedAt?: string; color?: string };

/** The fixed channel color palette. Mirrored client-side in
 *  src/chat/hooks/useChannels.ts — keep the two lists in sync. */
export const CHANNEL_COLORS = ['#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#3b82f6', '#10b981', '#84cc16', '#64748b'] as const;
/** Image attachments ride the same file store as the main chat: the post
 *  body carries base64 images, the route persists them as attachment files
 *  and only these refs land on the message record. */
export type ChannelMessage = { id: string; channelId: string; from: string; text: string; createdAt?: string; updatedAt?: string; images?: Array<{ id: string; mediaType: string }> };

/** One channel post is bounded, like every other write surface here. */
export const CHANNEL_TEXT_LIMIT = 20_000;

const channels = new JsonStore<Channel>('channels.json', []);
const messages = new JsonStore<ChannelMessage>('channel-messages.json', []);

/** Names in the list that are not teammates (empty when all are known). */
export async function unknownTeammates(names: string[]): Promise<string[]> {
  const roster = await teamRoster();
  const known = new Set(roster.map((agent) => agent.name));
  return names.filter((name) => !known.has(name));
}

export async function listChannels(): Promise<Channel[]> {
  return channels.list();
}

export async function findChannel(id: string): Promise<Channel | null> {
  return (await channels.list()).find((channel) => channel.id === id) ?? null;
}

export async function createChannel(name: string, members: string[]): Promise<Channel> {
  return channels.create({ name, members });
}

export async function updateChannel(id: string, patch: Partial<Channel>): Promise<Channel | null> {
  return channels.update(id, patch);
}

export async function deleteChannel(id: string): Promise<boolean> {
  return channels.delete(id);
}

/** A deleted channel takes its history with it. One atomic read-modify-write
 * so a post landing mid-purge cannot be erased by a stale list. */
export async function deleteChannelMessages(channelId: string): Promise<void> {
  await messages.modify((items) => items.filter((message) => message.channelId !== channelId));
}

export async function postChannelMessage(channelId: string, from: string, text: string, images?: Array<{ id: string; mediaType: string }>): Promise<ChannelMessage> {
  return messages.create(images?.length ? { channelId, from, text, images } : { channelId, from, text });
}

/** Most recent history, oldest first, capped. */
export async function channelHistory(channelId: string, limit: number): Promise<ChannelMessage[]> {
  const rows = (await messages.list()).filter((message) => message.channelId === channelId);
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return rows.slice(-limit);
}

// ---------------------------------------------------------------------------
// Fan-out delivery. A post always lands in history for everyone; delivery
// decides who is actually woken.

/** Matt's own post is hop 1; up to 3 agent-to-agent hops may follow it. */
export const CHANNEL_HOP_CAP = 4;

/** Members whose names appear as @mentions in the text. Longer names match
 * first, so @Sam Wise never also wakes a member named Sam. */
export function mentionedMembers(text: string, members: string[]): string[] {
  if (!members.length) return [];
  const sorted = [...members].sort((a, b) => b.length - a.length);
  const pattern = `@(?:${sorted.map((member) => member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w])`;
  const re = new RegExp(pattern, 'gi');
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0].slice(1);
    const member = sorted.find((m) => m.length === raw.length && m.toLowerCase() === raw.toLowerCase());
    if (member) seen.add(member);
  }
  return sorted.filter((member) => seen.has(member));
}

export type ChannelFanOut = { delivered: string[]; skipped: string[]; hop: number; capped?: boolean };

/** Deliver one channel post to whoever should hear it: the post with recent
 *  history and the reply rules. The poster's own post (a human posting) wakes
 *  every member; an agent's reply wakes only the members it @mentions, one hop
 *  deeper, and never past the cap. A capped reply still lands in history but
 *  wakes no one. Fan-out failures are collected, never thrown at the caller.
 *
 *  personPoster must come from a trusted signal (the route's explicit owner
 *  check), never inferred from a non-roster name: the agent MCP posts through
 *  the same route with its own name, and sessions without an agent identity
 *  send names like "Companion" that are not on the roster (review finding 1).
 *  Person-class steering (human interrupt, main lane) applies ONLY to the
 *  members the post actually @mentions, so a room post never cuts every
 *  member's unrelated work mid-turn; unmentioned members get the ordinary
 *  peer/background wake (review finding 4). */
export async function deliverChannelPost(
  channel: Channel,
  poster: string,
  text: string,
  receivedHop: number,
  personPoster = false,
  images?: Array<{ id: string; mediaType: string }>,
): Promise<ChannelFanOut> {
  const roster = await teamRoster();
  const isAgent = roster.some((agent) => agent.name === poster);
  // Matt's own post is hop 1. An agent reply must carry the hop number from
  // its ping; a missing or invalid hop fails closed (history only, wakes no
  // one) so the fan-out cap can never be reset by omitting it.
  const hop = isAgent
    ? (Number.isFinite(receivedHop) && receivedHop >= 1
      ? Math.min(Math.floor(receivedHop), CHANNEL_HOP_CAP) + 1
      : CHANNEL_HOP_CAP + 1)
    : 1;
  const mentioned = mentionedMembers(text, channel.members);
  const targets = !isAgent
    ? channel.members
    : hop > CHANNEL_HOP_CAP ? [] : mentioned;
  const earlier = (await channelHistory(channel.id, 9)).slice(0, -1);
  const guidance =
    `Reply in the channel with the channel_post tool (channel: "${channel.id}", from: "${isAgent ? poster : 'your own name'}"),`
    + ' including the hop number from this ping. Include @Name to address one member; only they need to answer.'
    + ' Without an @, answer only if the message is for you or you have something real to add;'
    + ' if nothing is needed from you, stay silent (do not reply at all, never send NO_UPDATE).'
    + ' Channel talk stays in the channel; never move it into a one-on-one thread.';
  const header = `[#${channel.name} group channel \u2014 handoff ${hop}] ${poster} posted:\n\n`;
  const imagePaths = (images ?? []).map((a) => chatAttachmentPath(a.id));
  const imageBlock = imagePaths.length
    ? `${text.trim() ? '\n\n' : ''}[${poster} attached ${imagePaths.length === 1 ? 'an image' : `${imagePaths.length} images`}. Open ${imagePaths.length === 1 ? 'it' : 'them'} with Read before replying: ${imagePaths.join(', ')}]`
    : '';
  // The delivered bundle must fit MAX_TEXT with the reply rules intact, so
  // the post text is clamped (with a visible note) and the history block is
  // clamped per message and dropped first when there is no room.
  const truncationNote = '\n(post text truncated for delivery; the full text is in the channel history)\n';
  const roomForText = MAX_TEXT - header.length - imageBlock.length - guidance.length - 2;
  const textPart = text.length > roomForText
    ? `${text.slice(0, Math.max(0, roomForText - truncationNote.length))}${truncationNote}`
    : text;
  const bodyPart = `${textPart}${imageBlock}`;
  let historyBlock = '';
  if (earlier.length) {
    let used = header.length + bodyPart.length + guidance.length + 2;
    const kept: string[] = [];
    for (const m of earlier) {
      const mPaths = (m.images ?? []).map((a) => chatAttachmentPath(a.id));
      const mText = m.text.length > 400 ? `${m.text.slice(0, 400)}\u2026` : m.text;
      const mImg = mPaths.length ? `${mText.trim() ? ' ' : ''}[images: ${mPaths.join(', ')}]` : '';
      const line = `${m.from}: ${mText}${mImg}`;
      if (used + line.length + 2 > MAX_TEXT) break;
      kept.push(line);
      used += line.length + 1;
    }
    historyBlock = kept.length ? `\nEarlier in this channel:\n${kept.join('\n')}\n` : '';
  }
  const bundle = `${header}${bodyPart}\n\n${guidance}` + historyBlock;
  const delivered: string[] = [];
  const skipped: string[] = [];
  for (const member of targets) {
    try {
      const result = await deliverTeamMessage({
        from: poster,
        to: member,
        text: bundle,
        source: 'channel',
        channel: { id: channel.id, name: `#${channel.name}` },
        hop,
        // Person-class goes to the members the post actually addresses: an
        // @mention, or every member when the channel has just one (nothing
        // Matt says there should need an @). Other members get the ordinary
        // peer/background wake, so a room post never takes over their main
        // lane or interrupts unrelated work (review 3, P1 3). A member with
        // a live turn from this channel is still steered at admission time
        // even without an @, so follow-ups join the same conversation.
        personPosted: personPoster && (mentioned.includes(member) || channel.members.length === 1),
        // Quiet hours (card-6b6916): Matt's own channel post is person-sourced
        // for every member of the room even when unmentioned (where personPosted
        // stays false so the post uses the bg lane instead of interrupting main).
        personSourced: personPoster ? true : undefined,
        // Ordering only: person posts already sort ahead via personPosted;
        // the flag is kept so the mention tier stays explicit (review 3, P2 10).
        priority: !isAgent && mentioned.includes(member) ? true : undefined,
        wait: false,
      });
      if (result.delivered) delivered.push(member);
      else skipped.push(member);
    } catch {
      skipped.push(member);
    }
  }
  return { delivered, skipped, hop, ...(isAgent && hop > CHANNEL_HOP_CAP ? { capped: true } : {}) };
}

// ---------------------------------------------------------------------------
// Working state and Stop (card-1327b9): Matt's channel posts wake and steer
// members, and the channel view shows who is working with a Stop control,
// exactly like the one-on-one chat.

export type ChannelMemberActivity = { member: string; lane: 'main' | 'bg'; lastActivityMs: number; fromChannel: boolean };

/** Which channel members have a live busy turn right now, in either lane,
 *  and whether that turn is THIS channel's work. A busy member whose turn
 *  came from elsewhere (one-on-one work, another channel, routines) shows
 *  as busy elsewhere — visible, but never Stoppable from here, so a channel
 *  Stop cannot kill work the channel did not start (review finding 4).
 *  Read-only: roster lane keys plus the runner's live session list.
 *  lastActivityMs is the last event time, not the turn's start. A lane
 *  matches on cli plus the account-pin-stripped chat id — the background
 *  suffix is kept, so main and background never compare equal (review 3,
 *  P0 1). This channel's lanes are checked first, so a member running a
 *  channel turn on background while busy on main with one-on-one work
 *  still shows the channel's turn with its Stop (review 3, P1 4). */
export async function channelMemberActivity(channelId: string, members: string[]): Promise<ChannelMemberActivity[]> {
  const live = activeChatSessions();
  const out: ChannelMemberActivity[] = [];
  for (const member of members) {
    const keys = agentLaneKeys(member);
    if (!keys) continue;
    const channelLanes = new Set(await liveChannelTurnLanesByName(member, channelId));
    const ordered = [...keys].sort((a, b) => Number(channelLanes.has(b.lane)) - Number(channelLanes.has(a.lane)));
    for (const { lane, cli, chatKey } of ordered) {
      const session = live.find((s) => s.busy === true && s.cli === cli && laneChatId(s.chatId) === chatKey);
      if (session) {
        out.push({ member, lane, lastActivityMs: session.lastActivityAt, fromChannel: channelLanes.has(lane) });
        break;
      }
    }
  }
  return out;
}

/** Stop a channel member's live turn in THIS channel: drop the member's
 *  still-queued pings from this channel first (aborting any delivery worker
 *  already holding its batch, so the dropped post cannot re-fire the moment
 *  the interrupt ends the busy turn), then interrupt only the lanes running
 *  a turn this channel started — a member busy on unrelated work is left
 *  alone. Interrupting the main lane still ends its background siblings by
 *  engine design, exactly like the one-on-one Stop. Empty stopped lanes
 *  means nothing from this channel was running; the UI can say so. */
export async function stopChannelMember(channelId: string, member: string): Promise<{ stopped: Array<'main' | 'bg'>; dropped: number }> {
  const keys = agentLaneKeys(member);
  if (!keys) throw new Error(`no teammate named "${member}" — they may have left the roster`);
  const dropped = await dropQueuedChannelDeliveries(member, channelId);
  const channelLanes = new Set(await liveChannelTurnLanesByName(member, channelId));
  const stopped: Array<'main' | 'bg'> = [];
  for (const { lane, cli, chatKey } of keys) {
    if (!channelLanes.has(lane)) continue;
    const session = activeChatSessions().find((s) => s.busy === true && s.cli === cli && laneChatId(s.chatId) === chatKey);
    if (!session) continue;
    await interruptSession({ cli: session.cli, repoPath: session.cwd, chatId: session.chatId });
    stopped.push(lane);
  }
  return { stopped, dropped };
}