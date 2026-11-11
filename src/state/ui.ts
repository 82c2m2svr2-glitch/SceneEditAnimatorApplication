import { create } from 'zustand';
import type { Ease, ID } from '../core/types';

export type ToolId =
  | 'select' | 'node' | 'hand' | 'zoom' | 'bone' | 'ik' | 'weights' | 'pen' | 'rect' | 'ellipse' | 'polygon'
  | 'star' | 'line' | 'brush' | 'eraser' | 'fill' | 'text' | 'camera';

export type DialogId = 'export' | 'settings' | 'characterCreator' | 'newProject' | 'shortcuts' | 'actionSave' | null;

export interface KeyRef {
  target: ID;
  prop: string;
  f: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export interface UIState {
  screen: 'start' | 'editor';
  sceneId: ID;
  frame: number;
  playing: boolean;
  loop: boolean;
  /** Play every scene back to back with transitions instead of looping the current scene. */
  playAll: boolean;
  selection: ID[];
  tool: ToolId;
  /** Setup mode edits the rig's rest pose; animate mode poses and keys it. */
  setupMode: boolean;
  autoKey: boolean;
  defaultEase: Ease;
  /** 'stage' looks at the scene with a neutral camera; 'camera' looks through the animated camera. */
  viewMode: 'stage' | 'camera';
  panX: number;
  panY: number;
  zoom: number;
  showBones: boolean;
  showGrid: boolean;
  showSafeArea: boolean;
  snap: boolean;
  onion: { enabled: boolean; before: number; after: number };
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  brushColor: string;
  brushSize: number;
  brushThinning: number;
  brushSmoothing: number;
  polygonSides: number;
  selectedKeys: KeyRef[];
  selectedStrip: ID | null;
  selectedAudio: ID | null;
  /** Timeline pixels per frame. */
  tlZoom: number;
  bottomPanel: 'timeline' | 'graph';
  rightTab: 'properties' | 'assets' | 'actions' | 'history';
  showChat: boolean;
  dialog: DialogId;
  toasts: Toast[];
  /** Bumped to force a viewport repaint for things outside the document (image decode, fonts). */
  repaint: number;
  set: (patch: Partial<UIState>) => void;
  select: (ids: ID[], additive?: boolean) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

let toastId = 1;

export const useUI = create<UIState>((set, get) => ({
  screen: 'start',
  sceneId: '',
  frame: 0,
  playing: false,
  loop: true,
  playAll: false,
  selection: [],
  tool: 'select',
  setupMode: false,
  autoKey: true,
  defaultEase: 'easeInOut',
  viewMode: 'stage',
  panX: 0,
  panY: 0,
  zoom: 0,
  showBones: true,
  showGrid: false,
  showSafeArea: false,
  snap: false,
  onion: { enabled: false, before: 2, after: 1 },
  fill: '#7c5cff',
  stroke: '#ffffff',
  strokeWidth: 0,
  brushColor: '#14151a',
  brushSize: 10,
  brushThinning: 0.6,
  brushSmoothing: 0.5,
  polygonSides: 6,
  selectedKeys: [],
  selectedStrip: null,
  selectedAudio: null,
  tlZoom: 10,
  bottomPanel: 'timeline',
  rightTab: 'properties',
  showChat: true,
  dialog: null,
  toasts: [],
  repaint: 0,
  set: (patch) => set(patch),
  select: (ids, additive = false) => {
    if (!additive) return set({ selection: ids, selectedKeys: [] });
    const cur = new Set(get().selection);
    for (const id of ids) {
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
    }
    set({ selection: [...cur] });
  },
  toast: (text, kind = 'info') => {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Non-reactive access for tools, commands and the AI layer. */
export const ui = (): UIState => useUI.getState();

export function requestRepaint(): void {
  useUI.setState({ repaint: useUI.getState().repaint + 1 });
}
