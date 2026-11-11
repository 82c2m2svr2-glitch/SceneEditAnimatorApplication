import { deleteKeys, deleteNodes, duplicateNodes, groupNodes, jumpKey, keyNodes, removeAudioClip, removeStrip, reorder, scene, setFrame, setPropsMany, ungroup, addMarker, currentValue } from '../state/commands';
import { copySelection, paste } from '../state/content';
import { openProjectFile, saveProjectFile } from '../state/persistence';
import { togglePlay } from '../state/playback';
import { doc } from '../state/store';
import { ui, useUI, type ToolId } from '../state/ui';
import { getTool } from '../tools';
import { makeEnv } from '../tools/env';
import { fitView } from './Viewport';

const TOOL_KEYS: Record<string, ToolId> = {
  v: 'select', a: 'node', h: 'hand', z: 'zoom', b: 'bone', i: 'ik', p: 'pen', r: 'rect', e: 'ellipse', g: 'polygon',
  s: 'star', l: 'line', d: 'brush', x: 'eraser', t: 'text', c: 'camera',
};

export const SHORTCUT_HELP: [string, string][] = [
  ['Space', 'Play / pause'], ['← →', 'Previous / next frame (Shift: 10)'], [', .', 'Previous / next keyframe'],
  ['Home / End', 'First / last frame'], ['K', 'Insert keyframe for selection'], ['Tab', 'Setup / Animate mode'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+C / V / D', 'Copy / paste / duplicate'], ['Delete', 'Delete selection, keys or strips'],
  ['Ctrl+G / Ctrl+Shift+G', 'Group / ungroup'], ['[ ]', 'Send backward / bring forward'], ['Ctrl+arrows', 'Nudge selection (Shift: 10 px)'],
  ['1 / 2', 'Stage view / camera view'], ['F', 'Fit stage in view'], ['O', 'Onion skin'], ['M', 'Add marker'],
  ['Mouse wheel', 'Zoom view'], ['Middle drag', 'Pan view'], ['Ctrl+click', 'Select inside a group'], ['Shift+drag', 'Constrain / snap'],
  ['V A H Z', 'Select, edit points, pan, zoom'], ['B I', 'Bone tool, IK pose tool'], ['P R E G S L', 'Pen, rectangle, ellipse, polygon, star, line'],
  ['D X T C', 'Brush, eraser, text, camera'], ['Ctrl+S / Ctrl+E', 'Save / export'],
];

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function handleKey(e: KeyboardEvent): void {
  if (!doc.project || typing(e)) return;
  const u = ui();
  if (u.dialog) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const done = () => e.preventDefault();

  if (!mod && getTool(u.tool).key?.(e, makeEnv())) return done();

  if (mod) {
    switch (key) {
      case 'z': if (e.shiftKey) doc.redo(); else doc.undo(); return done();
      case 'y': doc.redo(); return done();
      case 's': void saveProjectFile(); return done();
      case 'o': void openProjectFile(); return done();
      case 'e': u.set({ dialog: 'export' }); return done();
      case 'c': copySelection(); return done();
      case 'x': if (copySelection()) deleteNodes(u.selection); return done();
      case 'v': paste(); return done();
      case 'd': duplicateNodes(u.selection); return done();
      case 'g': if (!e.shiftKey) groupNodes(u.selection); else if (u.selection.length === 1) ungroup(u.selection[0]); return done();
      case 'a': u.select([...scene().roots]); return done();
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        const step = e.shiftKey ? 10 : 1;
        const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
        const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
        if (u.selection.length) {
          setPropsMany(u.selection.map((id) => ({ id, values: { x: ((currentValue(id, 'x') as number) ?? 0) + dx, y: ((currentValue(id, 'y') as number) ?? 0) + dy } })), { label: 'Nudge', mergeKey: 'nudge' });
        }
        return done();
      }
      default: return;
    }
  }

  switch (key) {
    case ' ': togglePlay(); return done();
    case 'ArrowLeft': setFrame(u.frame - (e.shiftKey ? 10 : 1)); return done();
    case 'ArrowRight': setFrame(u.frame + (e.shiftKey ? 10 : 1)); return done();
    case ',': jumpKey(-1); return done();
    case '.': jumpKey(1); return done();
    case 'Home': setFrame(0); return done();
    case 'End': setFrame(scene().duration - 1); return done();
    case 'Tab': u.set({ setupMode: !u.setupMode }); return done();
    case 'k': keyNodes(u.selection); return done();
    case 'f': fitView(); return done();
    case 'o': u.set({ onion: { ...u.onion, enabled: !u.onion.enabled } }); return done();
    case 'm': addMarker(u.frame, `Marker ${scene().markers.length + 1}`); return done();
    case '1': u.set({ viewMode: 'stage' }); return done();
    case '2': u.set({ viewMode: 'camera' }); return done();
    case '?': u.set({ dialog: 'shortcuts' }); return done();
    case '[': case '{': if (u.selection.length === 1) reorder(u.selection[0], e.shiftKey ? 'bottom' : 'down'); return done();
    case ']': case '}': if (u.selection.length === 1) reorder(u.selection[0], e.shiftKey ? 'top' : 'up'); return done();
    case 'Escape':
      getTool(u.tool).cancel?.();
      if (u.tool !== 'select') u.set({ tool: 'select' });
      else u.select([]);
      return done();
    case 'Delete': case 'Backspace':
      if (u.selectedKeys.length) deleteKeys(u.selectedKeys);
      else if (u.selectedStrip) { removeStrip(u.selectedStrip); useUI.setState({ selectedStrip: null }); }
      else if (u.selectedAudio) { removeAudioClip(u.selectedAudio); useUI.setState({ selectedAudio: null }); }
      else deleteNodes(u.selection);
      return done();
    default:
      if (TOOL_KEYS[key]) {
        u.set({ tool: TOOL_KEYS[key] });
        return done();
      }
  }
}

