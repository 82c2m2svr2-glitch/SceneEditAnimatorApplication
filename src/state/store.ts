import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { useSyncExternalStore } from 'react';
import type { Project } from '../core/types';

enablePatches();

export type ChangeSource = 'user' | 'ai';

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  source: ChangeSource;
  time: number;
  /** Consecutive entries with the same merge key collapse into one undo step. */
  mergeKey?: string;
}

export interface ApplyOptions {
  mergeKey?: string;
  source?: ChangeSource;
}

interface Transaction {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  source: ChangeSource;
}

const MAX_HISTORY = 300;
const MERGE_WINDOW_MS = 1200;

/**
 * The single source of truth for the open project.
 *
 * All mutations go through `apply` (or a transaction), which records immer patches so every
 * change is undoable. Nothing else may mutate the project object.
 */
export class DocStore {
  project: Project | null = null;
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  /** Bumped on every change; lets React subscribe cheaply. */
  revision = 0;
  /** Revision at the last save, to drive the unsaved-changes indicator. */
  savedRevision = 0;
  /** Default source for changes made outside an explicit option (the AI agent flips this). */
  source: ChangeSource = 'user';
  private txn: Transaction | null = null;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }

  load(project: Project | null): void {
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.txn = null;
    this.emit();
    this.savedRevision = this.revision;
  }

  get dirty(): boolean {
    return this.revision !== this.savedRevision;
  }

  markSaved(): void {
    this.savedRevision = this.revision;
    for (const fn of this.listeners) fn();
  }

  /** Applies a mutation recipe to the project and records it for undo. */
  apply(label: string, recipe: (draft: Project) => void, opts: ApplyOptions = {}): void {
    if (!this.project) return;
    const [next, patches, inverse] = produceWithPatches(this.project, (draft) => {
      recipe(draft as Project);
    });
    if (patches.length === 0) return;
    this.project = next;
    const source = opts.source ?? this.source;
    if (this.txn) {
      this.txn.patches.push(...patches);
      this.txn.inverse.unshift(...inverse);
    } else {
      this.push({ label, patches, inverse, source, time: Date.now(), mergeKey: opts.mergeKey });
    }
    this.emit();
  }

  private push(entry: HistoryEntry): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && entry.mergeKey && last.mergeKey === entry.mergeKey && entry.time - last.time < MERGE_WINDOW_MS) {
      last.patches.push(...entry.patches);
      last.inverse.unshift(...entry.inverse);
      last.time = entry.time;
    } else {
      this.undoStack.push(entry);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /** Starts a transaction: every `apply` until `commit` becomes a single undo step. */
  begin(label: string, source?: ChangeSource): void {
    if (this.txn) this.commit();
    this.txn = { label, patches: [], inverse: [], source: source ?? this.source };
  }

  get inTransaction(): boolean {
    return this.txn !== null;
  }

  commit(): void {
    const t = this.txn;
    this.txn = null;
    if (!t || t.patches.length === 0) return;
    this.push({ label: t.label, patches: t.patches, inverse: t.inverse, source: t.source, time: Date.now() });
    this.emit();
  }

  /** Abandons the open transaction and restores the project to how it was at `begin`. */
  rollback(): void {
    const t = this.txn;
    this.txn = null;
    if (!t || !this.project || t.inverse.length === 0) return;
    this.project = applyPatches(this.project, t.inverse);
    this.emit();
  }

  /** Runs `fn` inside a transaction so everything it does is one undo step. */
  transact<T>(label: string, fn: () => T, source?: ChangeSource): T {
    if (this.txn) return fn();
    this.begin(label, source);
    try {
      const out = fn();
      this.commit();
      return out;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): HistoryEntry | null {
    if (this.txn) this.commit();
    const entry = this.undoStack.pop();
    if (!entry || !this.project) return null;
    this.project = applyPatches(this.project, entry.inverse);
    this.redoStack.push(entry);
    this.emit();
    return entry;
  }

  redo(): HistoryEntry | null {
    if (this.txn) this.commit();
    const entry = this.redoStack.pop();
    if (!entry || !this.project) return null;
    this.project = applyPatches(this.project, entry.patches);
    this.undoStack.push(entry);
    this.emit();
    return entry;
  }
}

export const doc = new DocStore();

/** React hook: re-renders when the selected slice of the project changes. */
export function useDoc<T>(selector: (project: Project | null) => T): T {
  return useSyncExternalStore(doc.subscribe, () => selector(doc.project));
}

export function useDocRevision(): number {
  return useSyncExternalStore(doc.subscribe, () => doc.revision);
}

/** The open project. Throws when called with nothing open, which is always a programming error. */
export function project(): Project {
  if (!doc.project) throw new Error('No project is open');
  return doc.project;
}
