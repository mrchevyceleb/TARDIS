// Client-side companion to server/src/lib/proxyLinks.ts. Detects mentions of
// the workspace label `ASSISTANT-HUB/path/to/thing` (or the equivalent Windows
// absolute path under OneDrive) in freeform text and rewrites them to inline
// markdown links with custom protocols (`rivendell-doc:` / `rivendell-folder:`)
// so the Markdown renderer can swap them for in-app proxy cards. Display text
// is rendered as a configurable Windows path, and a clickable Windows path
// doubles as something the user can paste into Win+R when needed.

import { nativeShell, showToast } from '../../native/shell';
import { deskRefPattern, hasDeskRef, type DeskRef } from '../../data/desk';

const LABEL = 'ASSISTANT-HUB';
// Inside the desktop shell the local workspace is whatever that machine has
// (auto-detected or chosen in the Ship menu); browsers get the build-time
// Windows default.
const shellWorkspaceRoot = nativeShell()?.workspaceRoot?.replace(/[\\/]+$/, '');
export const WIN_WORKSPACE_PREFIX =
  shellWorkspaceRoot
  || (import.meta.env.VITE_RIVENDELL_WINDOWS_WORKSPACE_PATH || String.raw`C:\ASSISTANT-HUB`).replace(/[\\/]+$/, '');
// Separator of the local workspace path: backslashes for a Windows root,
// slashes for a macOS or Linux one.
const LOCAL_SEP = WIN_WORKSPACE_PREFIX.includes('\\') || /^[A-Za-z]:/.test(WIN_WORKSPACE_PREFIX) ? '\\' : '/';
export const NATIVE_OPEN_STORAGE_KEY = 'rivendell.native-open.installed.v2';
const UNIX_WORKSPACE_SOURCE = String.raw`\/(?:home|Users)\/[^/\s]+\/ASSISTANT-HUB`;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve the workspace-relative path TARDIS stores in ChatBlocks into the
// two URL forms a Windows client needs: a same-origin HTTP URL (the Tailscale
// front-door serves whatever TARDIS exposes on :8091, so this works from any
// device on the tailnet without a custom handler) and a `rivendell://` URL that
// the one-time PowerShell handler turns into `Start-Process` against the
// OneDrive-synced ASSISTANT-HUB copy on the local Windows PC.
export function buildLinkUrls(
  relPath: string,
  kind: 'doc' | 'folder',
): { browserUrl: string; nativeUrl: string; windowsPath: string } {
  const safeRel = (relPath || '').replace(/^\/+/, '');
  const windowsPath = safeRel === ''
    ? WIN_WORKSPACE_PREFIX
    : `${WIN_WORKSPACE_PREFIX}${LOCAL_SEP}${safeRel.split('/').join(LOCAL_SEP)}`;
  const browserUrl = `/api/files/raw?path=${encodeURIComponent(safeRel)}`;
  const nativeUrl = `rivendell://open?kind=${kind}&winpath=${encodeURIComponent(windowsPath)}`;
  return { browserUrl, nativeUrl, windowsPath };
}

// Triggers a `rivendell://` (or any custom scheme) URL in a way that does not
// navigate the current page. A throwaway hidden iframe whose `src` is the
// scheme URL is enough to fire the OS handler; the iframe load failure is
// silent in modern browsers, and unregistered-scheme dialogs only show in the
// top-level frame so the user gets at most a one-time "Open with…" prompt.
export function fireNativeScheme(url: string): void {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.setAttribute('aria-hidden', 'true');
  frame.src = url;
  document.body.appendChild(frame);
  setTimeout(() => {
    if (frame.parentNode) frame.parentNode.removeChild(frame);
  }, 1500);
}

export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Windows/i.test(navigator.userAgent);
}

function isAndroidChrome(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Android/i.test(ua)
    && /Chrome\//i.test(ua)
    && !/(?:EdgA|OPR|SamsungBrowser|Firefox|FxiOS)\//i.test(ua);
}

function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function androidViewIntent(url: URL): string {
  const scheme = url.protocol.slice(0, -1);
  const data = `${url.host}${url.pathname}${url.search}`;
  return `intent://${data}#Intent;scheme=${scheme};action=android.intent.action.VIEW;end`;
}

