/** Oct 21 (card-c960fa): the pre-restart state copy must survive live
 *  writers. A jobs.json tmp file that vanishes between the directory list
 *  and the copy open failed the gate's first try on a busy TARDIS; the copy
 *  must skip it, keep copying, heal a path that comes back, and still fail
 *  honestly on real destination, root, unreadable, or required-state
 *  errors. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyTree, stateFilter } from './state-copy.mjs';

const tmps = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'state-copy-test-'));
  tmps.push(d);
  return d;
}
test.after(() => {
  for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
const asRoot = process.getuid?.() === 0;

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
  assert.equal(result.healed, 0, 'a genuinely gone path is not healed');
  assert.equal(result.files, 2);
});

test('a vanished path that comes back is healed into the copy, not dropped', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'a.json'), 'aaa');
  fs.writeFileSync(path.join(src, 'live.json'), 'old');
  fs.writeFileSync(path.join(src, 'z.json'), 'zzz');
  // live.json vanishes at its own copy (a lost hot race or a sweep) and the
  // writer brings it back before the walk ends: the heal pass must take it.
  let vanishArmed = true;
  let backArmed = true;
  const result = copyTree(src, dest, {
    filter: (s) => {
      if (s.endsWith('a.json') && vanishArmed) {
        vanishArmed = false;
        fs.rmSync(path.join(src, 'live.json'));
      }
      if (s.endsWith('z.json') && backArmed) {
        backArmed = false;
        fs.writeFileSync(path.join(src, 'live.json'), 'back');
      }
      return true;
    },
  });
  assert.equal(fs.readFileSync(path.join(dest, 'live.json'), 'utf8'), 'back', 'the recreated file is copied by the heal pass');
  assert.equal(result.vanished, 0, 'a healed path is not also counted vanished');
  assert.equal(result.healed, 1);
  assert.equal(result.files, 3);
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

test('a directory that turns into a file mid-walk is copied as that file', () => {
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
        fs.writeFileSync(path.join(src, 'sub'), 'now a file');
      }
      return true;
    },
  });
  assert.equal(fs.readFileSync(path.join(dest, 'sub'), 'utf8'), 'now a file');
  assert.equal(fs.readFileSync(path.join(dest, 'top.json'), 'utf8'), 't');
  assert.equal(result.vanished, 0);
});

test('a file that turns into a directory mid-copy is walked, with its children copied', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'flip'), 'was a file');
  fs.writeFileSync(path.join(src, 'top.json'), 't');
  let armed = true;
  const result = copyTree(src, dest, {
    filter: (s) => {
      if (armed) {
        armed = false;
        fs.rmSync(path.join(src, 'flip'));
        fs.mkdirSync(path.join(src, 'flip'));
        fs.writeFileSync(path.join(src, 'flip', 'child.json'), 'c');
      }
      return true;
    },
  });
  assert.equal(fs.readFileSync(path.join(dest, 'flip', 'child.json'), 'utf8'), 'c', 'the new directory shape is walked');
  assert.equal(fs.statSync(path.join(dest, 'flip')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(dest, 'top.json'), 'utf8'), 't');
  assert.equal(result.vanished, 0);
});

test('a destination parent that is a file fails the copy instead of counting a vanish', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'a.json'), 'a');
  fs.mkdirSync(path.join(dest, 'sub'));
  // A torn earlier attempt left dest/sub as a file: the copy into it must
  // fail as a destination error, never pass as a tolerated writer vanish.
  let armed = true;
  assert.throws(() => copyTree(src, dest, {
    filter: (s) => {
      // Fire after the walk has mkdir'd dest/sub, at the child's own copy:
      // the copy into it must fail as a destination error, never pass as a
      // tolerated writer vanish.
      if (armed && s.endsWith('a.json')) {
        armed = false;
        fs.rmSync(path.join(dest, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'sub'), 'torn earlier attempt');
      }
      return true;
    },
  }), (err) => err.code === 'ENOTDIR');
});

test('an unreadable source is skipped and reported by default, and fails with failOnUnreadable', { skip: asRoot && 'permission bits are meaningless as root' }, () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'ok.json'), 'ok');
  fs.mkdirSync(path.join(src, 'subdir'));
  fs.writeFileSync(path.join(src, 'subdir', 'secret'), 's');
  fs.chmodSync(path.join(src, 'subdir', 'secret'), 0o000);
  try {
    const result = copyTree(src, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'ok.json'), 'utf8'), 'ok');
    assert.deepEqual(result.unreadable, [path.join('subdir', 'secret')], 'reported by its path relative to the root');
    assert.equal(result.vanished, 0);
    // The pre-restart check's mode: strict, like fs.cpSync was.
    const dest2 = tmpDir();
    assert.throws(() => copyTree(src, dest2, { failOnUnreadable: true }), (err) => err.code === 'EACCES');
  } finally {
    fs.chmodSync(path.join(src, 'subdir', 'secret'), 0o600);
  }
});

test('a failure writing the destination still fails the check', { skip: asRoot && 'permission bits are meaningless as root' }, () => {
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

test('a missing state root fails the copy instead of producing an empty side copy', () => {
  const dest = tmpDir();
  assert.throws(() => copyTree(path.join(dest, 'does-not-exist'), path.join(dest, 'out')), (err) => err.code === 'ENOENT');
});

test('a required file that the copy lost fails with ESTATEREQUIRED', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'desk.json'), '{"desk":true}');
  fs.writeFileSync(path.join(src, 'other.json'), '{}');
  const onlyOther = (s) => path.basename(s) !== 'desk.json';
  assert.throws(
    () => copyTree(src, dest, { filter: onlyOther, required: ['desk.json'] }),
    (err) => err.code === 'ESTATEREQUIRED' && /desk\.json/.test(err.message),
  );
  // A required file absent from the source is the caller's business, not a copy failure.
  const dest2 = tmpDir();
  copyTree(src, dest2, { filter: onlyOther, required: ['absent-in-source.json'] });
});

test('a must-exist file missing from the source fails with ESTATEREQUIRED', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'other.json'), '{}');
  assert.throws(
    () => copyTree(src, dest, { mustExist: ['desk.json'] }),
    (err) => err.code === 'ESTATEREQUIRED' && /missing from the source/.test(err.message),
  );
  // Without mustExist, the same absence stays the caller's business.
  copyTree(src, dest);
});

test('an unreadable state root fails the copy', { skip: asRoot && 'permission bits are meaningless as root' }, () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'a.json'), 'a');
  fs.chmodSync(src, 0o000);
  try {
    assert.throws(() => copyTree(src, dest), (err) => err.code === 'EACCES');
  } finally {
    fs.chmodSync(src, 0o700);
  }
});

test('a required file that copied torn fails with ESTATEREQUIRED', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'desk.json'), '{"torn":'); // invalid JSON in the source
  assert.throws(
    () => copyTree(src, dest, { required: ['desk.json'] }),
    (err) => err.code === 'ESTATEREQUIRED',
  );
});

test('a fifo is skipped and reported, never opened (it would hang)', (t) => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'a.json'), 'a');
  const fifo = path.join(src, 'api.sock');
  const made = spawnSync('mkfifo', [fifo]);
  if (made.status !== 0) return t.skip('mkfifo not available on this platform');
  const result = copyTree(src, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'a.json'), 'utf8'), 'a');
  assert.ok(result.skipped.includes('api.sock'), 'the fifo is reported as skipped, not copied and not fatal');
  assert.equal(result.unreadable.length, 0, 'a special kind is not a permission failure');
  assert.equal(result.vanished, 0);
});

test('a symlink that stays inside the tree is recreated; one pointing out or into excluded bulk is skipped and reported', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'real.json'), 'r');
  fs.symlinkSync('real.json', path.join(src, 'in-tree.link'));
  fs.symlinkSync(path.resolve(src, 'real.json'), path.join(src, 'absolute.link'));
  fs.symlinkSync('..', path.join(src, 'escape.link'));
  fs.mkdirSync(path.join(src, 'sub'));
  fs.symlinkSync('../real.json', path.join(src, 'sub', 'up-in-tree.link'));
  fs.mkdirSync(path.join(src, 'event-logs'));
  fs.symlinkSync('event-logs/x.json', path.join(src, 'bulk.link'));
  const result = copyTree(src, dest, { filter: stateFilter(src, { big: ['event-logs'] }) });
  assert.equal(fs.readFileSync(path.join(dest, 'in-tree.link'), 'utf8'), 'r', 'in-tree link recreated and resolves in the copy');
  assert.equal(fs.readFileSync(path.join(dest, 'sub', 'up-in-tree.link'), 'utf8'), 'r', 'an in-tree ../ link resolves inside the copy, not out of it');
  assert.equal(fs.existsSync(path.join(dest, 'absolute.link')), false);
  assert.equal(fs.existsSync(path.join(dest, 'escape.link')), false);
  assert.equal(fs.existsSync(path.join(dest, 'bulk.link')), false, 'a link into excluded bulk is not recreated dangling');
  assert.ok(result.skipped.includes('absolute.link') && result.skipped.includes('escape.link') && result.skipped.includes('bulk.link'));
});

test('a trailing separator or relative state root still recognizes in-tree links', () => {
  const src = tmpDir();
  const dest = tmpDir();
  fs.writeFileSync(path.join(src, 'real.json'), 'r');
  fs.symlinkSync('real.json', path.join(src, 'in-tree.link'));
  const result = copyTree(src + path.sep, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'in-tree.link'), 'utf8'), 'r', 'an in-tree link survives a non-normalized root');
  const dest2 = tmpDir();
  const cwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    const rel = copyTree(path.join('.', path.basename(src)), dest2);
    assert.equal(fs.readFileSync(path.join(dest2, 'in-tree.link'), 'utf8'), 'r', 'an in-tree link survives a relative root');
    assert.equal(rel.skipped.length, 0);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(result.skipped.length, 0);
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
