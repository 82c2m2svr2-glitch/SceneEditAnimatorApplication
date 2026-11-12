// Exposes a small, fixed API to the page. See NativeBridge in src/state/persistence.ts.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dreamforge', {
  isDesktop: true,
  saveFile: (opts) => ipcRenderer.invoke('dreamforge:save-file', opts),
  secretsAvailable: () => ipcRenderer.invoke('dreamforge:secrets-available'),
  getSecret: (name) => ipcRenderer.invoke('dreamforge:get-secret', name),
  setSecret: (name, value) => ipcRenderer.invoke('dreamforge:set-secret', name, value),
  canSelfUpdate: () => ipcRenderer.invoke('dreamforge:can-self-update'),
  installUpdate: (opts) => ipcRenderer.invoke('dreamforge:install-update', opts),
  onUpdateProgress: (fn) => {
    const listener = (_event, progress) => fn(progress);
    ipcRenderer.on('dreamforge:update-progress', listener);
    return () => ipcRenderer.removeListener('dreamforge:update-progress', listener);
  },
});
