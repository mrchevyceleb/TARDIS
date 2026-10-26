import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'tardis-sessions-'));
process.env.RIVENDELL_STATE_DIR = state;
writeFileSync(join(state, 'chat-sessions.json'), JSON.stringify({
  'muse|bot-legacy': {
    cli: 'muse',
    sessionId: 'legacy-session',
    generation: 1,
    updatedAt: 1,
  },
  'muse|/workspace/studio|studio': {
    cli: 'muse',
    sessionId: 'studio-session',
    updatedAt: 1,
  },
}));
const { getSessionId, setSessionId } = await import('./sessions.ts');

test.after(() => rmSync(state, { recursive: true, force: true }));

test('Muse resumes only in the workspace that created its native session', async () => {
  await setSessionId('muse', '/workspace/one/', 'muse-session', 'bot-example');

  assert.equal(await getSessionId('muse', '/workspace/one', 'bot-example'), 'muse-session');
  assert.equal(await getSessionId('muse', '/workspace/two', 'bot-example'), undefined);
  const stored = JSON.parse(readFileSync(join(state, 'chat-sessions.json'), 'utf8'));
  assert.equal(stored['muse|bot-example'].workspace, '/workspace/one');
});

test('legacy Muse records without workspace provenance are seeded instead of resumed', async () => {
  assert.equal(await getSessionId('muse', '/workspace/legacy', 'bot-legacy'), undefined);
});

test('a legacy repo-scoped Muse record already proves its workspace', async () => {
  assert.equal(await getSessionId('muse', '/workspace/studio', 'studio'), 'studio-session');
});
