import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('computerControl', {
  stop: () => ipcRenderer.send('tardis:computer-stop-native'),
  onState: (callback: (state: { label: string; expiresAt: number }) => void) => {
    ipcRenderer.on('tardis:control-state', (_event, state) => callback({ label: String(state.label), expiresAt: Number(state.expiresAt) }));
  },
});
