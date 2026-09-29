import { BrowserWindow, dialog, globalShortcut, ipcMain, nativeImage, powerMonitor, powerSaveBlocker, screen, shell, type MessageBoxOptions } from 'electron';
import path from 'node:path';
import { ComputerController, trustedComputerUrl, type ControlStatus, type PermissionStatus } from '../native/computer.mjs';
import { getSettings, saveSettings } from './settings.js';
import { approveComputer, bridgeEnabled } from './approvals.js';

const here = __dirname;
const listeners = new Set<(state: ControlStatus) => void>();
let indicator: BrowserWindow | null = null;
let serverOrigin = '';
let initialised = false;
// A sleeping display gives black captures, so on a Mac the display is held
// awake for exactly as long as an agent holds a grant. Nothing about the
// machine's power settings changes, and the hold ends with the grant.
let displayHold: number | null = null;
function holdDisplayAwake(on: boolean): void {
  if (process.platform !== 'darwin') return;
  if (on && displayHold === null) displayHold = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && displayHold !== null) { powerSaveBlocker.stop(displayHold); displayHold = null; }
}
export const computer = new ComputerController({
  automatic: () => Boolean(serverOrigin && getSettings().computerTrustedOrigin === serverOrigin),
  encode: async (png, region) => {
    const source = nativeImage.createFromBuffer(png, { scaleFactor: 1 });
    const size = source.getSize();
    if (source.isEmpty() || region.left < 0 || region.top < 0 || region.left + region.width > size.width || region.top + region.height > size.height) throw new Error('Display layout changed; capture again.');
    const ratio = Math.min(1, 1600 / region.width, 1200 / region.height);
    const width = Math.max(1, Math.round(region.width * ratio));
    const height = Math.max(1, Math.round(region.height * ratio));
    const result = source.crop({ x: region.left, y: region.top, width: region.width, height: region.height }).resize({ width, height, quality: 'best' });
    return { data: result.toJPEG(75), info: { width, height } };
  },
  approve: (request, signal) => approveComputer(request, serverOrigin, signal),
  changed: state => {
    holdDisplayAwake(Boolean(state.control));
    if (state.control) {
      indicator?.destroy();
      const win = new BrowserWindow({ width: 430, height: 110, resizable: false, minimizable: false,
        alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true, title: 'TARDIS computer control', show: false,
        webPreferences: { preload: path.join(here, 'control-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      // The indicator is a safety surface, not an interruption: dock it in a
      // corner of the display the person is working on, off the taskbar, with
      // no menu bar, instead of popping up in the middle of their screen.
      try {
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const bounds = win.getBounds();
        win.setPosition(area.x + area.width - bounds.width - 16, area.y + area.height - bounds.height - 16);
      } catch { /* corner placement is best-effort */ }
      indicator = win;
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.once('did-finish-load', () => {
        if (indicator !== win || win.isDestroyed()) return;
        win.webContents.send('tardis:control-state', state.control);
        win.showInactive();
      });
      win.on('closed', () => { if (indicator === win) { indicator = null; computer.stop(true); } });
      void win.loadFile(path.join(here, '..', 'pages', 'control.html'));
    } else {
      const win = indicator; indicator = null; win?.destroy();
    }
    for (const listener of listeners) listener(state);
  },
});
export function onComputerState(listener: (state: ControlStatus) => void): void { listeners.add(listener); }
export function initComputerControls(origin: string): void {
  serverOrigin = origin;
  if (initialised) return;
  initialised = true;
  ipcMain.on('tardis:computer-stop-native', event => {
    if (indicator && event.sender === indicator.webContents) computer.stop(true);
  });
  if (!globalShortcut.register('CommandOrControl+Alt+Shift+Escape', () => computer.stop(true))) {
    console.warn('[computer] Stop hotkey unavailable; native indicator and Ship menu remain available.');
  }
  powerMonitor.on('lock-screen', () => computer.stop());
  powerMonitor.on('suspend', () => computer.stop());
}
export function setComputerAutomatic(on: boolean, selectedServer = serverOrigin): void {
  let origin: string | undefined;
  if (on) {
    try { if (!trustedComputerUrl(selectedServer)) return; origin = new URL(selectedServer).origin; } catch { return; }
  }
  saveSettings({ computerTrustedOrigin: origin });
  computer.stop();
  // Switching back to attended mode must permit a new native consent request.
  if (!on) void computer.handle('resume').catch(error => console.error('[computer] could not clear pause:', error));
}
export async function handleComputer(op: string, params: Record<string, unknown>): Promise<unknown> {
  if (!bridgeEnabled()) throw new Error('Agents are disabled on this computer.');
  return computer.handle(op, params);
}

const MAC_PRIVACY_PANES = {
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};
const messageBox = (parent: BrowserWindow | null, options: MessageBoxOptions) =>
  parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
/** macOS only. Raises the two system prompts for Screen Recording and
 *  Accessibility, on purpose: the person at the Mac starts this from the Ship
 *  menu (or the setup launch flag) and then switches TARDIS on in System
 *  Settings. macOS asks for the login password or Touch ID for each switch, and
 *  nothing here can or should get around that. */
export async function setupMacComputerControl(parent: BrowserWindow | null, showResult = true): Promise<PermissionStatus | null> {
  if (process.platform !== 'darwin' || !computer.adapter.requestPermissions) return null;
  const capability = computer.status();
  if (!capability.supported) {
    if (showResult) await messageBox(parent, { type: 'error', message: 'Computer control is not available in this build.', detail: capability.reason ?? 'Unsupported.' });
    return null;
  }
  let status: PermissionStatus;
  try { status = await computer.adapter.requestPermissions(); }
  catch (error) {
    console.error('[computer] macOS setup failed:', error);
    if (showResult) await messageBox(parent, { type: 'error', message: 'Computer control setup could not start.', detail: error instanceof Error ? error.message : String(error) });
    return null;
  }
  if (!showResult) return status;
  const line = (name: string, on: boolean) => `${name}: ${on ? 'allowed' : 'not allowed yet'}`;
  const done = status.screenRecording && status.accessibility;
  if (!done) void shell.openExternal(status.screenRecording ? MAC_PRIVACY_PANES.accessibility : MAC_PRIVACY_PANES.screenRecording);
  await messageBox(parent, {
    type: 'info',
    message: done ? 'Computer control is ready on this Mac.' : 'Allow TARDIS to control this Mac',
    detail: `${line('Screen Recording', status.screenRecording)}\n${line('Accessibility', status.accessibility)}\n\n${done ? 'Agents can now see and use this Mac.' : 'In System Settings > Privacy & Security, switch TARDIS on for each one that is not allowed yet (macOS asks for the login password each time). If macOS offers Quit & Reopen, accept it. Then choose Set Up Computer Control again to check.'}`,
  });
  return status;
}
