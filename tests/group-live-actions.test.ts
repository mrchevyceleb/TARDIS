import assert from 'node:assert/strict';
import test from 'node:test';
import { groupHasLiveContent } from '../src/chat/data/liveGroup.ts';
import type { ChatBlock } from '../src/chat/data/types.ts';

const asBlocks = (v: unknown) => v as ChatBlock[];

test('a settled group is not live, so its actions survive a sibling turn', () => {
  // Regression (card-7c8931 review, Oct 19 2026): a settled response must keep
  // copy/pin/reply while the NEXT turn is thinking. The earlier gate trusted
  // ChatThread's last-group flag, which still names the settled response
  // between a new user message and the first assistant block.
  assert.equal(
    groupHasLiveContent(asBlocks([{ kind: 'text', open: false }, { kind: 'tool', running: false }])),
    false,
  );
});

test('an open text block or a running tool marks the group live', () => {
  assert.equal(groupHasLiveContent(asBlocks([{ kind: 'text', open: true }])), true);
  assert.equal(groupHasLiveContent(asBlocks([{ kind: 'tool', running: true }])), true);
});
