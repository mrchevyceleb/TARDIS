/**
 * Vanish-tolerant state tree copy for the pre-restart check (Matt's standing
 * rule, Oct 13 2026; first-try flake class fixed Oct 21 2026, card-c960fa).
 *
 * The live TARDIS state dir is written WHILE the check copies it: the job
 * runner saves jobs.json through a tmp file that is renamed into place, and
 * other writers rotate logs and receipts the same way. A path that exists
 * when the walker lists a directory can be gone by the time it is opened.
 * fs.cpSync treated that as an error, so a busy TARDIS failed the check's
 * FIRST try and passed the retry (it hit Jessica and Max on Oct 21).
 *
 * Contract:
 *  - Copy what exists when we get to it.
 *  - A path that vanishes or changes shape mid-walk is skipped and counted,
 *    never fatal: it was a live writer's atomic-rename artifact, not state
 *    the side copy boots from. One heal pass runs after the walk: a path
 *    that is BACK in the source is copied then, so a hot race or a
 *    delete-then-recreate writer cannot silently drop a real state file;
 *    a path that is genuinely gone stays a tolerated, named skip.
 *  - A source that exists but cannot be read for permissions is the
 *    caller's call: `failOnUnreadable` (the pre-restart check passes it)
 *    fails the copy on the spot, because a side copy that silently boots
 *    without the file proves less than the check claims; without the
 *    option it is skipped and reported for the caller to judge.
 *  - Special file kinds (fifo, socket, device) and links that would point
 *    the side copy outside itself (absolute or parent-escaping targets,
 *    or a link into bulk the filter excludes) are skipped and reported in
 *    `skipped`: layout is not the build, and the live state has none today.
 *  - The state ROOT and every REQUIRED file (below) are load-bearing: an
 *    unreadable or missing root, or a required file that did not survive
 *    the copy, fails the copy (code ESTATEREQUIRED for the latter),
 *    because a side copy without them silently exercises far less of the
 *    real system than the check claims to prove.
 *  - A failure writing the DESTINATION, a failing device (EIO), or running
 *    out of a system resource stays fatal: then the check genuinely cannot
 *    prepare a side copy and an honest FAIL with the real error is right.
 */

import fs from 'node:fs';
import path from 'node:path';

/** There at list time, gone (or a different shape) at open time: a live
 *  writer renamed, rotated or deleted it mid-walk. */
const VANISHED = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);
/** Exists but cannot be opened for reading from this process: permissions,
 *  a symlink loop, an over-long or over-deep name. EIO is deliberately NOT
 *  here: a failing device is a system failure and must fail the check. */
