// A desk write must credit a real author. The regression this guards (Oct 17
// 2026): lanes that curl the comment API with an `author` field posted as the
// owner, because the route read only `agent` and treated a missing identity as
// the Desk UI. Now: agent or author names a teammate, the owner is reachable
// only through the UI marker, and anything else is refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.RIVENDELL_STATE_DIR = mkdtempSync(join(tmpdir(), `desk-author-${process.pid}-`));
process.env.RIVENDELL_OWNER_NAME = 'Matt';

import { resolveWriteAuthor } from './desk.ts';
import type { DeskActor } from '../lib/deskStore.ts';

const teammate = (a: DeskActor) => `${a.kind}:${a.id}`;

test('author alias credits the teammate (raw curl field)', () => {
  assert.equal(teammate(resolveWriteAuthor({ author: 'maria' })), 'agent:maria');
});

test('agent field credits the teammate (team MCP field)', () => {
  assert.equal(teammate(resolveWriteAuthor({ agent: 'Maria Gallardo' })), 'agent:maria-gallardo');
});

test('agent wins when both fields are present', () => {
  assert.equal(teammate(resolveWriteAuthor({ agent: 'felix', author: 'maria' })), 'agent:felix');
});

test('an owner name from outside the UI is refused, never silently credited', () => {
  assert.throws(() => resolveWriteAuthor({ agent: 'Matt' }), /Desk UI/);
  assert.throws(() => resolveWriteAuthor({ author: 'owner' }), /Desk UI/);
});

test('a write with no identity is refused', () => {
  assert.throws(() => resolveWriteAuthor({}), /teammate name/);
  assert.throws(() => resolveWriteAuthor({ text: 'hello' }), /teammate name/);
});

test('the UI marker is the only path to the owner', () => {
  assert.equal(teammate(resolveWriteAuthor({ source: 'ui' })), 'owner:owner');
  assert.equal(teammate(resolveWriteAuthor({ ui: true })), 'owner:owner');
});
