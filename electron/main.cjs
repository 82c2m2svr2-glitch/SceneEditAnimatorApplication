// DreamForge desktop shell. The app itself is the same web build that runs in a browser; this
// process only adds a native window, save dialogs and OS-protected storage for API keys.
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const isDev = process.argv.includes('--dev');
const DEV_URL = process.env.DREAMFORGE_DEV_URL || 'http://localhost:5173';

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0c0d11',
    title: 'DreamForge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  if (isDev) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // The app never opens windows of its own; links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });
  win.on('closed', () => (win = null));
}

// --- native file save --------------------------------------------------------------------------

ipcMain.handle('dreamforge:save-file', async (_event, opts) => {
  if (!win || !opts || typeof opts.defaultPath !== 'string') return null;
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.basename(opts.defaultPath),
    filters: Array.isArray(opts.filters) ? opts.filters : undefined,
  });
  if (res.canceled || !res.filePath) return null;
  const data = typeof opts.data === 'string' ? opts.data : Buffer.from(opts.data);
  await fs.writeFile(res.filePath, data);
  return res.filePath;
});

// --- API keys in the OS credential store ---------------------------------------------------------

const SECRET_NAMES = new Set(['openaiKey', 'anthropicKey']);
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');

async function readSecrets() {
  try {
    return JSON.parse(await fs.readFile(secretsFile(), 'utf8'));
  } catch {
    return {};
  }
}

ipcMain.handle('dreamforge:secrets-available', () => safeStorage.isEncryptionAvailable());

ipcMain.handle('dreamforge:get-secret', async (_event, name) => {
  if (!SECRET_NAMES.has(name) || !safeStorage.isEncryptionAvailable()) return null;
  const all = await readSecrets();
  if (!all[name]) return null;
  try {
    return safeStorage.decryptString(Buffer.from(all[name], 'base64'));
  } catch {
    return null;
  }
});

ipcMain.handle('dreamforge:set-secret', async (_event, name, value) => {
  if (!SECRET_NAMES.has(name) || typeof value !== 'string' || !safeStorage.isEncryptionAvailable()) return;
  const all = await readSecrets();
  if (value) all[name] = safeStorage.encryptString(value).toString('base64');
  else delete all[name];
  await fs.writeFile(secretsFile(), JSON.stringify(all), { mode: 0o600 });
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