function openWindowsDefaultBrowser(url: URL): void {
  let handedOff = false;
  const markHandedOff = () => { handedOff = true; };
  const onVisibility = () => { if (document.visibilityState === 'hidden') markHandedOff(); };
  window.addEventListener('blur', markHandedOff, { once: true });
  document.addEventListener('visibilitychange', onVisibility);
  fireNativeScheme(`rivendell://open?url=${encodeURIComponent(url.href)}`);

  window.setTimeout(() => {
    window.removeEventListener('blur', markHandedOff);
    document.removeEventListener('visibilitychange', onVisibility);
    if (handedOff || document.visibilityState === 'hidden') return;
    // The acknowledged handler no longer responded. Make this click recoverable
    // and let future links use their ordinary target=_blank path until setup is
    // confirmed again. Top-level navigation is the only popup-safe async fallback.
    try { window.localStorage.removeItem(NATIVE_OPEN_STORAGE_KEY); } catch { /* best effort */ }
    window.location.assign(url.href);
  }, 3000);
}

/** Open an agent-supplied external HTTP(S) link outside an installed PWA.
 *  Returns true when the normal anchor navigation has been replaced.
 *
 *  Web platform APIs cannot choose the OS default browser directly. Windows
 *  uses TARDIS's one-time native scheme handler (Start-Process honors the
 *  default browser); Android hands the URL to ACTION_VIEW. Ordinary browser
 *  tabs and same-origin links retain normal target=_blank behavior. */
export function openExternalHttpLink(href: string): boolean {
  if (!isStandalonePwa() || typeof window === 'undefined') return false;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol) || url.origin === window.location.origin) return false;

  if (isWindowsPlatform()) {
    try {
      if (window.localStorage.getItem(NATIVE_OPEN_STORAGE_KEY) !== '1') return false;
    } catch {
      return false;
    }
    openWindowsDefaultBrowser(url);
    return true;
  }

  // Chrome's documented intent:// path is reliable on Android. Other Android
  // PWA runtimes differ (and may replace the PWA with the fallback URL), so
  // leave their ordinary target=_blank behavior untouched. Intent fragments
  // reserve `#Intent`; links with fragments/credentials also keep the normal,
  // lossless anchor path.
  if (isAndroidChrome() && !url.hash && !url.username && !url.password) {
    try {
      window.location.assign(androidViewIntent(url));
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

// Single entry point for "open this workspace path the right way for this
// device". The desktop shell opens it with the machine's own apps (fetching a
// copy from the ship when it is not synced locally). In a browser on Windows
// we fire the `rivendell://` handler; on phones, Macs, or Windows machines that
// haven't run the installer yet, we fall back to a path that always works —
// Tailscale-served HTTP for files, the in-app Library room for folders.
/** Open an absolute machine path the way Matt asked for: the folder in
 *  Explorer, or the file revealed in its folder, from the desktop shell on
 *  the machine he is on. Never launches anything; a quiet toast when the
 *  path does not exist on this PC. */
export function openMachineLink(absPath: string): void {
  const shellBridge = nativeShell();
  if (shellBridge?.openMachinePath) {
    shellBridge.openMachinePath(absPath)
      .then((result) => { if (!result.ok && result.error) showToast(result.error); })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : 'Could not open that path.'));
    return;
  }
  showToast('Machine paths open in the TARDIS desktop app on that PC.');
}

// Types that belong in a real app on the PC rather than in TARDIS's own viewer
// or editor: web pages (their scripts only run there), documents, images,
// media, Office files, and spreadsheets. Macro-capable Office formats (legacy
// .doc/.xls/.ppt, .xlsm, .xlsb, .rtf) are left out on purpose.
const NATIVE_APP_EXTS = new Set([
  '.html', '.htm', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff', '.heic', '.avif',
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a', '.ogg', '.flac',
  '.docx', '.dotx', '.xlsx', '.pptx', '.ppsx',
  '.odt', '.ods', '.odp', '.csv',
]);

