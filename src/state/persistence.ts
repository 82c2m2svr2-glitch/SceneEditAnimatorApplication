import type { Project } from '../core/types';
import { doc } from './store';
import { openProject } from './session';
import { ui } from './ui';

const DB = 'dreamforge';
const STORE = 'projects';

interface Stored {
  id: string;
  name: string;
  modifiedAt: number;
  width: number;
  height: number;
  fps: number;
  thumb?: string;
  project: Project;
}

export type RecentProject = Omit<Stored, 'project'>;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Saves the open project into the browser's local library (autosave and "Recent projects"). */
export async function saveToLibrary(thumb?: string): Promise<void> {
  const p = doc.project;
  if (!p) return;
  const stored: Stored = { id: p.id, name: p.name, modifiedAt: Date.now(), width: p.width, height: p.height, fps: p.fps, thumb, project: p };
  await tx('readwrite', (s) => s.put(stored));
}

export async function listLibrary(): Promise<RecentProject[]> {
  try {
    const all = await tx<Stored[]>('readonly', (s) => s.getAll());
    return all.map(({ project: _p, ...rest }) => rest).sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch {
    return [];
  }
}

export async function loadFromLibrary(id: string): Promise<boolean> {
  const stored = await tx<Stored | undefined>('readonly', (s) => s.get(id));
  if (!stored) return false;
  openProject(validateProject(stored.project));
  return true;
}

export async function deleteFromLibrary(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

/** Checks a parsed file is a DreamForge project and fills in fields added since it was saved. */
export function validateProject(data: unknown): Project {
  const p = data as Project;
  if (!p || p.format !== 'dreamforge' || !Array.isArray(p.scenes) || p.scenes.length === 0) {
    throw new Error('This file is not a DreamForge project.');
  }
  if (p.version !== 1) throw new Error(`This project was saved by a newer version of DreamForge (format ${p.version}).`);
  p.assets ??= {};
  p.actions ??= {};
  for (const s of p.scenes) {
    s.anim ??= {};
    s.strips ??= [];
    s.constraints ??= [];
    s.audio ??= [];
    s.markers ??= [];
    s.transition ??= { type: 'cut', duration: 12 };
  }
  return p;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const safeName = (s: string) => s.replace(/[^\w\- ]+/g, '').trim() || 'project';

/** Saves the project as a .dreamforge file (native dialog on desktop, download in the browser). */
export async function saveProjectFile(): Promise<void> {
  const p = doc.project;
  if (!p) return;
  const json = JSON.stringify({ ...p, modifiedAt: Date.now() });
  const name = `${safeName(p.name)}.dreamforge`;
  const native = window.dreamforge;
  if (native) {
    const saved = await native.saveFile({ defaultPath: name, data: json, filters: [{ name: 'DreamForge project', extensions: ['dreamforge'] }] });
    if (!saved) return;
  } else {
    downloadBlob(new Blob([json], { type: 'application/json' }), name);
  }
  doc.markSaved();
  void saveToLibrary();
  ui().toast('Project saved', 'success');
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function openProjectFile(file?: File): Promise<boolean> {
  const f = file ?? (await pickFile('.dreamforge,application/json'))[0];
  if (!f) return false;
  try {
    openProject(validateProject(JSON.parse(await f.text())));
    return true;
  } catch (err) {
    ui().toast(err instanceof Error ? err.message : 'Could not open that file.', 'error');
    return false;
  }
}

/** Bridge exposed by the Electron preload script; undefined in the browser. */
export interface NativeBridge {
  isDesktop: true;
  saveFile(opts: { defaultPath: string; data: string | ArrayBuffer; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
}

declare global {
  interface Window {
    dreamforge?: NativeBridge;
  }
}
