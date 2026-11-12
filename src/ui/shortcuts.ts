import { deleteKeys, deleteNodes, duplicateNodes, groupNodes, jumpKey, keyNodes, removeAudioClip, removeStrip, reorder, scene, setFrame, setPropsMany, ungroup, addMarker, currentValue } from '../state/commands';
import { copySelection, paste } from '../state/content';
import { openProjectFile, saveProjectFile } from '../state/persistence';
import { togglePlay } from '../state/playback';
import { doc } from '../state/store';
import { ancestorOfType, subtreeIds } from '../core/tree';
import { VIEW_NAMES } from '../core/types';
import { patchNode } from '../state/commands';
import { toggleFullscreen, ui, useUI, type ToolId } from '../state/ui';
import { importImagesDialog, importModelsDialog } from './Panels';
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
  ['Shift+F or F11', 'Full-screen editing on / off'], ['Shift+Space', 'Play from the first frame'], ['+ / - / 0', 'Zoom in / out / actual size'],
  ['Alt+← →', 'Turn the selected character to its previous / next view'], ['Shift+K', 'Key the whole pose of the selected character'],
  ['Shift+H / Shift+L', 'Hide or show / lock or unlock the selection'], ['Shift+B / Shift+G', 'Show or hide bones / grid'],
  ['Page Up / Page Down', 'Previous / next scene'], ['Ctrl+I / Ctrl+Shift+I', 'Import images / 3D models'],
  ['Alt+C / Alt+A', 'Character Creator / Asset Builder'], ['Ctrl+Shift+A', 'Deselect everything'],
];

/** The character a selection belongs to, if any. */
function selectedCharacter(): ReturnType<typeof ancestorOfType> {
  const s = scene();
  for (const id of ui().selection) {
    const n = s.nodes[id];
    if (n?.type === 'character') return n;
    const owner = n ? ancestorOfType(s, id, 'character') : null;
    if (owner) return owner;
  }
  return null;
}

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function handleKey(e: KeyboardEvent): void {
  if (!doc.project || typing(e)) return;
  const u = ui();
  if (u.dialog) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'F11') {
    e.preventDefault();
    return toggleFullscreen();
  }
  if (e.altKey && !mod) {
    const stop = () => e.preventDefault();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const ch = selectedCharacter();
      if (ch && ch.type === 'character' && ch.views.length > 1) {
        const order = VIEW_NAMES.filter((v) => ch.views.includes(v));
        // The view may be keyed, so step from what is on screen now, not from the stored base value.
        const at = Math.max(0, order.indexOf(currentValue(ch.id, 'currentView') as (typeof order)[number]));
        setPropsMany([{ id: ch.id, values: { currentView: order[(at + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length] } }], { label: 'Turn character' });
      }
      return stop();
    }
    if (e.key.toLowerCase() === 'c') { u.set({ dialog: 'characterCreator' }); return stop(); }
    if (e.key.toLowerCase() === 'a') { u.set({ dialog: 'assetBuilder' }); return stop(); }
    return;
  }
  if (e.shiftKey && !mod) {
    const stop = () => e.preventDefault();
    const s = scene();
    switch (e.key.toLowerCase()) {
      case 'f': toggleFullscreen(); return stop();
      case ' ': setFrame(0); if (!u.playing) togglePlay(); return stop();
      case 'b': u.set({ showBones: !u.showBones }); return stop();
      case 'g': u.set({ showGrid: !u.showGrid }); return stop();
      case 'h': {
        const hide = u.selection.some((id) => s.nodes[id]?.visible);
        doc.transact(hide ? 'Hide' : 'Show', () => u.selection.forEach((id) => patchNode(id, { visible: !hide }, hide ? 'Hide' : 'Show')));
        return stop();
      }
      case 'l': {
        const lock = u.selection.some((id) => !s.nodes[id]?.locked);
        doc.transact(lock ? 'Lock' : 'Unlock', () => u.selection.forEach((id) => patchNode(id, { locked: lock }, lock ? 'Lock' : 'Unlock')));
        return stop();
      }
      case 'k': {
        const ch = selectedCharacter();
        if (ch) {
          const bones = [...subtreeIds(s, ch.id)].filter((id) => s.nodes[id]?.type === 'bone');
          keyNodes(bones);
          u.toast(`Keyed the whole pose of ${ch.name} (${bones.length} bones)`, 'success');
        }
        return stop();
      }
    }
  }
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
      case 'a': u.select(e.shiftKey ? [] : [...scene().roots]); return done();
      case 'i': void (e.shiftKey ? importModelsDialog() : importImagesDialog()); return done();
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
    case '+': case '=': u.set({ zoom: Math.min(32, u.zoom * 1.25) }); return done();
    case '-': case '_': u.set({ zoom: Math.max(0.02, u.zoom / 1.25) }); return done();
    case '0': u.set({ zoom: 1 }); return done();
    case 'PageUp': case 'PageDown': {
      const list = doc.project.scenes;
      const at = list.findIndex((x) => x.id === u.sceneId);
      const next = list[at + (key === 'PageDown' ? 1 : -1)];
      if (next) u.set({ sceneId: next.id, frame: 0, selection: [], selectedKeys: [] });
      return done();
    }
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
      else if (u.selection.length) u.select([]);
      else if (u.fullscreen) toggleFullscreen(false);
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