// Text and data files that are safe to hand to the PC's default editor. They
// get the "Open on PC" button but keep opening in TARDIS's editor on a click.
// Together with NATIVE_APP_EXTS this is an ALLOWLIST: the desktop shell opens a
// synced local file with whatever Windows associates with it, so anything not
// named here (scripts, shortcuts, installers, odd extensions) is never offered
// or routed, whatever a denylist would have said.
const PC_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml',
  '.ini', '.cfg', '.conf', '.tsv', '.sql', '.rst', '.tex',
  '.ts', '.tsx', '.jsx', '.css', '.scss',
]);

// Mirrors LAUNCHABLE in desktop/src/approvals.ts. A folder link whose name ends
// in one of these is refused; the allowlist above already keeps them out of docs.
const LAUNCHABLE_EXTS = new Set([
  '.exe', '.msi', '.msix', '.appx', '.bat', '.cmd', '.com', '.scr', '.pif', '.cpl', '.hta',
  '.ps1', '.psm1', '.psd1', '.vbs', '.vbe', '.wsf', '.wsh', '.js', '.jse', '.mjs', '.cjs',
  '.jar', '.lnk', '.url', '.reg', '.inf', '.sct', '.msc', '.gadget', '.chm',
  '.sh', '.bash', '.zsh', '.fish', '.command', '.tool', '.app', '.dmg', '.pkg', '.mpkg',
  '.run', '.bin', '.out', '.apk', '.deb', '.rpm', '.appimage', '.flatpakref', '.snap',
  '.desktop', '.service', '.scpt', '.applescript', '.workflow', '.action',
  '.py', '.pyw', '.rb', '.pl', '.php', '.lua', '.tcl', '.ahk', '.jsp',
  '.scf', '.application', '.ws', '.xll', '.wll', '.slk', '.diagcab', '.appref-ms', '.settingcontent-ms',
  '.website', '.search-ms', '.library-ms', '.theme', '.themepack', '.cab', '.iso', '.vhd', '.vhdx',
  '.msp', '.mst', '.msu', '.jnlp', '.psc1', '.rdp', '.xbap', '.ps1xml', '.pssc', '.cdxml',
]);

// Also only ever a click-through on a plain, well-formed leaf name: no trailing
// dot or space (Windows drops them), no stream separator, no control chars.
const ODD_LEAF = /[.\s]$|:|[\u0000-\u001f]/;

function extensionOf(relPath: string): string {
  const leaf = relPath.split('/').pop() ?? '';
  if (ODD_LEAF.test(leaf)) return '';
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot).toLowerCase() : '';
}

/** True when the desktop shell can open this workspace link with the PC's own
 *  apps. Folders: only when the name does not look like a file (the shell
 *  cannot be trusted to tell, so a "folder" link at report.pdf is refused).
 *  Files: only known-safe types. False everywhere outside the desktop shell. */
export function canOpenOnThisPc(relPath: string, kind: 'doc' | 'folder'): boolean {
  if (!nativeShell()?.openWorkspacePath) return false;
  const leaf = relPath.split('/').pop() ?? '';
  if (ODD_LEAF.test(leaf) && leaf !== '') return false;
  const ext = extensionOf(relPath);
  if (kind === 'folder') return !NATIVE_APP_EXTS.has(ext) && !PC_TEXT_EXTS.has(ext) && !LAUNCHABLE_EXTS.has(ext);
  return NATIVE_APP_EXTS.has(ext) || PC_TEXT_EXTS.has(ext);
}

/** True when a plain click on this doc link should open it on the PC: the
 *  desktop shell is here and the file is the kind of thing that belongs in a
 *  real app. */
export function opensOnThisPcByClick(relPath: string, kind: 'doc' | 'folder'): boolean {
  return kind === 'doc' && canOpenOnThisPc(relPath, kind) && NATIVE_APP_EXTS.has(extensionOf(relPath));
}

/** What to call the PC's folder browser in a tooltip. */
export function fileManagerName(): string {
  return nativeShell()?.platform === 'win32' ? 'Explorer' : 'your file manager';
}

