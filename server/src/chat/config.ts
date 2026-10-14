import { homedir } from 'node:os';
import { join } from 'node:path';

export const PORT = Number(process.env.PORT) || 8091;

// Event-log retention window (entries per lane log), on this leaf module
// so the log store, compaction, and the runners can share it without an
// import cycle evaluating it before initialization.
export const MAX_EVENTS_PER_LOG = 2000;

// Where to scan for repos. Each entry is a parent directory; first-level
// children that contain a .git folder are treated as repos.
export const REPO_SCAN_PATHS: string[] = [
  join(homedir(), 'code'),
  join(homedir(), 'Documents', 'PERSONAL-PROJECTS'),
];

// Two-level scan paths: for each entry, look at every subfolder (except
// IGNORED_HUBS), then scan THAT for repos. Lets ~/samwise act as a workspace
// containing hubs (Personal-Apps, KG-Apps, YPP-Apps, Elite-Apps) that each
// hold many repos.
export const REPO_SCAN_HUB_PATHS: string[] = [
  join(homedir(), 'samwise'),
];

// Hub-level subfolders to skip when walking REPO_SCAN_HUB_PATHS.
export const IGNORED_HUB_NAMES = new Set<string>(['worktrees', 'node_modules']);

// The Assistant Hub — surfaced as the "Assistant" companion's repo.
// Moved off OneDrive to a Syncthing-managed local folder. Env override lets
// Windows (where ASSISTANT-HUB lives at C:\ASSISTANT-HUB) point at its real
// location without code changes.
export const ASSISTANT_HUB_PATH =
  process.env.ELROND_WORKSPACE_PATH || join(homedir(), 'ASSISTANT-HUB');

export const CROSS_COMPUTER_SHARE_PATH = join(
  homedir(),
  'Library',
  'CloudStorage',
  'OneDrive-Personal',
  'Documents',
  'CROSS-COMPUTER-SHARE',
);

export const CLAUDE_COMMANDS_DIR = join(CROSS_COMPUTER_SHARE_PATH, 'claude-commands');
export const CODEX_SKILLS_DIR = join(CROSS_COMPUTER_SHARE_PATH, 'skills');
export const BANANA_DIR = join(CROSS_COMPUTER_SHARE_PATH, 'bananacode');
export const BANANA_COMMANDS_DIR = join(BANANA_DIR, 'Commands');
export const BANANA_GLOBAL_INSTRUCTIONS_FILE = join(BANANA_DIR, '.banana.md');

// --- Hall slash-menu command discovery ---
// The CROSS-COMPUTER-SHARE tree above is an optional Mac/OneDrive layout that
// may not exist on a Linux host, so the /api/commands catalog could return
// empty — that's the "0 commands / no autocomplete" in Hall. These point at the
// real per-account command dirs that the spawned CLIs actually load from, and
// are env-overridable for other hosts:
//   Claude Code -> $CLAUDE_CONFIG_DIR/commands or ~/.claude/commands
//   Codex       -> ~/.codex/prompts (flat *.md)
// Custom account/profile maps remain explicit operator configuration.
export const ELROND_COMMANDS_DIR =
  process.env.RIVENDELL_ELROND_COMMANDS_DIR || join(homedir(), '.claude', 'commands');
export const CODEX_PROMPTS_DIR =
  process.env.RIVENDELL_CODEX_PROMPTS_DIR || join(homedir(), '.codex', 'prompts');

// Where Claude Code persists its session JSONL files.
export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Where TARDIS persists its (repo,cli) -> claude session_id map.
export const STATE_DIR = process.env.RIVENDELL_STATE_DIR || join(homedir(), '.rivendell');
export const SESSIONS_FILE = join(STATE_DIR, 'chat-sessions.json');
