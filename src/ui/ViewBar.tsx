import { Bone, Expand, Frame, Grid3x3, Layers, Maximize } from 'lucide-react';
import { toggleFullscreen, useUI } from '../state/ui';
import { ToolOptions } from './Toolbar';
import { fitView } from './Viewport';
import { NumberField } from './widgets';

export function ViewBar() {
  const u = useUI();
  const set = u.set;
  return (
    <div className="viewbar">
      <div className="seg" title="Setup edits the rig's rest pose. Animate poses it and creates keyframes. (Tab)">
        <button className={u.setupMode ? 'on warn' : ''} onClick={() => set({ setupMode: true })}>Setup</button>
        <button className={!u.setupMode ? 'on' : ''} onClick={() => set({ setupMode: false })}>Animate</button>
      </div>
      <div className="seg" title="Stage shows the whole scene with a neutral camera. Camera shows exactly what will be exported.">
        <button className={u.viewMode === 'stage' ? 'on' : ''} onClick={() => set({ viewMode: 'stage' })}>Stage</button>
        <button className={u.viewMode === 'camera' ? 'on' : ''} onClick={() => set({ viewMode: 'camera' })}>Camera</button>
      </div>
      <button className={`icon-btn${u.showBones ? ' on' : ''}`} title="Show bones" onClick={() => set({ showBones: !u.showBones })}><Bone size={15} /></button>
      <button className={`icon-btn${u.onion.enabled ? ' on' : ''}`} title="Onion skin: ghost the frames before (red) and after (green)" onClick={() => set({ onion: { ...u.onion, enabled: !u.onion.enabled } })}><Layers size={15} /></button>
      {u.onion.enabled && (
        <>
          <div style={{ width: 62 }}><NumberField label="Before" value={u.onion.before} min={0} max={8} precision={0} onChange={(v) => set({ onion: { ...u.onion, before: Math.round(v) } })} /></div>
          <div style={{ width: 54 }}><NumberField label="After" value={u.onion.after} min={0} max={8} precision={0} onChange={(v) => set({ onion: { ...u.onion, after: Math.round(v) } })} /></div>
        </>
      )}
      <button className={`icon-btn${u.showGrid ? ' on' : ''}`} title="Grid" onClick={() => set({ showGrid: !u.showGrid })}><Grid3x3 size={15} /></button>
      <button className={`icon-btn${u.showSafeArea ? ' on' : ''}`} title="Title and action safe areas" onClick={() => set({ showSafeArea: !u.showSafeArea })}><Frame size={15} /></button>
      <div style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 4px' }} />
      <ToolOptions />
      <div className="spacer" />
      <span className="chip">{Math.round(u.zoom * 100)}%</span>
      <button className="icon-btn" title="Fit stage in view (F)" onClick={() => fitView()}><Maximize size={15} /></button>
      <button className={`icon-btn${u.fullscreen ? ' on' : ''}`} title="Full-screen editing: hide the panels and work on the stage alone (Shift+F or F11)" onClick={() => toggleFullscreen()}><Expand size={15} /></button>
    </div>
  );
}