/** True inside the classic Studio IDE (/studio), which reveals folders in its
 *  own file tree. The agent app never does. */
export function inStudioShell(): boolean {
  return typeof window !== 'undefined' && /^\/studio(\/|$)/.test(window.location.pathname);
}

export function openWorkspaceLink(relPath: string, kind: 'doc' | 'folder', onFolderFallback?: () => void): void {
  const shell = nativeShell();
  if (shell?.openWorkspacePath) {
    // The shell already tried the machine's own apps; say why that failed and
    // use the fallbacks that can still work from here (never the rivendell://
    // scheme, which would land straight back in the shell).
    shell.openWorkspacePath(relPath, kind)
      .then((result) => {
        if (result.ok) return;
        if (result.error) showToast(result.error);
        // A policy refusal is final: no other way of opening it is tried.
        if (result.refused) return;
        openWorkspaceLinkInBrowser(relPath, kind, false, onFolderFallback);
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'Could not open that path.');
        openWorkspaceLinkInBrowser(relPath, kind, false, onFolderFallback);
      });
    return;
  }
  openWorkspaceLinkInBrowser(relPath, kind, true, onFolderFallback);
}

function openWorkspaceLinkInBrowser(relPath: string, kind: 'doc' | 'folder', allowNativeScheme: boolean, onFolderFallback?: () => void): void {
  const { browserUrl, nativeUrl } = buildLinkUrls(relPath, kind);
  if (allowNativeScheme && isWindowsPlatform()) {
    fireNativeScheme(nativeUrl);
    return;
  }
  if (kind === 'doc') {
    window.open(browserUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  // A folder that cannot open on this PC used to push the app into the legacy
  // /library route, a screen with no way back. Never navigate the app away:
  // show a closable file list instead.
  if (onFolderFallback) onFolderFallback();
  else showToast('That folder cannot be opened from here.');
}

// Workspace and OneDrive paths commonly contain spaces ("Client Dashboards/
// Q1 Plan.md"), so the matcher has to accept them inside segments. To avoid
// absorbing trailing prose, the lookahead caps the run at: end-of-text,
// newline, sentence punctuation, period-then-space (e.g. ".md "), or a space
// followed by a common English connective. This handles the common cases
// well enough — a stray over-match on unusual prose is preferable to
// breaking every path that contains a space.
const STOP_WORDS = '(?:and|or|but|the|a|an|is|are|was|were|to|of|in|on|at|by|for|that|which|because|since|so|then|with|from|as|when|where|while|after|before|will|would|should|can|could|may|might|like|this|these|those|it|its|i|we|you|he|she|they)';
const STOP_LOOKAHEAD = String.raw`(?=$|[,;:!?]|[\n\r]|\.(?:\s|$)|\s+${STOP_WORDS}\b|[)\]"'\`<>])`;
const WORKSPACE_MENTION = String.raw`\b${LABEL}(?:\/[^\n\r]+?)?`;
const WIN_MENTION = `${escapeRegex(WIN_WORKSPACE_PREFIX)}(?:${escapeRegex(LOCAL_SEP)}[^\\n\\r]+?)?`;
const UNIX_MENTION = `${UNIX_WORKSPACE_SOURCE}(?:/[^\\n\\r]+?)?`;
const MENTION_PATTERN = new RegExp(
  `(?:${WIN_MENTION}|${UNIX_MENTION}|${WORKSPACE_MENTION})${STOP_LOOKAHEAD}`,
  'g',
);

const TRAILING_PUNCT = /[\s).,;:!?\]'"`>]+$/;

// Absolute machine paths outside the workspace (C:\Users\...\Desktop and
// friends) become `rivendell-machine:` links: the desktop shell opens the
// folder in Explorer or reveals the file in its folder, with a quiet toast
// when the path does not exist on that PC. Workspace-prefixed paths stay
// workspace mentions (they carry fetch-and-open semantics).
const MACHINE_PATH_PATTERN = new RegExp(
  String.raw`\b[A-Za-z]:\\[^\n\r]+?${STOP_LOOKAHEAD}`,
  'g',
);

export function annotateMachinePaths(input: string): string {
  if (!/[A-Za-z]:\\/.test(input)) return input;
  return annotateMarkdownOutsideCode(input, (plain: string): string => {
    // A manual exec loop, not String.replace: the lazy matcher's prose
    // lookahead cuts at closers, which strands common Windows names like
    // "C:\\Downloads\\Report (1).pdf". An absorbed opener run is either
    // path-like ("Report (1)", no spaces inside) or prose ("(see log)"):
    // path-like runs take their closer and extension chain back from the
    // following text (which requires consuming past the match, something a
    // replace callback cannot do without duplicating the remainder), and
    // prose runs are trimmed off the path.
    const workspacePrefix = WIN_WORKSPACE_PREFIX.toLowerCase();
    let out = '';
    let last = 0;
    MACHINE_PATH_PATTERN.lastIndex = 0;
    for (let m = MACHINE_PATH_PATTERN.exec(plain); m !== null; m = MACHINE_PATH_PATTERN.exec(plain)) {
      const match = m[0];
      const offset = m.index;
      let end = offset + match.length;
      let clean = match;
      const trailingMatch = match.match(TRAILING_PUNCT);
      let trailing = trailingMatch ? trailingMatch[0] : '';
      if (trailing) clean = match.slice(0, match.length - trailing.length);
      const openRun = clean.match(/[([][^()[\]\n\r]*$/);
      if (openRun) {
        if (openRun[0].includes(' ')) {
          // Prose parenthetical: the path ends before it.
          clean = clean.slice(0, openRun.index);
          const retrim = clean.match(TRAILING_PUNCT);
          if (retrim) clean = clean.slice(0, clean.length - retrim[0].length);
          // Move the consumption point back to the trimmed path end, so
          // the prose parenthetical's closer is not mistaken for a markdown
          // link target's.
          end = offset + clean.length;
        } else {
          const opens = (clean.match(/[([]/g) ?? []).length;
          const closes = (clean.match(/[)\]]/g) ?? []).length;
          const rest = plain.slice(end);
          let take = 0;
          while (take < opens - closes && (rest[take] === ')' || rest[take] === ']')) take += 1;
          if (take > 0) {
            clean += rest.slice(0, take);
            end += take;
            trailing = '';
            // The prose lookahead cut at the closer, so a file extension
            // that follows it ("Report (1).pdf") got stranded outside the
            // match. Absorb the extension chain back onto the path.
            const extension = rest.slice(take).match(/^((?:\.[A-Za-z0-9_-]+)+)/);
            if (extension) { clean += extension[1]; end += extension[1].length; }
          }
        }
      }
      // Bounded workspace exclusion, computed from the final cleaned path:
      // only the workspace root itself or a child under a separator stays a
      // workspace mention (its siblings like C:\...\ASSISTANT-HUB-old\x are
      // machine paths, and trailing punctuation never changes the verdict).
      const lower = clean.toLowerCase();
      const isWorkspace = lower === workspacePrefix
        || lower.startsWith(`${workspacePrefix}\\`)
        || lower.startsWith(`${workspacePrefix}/`);
      // Skip anything already inside a markdown link label or target: the
      // agent may have written its own links around these paths. Checked
      // after the closer re-attachment, so a path's own closing paren is not
      // mistaken for a link target's.
      const before = offset > 0 ? plain[offset - 1] : '';
      const after = plain[end] ?? '';
      const insideLink = before === '[' || before === '(' || after === ']' || after === ')';
      if (!isWorkspace && !insideLink && clean.length > 3) {
        out += plain.slice(last, offset) + `[${clean}](rivendell-machine:${encodeURIComponent(clean)})`;
        last = end;
      }
      MACHINE_PATH_PATTERN.lastIndex = end;
    }
    return out + plain.slice(last);
  });
}

export function annotateWorkspaceMentions(input: string): string {
  if (!mentionsWorkspace(input)) return input;
  return annotateMarkdownOutsideCode(input);
}

/** Desk references (`[desk:card-…]`) in agent markdown become
 *  `rivendell-desk:` links, which the Markdown anchor renders as live pills.
 *  Code spans and fences are left alone. */
export function annotateDeskRefs(input: string): string {
  if (!hasDeskRef(input)) return input;
  return annotateMarkdownOutsideCode(input, (plain) => plain.replace(
    deskRefPattern(),
    (match: string, id: string, _kind: string, offset: number, whole: string) =>
      whole[offset + match.length] === '(' ? match : `[${id}](${DESK_HREF_PREFIX}${id})`,
  ));
}

export const DESK_HREF_PREFIX = 'rivendell-desk:';

/** `rivendell-desk:card-15a412` back to a reference. */
export function parseDeskHref(href: string | undefined): DeskRef | null {
  if (!href?.startsWith(DESK_HREF_PREFIX)) return null;
  const id = href.slice(DESK_HREF_PREFIX.length);
  const match = id.match(/^(card|todo)-[a-z0-9][a-z0-9_-]{0,78}$/i);
  return match ? { kind: match[1].toLowerCase() as DeskRef['kind'], id } : null;
}

export function parseWorkspaceMentionText(value: string): { kind: 'doc' | 'folder'; path: string; display: string } | null {
  const trimmed = value.trim();
  const proxyMarkdownLink = trimmed.match(/^\[([^\]]+)]\((rivendell-(?:doc|folder):[^)]+)\)$/);
  if (proxyMarkdownLink) {
    const target = parseProxyHref(proxyMarkdownLink[2]);
    if (!target || target.kind === 'machine') return null;
    // Direct fields, not a spread: TS spreads use the declared type, which
    // would smuggle the 'machine' kind back into this doc/folder-only view.
    return { kind: target.kind, path: target.path, display: proxyMarkdownLink[1] || toWindowsDisplay(target.path) };
  }

  const clean = trimmed.replace(TRAILING_PUNCT, '');
  const rel = extractRelativePath(normalizeHrefPath(clean));
  if (rel === null) return null;
  const path = normalizeWorkspacePath(rel);
  if (path === null) return null;
  return { kind: inferKind(path), path, display: toWindowsDisplay(path) };
}

function annotatePlainWorkspaceMentions(input: string): string {
  return input.replace(MENTION_PATTERN, (match) => {
    const trailingMatch = match.match(TRAILING_PUNCT);
    const trailing = trailingMatch ? trailingMatch[0] : '';
    const cleanMatch = trailing ? match.slice(0, match.length - trailing.length) : match;

    const rel = extractRelativePath(cleanMatch);
    if (rel === null) return match;

    const pathParts = splitPathAndTrailingText(rel);
    const finalRel = normalizeWorkspacePath(pathParts.path);
    if (finalRel === null) return match;
    const looksLikeFile = finalRel.length > 0 && /\.[A-Za-z0-9]+$/.test(finalRel.split('/').pop() ?? '');
    const protocol = looksLikeFile ? 'rivendell-doc' : 'rivendell-folder';
    const display = toWindowsDisplay(finalRel);
    return `[${display}](${protocol}:${encodeURIComponent(finalRel)})${pathParts.trailingText}${trailing}`;
  });
}

type PlainAnnotator = (plain: string) => string;

function annotateMarkdownOutsideCode(input: string, annotate: PlainAnnotator = annotatePlainWorkspaceMentions): string {
  const chunks = input.split(/(\r?\n)/);
  let output = '';
  let fence: { char: '`' | '~'; length: number } | null = null;

  for (let i = 0; i < chunks.length; i += 2) {
    const line = chunks[i] ?? '';
    const newline = chunks[i + 1] ?? '';

    if (fence) {
      output += line + newline;
      const close = line.match(/^(?: {0,3})(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }

    const open = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1][0] as '`' | '~', length: open[1].length };
      output += line + newline;
      continue;
    }

    output += annotateInlineOutsideCodeSpans(line, annotate) + newline;
  }

  return output;
}

