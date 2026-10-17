// A desk write must credit a real author. The regression this guards (Oct 17
// 2026): lanes that curl the comment API with an `author` field posted as the
// owner, because the route read only `agent` and treated a missing identity as
// the Desk UI. Now: agent or author names a teammate, the owner is reachable
// only through the Desk app's own same-origin browser fetch (Sec-Fetch-Site,
// which curl cannot send and pages cannot forge), and anything else is
// refused. The error must never teach a lane how to post as the owner.
import './desk-author-env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

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
  assert.throws(() => resolveWriteAuthor({ agent: 'Matt' }, 'same-origin'), /Desk UI/);
});

test('a write with no identity is refused, without hinting how to pose as the owner', () => {
  assert.throws(() => resolveWriteAuthor({}), /teammate name/);
  assert.throws(() => resolveWriteAuthor({ text: 'hello' }), /teammate name/);
  assert.throws(() => resolveWriteAuthor({}), /teammate name/);
  const message = (() => { try { resolveWriteAuthor({}); return ''; } catch (e) { return String((e as Error).message); } })();
  assert.ok(!message.includes('source'), 'the refusal must not teach the UI marker');
  assert.ok(!message.includes('ui'), 'the refusal must not teach the UI marker');
});

test('the Desk app is credited only through a same-origin browser fetch', () => {
  assert.equal(teammate(resolveWriteAuthor({}, 'same-origin')), 'owner:owner');
  // A stale tab (old bundle, no marker) still writes: the browser-native
  // header is the proof, not the bundle.
  assert.equal(teammate(resolveWriteAuthor({ text: 'hi' }, 'same-origin')), 'owner:owner');
});

test('curl cannot reach the owner path, with or without the marker', () => {
  assert.throws(() => resolveWriteAuthor({ source: 'ui' }), /reload the Desk/);
  assert.throws(() => resolveWriteAuthor({ source: 'ui' }, 'cross-site'), /reload the Desk/);
  assert.throws(() => resolveWriteAuthor({ ui: true }), /teammate name/);
  assert.throws(() => resolveWriteAuthor({}, 'same-site'), /teammate name/);
  assert.throws(() => resolveWriteAuthor({}, 'none'), /teammate name/);
});
