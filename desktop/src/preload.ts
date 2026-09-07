// Runs in every page the shell loads. Local pages (connect, offline) get the
// small control bridge; the TARDIS app itself only gets a `native` flag and a
// one-way theme report so the OS chrome can follow the console theme.
import { contextBridge, ipcRenderer } from 'electron';

const version = (process.argv.find((value) => value.startsWith('--tardis-version=')) ?? '').split('=')[1] ?? '';
const local = window.location.protocol === 'file:';
const base = { native: true as const, platform: process.platform, version };

if (local) {
  contextBridge.exposeInMainWorld('tardisShell', {
    ...base,
    getState: () => ipcRenderer.invoke('tardis:state'),
    connect: (url: string, force = false) => ipcRenderer.invoke('tardis:connect', url, force),
    retry: () => ipcRenderer.invoke('tardis:retry'),
    changeServer: () => ipcRenderer.invoke('tardis:change-server'),
    openExternal: (url: string) => ipcRenderer.invoke('tardis:open-external', url),
  });
} else {
  // Where this machine keeps its copy of the workspace, so the console can
  // show local paths and open files with the machine's own apps.
  const workspaceRoot = String(ipcRenderer.sendSync('tardis:workspace-root') ?? '');
  contextBridge.exposeInMainWorld('tardisShell', {
    ...base,
    workspaceRoot: workspaceRoot || undefined,
    deviceId: String(ipcRenderer.sendSync('tardis:device-id') ?? '') || undefined,
    openWorkspacePath: (relPath: string, kind: 'doc' | 'folder') => ipcRenderer.invoke('tardis:open-workspace', relPath, kind),
  });
  const report = () => {
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    ipcRenderer.send('tardis:theme', theme);
  };
  const start = () => {
    report();
    new MutationObserver(report).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