function annotateInlineOutsideCodeSpans(line: string, annotate: PlainAnnotator): string {
  let output = '';
  let cursor = 0;

  while (cursor < line.length) {
    const start = line.indexOf('`', cursor);
    if (start < 0) {
      output += annotate(line.slice(cursor));
      break;
    }

    let ticksEnd = start;
    while (line[ticksEnd] === '`') ticksEnd += 1;
    const tickCount = ticksEnd - start;
    const close = findClosingTickRun(line, ticksEnd, tickCount);

    if (close < 0) {
      output += annotate(line.slice(cursor));
      break;
    }

    output += annotate(line.slice(cursor, start));
    output += line.slice(start, close + tickCount);
    cursor = close + tickCount;
  }

  return output;
}

function findClosingTickRun(line: string, from: number, tickCount: number): number {
  const needle = '`'.repeat(tickCount);
  let pos = line.indexOf(needle, from);

  while (pos >= 0) {
    const before = line[pos - 1];
    const after = line[pos + tickCount];
    if (before !== '`' && after !== '`') return pos;
    pos = line.indexOf(needle, pos + 1);
  }

  return -1;
}

function extractRelativePath(value: string): string | null {
  if (value.startsWith(WIN_WORKSPACE_PREFIX)) {
    const tail = value.slice(WIN_WORKSPACE_PREFIX.length);
    if (tail === '') return '';
    if (!tail.startsWith(LOCAL_SEP)) return null;
    return tail.slice(1).replace(/\\/g, '/');
  }
  const unix = value.match(new RegExp(`^${UNIX_WORKSPACE_SOURCE}(?:/(.*))?$`));
  if (unix) return unix[1] ?? '';
  if (value === LABEL) return '';
  if (value.startsWith(`${LABEL}/`)) return value.slice(LABEL.length + 1);
  return null;
}

