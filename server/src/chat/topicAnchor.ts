// One Max (card-e14342): every lane that answers Matt in a thread must see
// the same current topic. Lanes share a transcript but not the live topic,
// so a background lane could answer a question the foreground had just
// settled, with the opposite content. The anchor is the server-side record
// of the topic Matt set most recently in a thread. It changes only when
// Matt changes it: teammate messages, job results and other lanes' answers
// never move it.

export interface TopicAnchor {
  threadKey: string;
  topic: string;
  setBy: string;
  setAt: number;
}

const anchors = new Map<string, TopicAnchor>();

/** Record the topic Matt set in a thread. Only Matt (the thread owner,
 *  passed as actor) may set or replace an anchor; any other actor is a
 *  no-op, so a lane can never move the anchor under the foreground. */
export function setTopicAnchor(threadKey: string, topic: string, actor: string, owner: string, now: number = Date.now()): TopicAnchor | null {
  if (!threadKey || !topic.trim()) return null;
  if (actor !== owner) return anchors.get(threadKey) ?? null;
  const anchor: TopicAnchor = { threadKey, topic: topic.trim(), setBy: actor, setAt: now };
  anchors.set(threadKey, anchor);
  return anchor;
}

export function getTopicAnchor(threadKey: string): TopicAnchor | null {
  return anchors.get(threadKey) ?? null;
}

/** The line injected into a lane's context before it answers Matt, so the
 *  lane argues from the topic Matt set, not from its own stale history. */
export function topicAnchorContext(threadKey: string): string | null {
  const a = anchors.get(threadKey);
  if (!a) return null;
  return `Current topic in this thread (set by Matt, do not drift from it until Matt changes it): ${a.topic}`;
}

export function clearTopicAnchor(threadKey: string): void {
  anchors.delete(threadKey);
}
