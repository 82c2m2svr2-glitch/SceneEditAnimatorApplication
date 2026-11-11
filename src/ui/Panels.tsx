import { FileAudio, ImagePlus, Music, Plus, Save, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { importAudio, placeAudio } from '../audio/engine';
import { actionFitsView } from '../core/character/actions';
import { ancestorOfType, subtreeIds } from '../core/tree';
import type { ActionClip, ID, Scene } from '../core/types';
import { removeAction, removeAsset } from '../state/commands';
import { applyAction, builtins, importImage, placeImage, readAsDataUrl, saveAsAction } from '../state/content';
import { pickFile } from '../state/persistence';
import { doc, useDocRevision } from '../state/store';
import { ui, useUI } from '../state/ui';
import { VIEW_LABEL } from './Properties';

export async function importImagesDialog(): Promise<void> {
  const files = await pickFile('image/png,image/jpeg,image/webp,image/gif,image/svg+xml', true);
  for (const f of files) {
    try {
      placeImage(await importImage(f.name, await readAsDataUrl(f), f.type));
    } catch {
      ui().toast(`Could not import "${f.name}".`, 'error');
    }
  }
}

export async function importAudioDialog(): Promise<void> {
  const files = await pickFile('audio/*', true);
  for (const f of files) await importAudio(f);
}

export function AssetsPanel() {
  useDocRevision();
  const p = doc.project;
  if (!p) return null;
  const assets = Object.values(p.assets);
  return (
    <>
      <div style={{ display: 'flex', gap: 6, padding: 8 }}>
        <button className="btn" style={{ flex: 1 }} onClick={() => void importImagesDialog()}><ImagePlus size={14} /> Import images</button>
        <button className="btn" style={{ flex: 1 }} onClick={() => void importAudioDialog()}><FileAudio size={14} /> Import audio</button>
      </div>
      {assets.length === 0 && <div className="empty">Imported images and sounds appear here. Click one to place it in the scene at the playhead.</div>}
      <div className="asset-grid">
        {assets.map((a) => (
          <div key={a.id} className="asset" title={`${a.name}\nClick to add to the scene`} onClick={() => (a.kind === 'image' ? placeImage(a) : placeAudio(a))}>
            {a.kind === 'image' ? <img src={a.dataUrl} alt="" draggable={false} /> : <div className="audio-ico"><Music size={22} /></div>}
            <small>{a.name}</small>
            <button className="icon-btn sm del" title="Delete asset" onClick={(e) => { e.stopPropagation(); removeAsset(a.id); }}><Trash2 size={11} /></button>
          </div>
        ))}
      </div>
    </>
  );
}

/** The character (or group) that actions apply to for the current selection. */
export function actionTarget(scene: Scene, selection: ID[]): ID | null {
  for (const id of selection) {
    const ch = ancestorOfType(scene, id, 'character');
    if (ch) return ch.id;
  }
  const first = selection.find((id) => scene.nodes[id]?.type === 'group');
  return first ?? null;
}

export function ActionsPanel() {
  useDocRevision();
  const selection = useUI((s) => s.selection);
  const sceneId = useUI((s) => s.sceneId);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('My action');
  const [loop, setLoop] = useState(true);
  const p = doc.project;
  if (!p) return null;
  const scene = p.scenes.find((s) => s.id === sceneId) ?? p.scenes[0];
  const target = actionTarget(scene, selection);
  const targetNode = target ? scene.nodes[target] : null;
  const view = targetNode?.type === 'character' ? targetNode.currentView : null;
  const mine = Object.values(p.actions).filter((a) => !a.id.startsWith('builtin_'));
  const groups = new Map<string, ActionClip[]>();
  for (const a of [...mine, ...builtins()]) {
    if (!groups.has(a.category)) groups.set(a.category, []);
    groups.get(a.category)!.push(a);
  }
  const apply = (a: ActionClip) => {
    if (!target) return ui().toast('Select a character first.', 'error');
    const id = applyAction(target, a.id, { repeat: a.loop ? Math.max(1, Math.round((p.fps * 2) / Math.max(1, a.duration * (p.fps / a.fps)))) : 1 });
    if (id) useUI.setState({ selectedStrip: id });
  };
  const keyRange = (): [number, number] | null => {
    if (!target) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const id of subtreeIds(scene, target)) {
      for (const prop in scene.anim[id] ?? {}) {
        for (const k of scene.anim[id][prop].keys) {
          lo = Math.min(lo, k.f);
          hi = Math.max(hi, k.f);
        }
      }
    }
    return hi > lo ? [lo, hi] : null;
  };
  const range = keyRange();
  return (
    <>
      <div style={{ padding: 8, borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="hint">
          {targetNode ? <>Applies to <b style={{ color: 'var(--text)' }}>{targetNode.name}</b>{view && <> ({VIEW_LABEL[view]} view)</>} at the playhead. Strips can be moved, stretched to loop, and blended on the timeline.</> : 'Select a character to apply an action.'}
        </div>
        {saving ? (
          <>
            <input type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loops</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn primary" style={{ flex: 1 }} onClick={() => {
                if (target && range) {
                  const id = saveAsAction(target, name.trim() || 'My action', range[0], range[1], loop);
                  ui().toast(id ? `Saved "${name}" to the library` : 'Nothing to save', id ? 'success' : 'error');
                }
                setSaving(false);
              }}>Save frames {range?.[0]}–{range?.[1]}</button>
              <button className="btn" onClick={() => setSaving(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <button className="btn" disabled={!range} title="Turns this character's keyframes into a reusable clip" onClick={() => setSaving(true)}><Save size={13} /> Save keyframes as action</button>
        )}
      </div>
      {[...groups.entries()].map(([cat, list]) => (
        <div key={cat}>
          <div className="section-head" style={{ cursor: 'default' }}>{cat}</div>
          {list.map((a) => {
            const fits = !view || actionFitsView(a, view);
            return (
              <div key={a.id} className={`action-item${fits ? '' : ' off'}`} onDoubleClick={() => apply(a)} title={fits ? 'Double-click or press + to apply' : `Made for: ${a.views.map((v) => VIEW_LABEL[v]).join(', ')}`}>
                <div className="meta">
                  {a.name}
                  <small>{(a.duration / a.fps).toFixed(1)}s{a.loop ? ' · loops' : ''}{a.views.length ? ` · ${a.views.map((v) => VIEW_LABEL[v]).join(', ')}` : ' · any view'}</small>
                </div>
                {!a.id.startsWith('builtin_') && <button className="icon-btn sm" title="Delete action" onClick={() => removeAction(a.id)}><Trash2 size={12} /></button>}
                <button className="icon-btn" title="Apply at the playhead" onClick={() => apply(a)}><Plus size={14} /></button>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

export function HistoryPanel() {
  useDocRevision();
  const undo = doc.undoStack;
  const redo = doc.redoStack;
  return (
    <>
      {undo.length === 0 && redo.length === 0 && <div className="empty">Every change you or the assistant make is listed here and can be undone.</div>}
      {[...redo].map((e, i) => (
        <div key={`r${i}`} className="action-item" style={{ opacity: 0.4 }} onClick={() => { for (let k = redo.length - i; k > 0; k--) doc.redo(); }}>
          <div className="meta">{e.label}{e.source === 'ai' && <span className="chip" style={{ marginLeft: 6 }}>AI</span>}</div>
        </div>
      ))}
      {[...undo].reverse().map((e, i) => (
        <div key={`u${i}`} className="action-item" title="Undo back to here" onClick={() => { for (let k = 0; k < i; k++) doc.undo(); }}>
          {i === 0 && <Undo2 size={12} />}
          <div className="meta">{e.label}{e.source === 'ai' && <span className="chip" style={{ marginLeft: 6 }}>AI</span>}</div>
        </div>
      ))}
    </>
  );
}
