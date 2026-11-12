// DreamForge desktop shell. The app itself is the same web build that runs in a browser; this
// process only adds a native window, save dialogs and OS-protected storage for API keys.
const { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell, Menu } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
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
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
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

const SECRET_NAMES = new Set(['openaiKey', 'anthropicKey', 'localGenAuth']);
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

// --- local image generator (SD.Next on this computer) --------------------------------------------
//
// The page asks this process to make the request, so the generator needs no CORS opening and can
// stay bound to 127.0.0.1. Only loopback addresses and the few API routes DreamForge uses are
// allowed, so this cannot be used to reach anything else.

const LOCAL_GEN_ROUTES = /^\/sdapi\/v1\/(version|platform|options|sd-models|samplers|progress|interrupt|txt2img|img2img|checkpoint|reload-checkpoint|refresh-checkpoints)(\?[\w=&.%-]*)?$/;
const isLoopback = (host) => {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
};

ipcMain.handle('dreamforge:local-gen', async (_event, req) => {
  let base;
  try {
    base = new URL(String(req && req.base));
  } catch {
    return { ok: false, status: 0, error: 'The generator address is not valid.' };
  }
  if (!/^https?:$/.test(base.protocol) || !isLoopback(base.hostname)) return { ok: false, status: 0, error: 'Only a generator on this computer can be used.' };
  const route = String(req.path || '');
  if (!LOCAL_GEN_ROUTES.test(route)) return { ok: false, status: 0, error: 'That generator request is not allowed.' };
  const method = req.method === 'POST' ? 'POST' : 'GET';
  const headers = { Accept: 'application/json' };
  if (typeof req.body === 'string') headers['Content-Type'] = 'application/json';
  if (typeof req.auth === 'string' && req.auth.includes(':')) headers.Authorization = `Basic ${Buffer.from(req.auth, 'utf8').toString('base64')}`;
  // The first image after a model or size change waits for OpenVINO to compile, which can take minutes.
  const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 15000, 1000), 30 * 60 * 1000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await net.fetch(`${base.origin}${base.pathname.replace(/\/+$/, '')}${route}`, { method, headers, body: typeof req.body === 'string' ? req.body : undefined, signal: ac.signal, cache: 'no-store' });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (err) {
    const timedOut = ac.signal.aborted;
    return { ok: false, status: 0, error: timedOut ? 'The generator did not answer in time.' : `Could not reach the generator at ${base.origin}. Is SD.Next running? (${err instanceof Error ? err.message : err})` };
  } finally {
    clearTimeout(timer);
  }
});

// --- self-update ---------------------------------------------------------------------------------
//
// The Windows build is a single portable .exe. To update, the new .exe is downloaded next to it and
// checked, then a small PowerShell script waits for DreamForge to close, copies the new file over
// the old one (same name and place, so shortcuts and launchers keep working) and starts it again.

/** Only release files of DreamForge's own repository are ever downloaded. */
const RELEASE_DOWNLOADS = 'https://github.com/82c2m2svr2-glitch/SceneEditAnimatorApplication/releases/download/';

/** The .exe the user started. Set by the portable launcher; absent in development and other builds. */
const portableExe = () => (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) || null;

ipcMain.handle('dreamforge:can-self-update', async () => {
  const exe = portableExe();
  if (!exe) return { ok: false, reason: 'Only the Windows .exe can update itself. Download the new version instead.' };
  const probe = path.join(path.dirname(exe), `.dreamforge-write-test-${process.pid}`);
  try {
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
  } catch {
    return { ok: false, reason: `DreamForge is not allowed to change files in ${path.dirname(exe)}. Move DreamForge.exe to a folder of your own (such as Documents) to update it in one click, or download the new version.` };
  }
  return { ok: true, path: exe };
});

let updating = false;

ipcMain.handle('dreamforge:install-update', async (event, opts) => {
  const exe = portableExe();
  if (!exe) return { ok: false, error: 'Only the Windows .exe can update itself.' };
  const url = opts && typeof opts.url === 'string' ? opts.url : '';
  if (!url.startsWith(RELEASE_DOWNLOADS) || !/\.exe$/i.test(new URL(url).pathname)) return { ok: false, error: 'That download is not a DreamForge release.' };
  const size = opts && Number.isFinite(opts.size) && opts.size > 0 ? opts.size : 0;
  const sha256 = opts && typeof opts.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(opts.sha256) ? opts.sha256.toLowerCase() : '';
  if (updating) return { ok: false, error: 'An update is already downloading.' };
  updating = true;

  const download = path.join(path.dirname(exe), `${path.basename(exe, path.extname(exe))}.update-download`);
  try {
    const res = await net.fetch(url);
    if (!res.ok || !res.body) throw new Error(`GitHub answered with an error (${res.status}).`);
    const total = Number(res.headers.get('content-length')) || size;
    const hash = crypto.createHash('sha256');
    const file = await fs.open(download, 'w');
    let received = 0;
    let head = null;
    let lastReport = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!head) head = Buffer.from(value.subarray(0, 2));
        await file.write(value);
        hash.update(value);
        received += value.length;
        if (Date.now() - lastReport > 120 && !event.sender.isDestroyed()) {
          lastReport = Date.now();
          event.sender.send('dreamforge:update-progress', { received, total });
        }
      }
    } finally {
      await file.close();
    }
    if ((size && received !== size) || (total && received !== total)) throw new Error('The download was cut off. Try again.');
    if (!head || head.toString('latin1') !== 'MZ') throw new Error('The downloaded file is not a Windows program.');
    if (sha256 && hash.digest('hex') !== sha256) throw new Error('The downloaded file did not match the release. It was not installed; try again.');
  } catch (err) {
    updating = false;
    await fs.rm(download, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: /GitHub|download|Windows|release/.test(message) ? message : `The update could not be downloaded: ${message}` };
  }

  // PowerShell single-quoted strings take any character except ', which is doubled.
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const script = path.join(app.getPath('temp'), `dreamforge-update-${Date.now()}.ps1`);
  const lines = [
    `$new = ${q(download)}`,
    `$target = ${q(exe)}`,
    '# The old program stays locked until DreamForge has fully closed: keep trying for two minutes.',
    'for ($i = 0; $i -lt 240; $i++) {',
    '  try {',
    '    [System.IO.File]::Copy($new, $target, $true)',
    '    Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue',
    '    Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target)',
    '    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    '    exit 0',
    '  } catch {',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '}',
    '# Could not replace it: show the user the downloaded file so nothing is lost.',
    "Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,\"' + $new + '\"')",
  ];
  try {
    // The byte-order mark makes Windows PowerShell read non-English folder names correctly.
    await fs.writeFile(script, '﻿' + lines.join('\r\n'), 'utf8');
    // Only close DreamForge once the script that brings it back is really running.
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  } catch (err) {
    updating = false;
    return { ok: false, error: `The update was downloaded but could not be installed: ${err instanceof Error ? err.message : err}. The new file is ${download}; rename it to .exe and run it.` };
  }
  setTimeout(() => app.quit(), 400);
  return { ok: true };
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
