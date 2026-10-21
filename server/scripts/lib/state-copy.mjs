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
 *    decide the verdict, so no skip can turn a broken build into a PASS.
 *  - A failure writing the DESTINATION, or running out of a system resource,
 *    stays fatal: then the check genuinely cannot prepare a side copy and an
 *    honest FAIL with the real error is the right answer.
 */

import fs from 'node:fs';
import path from 'node:path';

/** There at list time, gone (or a different shape) at open time: a live
 *  writer renamed, rotated or deleted it mid-walk. */
const VANISHED = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);
/** Exists but cannot be opened for reading from this process: permissions,
 *  a symlink loop, an over-long or over-deep name, or a failing device. */
const UNREADABLE = new Set(['EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'EOVERFLOW', 'EIO']);

/** Copy a tree from `src` to `dest`, tolerating live writers. `filter` is
 *  called with each SOURCE path (files, directories and symlinks) and keeps
 *  the fs.cpSync-era contract: true means copy. Returns
 *  { files, bytes, vanished, unreadable } so the caller can report what it
 *  skipped instead of hiding it. */
export function copyTree(src, dest, opts = {}) {
  const filter = opts.filter ?? (() => true);
  const result = { files: 0, bytes: 0, vanished: 0, unreadable: [] };
  walk(src, dest);
  return result;

  function walk(from, to) {
    let entries;
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch (err) {
      if (VANISHED.has(err.code)) { result.vanished += 1; return; }
      if (UNREADABLE.has(err.code)) { result.unreadable.push(path.basename(from)); return; }
      throw err;
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
      else if (entry.isSymbolicLink()) copyLink(fp, tp, entry.name);
      else copyFile(fp, tp, entry.name);
    }
  }

  function copyFile(fp, tp, name) {
    // Prove the source is readable BEFORE blaming a failure on a live
    // writer: after a successful open, anything but a fresh vanish is a
    // destination or system problem and must fail the check, not quietly
    // drop state the side copy would have booted with.
    try {
      const fd = fs.openSync(fp, 'r');
      fs.closeSync(fd);
    } catch (err) {
      if (VANISHED.has(err.code)) { result.vanished += 1; return; }
      if (UNREADABLE.has(err.code)) { result.unreadable.push(name); return; }
      throw err;
    }
    try {
      fs.copyFileSync(fp, tp);
      result.files += 1;
    } catch (err) {
      // Renamed away between our open and the copy: still just a vanish.
      if (err.code === 'ENOENT') { result.vanished += 1; return; }
      throw err;
    }
    try {
      result.bytes += fs.statSync(tp).size;
    } catch {
      // Counted, not required.
    }
  }

  function copyLink(fp, tp, name) {
    // Recreated verbatim (the link's own target string), never followed: a
    // link is not state to dereference into an unbounded copy.
    let target;
    try {
      target = fs.readlinkSync(fp);
    } catch (err) {
      if (VANISHED.has(err.code)) { result.vanished += 1; return; }
      if (UNREADABLE.has(err.code)) { result.unreadable.push(name); return; }
      throw err;
    }
    try {
      fs.rmSync(tp, { force: true });
      fs.symlinkSync(target, tp);
      result.files += 1;
    } catch (err) {
      if (err.code === 'ENOENT') { result.vanished += 1; return; }
      throw err;
    }
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
