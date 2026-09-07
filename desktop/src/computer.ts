import { BrowserWindow, globalShortcut, ipcMain, nativeImage, powerMonitor } from 'electron';
import path from 'node:path';
import { ComputerController, trustedComputerUrl, type ControlStatus } from '../native/computer.mjs';
import { getSettings, saveSettings } from './settings.js';
import { approveComputer, bridgeEnabled } from './approvals.js';

const here = __dirname;
const listeners = new Set<(state: ControlStatus) => void>();
let indicator: BrowserWindow | null = null;
let serverOrigin = '';
let initialised = false;
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
    if (state.control) {
      indicator?.destroy();
      const win = new BrowserWindow({ width: 430, height: 110, resizable: false, minimizable: false,
        alwaysOnTop: true, title: 'TARDIS computer control', show: false,
        webPreferences: { preload: path.join(here, 'control-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
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
