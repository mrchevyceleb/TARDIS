/** Oct 21 (card-c960fa): the pre-restart state copy must survive live
 *  writers. A jobs.json tmp file that vanishes between the directory list
 *  and the copy open failed the gate's first try on a busy TARDIS; the copy
 *  must skip it, keep copying, and still fail honestly on real destination
 *  or system errors. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyTree, stateFilter } from './state-copy.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'state-copy-test-'));
}

test('a file that vanishes between list and copy is skipped, not fatal', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'a.json'), 'aaa');
  fs.writeFileSync(path.join(src, 'jobs.json.123.tmp'), 'half');
  fs.writeFileSync(path.join(src, 'c.json'), 'ccc');
  // The vanish lands inside the walker itself: the first filter call plays
  // the live writer and renames the tmp file away, so whichever order the
  // directory lists, the tmp file is gone before (or at) its own copy.
  let armed = true;
  const liveWriter = path.join(src, 'jobs.json.123.tmp');
  const result = copyTree(src, dest, {
    filter: (s) => {
      if (armed) {
        armed = false;
        fs.renameSync(liveWriter, path.join(src, 'jobs.json'));
      }
      return true;
    },
  });
  assert.equal(fs.readFileSync(path.join(dest, 'a.json'), 'utf8'), 'aaa');
  assert.equal(fs.readFileSync(path.join(dest, 'c.json'), 'utf8'), 'ccc');
  assert.equal(fs.existsSync(path.join(dest, 'jobs.json.123.tmp')), false);
  assert.equal(result.vanished, 1, 'the vanished tmp file is counted, not copied');
  assert.equal(result.files, 2);
});

test('a directory that vanishes mid-walk is skipped, not fatal', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'x.json'), 'x');
  fs.writeFileSync(path.join(src, 'top.json'), 't');
  let armed = true;
  const result = copyTree(src, dest, {
    filter: (s) => {
      if (armed) {
        armed = false;
        fs.rmSync(path.join(src, 'sub'), { recursive: true });
      }
      return true;
    },
  });
  assert.equal(fs.readFileSync(path.join(dest, 'top.json'), 'utf8'), 't');
  assert.equal(fs.existsSync(path.join(dest, 'sub')), false);
  assert.ok(result.vanished >= 1, 'the vanished directory is counted');
});

test('an unreadable source is skipped and reported, never fatal', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'ok.json'), 'ok');
  fs.writeFileSync(path.join(src, 'secret'), 's');
  fs.chmodSync(path.join(src, 'secret'), 0o000);
  try {
    const result = copyTree(src, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'ok.json'), 'utf8'), 'ok');
    assert.deepEqual(result.unreadable, ['secret']);
    assert.equal(result.vanished, 0);
  } finally {
    fs.chmodSync(path.join(src, 'secret'), 0o600);
  }
});

test('a failure writing the destination still fails the check', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'a.json'), 'a');
  fs.chmodSync(dest, 0o500); // readable, not writable
  try {
    assert.throws(() => copyTree(src, dest), (err) => err.code === 'EACCES');
  } finally {
    fs.chmodSync(dest, 0o700);
  }
});

test('the state filter keeps the fs.cpSync-era selection', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'event-logs'));
  fs.mkdirSync(path.join(root, 'personas'));
  fs.writeFileSync(path.join(root, 'desk.json'), 'd');
  fs.writeFileSync(path.join(root, 'tiny'), '1234');
  fs.writeFileSync(path.join(root, 'huge'), 'x'.repeat(5000));
  const f = stateFilter(root, { big: ['event-logs'], always: ['desk.json'], maxBytes: 4096 });
  assert.equal(f(root), true, 'the root itself is always taken');
  assert.equal(f(path.join(root, 'desk.json')), true, 'always-file, past any cap');
  assert.equal(f(path.join(root, 'event-logs', 'x.json')), false, 'bulk dir excluded');
  assert.equal(f(path.join(root, 'huge')), false, 'over the byte cap');
  assert.equal(f(path.join(root, 'personas')), true, 'directory itself');
  assert.equal(f(path.join(root, 'tiny')), true, 'under the byte cap');
  assert.equal(f(path.join(root, 'a-vanished.json')), true, 'stat failure keeps the path in; the copy decides');
});
