// TARDIS desktop shell. A single hardened window over a TARDIS server: the
// server keeps every bit of state, the shell only remembers where the ship is,
// how big the window was, and which theme the console was left in.
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSettings, initSettings, saveSettings, type Settings, type ThemeName, type WindowBounds } from './settings.js';
import { installMenu } from './menu.js';
import { normalizeServerUrl, probeServer, sameOrigin } from './server.js';
import { canAutoUpdate, checkForUpdatesInteractive, startUpdater } from './updater.js';
import { chooseWorkspaceRoot, clearFetchedCopies, handleNativeScheme, openWorkspacePath, workspaceRoot } from './workspace.js';
import { deviceId, refreshDeviceBridge, startDeviceBridge, stopDeviceBridge } from './bridge.js';
import { computer } from './computer.js';
import { bridgeEnabled, forgetApprovals, setBridgeEnabled } from './approvals.js';

const pkg = require('../package.json') as { repository?: { url?: string } };

const APP_ID = 'app.tardis.desktop';
const REPO_URL = (pkg.repository?.url ?? 'https://github.com/mrchevyceleb/TARDIS').replace(/\.git$/, '');
const RELEASES_URL = `${REPO_URL}/releases`;
const THEME_BG: Record<ThemeName, string> = { dark: '#08080a', light: '#f4f1ea' };
// Older console bundles fire `rivendell://` links (workspace files,
// default-browser hand-off) from a hidden iframe. The shell handles those
// itself; no Windows helper is involved.
const NATIVE_SCHEME = 'rivendell:';
const ERR_ABORTED = -3;
const ERR_UNKNOWN_URL_SCHEME = -302;
const PAGES = path.join(app.getAppPath(), 'pages');
// The only local pages the window may show, and the only senders allowed to
// drive the shell over IPC. Compared by path (case-folded on Windows).
const SHELL_PAGES = new Set(['connect.html', 'offline.html'].map((name) => shellPageKey(pathToFileURL(path.join(PAGES, name)).href)));
// Granted to the server origin only. `media` is narrowed further to audio:
// the console talks, it never films.
const PERMISSIONS = new Set<string>([
  'media',
  'notifications',
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'speaker-selection',
]);

let win: BrowserWindow | null = null;
let serverUrl: string | undefined;

function cliServer(): string | undefined {
  const arg = process.argv.find((value) => value.startsWith('--server='));
  const raw = arg ? arg.slice('--server='.length) : process.env.TARDIS_URL;
  if (!raw) return undefined;
  return normalizeServerUrl(raw) ?? undefined;
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/** Drop a remembered position that no longer lands on any display. */
function visibleBounds(bounds: WindowBounds | undefined): WindowBounds | undefined {
  if (!bounds) return undefined;
  if (bounds.x === undefined || bounds.y === undefined) return bounds;
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return bounds.x! < area.x + area.width - 80
      && bounds.x! + bounds.width > area.x + 80
      && bounds.y! < area.y + area.height - 80
      && bounds.y! + 40 > area.y;
  });
  return onScreen ? bounds : { width: bounds.width, height: bounds.height };
}

function shellPageKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return null;
    const pathname = decodeURIComponent(parsed.pathname);
    return process.platform === 'win32' ? pathname.toLowerCase() : pathname;
  } catch {
    return null;
  }
}

function isShellPage(url: string): boolean {
  const key = shellPageKey(url);
  return key !== null && SHELL_PAGES.has(key);
}

function allowedInApp(url: string): boolean {
  if (url === 'about:blank' || url.startsWith('blob:') || url.startsWith('devtools:')) return true;
  return isShellPage(url) || sameOrigin(url, serverUrl);
}

async function openOutside(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const protocol = parsed.protocol;
  if (protocol === NATIVE_SCHEME) {
    await handleNativeScheme(url, serverUrl);
    return;
  }
  if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
    try {
      await shell.openExternal(url);
    } catch (error) {
      console.error('[tardis] could not open', url, error);
    }
  }
}

async function chooseWorkspace(): Promise<void> {
  const picked = await chooseWorkspaceRoot(win);
  if (!picked) return;
  // The console reads the root once at load, and the ship was told the old
  // one when this machine announced itself.
  loadServer();
  refreshDeviceBridge();
}

async function openWorkspace(): Promise<void> {
  const root = workspaceRoot() ?? (await chooseWorkspaceRoot(win));
  if (root) await shell.openPath(root);
}

