// Exposes a small, fixed API to the page. See NativeBridge in src/state/persistence.ts.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dreamforge', {
  isDesktop: true,
  saveFile: (opts) => ipcRenderer.invoke('dreamforge:save-file', opts),
  secretsAvailable: () => ipcRenderer.invoke('dreamforge:secrets-available'),
  getSecret: (name) => ipcRenderer.invoke('dreamforge:get-secret', name),
  setSecret: (name, value) => ipcRenderer.invoke('dreamforge:set-secret', name, value),
});
