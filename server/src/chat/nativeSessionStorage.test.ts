import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tardis-native-storage-'));
process.env.RIVENDELL_STATE_DIR = join(root, 'state');
const { prepareClaudeNativeStorage } = await import('./nativeSessionStorage.ts');
const { claudeSessionJsonlBytes } = await import('./threadWindow.ts');

after(() => rmSync(root, { recursive: true, force: true }));

test('a symlink alias of the same Claude project skips transcript and artifact copies', () => {
  const profile = join(root, 'profile');
  const alias = join(root, 'profile-alias');
  mkdirSync(profile, { recursive: true });
  symlinkSync(profile, alias, 'dir');

  const lane = 'ordinary-lane';
  const cwd = '/synthetic/workspace';
  const sessionId = 'native-session-id';
  const first = prepareClaudeNativeStorage(lane, profile, null, cwd);
  assert.ok(first.project);
  const project = join(profile, 'projects', first.project!);
  const transcript = join(project, `${sessionId}.jsonl`);
  const artifacts = join(project, sessionId);
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(transcript, '{"type":"assistant"}\n');
  writeFileSync(join(artifacts, 'tool-result.txt'), 'kept');
  first.accept(sessionId);
  assert.equal(claudeSessionJsonlBytes('claude', cwd, sessionId), Buffer.byteLength('{"type":"assistant"}\n'));

  assert.doesNotThrow(() => prepareClaudeNativeStorage(lane, alias, sessionId, cwd));
  assert.equal(readFileSync(transcript, 'utf8'), '{"type":"assistant"}\n');
  assert.equal(readFileSync(join(artifacts, 'tool-result.txt'), 'utf8'), 'kept');
});

test('first failover adopts an ordinary lane transcript from the preferred profile', () => {
  const preferred = join(root, 'preferred-profile');
  const backup = join(root, 'backup-profile');
  const legacyProject = join(preferred, 'projects', 'legacy-workspace');
  const lane = 'first-failover-lane';
  const cwd = '/synthetic/first-failover';
  const sessionId = 'pre-registry-session';
  mkdirSync(legacyProject, { recursive: true });
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(legacyProject, `${sessionId}.jsonl`), '{"type":"assistant","message":"kept"}\n');

  const storage = prepareClaudeNativeStorage(lane, backup, sessionId, cwd, [preferred]);
  assert.equal(storage.reseed, false);
  assert.ok(storage.project);
  assert.equal(
    readFileSync(join(backup, 'projects', storage.project!, `${sessionId}.jsonl`), 'utf8'),
    '{"type":"assistant","message":"kept"}\n',
  );
});