function applyTheme(theme: ThemeName): void {
  nativeTheme.themeSource = theme;
  saveSettings({ theme });
  if (win && !win.isDestroyed()) win.setBackgroundColor(THEME_BG[theme]);
}

function loadServer(): void {
  if (!win || win.isDestroyed()) return;
  if (!serverUrl) {
    void showConnect();
    return;
  }
  void win.loadURL(serverUrl);
}

async function showConnect(): Promise<void> {
  if (!win || win.isDestroyed()) return;
  await win.loadFile(path.join(PAGES, 'connect.html'));
}

async function showOffline(reason: string): Promise<void> {
  if (!win || win.isDestroyed()) return;
  await win.loadFile(path.join(PAGES, 'offline.html'), { query: { reason } });
}

function createWindow(settings: Settings): BrowserWindow {
  const theme = settings.theme ?? 'dark';
  const bounds = visibleBounds(settings.bounds);
  const window = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 360,
    minHeight: 520,
    title: 'TARDIS',
    backgroundColor: THEME_BG[theme],
    show: false,
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: [`--tardis-version=${app.getVersion()}`],
    },
  });
  if (settings.maximized) window.maximize();
  window.once('ready-to-show', () => window.show());

  const remember = () => {
    if (window.isDestroyed()) return;
    saveSettings({ bounds: window.getNormalBounds(), maximized: window.isMaximized() });
  };
  const rememberSoon = debounce(remember, 400);
  window.on('resize', rememberSoon);
  window.on('move', rememberSoon);
  window.on('maximize', rememberSoon);
  window.on('unmaximize', rememberSoon);
  window.on('close', remember);
  window.on('closed', () => {
    if (win === window) win = null;
  });

  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (code === ERR_ABORTED) return;
    if (!isMainFrame) {
      // A hidden iframe pointed at rivendell:// that no throttle caught.
      if (code === ERR_UNKNOWN_URL_SCHEME && url.startsWith(NATIVE_SCHEME)) void openOutside(url);
      return;
    }
    if (!serverUrl || !sameOrigin(url, serverUrl)) return;
    void showOffline(description);
  });
  // A front door (Tailscale Serve, a reverse proxy) answers for a server that
  // is down or restarting with its own 5xx page. Treat that as unreachable too.
  window.webContents.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
    if (httpResponseCode < 500 || !serverUrl || !sameOrigin(url, serverUrl)) return;
    void showOffline(`HTTP ${httpResponseCode} ${httpStatusText ?? ''}`.trim());
  });

  return window;
}

function installNavigationPolicy(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (allowedInApp(url)) return;
      event.preventDefault();
      void openOutside(url);
    });
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || !event.url.startsWith(NATIVE_SCHEME)) return;
      event.preventDefault();
      void openOutside(event.url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      // The transcript previews an uploaded image by opening a blank window and
      // pointing it at a blob URL; that stays a real (sandboxed) child window.
      if (url === '' || url === 'about:blank' || url.startsWith('blob:')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 960,
            height: 720,
            autoHideMenuBar: true,
            backgroundColor: THEME_BG.dark,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        };
      }
      void openOutside(url);
      return { action: 'deny' };
    });
  });
}

function installPermissions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const from = details.requestingUrl || contents.getURL();
    if (!PERMISSIONS.has(permission) || !sameOrigin(from, serverUrl)) {
      callback(false);
      return;
    }
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      callback(types.length > 0 && types.every((type) => type === 'audio'));
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (!PERMISSIONS.has(permission) || !sameOrigin(requestingOrigin, serverUrl)) return false;
    if (permission === 'media') return (details as { mediaType?: string }).mediaType === 'audio';
    return true;
  });
}

function fromLocalPage(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return isShellPage(event.senderFrame?.url ?? '');
}

