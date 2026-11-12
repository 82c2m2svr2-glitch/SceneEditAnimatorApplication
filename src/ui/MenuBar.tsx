import { Bot, Download, RefreshCw, Settings, Wand2 } from 'lucide-react';
import { importAudioDialog, importImagesDialog, importModelsDialog } from './Panels';
import { humanoidSpec } from '../core/character/humanoid';
import { SOLID_SHAPES } from '../core/types';
import { APP_VERSION, useUpdate } from '../state/updates';
import { createDrawing, createGroup, createRect, createShape, createText } from '../core/factory';
import { ellipsePath, starPath } from '../core/path';
import { PARTICLE_PRESETS } from '../core/particles';
import { addNode, deleteNodes, duplicateNodes, groupNodes, keyNodes, reorder, scene, ungroup } from '../state/commands';
import { addCharacter3DFromSpec, addCharacterFromSpec, addIKForBone, addParticlePreset, addSolid, bindSkin, copySelection, exportRig, importRig, paste } from '../state/content';
import { downloadBlob, openProjectFile, pickFile, saveProjectFile } from '../state/persistence';
import { closeProject } from '../state/session';
import { doc, useDocRevision } from '../state/store';
import { ui, useUI } from '../state/ui';
import { fitView } from './Viewport';
import { Menu, MenuItem, TextField } from './widgets';
import { patchProject } from '../state/commands';

const HAIR = ['short', 'long', 'spiky', 'bald'] as const;
const PALETTES = [
  { skin: '#f2c6a0', hair: '#4a2f22', shirt: '#3d7dd8', pants: '#2b3350' },
  { skin: '#c68863', hair: '#1c1412', shirt: '#e4572e', pants: '#3a3a44' },
  { skin: '#f6d7b8', hair: '#d9a441', shirt: '#2a9d8f', pants: '#5b4636' },
  { skin: '#8d5a3b', hair: '#2b1b12', shirt: '#f4c95d', pants: '#22334a' },
  { skin: '#ffe0c2', hair: '#b5462f', shirt: '#9b5de5', pants: '#1f2233' },
];

export function insertSampleCharacter(threeD = false): void {
  const s = scene();
  const count = Object.values(s.nodes).filter((n) => n.type === 'character').length;
  const p = doc.project!;
  const pal = PALETTES[count % PALETTES.length];
  const spec = humanoidSpec({ name: `Character ${count + 1}`, ...pal, hairStyle: HAIR[count % HAIR.length], height: Math.round(p.height * 0.55) });
  const at = { x: p.width * (0.3 + ((count * 0.2) % 0.5)), y: Math.round(p.height * 0.86) };
  if (threeD) addCharacter3DFromSpec(spec, at);
  else addCharacterFromSpec(spec, at);
}

async function importRigDialog(): Promise<void> {
  const [f] = await pickFile('.dfrig,application/json');
  if (!f) return;
  try {
    importRig(JSON.parse(await f.text()));
    ui().toast('Character imported', 'success');
  } catch (err) {
    ui().toast(err instanceof Error ? err.message : 'Could not import that file.', 'error');
  }
}

function exportRigFile(): void {
  const rig = exportRig(ui().selection);
  if (!rig) return ui().toast('Select a character or layer to export.', 'error');
  downloadBlob(new Blob([JSON.stringify(rig)], { type: 'application/json' }), `${rig.name.replace(/[^\w\- ]+/g, '') || 'character'}.dfrig`);
}