const UNREADABLE = new Set(['EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'EOVERFLOW']);
/** A path flipped between file and directory more than this many times
 *  during one copy is a pathological writer, not state: counted as churn
 *  and left to the heal pass, never recursed into forever. */
const MAX_FLIP = 32;

/** Copy a tree from `src` to `dest`, tolerating live writers. `filter` is
 *  called with each SOURCE path (files, directories and symlinks) and keeps
 *  the fs.cpSync-era contract: true means copy. `required` lists paths
 *  relative to `src` that must exist in the copy whenever they exist in the
 *  source and must be valid JSON (the check's always-copy set, e.g.
 *  desk.json); a required file that is missing or torn throws an error with
 *  code ESTATEREQUIRED so the caller can retry the whole copy. `mustExist`
 *  lists paths that must exist in the SOURCE at all. Returns
 *  { files, bytes, vanished, vanishedPaths, healed, healedPaths, skipped,
 *  unreadable } so the caller can report what it skipped and what it
 *  recovered, by name, instead of hiding it. */
export function copyTree(src, dest, opts = {}) {
  const filter = opts.filter ?? (() => true);
  const required = opts.required ?? [];
  const mustExist = opts.mustExist ?? [];
  const failOnUnreadable = opts.failOnUnreadable ?? false;
  // One normalized form for every comparison and recreation: a trailing
  // separator or a relative RIVENDELL_STATE_DIR would otherwise misclassify
  // every in-tree link as an escape (Oct 21).
  src = path.resolve(src);
  dest = path.resolve(dest);
  const result = { files: 0, bytes: 0, vanished: 0, vanishedPaths: [], healed: 0, healedPaths: [], skipped: [], unreadable: [] };
  walk(src, dest, 0, true);
  healVanished();
  enforceRequired();
  return result;

  function walk(from, to, hops = 0, isRoot = false, retried = false) {
    let entries;
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch (err) {
      // The state root is load-bearing: an unreadable, missing or wrong
      // RIVENDELL_STATE_DIR must fail the check, not silently produce an
      // empty side copy that exercises nothing it claims to prove.
      if (isRoot) throw err;
      // A delete-then-recreate writer: the directory exists again, so look
      // once more before giving up on its contents.
      if (err.code === 'ENOENT' && !retried && fs.existsSync(from)) return walk(from, to, hops, false, true);
      if (err.code === 'ENOTDIR') return copyFile(from, to, hops); // a directory turned into a file mid-walk
      classify(err, from);
      return;
    }
    // A failure creating the destination directory is always ours, never a
    // live writer's: fail loudly instead of silently shrinking the copy.
    fs.mkdirSync(to, { recursive: true });
    for (const entry of entries) {
      const fp = path.join(from, entry.name);
      let wanted = true;
      try {
        wanted = filter(fp);
      } catch {
        // The caller's filter already tolerates its own stat races; one that
        // still throws is treated as "copy it" and the copy decides.
      }
      if (!wanted) continue;
      const tp = path.join(to, entry.name);
      if (entry.isDirectory()) walk(fp, tp, hops);
      else if (entry.isSymbolicLink()) copyLink(fp, tp);
      else if (entry.isFile()) copyFile(fp, tp, hops);
      else classifyEntry(fp, tp, hops); // DT_UNKNOWN, fifo, socket, device: never open blindly
    }
  }

  /** Classify by lstat, never by opening: a fifo with no writer would hang
   *  an open forever, and a socket open errors oddly. Present-but-uncopyable
   *  kinds are skipped and reported. */
  function classifyEntry(fp, tp, hops = 0) {
    let st = null;
    try {
      st = fs.lstatSync(fp);
    } catch (err) {
      classify(err, fp);
      return;
    }
    if (st.isFile()) copyFile(fp, tp, hops);
    else if (st.isDirectory()) walk(fp, tp, hops);
    else if (st.isSymbolicLink()) copyLink(fp, tp);
    else result.skipped.push(rel(fp)); // fifo, socket, block/char device
  }

  function copyFile(fp, tp, hops = 0) {
    // Prove the source is readable BEFORE blaming a failure on a live
    // writer. A delete-then-recreate writer that exists again a moment
    // later gets one more look instead of being dropped for good.
    let probed = false;
    for (;;) {
      try {
        const fd = fs.openSync(fp, 'r');
        fs.closeSync(fd);
        break;
      } catch (err) {
        if (VANISHED.has(err.code) && !probed) {
          probed = true;
          if (stillAFile(fp)) continue; // it is back: probe once more
        }
        classify(err, fp);
        return;
      }
    }
    let last = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.copyFileSync(fp, tp);
        result.files += 1;
        try {
          result.bytes += fs.statSync(tp).size;
        } catch {
          // Counted, not required.
        }
        return;
      } catch (err) {
        if (err.code === 'EISDIR') {
          let st = null;
          try { st = fs.statSync(fp); } catch {}
          if (st && st.isDirectory()) {
            if (hops >= MAX_FLIP) { last = err; break; } // endless shape-flipping: churn, not state
            // A failed copy can leave an empty destination file where the
            // walk needs a directory; remove it, then walk the new shape.
            fs.rmSync(tp, { force: true });
            walk(fp, tp, hops + 1);
            return;
          }
          if (st && st.isFile()) {
            // The destination is a directory left by an earlier shape of
            // this path: drop it so the file can land there.
            fs.rmSync(tp, { force: true, recursive: true });
            continue;
          }
          throw err;
        }
        if (!VANISHED.has(err.code)) throw err;
        last = err;
        // A recreating writer (delete + rewrite, rename dance) can make the
        // copy fail on a source that exists again a moment later: one retry
        // converges on the new content instead of dropping the file.
        if (!stillAFile(fp)) break; // the source is really gone
      }
    }
    // Two attempts lost a hot source race, or the source never came back.
    // ENOTDIR and friends can come from the DESTINATION side too, so prove
    // the destination's parent is a real directory before calling this the
    // source's churn: a destination failure stays fatal. Otherwise count
    // the vanish, name it, and let the heal pass take one more look.
    let parentIsDir = false;
    try { parentIsDir = fs.statSync(path.dirname(tp)).isDirectory(); } catch { /* parent gone */ }
    if (!parentIsDir) throw last;
    result.vanished += 1;
    result.vanishedPaths.push(rel(fp));
  }

  function copyLink(fp, tp) {
    // A link is recreated only when it stays inside the copied tree AND its
    // target is part of the copy: anything else would dangle or point the
    // side copy back at live state, so those are skipped and reported.
    // Links are never followed into the copy.
    let target;
    try {
      target = fs.readlinkSync(fp);
    } catch (err) {
      classify(err, fp);
      return;
    }
    // An absolute target is skipped even when it points inside the tree:
    // recreated verbatim it still points at the LIVE path, so following it
    // at runtime would read from or write into live state, not the copy.
    if (path.isAbsolute(target)) {
      result.skipped.push(rel(fp));
      return;
    }
    const resolved = path.resolve(path.dirname(fp), target);
    if (resolved !== src && !resolved.startsWith(src + path.sep)) {
      result.skipped.push(rel(fp));
      return;
    }
    // A link into bulk the filter excludes (event-logs and friends) would
    // dangle in the copy: its target was never copied. Skip it with the
    // other reported kinds instead of counting a file that resolves nowhere.
    let wanted = true;
    try { wanted = filter(resolved); } catch { wanted = true; }
    if (!wanted) {
      result.skipped.push(rel(fp));
      return;
    }
    try {
      fs.rmSync(tp, { force: true });
      fs.symlinkSync(target, tp);
      result.files += 1;
    } catch (err) {
      if (VANISHED.has(err.code) && !fs.existsSync(fp)) {
        result.vanished += 1;
        result.vanishedPaths.push(rel(fp));
        return;
      }
      throw err;
    }
  }

  function classify(err, fp) {
    if (VANISHED.has(err.code)) {
      result.vanished += 1;
      result.vanishedPaths.push(rel(fp));
      return;
    }
    if (UNREADABLE.has(err.code)) {
      if (failOnUnreadable) {
        throw Object.assign(new Error(`state file unreadable (${err.code}): ${rel(fp)}`), { code: err.code });
      }
      result.unreadable.push(rel(fp));
      return;
    }
    throw err;
  }

  function stillAFile(fp) {
    try {
      return fs.statSync(fp).isFile();
    } catch {
      return false;
    }
  }

  function rel(fp) {
    return path.relative(src, fp) || path.basename(fp);
  }

  /** A vanished path that is BACK in the source was a hot race or a
   *  delete-then-recreate writer, not a throwaway tmp file: copy it now so
   *  a real state file cannot be silently dropped from the side copy. A
   *  path that churns away again mid-heal lands back on the vanished list,
   *  still named and counted. */
  function healVanished() {
    if (!result.vanishedPaths.length) return;
    for (const relPath of [...result.vanishedPaths]) {
      const from = path.join(src, relPath);
      const to = path.join(dest, relPath);
      let st = null;
      try { st = fs.lstatSync(from); } catch { continue; } // genuinely gone: a tolerated skip
      result.vanishedPaths = result.vanishedPaths.filter((p) => p !== relPath);
      result.vanished -= 1;
      try {
        if (st.isDirectory()) {
          try { if (!fs.statSync(to).isDirectory()) fs.rmSync(to, { force: true }); } catch { /* dest absent */ }
          walk(from, to);
        } else if (st.isFile()) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          copyFile(from, to);
        } else if (st.isSymbolicLink()) {
          copyLink(from, to);
        } else {
          result.skipped.push(relPath);
          continue;
        }
        if (!result.vanishedPaths.includes(relPath)) {
          result.healed += 1;
          result.healedPaths.push(relPath);
        }
      } catch (err) {
        if (err.code === 'ESTATEREQUIRED') throw err;
        // Destination and system failures never became tolerable.
        if (!VANISHED.has(err.code) && !UNREADABLE.has(err.code)) throw err;
        // It churned again: back on the vanished list, still reported.
        classify(err, from);
      }
    }
  }

  function enforceRequired() {
    const missing = [];
    for (const relPath of mustExist) {
      const from = path.join(src, relPath);
      let srcHas = false;
      try { srcHas = fs.statSync(from).isFile(); } catch {}
      if (!srcHas) missing.push(`${relPath} (missing from the source)`);
    }
    for (const relPath of required) {
      const from = path.join(src, relPath);
      const to = path.join(dest, relPath);
      let srcHas = false;
      try { srcHas = fs.statSync(from).isFile(); } catch { /* absent in the source: not the copy's problem */ }
      if (!srcHas) continue;
      let ok = false;
      try { ok = fs.statSync(to).isFile() && !isTornJson(to); } catch { /* missing or unreadable */ }
      if (!ok) missing.push(relPath);
    }
    if (missing.length) {
      throw Object.assign(
        new Error(`required state file(s) missing or unreadable after the copy: ${missing.join(', ')}`),
        { code: 'ESTATEREQUIRED' },
      );
    }
  }
}

function isTornJson(p) {
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
    return false;
  } catch {
    return true;
  }
}

/** The check's state selection, unchanged from the fs.cpSync era: skip the
 *  bulk directories, always take the named top-level files however large
 *  (desk.json outgrew the bulk cap, Oct 17), take anything else up to
 *  `maxBytes`. A stat that fails keeps the path in — the copy attempt then
 *  decides what a vanished path means. */
export function stateFilter(root, { big = [], always = [], maxBytes = 8 * 1024 * 1024 } = {}) {
  root = path.resolve(root);
  return (s) => {
    const rel = path.relative(root, s);
    if (!rel) return true;
    if (always.includes(rel)) return true;
    const top = rel.split(path.sep)[0];
    if (big.includes(top)) return false;
    try {
      return fs.statSync(s).size <= maxBytes;
    } catch {
      return true;
    }
  };
}