function toWindowsDisplay(rel: string): string {
  if (!rel) return WIN_WORKSPACE_PREFIX;
  return `${WIN_WORKSPACE_PREFIX}${LOCAL_SEP}${rel.split('/').join(LOCAL_SEP)}`;
}

export function parseProxyHref(href: string | undefined): { kind: 'doc' | 'folder' | 'machine'; path: string } | null {
  if (!href) return null;
  if (href.startsWith('rivendell-machine:')) {
    const abs = decodeProxyPath(href.slice('rivendell-machine:'.length));
    return abs && /^[A-Za-z]:[\\/]/.test(abs) ? { kind: 'machine', path: abs } : null;
  }
  if (href.startsWith('rivendell-doc:')) {
    const path = normalizeWorkspacePath(decodeProxyPath(href.slice('rivendell-doc:'.length)));
    return path === null ? null : { kind: 'doc', path };
  }
  if (href.startsWith('rivendell-folder:')) {
    const path = normalizeWorkspacePath(decodeProxyPath(href.slice('rivendell-folder:'.length)));
    return path === null ? null : { kind: 'folder', path };
  }
  const rel = extractRelativePath(normalizeHrefPath(href));
  if (rel !== null) {
    const path = normalizeWorkspacePath(rel);
    if (path === null) return null;
    return { kind: inferKind(path), path };
  }
  return null;
}

function decodeProxyPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitPathAndTrailingText(value: string): { path: string; trailingText: string } {
  const filePathWithTrailingText = value.match(/^(.+\.[A-Za-z0-9]{1,12})(\s+.+)$/);
  if (filePathWithTrailingText) {
    return { path: filePathWithTrailingText[1], trailingText: filePathWithTrailingText[2] };
  }
  return { path: value, trailingText: '' };
}

function mentionsWorkspace(value: string): boolean {
  return value.includes(LABEL)
    || value.includes(WIN_WORKSPACE_PREFIX)
    || new RegExp(UNIX_WORKSPACE_SOURCE).test(value);
}

function normalizeHrefPath(href: string): string {
  const decoded = decodeProxyPath(href);
  if (decoded.startsWith('file://')) return decoded.slice('file://'.length);
  return decoded;
}

export function normalizeWorkspacePath(path: string): string | null {
  const extracted = extractRelativePath(path);
  const candidate = (extracted ?? path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '');
  const parts = candidate.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}

function inferKind(rel: string): 'doc' | 'folder' {
  const leaf = rel.split('/').pop() ?? '';
  return /\.[A-Za-z0-9]+$/.test(leaf) ? 'doc' : 'folder';
}
