// Auto-update through GitHub Releases. electron-updater can replace the app
// in place on Windows (NSIS) and Linux (AppImage). macOS requires a signed
// build for in-place updates, so there the menu points at the releases page.
//
// Every updater event lands in <userData>/updater.log. A downloaded update
// once sat uninstalled through a full app quit with no trace anywhere,
// because a packaged app's console.error goes nowhere: every failure path in
// electron-updater (spawn refused, installer killed, quit skipped with a
// nonzero exit code) is only logged. The file logger records
// electron-updater's own decisions through autoUpdater.logger, so the exact
// reason the install did not happen is on disk next time.
import { app, dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron';
import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const LOG_CAP = 512 * 1024;
let started = false;
let pendingVersion: string | null = null;
let logger: UpdaterFileLogger | null = null;
const readyListeners = new Set<(version: string) => void>();

/** A tiny synchronous file logger matching electron-updater's logger
 *  interface (debug/info/warn/error). Synchronous on purpose: the lines this
 *  exists to capture are written during Electron's quit handlers, where a
 *  queued async write would die with the process before touching disk. It
 *  never throws (formatting included) and rotates once at the cap. */
class UpdaterFileLogger {
  constructor(private readonly file: string) {}
  private write(level: string, args: unknown[]): void {
    try {
      const text = args
        .map(a => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : safeText(a)))
        .join(' ');
      const line = `${new Date().toISOString()} [${level}] ${text.replace(/\r?\n/g, ' ').slice(0, 8000)}\n`;
      appendFileSync(this.file, line, 'utf8');
      if (statSync(this.file).size > LOG_CAP) {
        // Windows renames cannot replace an existing destination: drop the
        // old log first so rotation keeps working after the first one.
        try { rmSync(`${this.file}.old`, { force: true }); } catch { /* disposable */ }
        try { renameSync(this.file, `${this.file}.old`); } catch { /* disposable */ }
      }
    } catch { /* logging must never break the updater */ }
  }
  debug(...args: unknown[]): void { this.write('debug', args); }
  info(...args: unknown[]): void { this.write('info', args); }
  warn(...args: unknown[]): void { this.write('warn', args); }
  error(...args: unknown[]): void { this.write('error', args); }
}

/** Cycle- and BigInt-safe one-line rendering for logger arguments. */
function safeText(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

export function canAutoUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE);
  return false;
}

/** The version downloaded and waiting to install, if any. */
export function pendingUpdateVersion(): string | null {
  return pendingVersion;
}

/** Fires for every downloaded update, and immediately for a listener
 *  registered after the download already happened. */
export function onUpdateReady(listener: (version: string) => void): void {
  readyListeners.add(listener);
  if (pendingVersion) listener(pendingVersion);
}

/** Install the downloaded update right now: a silent install spawned while
 *  the app is still alive (not during quit teardown), then relaunch on the
 *  new version. Failures land in updater.log through the error event. */
export function restartToUpdate(): void {
  if (!pendingVersion || !started) return;
  logger?.info(`restart-to-update: quitAndInstall for ${pendingVersion}`);
  autoUpdater.quitAndInstall(true, true);
}

export function startUpdater(): void {
  if (started || !canAutoUpdate()) return;
  started = true;
  try {
    logger = new UpdaterFileLogger(path.join(app.getPath('userData'), 'updater.log'));
  } catch { logger = null; }
  autoUpdater.logger = logger ?? console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  logger?.info(`updater started: app ${app.getVersion()} on ${process.platform}`);
  autoUpdater.on('error', error => logger?.error('updater error:', error));
  autoUpdater.on('checking-for-update', () => logger?.info('checking for update'));
  autoUpdater.on('update-available', info => logger?.info(`update available: ${info.version}`));
  autoUpdater.on('update-not-available', info => logger?.info(`no update: ${info.version}`));
  autoUpdater.on('update-downloaded', event => {
    logger?.info(`update downloaded: ${event.version} (install-on-quit ${autoUpdater.autoInstallOnAppQuit ? 'armed' : 'OFF'})`);
    pendingVersion = event.version;
    for (const listener of readyListeners) listener(event.version);
  });
  const check = () => {
    autoUpdater
      .checkForUpdates()
      .then(result => logger?.info(`update check: latest ${result?.updateInfo?.version ?? 'unknown'}`))
      .catch(error => logger?.error('update check failed:', error));
  };
  setTimeout(check, 8000);
  setInterval(check, CHECK_EVERY_MS);
}

function tell(win: BrowserWindow | null, options: MessageBoxOptions): Promise<unknown> {
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

export async function checkForUpdatesInteractive(win: BrowserWindow | null, releasesUrl: string): Promise<void> {
  if (!canAutoUpdate()) {
    await shell.openExternal(releasesUrl);
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const next = result?.updateInfo?.version;
    if (!next || next === app.getVersion()) {
      await tell(win, {
        type: 'info',
        title: 'TARDIS',
        message: 'TARDIS is up to date.',
        detail: `Type 40 TT Capsule · v${app.getVersion()}`,
      });
      return;
    }
    await tell(win, {
      type: 'info',
      title: 'TARDIS',
      message: `Version ${next} is on its way.`,
      detail: 'It downloads in the background. A Restart to Update item appears when it is ready.',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await tell(win, {
      type: 'warning',
      title: 'TARDIS',
      message: 'Could not check for updates.',
      detail: reason,
    });
  }
}