export function MenuBar() {
  useDocRevision();
  const selection = useUI((s) => s.selection);
  const showChat = useUI((s) => s.showChat);
  const update = useUpdate((s) => s.available);
  const set = useUI((s) => s.set);
  const p = doc.project;
  if (!p) return null;
  const has = selection.length > 0;
  const center = { x: p.width / 2, y: p.height / 2 };
  const insert = (make: () => Parameters<typeof addNode>[0]) => {
    const n = make();
    Object.assign(n, center);
    addNode(n);
    ui().select([n.id]);
  };
  return (
    <div className="menubar">
      <div className="brand"><img src="./favicon.svg" alt="" /> DreamForge</div>
      <Menu label="File">
        {(close) => (
          <>
            <MenuItem label="New project…" onClick={() => { close(); if (!doc.dirty || confirm('Close this project? Unsaved changes are kept in Recent projects.')) closeProject(); }} />
            <MenuItem label="Open…" kbd="Ctrl+O" onClick={() => { close(); void openProjectFile(); }} />
            <MenuItem label="Save" kbd="Ctrl+S" onClick={() => { close(); void saveProjectFile(); }} />
            <div className="menu-sep" />
            <MenuItem label="Import images…" onClick={() => { close(); void importImagesDialog(); }} />
            <MenuItem label="Import audio…" onClick={() => { close(); void importAudioDialog(); }} />
            <MenuItem label="Import 3D model (.glb, .gltf, .obj)…" onClick={() => { close(); void importModelsDialog(); }} />
            <MenuItem label="Import character file…" onClick={() => { close(); void importRigDialog(); }} />
            <MenuItem label="Export selected as character file" disabled={!has} onClick={() => { close(); exportRigFile(); }} />
            <div className="menu-sep" />
            <MenuItem label="Export video, GIF or frames…" kbd="Ctrl+E" onClick={() => { close(); set({ dialog: 'export' }); }} />
          </>
        )}
      </Menu>
      <Menu label="Edit">
        {(close) => (
          <>
            <MenuItem label="Undo" kbd="Ctrl+Z" disabled={!doc.canUndo} onClick={() => { doc.undo(); }} />
            <MenuItem label="Redo" kbd="Ctrl+Shift+Z" disabled={!doc.canRedo} onClick={() => { doc.redo(); }} />
            <div className="menu-sep" />
            <MenuItem label="Copy" kbd="Ctrl+C" disabled={!has} onClick={() => { close(); copySelection(); }} />
            <MenuItem label="Paste" kbd="Ctrl+V" onClick={() => { close(); paste(); }} />
            <MenuItem label="Duplicate" kbd="Ctrl+D" disabled={!has} onClick={() => { close(); duplicateNodes(selection); }} />
            <MenuItem label="Delete" kbd="Del" disabled={!has} onClick={() => { close(); deleteNodes(selection); }} />
            <div className="menu-sep" />
            <MenuItem label="Group" kbd="Ctrl+G" disabled={!has} onClick={() => { close(); groupNodes(selection); }} />
            <MenuItem label="Ungroup" kbd="Ctrl+Shift+G" disabled={selection.length !== 1} onClick={() => { close(); ungroup(selection[0]); }} />
            <MenuItem label="Bring to front" kbd="Shift+]" disabled={selection.length !== 1} onClick={() => { close(); reorder(selection[0], 'top'); }} />
            <MenuItem label="Bring forward" kbd="]" disabled={selection.length !== 1} onClick={() => { close(); reorder(selection[0], 'up'); }} />
            <MenuItem label="Send backward" kbd="[" disabled={selection.length !== 1} onClick={() => { close(); reorder(selection[0], 'down'); }} />
            <MenuItem label="Send to back" kbd="Shift+[" disabled={selection.length !== 1} onClick={() => { close(); reorder(selection[0], 'bottom'); }} />
            <div className="menu-sep" />
            <MenuItem label="Trace image to vector shapes…" disabled={selection.length !== 1 || scene().nodes[selection[0]]?.type !== 'image'} onClick={() => { close(); set({ dialog: 'trace' }); }} />
            <MenuItem label="Insert keyframe" kbd="K" disabled={!has} onClick={() => { close(); keyNodes(selection); }} />
          </>
        )}
      </Menu>
      <Menu label="Insert">
        {(close) => (
          <>
            <MenuItem label="Sample character (rigged, 5 views)" onClick={() => { close(); insertSampleCharacter(); }} />
            <MenuItem label="Sample 3D character (same rig, drawn cel-shaded)" onClick={() => { close(); insertSampleCharacter(true); }} />
            <MenuItem label="Character Creator (AI)…" onClick={() => { close(); set({ dialog: 'characterCreator' }); }} />
            <MenuItem label="Asset Builder (AI)…" onClick={() => { close(); set({ dialog: 'assetBuilder' }); }} />
            <MenuItem label="Local Image Generation (on this computer)…" kbd="Alt+G" onClick={() => { close(); set({ dialog: 'localGen' }); }} />
            <div className="menu-sep" />
            <MenuItem label="Rectangle" onClick={() => { close(); insert(() => createRect('Rectangle', 300, 200, ui().fill ?? '#7c5cff')); }} />
            <MenuItem label="Ellipse" onClick={() => { close(); insert(() => createShape('Ellipse', ellipsePath(0, 0, 150, 150), { fill: ui().fill })); }} />
            <MenuItem label="Star" onClick={() => { close(); insert(() => createShape('Star', starPath(0, 0, 150, 64, 5), { fill: ui().fill })); }} />
            <MenuItem label="Text" onClick={() => { close(); insert(() => createText('Text')); }} />
            <MenuItem label="Drawing layer" onClick={() => { close(); const n = createDrawing(); addNode(n); ui().select([n.id]); set({ tool: 'brush' }); }} />
            <MenuItem label="Empty group" onClick={() => { close(); insert(() => createGroup('Group')); }} />
            <div className="menu-sep" />
            {SOLID_SHAPES.map((k) => <MenuItem key={k} label={`3D shape: ${k}`} onClick={() => { close(); addSolid(k, ui().fill ?? '#7c5cff'); }} />)}
            <div className="menu-sep" />
            {Object.keys(PARTICLE_PRESETS).map((k) => <MenuItem key={k} label={`Particles: ${k}`} onClick={() => { close(); addParticlePreset(k); }} />)}
          </>
        )}
      </Menu>
      <Menu label="Rig">
        {(close) => (
          <>
            <MenuItem label="Bind selected shapes to bones" disabled={!has} onClick={() => { close(); const n = bindSkin(selection); ui().toast(n ? `Bound ${n} layer${n > 1 ? 's' : ''}` : 'Select shapes or meshes that have bones available.', n ? 'success' : 'error'); }} />
            <MenuItem label="Add IK target for selected bone" disabled={selection.length !== 1} onClick={() => { close(); if (!addIKForBone(selection[0])) ui().toast('Select a bone first.', 'error'); }} />
            <div className="menu-sep" />
            <MenuItem label="Setup mode (edit the rig)" kbd="Tab" onClick={() => { close(); set({ setupMode: true }); }} />
            <MenuItem label="Animate mode (pose and key)" kbd="Tab" onClick={() => { close(); set({ setupMode: false }); }} />
          </>
        )}
      </Menu>
      <Menu label="View">
        {(close) => (
          <>
            <MenuItem label="Fit stage in view" kbd="F" onClick={() => { close(); fitView(); }} />
            <MenuItem label="Stage view" kbd="1" onClick={() => { close(); set({ viewMode: 'stage' }); }} />
            <MenuItem label="Camera view" kbd="2" onClick={() => { close(); set({ viewMode: 'camera' }); }} />
            <div className="menu-sep" />
            <MenuItem label="Timeline" onClick={() => { close(); set({ bottomPanel: 'timeline' }); }} />
            <MenuItem label="Graph editor" onClick={() => { close(); set({ bottomPanel: 'graph' }); }} />
            <MenuItem label="Keyboard shortcuts" kbd="?" onClick={() => { close(); set({ dialog: 'shortcuts' }); }} />
            <MenuItem label={`Check for updates… (version ${APP_VERSION})`} onClick={() => { close(); set({ dialog: 'update' }); }} />
          </>
        )}
      </Menu>
      <TextField className="project-name" value={p.name} onChange={(v) => v && patchProject({ name: v }, 'Rename project')} />
      {doc.dirty && <span className="dirty-dot" title="Unsaved changes (autosaved to Recent projects)" />}
      <div className="spacer" />
      {update && (
        <button className="btn update-btn" onClick={() => set({ dialog: 'update' })} title={`DreamForge ${update.latest} is available: click to install it`}>
          <RefreshCw size={14} /> Update to {update.latest}
        </button>
      )}
      <button className="btn primary" onClick={() => set({ dialog: 'characterCreator' })} title="Generate a character with AI and turn it into a rigged, animatable vector puppet">
        <Wand2 size={14} /> Character Creator
      </button>
      <button className="btn" onClick={() => set({ dialog: 'export' })}><Download size={14} /> Export</button>
      <button className={`icon-btn${showChat ? ' on' : ''}`} title="AI assistant" onClick={() => set({ showChat: !showChat })}><Bot size={16} /></button>
      <button className="icon-btn" title="Settings and API keys" onClick={() => set({ dialog: 'settings' })}><Settings size={16} /></button>
    </div>
  );
}
