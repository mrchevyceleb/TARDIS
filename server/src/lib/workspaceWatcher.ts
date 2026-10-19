import chokidar from 'chokidar';
import { readdir } from 'node:fs/promises';
import { relative } from 'node:path';
import { ELROND_WORKSPACE_PATH } from '../config.ts';
import { workspaceRoot } from './workspace.ts';
import { isHubRootPollution } from './hubPaths.ts';
import { emitScribe } from '../worker/scribe.ts';

// Directories chokidar must PRUNE (never recurse into). Matching the directory
// itself — not just its contents — is what stops chokidar from crawling huge
// subtrees (node_modules, .git, build output) and stat'ing every file inside,
// which OOM-killed the server on the 37k-file Syncthing-managed hub. The regex
// anchors on a path segment so it prunes at any depth on posix AND windows.
const PRUNE_RE =
  /(^|[/\\])(node_modules|\.git|dist|\.next|\.turbo|\.venv|__pycache__|\.stfolder|\.stversions|\.stignore)([/\\]|$)/;

// Individual throwaway files to ignore (matched as anymatch globs).
const IGNORED_FILES = ['**/*.swp', '**/*.swx', '**/*~', '**/.DS_Store'];

const IGNORED: Array<string | RegExp> = [PRUNE_RE, ...IGNORED_FILES];

// Bounded recursion (Max, Oct 19 2026, card-16bc3e): a full recursive watch of
// the Syncthing hub held ~428k inotify watches in the live server process
// (460k files against a 524,288 box limit), which filled the limit and killed
// Sam's build at 13:17 on Oct 19. Depth 3 keeps every surface work actually
// happens on: top-level dirs and control files, scratch/<day>/<task> dirs and
// their direct files, Shares/pages/<name>/index.html, inbox notes. Measured
// live on Oct 19 2026: 79,442 watches at depth 3, and the probe still saw
// scratch task-file events fire. Repo sources under projects/ are
// intentionally out of scope; their builds and editors own those watches.
const WATCH_DEPTH = 3;

type WatcherOp = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

let watcher: ReturnType<typeof chokidar.watch> | null = null;

// Burst coalescer: Syncthing lands files in batches, and emitting one Scribe
// row per file floods Supabase (and the activity log). Queue changes for a short
// window, then emit a single summarized event. Pollution canaries stay immediate.
const COALESCE_MS = 400;
const MAX_PATHS_IN_PAYLOAD = 50;
let pending: Array<{ op: WatcherOp; rel: string }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPending(): void {
  flushTimer = null;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  const uniq = [...new Set(batch.map((b) => b.rel))];
  const text =
    uniq.length === 1
      ? `Workspace: ${batch[0]!.op} ${uniq[0]}`
      : `Workspace: ${batch.length} changes · ${uniq[0]}`;
  void emitScribe({
    level: 'system',
    text,
    payload: {
      kind: 'workspace-change',
      paths: uniq.slice(0, MAX_PATHS_IN_PAYLOAD),
      count: batch.length,
      by: 'fs',
    },
  });
}

function queueChange(op: WatcherOp, rel: string): void {
  pending.push({ op, rel });
  if (flushTimer) return;
  flushTimer = setTimeout(flushPending, COALESCE_MS);
}

function toPosixRel(root: string, absPath: string): string {
  return relative(root, absPath).split('\\').join('/');
}

export function startWorkspaceWatcher(): void {
  const enabled = process.env.RIVENDELL_FS_WATCH !== 'false';
  if (!enabled) {
    console.log('[workspace-watcher] disabled (RIVENDELL_FS_WATCH=false)');
    return;
  }
  const root = workspaceRoot();
  watcher = chokidar.watch(root, {
    ignored: IGNORED,
    persistent: true,
    ignoreInitial: true,
    depth: WATCH_DEPTH,
    // No awaitWriteFinish: it turned every pending write into a 50ms polling
    // loop, which multiplies into a stat storm on a large tree. Pure inotify +
    // the coalescer above handles multi-chunk writes without the polling cost.
  });

  const handle = (op: WatcherOp) => (absPath: string) => {
    const rel = toPosixRel(root, absPath);
    if (!rel || rel.startsWith('..')) return;
    queueChange(op, rel);
    // Root pollution canary: something landed outside the closed hub schema.
    // Emitted immediately (not coalesced) so it's never buried in a burst.
    if ((op === 'add' || op === 'addDir') && isHubRootPollution(rel)) {
      void emitScribe({
        level: 'note',
        text: `Hub root pollution: ${rel} (move into inbox/projects/areas/resources/scratch or delete)`,
        payload: { kind: 'hub-root-pollution', op, path: rel, by: 'fs' },
      });
    }
  };

  watcher
    .on('add', handle('add'))
    .on('change', handle('change'))
    .on('unlink', handle('unlink'))
    .on('addDir', handle('addDir'))
    .on('unlinkDir', handle('unlinkDir'))
    .on('error', (err) => console.error('[workspace-watcher] error:', err));

  // One-shot root scan so pollution that appeared while TARDIS was down is noted.
  void readdir(root, { withFileTypes: true })
    .then((entries) => {
      for (const entry of entries) {
        if (!isHubRootPollution(entry.name)) continue;
        void emitScribe({
          level: 'note',
          text: `Hub root pollution (startup): ${entry.name}`,
          payload: { kind: 'hub-root-pollution', op: entry.isDirectory() ? 'addDir' : 'add', path: entry.name, by: 'fs' },
        });
      }
    })
    .catch((err) => console.error('[workspace-watcher] startup scan failed:', err));

  console.log(`[workspace-watcher] watching ${ELROND_WORKSPACE_PATH}`);
}

export function stopWorkspaceWatcher(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushPending();
  }
  void watcher?.close();
  watcher = null;
}
