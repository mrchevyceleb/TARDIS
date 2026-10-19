import type { ChatBlock } from './types';

/** True while a message group still has content being written: an open text
 *  block or a running tool. Message actions (copy/pin/reply) gate on this,
 *  never on the thread-wide streaming flag: a live sibling turn must not
 *  strip actions from settled messages (card-7c8931), and a settled response
 *  must keep them through the next turn's thinking interval (codex review,
 *  Oct 19 2026: trusting ChatThread's last-group flag hid exactly that). */
export function groupHasLiveContent(blocks: ChatBlock[]): boolean {
  return blocks.some((b) => (b.kind === 'text' && b.open) || (b.kind === 'tool' && b.running));
}