function installIpc(): void {
  ipcMain.handle('tardis:state', () => ({
    version: app.getVersion(),
    platform: process.platform,
    serverUrl: serverUrl ?? null,
    releasesUrl: RELEASES_URL,
    autoUpdate: canAutoUpdate(),
  }));

  ipcMain.handle('tardis:connect', async (event, raw: unknown, force: unknown) => {
    if (!fromLocalPage(event)) return { ok: false, error: 'Not allowed from this page.' };
    const origin = normalizeServerUrl(String(raw ?? ''));
    if (!origin) return { ok: false, error: 'Enter a full address, like https://your-server.your-tailnet.ts.net' };
    if (force !== true) {
      const probe = await probeServer(origin);
      if (!probe.ok) return probe;
    }
    serverUrl = origin;
    saveSettings({ serverUrl: origin });
    loadServer();
    startDeviceBridge(serverUrl);
    return { ok: true };
  });

  ipcMain.handle('tardis:retry', async (event) => {
    if (!fromLocalPage(event)) return { ok: false, error: 'Not allowed from this page.' };
    if (!serverUrl) {
      void showConnect();
      return { ok: false, error: 'No server address saved.' };
    }
    const probe = await probeServer(serverUrl, 4000);
    if (probe.ok) loadServer();
    return probe;
  });

  ipcMain.handle('tardis:change-server', (event) => {
    if (!fromLocalPage(event)) return;
    void showConnect();
  });

  ipcMain.handle('tardis:open-external', (event, url: unknown) => {
    if (!fromLocalPage(event)) return;
    const value = String(url ?? '');
    if (/^https?:\/\//i.test(value)) void shell.openExternal(value);
  });

  ipcMain.on('tardis:device-id', event => {
    event.returnValue = sameOrigin(event.senderFrame?.url ?? '', serverUrl) ? deviceId() : '';
  });

  ipcMain.on('tardis:workspace-root', (event) => {
    event.returnValue = workspaceRoot() ?? '';
  });

  ipcMain.handle('tardis:open-workspace', (event, rel: unknown, kind: unknown) => {
    if (!sameOrigin(event.senderFrame?.url ?? '', serverUrl)) return { ok: false, error: 'Not allowed from this page.' };
    return openWorkspacePath(String(rel ?? ''), kind === 'folder' ? 'folder' : 'doc', serverUrl);
  });

  ipcMain.on('tardis:theme', (event, theme: unknown) => {
    if (!sameOrigin(event.senderFrame?.url ?? '', serverUrl)) return;
    if (theme === 'light' || theme === 'dark') applyTheme(theme);
  });
}

/** Debugging aid: TARDIS_SHOT=/path/out.png captures the first loaded page
 *  (TARDIS_SHOT_DELAY ms after it finishes, default 1500) and quits. Pair
 *  with xvfb or --ozone-platform=headless on a display-less box. */
function scheduleScreenshot(target: string): void {
  const contents = win?.webContents;
  if (!contents) return;
  const delay = Number(process.env.TARDIS_SHOT_DELAY) || 1500;
  contents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const image = await contents.capturePage();
        await writeFile(target, image.toPNG());
        console.log(`[tardis] wrote ${target}`);
      } catch (error) {
        console.error('[tardis] screenshot failed:', error);
      } finally {
        app.quit();
      }
    }, delay);
  });
}

async function main(): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  const settings = initSettings(app.getPath('userData'));
  serverUrl = cliServer() ?? settings.serverUrl;
  nativeTheme.themeSource = settings.theme ?? 'dark';

  installPermissions();
  installIpc();
  installMenu({
    bridgeEnabled: bridgeEnabled(),
    setBridgeEnabled: (on: boolean) => {
      setBridgeEnabled(on);
      if (on) startDeviceBridge(serverUrl);
      else stopDeviceBridge();
    },
    forgetApprovals,
    stopComputer: () => computer.stop(),
    changeServer: () => void showConnect(),
    reloadServer: () => loadServer(),
    chooseWorkspace: () => void chooseWorkspace(),
    openWorkspace: () => void openWorkspace(),
    clearFetchedCopies: () => void clearFetchedCopies(win),
    checkForUpdates: () => void checkForUpdatesInteractive(win, RELEASES_URL),
    openReleases: () => void shell.openExternal(RELEASES_URL),
    openRepository: () => void shell.openExternal(REPO_URL),
  });

  win = createWindow(settings);
  if (process.env.TARDIS_SHOT) scheduleScreenshot(process.env.TARDIS_SHOT);
  loadServer();
  startUpdater();
  // The link is what lets agents use this machine; it is refused entirely
  // while the Ship menu switch is off.
  if (bridgeEnabled()) startDeviceBridge(serverUrl);
}

installNavigationPolicy();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => stopDeviceBridge());
  app.on('activate', () => {
    if (win && !win.isDestroyed()) return;
    win = createWindow(getSettings());
    loadServer();
  });
  void app.whenReady().then(main);
}
