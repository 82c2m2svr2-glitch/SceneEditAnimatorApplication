import { Bone, Brush, FolderOpen, Grid3x3, MoveRight, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CANVAS_PRESETS, FPS_PRESETS } from '../core/factory';
import type { AnimMode } from '../core/types';
import { deleteFromLibrary, listLibrary, loadFromLibrary, openProjectFile, type RecentProject } from '../state/persistence';
import { newProject } from '../state/session';
import { addHumanoid } from '../state/content';
import { NumberField } from './widgets';

const MODES: { id: AnimMode; title: string; text: string; icon: React.ReactNode; tag?: string }[] = [
  { id: 'rig', title: 'Bone rig', tag: 'Recommended', icon: <Bone size={22} />, text: 'Characters built from parts on a skeleton. Pose with bones and IK, reuse walk cycles and gestures.' },
  { id: 'tween', title: 'Keyframe tween', icon: <MoveRight size={22} />, text: 'Move, rotate, scale and fade anything between keyframes with easing curves.' },
  { id: 'frame', title: 'Frame by frame', icon: <Brush size={22} />, text: 'Draw each frame by hand with a pressure brush and onion skinning.' },
  { id: 'mesh', title: 'Mesh deform', icon: <Grid3x3 size={22} />, text: 'Bend a single image or shape smoothly by binding it to bones.' },
];

export function StartMenu() {
  const [name, setName] = useState('Untitled project');
  const [mode, setMode] = useState<AnimMode>('rig');
  const [preset, setPreset] = useState('hd');
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(24);
  const [starter, setStarter] = useState(true);
  const [recent, setRecent] = useState<RecentProject[]>([]);

  useEffect(() => {
    void listLibrary().then(setRecent);
  }, []);

  const create = () => {
    newProject({ name: name.trim() || 'Untitled project', width: Math.round(width), height: Math.round(height), fps, mode });
    if (starter && (mode === 'rig' || mode === 'mesh')) addHumanoid({ name: 'Hero', height: Math.round(height * 0.55) });
  };

  return (
    <div className="start">
      <div className="start-inner">
        <div>
          <h1>
            <img src="./favicon.svg" alt="" /> DreamForge
          </h1>
          <p className="lede">2D animation and scene editing studio with a multiplane camera and a built-in AI assistant.</p>
        </div>

        <div>
          <h2>How do you want to animate?</h2>
          <div className="cards">
            {MODES.map((m) => (
              <button key={m.id} className={`card${mode === m.id ? ' on' : ''}`} onClick={() => setMode(m.id)}>
                {m.tag && <span className="tag">{m.tag}</span>}
                {m.icon}
                <b>{m.title}</b>
                <span>{m.text}</span>
              </button>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            This sets up the workspace. Every method stays available inside the project.
          </p>
        </div>

        <div className="start-grid">
          <div className="box" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 style={{ margin: 0 }}>New project</h2>
            <div className="form-row">
              <label>Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
            </div>
            <div>
              <div className="preset-list">
                {CANVAS_PRESETS.map((c) => {
                  const k = 34 / Math.max(c.width, c.height);
                  return (
                    <button
                      key={c.id}
                      className={`preset${preset === c.id ? ' on' : ''}`}
                      onClick={() => {
                        setPreset(c.id);
                        setWidth(c.width);
                        setHeight(c.height);
                      }}
                    >
                      <span className="shape" style={{ width: c.width * k, height: c.height * k }} />
                      <small>{c.label}</small>
                    </button>
                  );
                })}
                <button className={`preset${preset === 'custom' ? ' on' : ''}`} onClick={() => setPreset('custom')}>
                  <span className="shape" style={{ width: 30, height: 24, borderStyle: 'dashed' }} />
                  <small>Custom size</small>
                </button>
              </div>
            </div>
            <div className="form-row">
              <label>Size (pixels)</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <NumberField label="W" value={width} min={16} max={8192} precision={0} onChange={(v) => { setWidth(v); setPreset('custom'); }} />
                <NumberField label="H" value={height} min={16} max={8192} precision={0} onChange={(v) => { setHeight(v); setPreset('custom'); }} />
              </div>
            </div>
            <div className="form-row">
              <label>Frame rate</label>
              <div className="seg" style={{ width: 'fit-content' }}>
                {FPS_PRESETS.map((f) => (
                  <button key={f} className={fps === f ? 'on' : ''} onClick={() => setFps(f)}>
                    {f} fps
                  </button>
                ))}
              </div>
            </div>
            {(mode === 'rig' || mode === 'mesh') && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--dim)' }}>
                <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
                Start with a ready-rigged sample character
              </label>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary big" onClick={create}>
                <Sparkles size={16} /> Create project
              </button>
              <button className="btn big" onClick={() => void openProjectFile()}>
                <FolderOpen size={16} /> Open file
              </button>
            </div>
          </div>

          <div className="box">
            <h2>Recent projects</h2>
            {recent.length === 0 && <div className="empty">Projects you work on are kept here automatically.</div>}
            {recent.map((r) => (
              <div key={r.id} className="recent" onClick={() => void loadFromLibrary(r.id)}>
                {r.thumb ? <img className="thumb" src={r.thumb} alt="" /> : <div className="thumb" />}
                <div className="meta">
                  <b>{r.name}</b>
                  <small>
                    {r.width} x {r.height} · {r.fps} fps · {new Date(r.modifiedAt).toLocaleString()}
                  </small>
                </div>
                <button
                  className="icon-btn"
                  title="Remove from this list"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteFromLibrary(r.id).then(listLibrary).then(setRecent);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
