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
 *    the side copy boots from.
 *  - A source that exists but cannot be read is skipped and reported: the
 *    side copy boots on the rest, and the boot/probe legs — not the copy —
 *    decide the verdict.
 *  - The state ROOT and every REQUIRED file (below) are load-bearing: an
 *    unreadable root or a required file that did not survive the copy fails
 *    the copy (code ESTATEREQUIRED for the latter), because a side copy
 *    without them silently exercises far less of the real system than the
 *    check claims to prove.
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

/** Copy a tree from `src` to `dest`, tolerating live writers. `filter` is
 *  called with each SOURCE path (files, directories and symlinks) and keeps
 *  the fs.cpSync-era contract: true means copy. `required` lists paths
 *  relative to `src` that must exist in the copy whenever they exist in the
 *  source and must be valid JSON (the check's always-copy set, e.g.
 *  desk.json); a required file that is missing or torn throws an error with
 *  code ESTATEREQUIRED so the caller can retry the whole copy. Returns
 *  { files, bytes, vanished, unreadable } so the caller can report what it
 *  skipped instead of hiding it. */
export function copyTree(src, dest, opts = {}) {
  const filter = opts.filter ?? (() => true);
  const required = opts.required ?? [];
  const result = { files: 0, bytes: 0, vanished: 0, unreadable: [] };
  walk(src, dest, true);
  enforceRequired();
  return result;

  function walk(from, to, isRoot = false) {
    let entries;
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch (err) {
      // The state root is load-bearing: an unreadable, missing or wrong
      // RIVENDELL_STATE_DIR must fail the check, not silently produce an
      // empty side copy that exercises nothing it claims to prove.
      if (isRoot) throw err;
      if (err.code === 'ENOTDIR') return copyFile(from, to); // a directory turned into a file mid-walk
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
      if (entry.isDirectory()) walk(fp, tp);
      else if (entry.isSymbolicLink()) copyLink(fp, tp);
      else if (entry.isFile()) copyFile(fp, tp);
      else classifyEntry(fp, tp); // DT_UNKNOWN, fifo, socket, device: never open blindly
    }
  }

  /** Classify by lstat, never by opening: a fifo with no writer would hang
   *  an open forever, and a socket open errors oddly. Present-but-uncopyable
   *  kinds are skipped and reported. */
  function classifyEntry(fp, tp) {
    let st = null;
    try {
      st = fs.lstatSync(fp);
    } catch (err) {
      classify(err, fp);
      return;
    }
    if (st.isFile()) copyFile(fp, tp);
    else if (st.isDirectory()) walk(fp, tp);
    else if (st.isSymbolicLink()) copyLink(fp, tp);
    else result.unreadable.push(rel(fp)); // fifo, socket, block/char device
  }

  function copyFile(fp, tp) {
    // Prove the source is readable BEFORE blaming a failure on a live
    // writer: after a good open, an error is a destination or system
    // problem unless the source itself stopped being that same file.
    try {
      const fd = fs.openSync(fp, 'r');
      fs.closeSync(fd);
    } catch (err) {
      classify(err, fp);
      return;
    }
    try {
      fs.copyFileSync(fp, tp);
      result.files += 1;
    } catch (err) {
      if (!VANISHED.has(err.code)) throw err;
      // A recreating writer (delete + rewrite, rename dance) can make the
      // copy fail on a source that exists again a moment later: one retry
      // converges on the new content instead of failing the check.
      if (stillAFile(fp)) {
        try {
          fs.copyFileSync(fp, tp);
          result.files += 1;
          return;
        } catch (err2) {
          if (!VANISHED.has(err2.code)) throw err2;
        }
      }
      // The source never came back as a file: a live writer's vanish.
      // Anything else (the destination's parent vanished, the dest is a
      // directory) fails the check rather than quietly shrinking the copy.
      if (!stillAFile(fp)) { result.vanished += 1; return; }
      throw err;
    }
    try {
      result.bytes += fs.statSync(tp).size;
    } catch {
      // Counted, not required.
    }
  }

  function copyLink(fp, tp) {
    // A link is recreated only when it stays inside the copied tree: an
    // absolute or parent-escaping link would point the side copy back at
    // live state or somewhere else entirely, so those are skipped and
    // reported. Links are never followed into the copy.
    let target;
    try {
      target = fs.readlinkSync(fp);
    } catch (err) {
      classify(err, fp);
      return;
    }
    const norm = path.normalize(target);
    if (path.isAbsolute(norm) || norm === '..' || norm.startsWith(`..${path.sep}`)) {
      result.unreadable.push(rel(fp));
      return;
    }
    try {
      fs.rmSync(tp, { force: true });
      fs.symlinkSync(target, tp);
      result.files += 1;
    } catch (err) {
      if (VANISHED.has(err.code) && !fs.existsSync(fp)) { result.vanished += 1; return; }
      throw err;
    }
  }

  function classify(err, fp) {
    if (VANISHED.has(err.code)) { result.vanished += 1; return; }
    if (UNREADABLE.has(err.code)) { result.unreadable.push(rel(fp)); return; }
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

  function enforceRequired() {
    const missing = [];
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
