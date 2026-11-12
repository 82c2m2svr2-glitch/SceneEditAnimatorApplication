import { FlipHorizontal2, Link2, MessageSquareText, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CAMERA_ANIM_PROPS, sampleTrack } from '../core/anim';
import { VISEMES } from '../core/character/spec';
import { textToVisemes } from '../core/character/speech';
import { exposureAt, exposureFrames } from '../core/drawing';
import { PARTICLE_PRESETS } from '../core/particles';
import { ancestorOfType } from '../core/tree';
import { modelClips, modelError, modelJoints } from '../render/models';
import {
  CAMERA_ID, VIEW_NAMES, type BlendMode, type Effect, type ID, type KeyValue, type ParticleConfig, type Scene,
  type SceneNode, type Transition,
} from '../core/types';
import {
  currentValue, deleteKeys, isAnimatable, patchConstraint, patchNode, patchProject, patchScene, removeConstraint,
  scene as currentScene, setCamera, setDrawingFrame, setKey, setKeys, setProps, setPropsMany,
} from '../state/commands';
import { addIKForBone, bindSkin, imageTo3D, makeMesh, unbindSkin } from '../state/content';
import { doc, useDocRevision } from '../state/store';
import { ui, useUI } from '../state/ui';
import { ColorField, KeyDot, NumberField, Row, Section, TextField } from './widgets';

const VIEW_LABEL: Record<string, string> = { front: 'Front', threeQuarter: '3/4', side: 'Side', backThreeQuarter: 'Back 3/4', back: 'Back' };

function keyState(scene: Scene, target: ID, prop: string, frame: number): 'none' | 'track' | 'on' {
  const tr = scene.anim[target]?.[prop];
  if (!tr || tr.keys.length === 0) return 'none';
  return tr.keys.some((k) => Math.abs(k.f - frame) < 1e-6) ? 'on' : 'track';
}

function toggleKey(target: ID, prop: string, value: KeyValue | undefined): void {
  const frame = ui().frame;
  const st = keyState(currentScene(), target, prop, frame);
  if (st === 'on') deleteKeys([{ target, prop, f: frame }]);
  else if (value !== undefined) setKey(target, prop, frame, value);
}

/** Animation-aware numeric property bound to every selected node. */
function Num(props: { ids: ID[]; prop: string; label: string; step?: number; min?: number; max?: number; precision?: number; scale?: number; suffix?: string }) {
  const { ids, prop, scale = 1 } = props;
  const id = ids[0];
  const raw = currentValue(id, prop);
  // Joint turns have no stored value until they are first set; they read as zero.
  const v = typeof raw === 'number' ? raw * scale : prop.startsWith('j:') ? 0 : undefined;
  const s = currentScene();
  const frame = useUI((u) => u.frame);
  const node = s.nodes[id];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <NumberField
          label={props.label} value={v} step={props.step} min={props.min} max={props.max} precision={props.precision} suffix={props.suffix}
          undoLabel={`Change ${prop}`}
          onChange={(nv) => setPropsMany(ids.map((x) => ({ id: x, values: { [prop]: nv / scale } })), { label: `Change ${prop}`, mergeKey: `prop:${prop}` })}
        />
      </div>
      {node && isAnimatable(node, prop) && <KeyDot state={keyState(s, id, prop, frame)} onClick={() => ids.forEach((x) => toggleKey(x, prop, currentValue(x, prop)))} />}
    </div>
  );
}

function Color(props: { ids: ID[]; prop: string; allowNone?: boolean }) {
  const { ids, prop } = props;
  const raw = currentValue(ids[0], prop);
  const s = currentScene();
  const frame = useUI((u) => u.frame);
  const value = typeof raw === 'string' ? raw : null;
  const isGradient = raw !== null && typeof raw === 'object';
  return (
    <>
      <ColorField
        value={value} allowNone={props.allowNone}
        onChange={(c) => {
          if (c === null) ids.forEach((x) => patchNode(x, { [prop]: null }, `Change ${prop}`));
          else setPropsMany(ids.map((x) => ({ id: x, values: { [prop]: c } })), { label: `Change ${prop}`, mergeKey: `prop:${prop}` });
        }}
      />
      {isGradient && <span className="chip">gradient</span>}
      <span style={{ flex: 1 }} />
      <KeyDot state={keyState(s, ids[0], prop, frame)} onClick={() => value && ids.forEach((x) => toggleKey(x, prop, currentValue(x, prop)))} />
    </>
  );
}

function StepSelect(props: { id: ID; prop: string; options: { value: string; label: string }[] }) {
  const { id, prop } = props;
  const value = String(currentValue(id, prop) ?? '');
  const s = currentScene();
  const frame = useUI((u) => u.frame);
  return (
    <>
      <select
        style={{ flex: 1 }} value={value}
        onChange={(e) => setProps(id, { [prop]: e.target.value }, { label: `Change ${prop}`, ease: 'step' })}
      >
        {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <KeyDot state={keyState(s, id, prop, frame)} onClick={() => toggleKey(id, prop, value)} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------

const AXES = [['x', 'Tilt'], ['y', 'Turn'], ['z', 'Roll']] as const;

/** Three keyable angles that turn one joint of a 3D model. */
function JointTurn({ bodyId, joint }: { bodyId: ID; joint: string }) {
  return (
    <div className="grid3">
      {AXES.map(([axis, label]) => <Num key={axis} ids={[bodyId]} prop={`j:${joint}:${axis}`} label={label} suffix="°" precision={0} />)}
    </div>
  );
}

function Model3DSection({ node }: { node: Extract<SceneNode, { type: 'model3d' }> }) {
  const asset = doc.project!.assets[node.assetId];
  const clips = modelClips(asset);
  const joints = modelJoints(asset);
  const error = modelError(asset);
  const [joint, setJoint] = useState('');
  const current = joints.includes(joint) ? joint : joints[0] ?? '';
  const ids = [node.id];
  return (
    <>
      <Section title="3D model">
        {error && <div className="hint" style={{ color: 'var(--danger, #ff6b6b)' }}>{error}</div>}
        <div className="grid3">
          <Num ids={ids} prop="rotY" label="Turn" suffix="°" precision={0} />
          <Num ids={ids} prop="rotX" label="Tilt" suffix="°" precision={0} />
          <Num ids={ids} prop="rotZ" label="Roll" suffix="°" precision={0} />
        </div>
        <NumberField label="Size" value={node.height} min={8} onChange={(v) => patchNode(node.id, { height: v, width: (v * node.width) / node.height }, 'Resize 3D model', 'm3dsize')} />
        {clips.length > 0 && (
          <>
            <Row name="Motion">
              <select value={node.clip ?? ''} onChange={(e) => patchNode(node.id, { clip: e.target.value || null }, 'Choose motion')}>
                <option value="">None (rest pose)</option>
                {clips.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.duration.toFixed(1)}s)</option>)}
              </select>
            </Row>
            {node.clip && (
              <div className="grid2">
                <Num ids={ids} prop="clipSpeed" label="Speed" step={0.05} />
                <Num ids={ids} prop="clipTime" label="Offset" suffix="s" step={0.05} />
              </div>
            )}
          </>
        )}
      </Section>
      <Section title="2D look">
        <Row name="Shading">
          <div className="seg">
            {[[1, 'Flat'], [2, '2 tones'], [3, '3 tones']].map(([n, label]) => (
              <button key={n} className={node.shadeSteps === n ? 'on' : ''} onClick={() => patchNode(node.id, { shadeSteps: n as number }, 'Shading')}>{label}</button>
            ))}
          </div>
        </Row>
        <div className="grid2">
          <Num ids={ids} prop="shade" label="Shadow" min={0} max={1} step={0.02} />
          <Num ids={ids} prop="lightAngle" label="Light" suffix="°" precision={0} />
        </div>
        <Row name="Outline">
          <Num ids={ids} prop="outline" label="" min={0} max={4} step={0.05} />
          <Color ids={ids} prop="outlineColor" />
        </Row>
      </Section>
      {joints.length > 0 && (
        <Section title={`Joints (${joints.length})`}>
          <select value={current} onChange={(e) => setJoint(e.target.value)}>
            {joints.map((j) => <option key={j} value={j}>{j}</option>)}
          </select>
          <JointTurn bodyId={node.id} joint={current} />
          <div className="hint">Every joint can be turned and keyed. For a character, select a bone on the stage to pose it; these turns add true 3D motion on top.</div>
        </Section>
      )}
    </>
  );
}

function EffectsSection({ node }: { node: SceneNode }) {
  const update = (fx: Effect[]) => patchNode(node.id, { effects: fx }, 'Edit effects', 'effects');
  const setFx = (i: number, patch: Partial<Effect>) => update(node.effects.map((e, k) => (k === i ? ({ ...e, ...patch } as Effect) : e)));
  const add = (type: Effect['type']) => {
    const defs: Record<Effect['type'], Effect> = {
      blur: { type: 'blur', enabled: true, radius: 6 },
      glow: { type: 'glow', enabled: true, radius: 14, color: '#7c5cff', strength: 2 },
      shadow: { type: 'shadow', enabled: true, dx: 0, dy: 12, radius: 16, color: 'rgba(0,0,0,0.55)' },
      color: { type: 'color', enabled: true, brightness: 1, contrast: 1, saturation: 1, hue: 0 },
      tint: { type: 'tint', enabled: true, color: '#22d3ee', amount: 0.35 },
    };
    patchNode(node.id, { effects: [...node.effects, defs[type]] }, 'Add effect');
  };
  return (
    <Section
      title="Effects"
      defaultOpen={node.effects.length > 0}
      actions={
        <select value="" style={{ height: 20, width: 74 }} onChange={(e) => e.target.value && add(e.target.value as Effect['type'])}>
          <option value="">+ Add</option>
          <option value="blur">Blur</option>
          <option value="glow">Glow</option>
          <option value="shadow">Drop shadow</option>
          <option value="color">Colour adjust</option>
          <option value="tint">Tint</option>
        </select>
      }
    >
      {node.effects.length === 0 && <div className="hint">Blur, glow, drop shadow, colour adjustment and tint. Effects apply to this layer and everything inside it.</div>}
      {node.effects.map((e, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, background: 'var(--bg-2)', padding: 6, borderRadius: 6 }}>
          <div className="row">
            <input type="checkbox" checked={e.enabled} onChange={(ev) => setFx(i, { enabled: ev.target.checked })} />
            <b style={{ flex: 1, textTransform: 'capitalize' }}>{e.type === 'color' ? 'Colour adjust' : e.type}</b>
            <button className="icon-btn sm" title="Remove effect" onClick={() => update(node.effects.filter((_x, k) => k !== i))}><Trash2 size={12} /></button>
          </div>
          {e.type === 'blur' && <NumberField label="Radius" value={e.radius} min={0} max={200} onChange={(v) => setFx(i, { radius: v })} />}
          {e.type === 'glow' && (
            <div className="row">
              <ColorField value={e.color} onChange={(c) => setFx(i, { color: c ?? '#ffffff' })} />
              <NumberField label="Radius" value={e.radius} min={0} max={200} onChange={(v) => setFx(i, { radius: v })} />
              <NumberField label="Power" value={e.strength} min={1} max={4} precision={0} onChange={(v) => setFx(i, { strength: v })} />
            </div>
          )}
          {e.type === 'shadow' && (
            <>
              <div className="row">
                <ColorField value={e.color} onChange={(c) => setFx(i, { color: c ?? '#000000' })} />
                <NumberField label="Blur" value={e.radius} min={0} max={200} onChange={(v) => setFx(i, { radius: v })} />
              </div>
              <div className="grid2">
                <NumberField label="X" value={e.dx} onChange={(v) => setFx(i, { dx: v })} />
                <NumberField label="Y" value={e.dy} onChange={(v) => setFx(i, { dy: v })} />
              </div>
            </>
          )}
          {e.type === 'color' && (
            <div className="grid2">
              <NumberField label="Bright" value={e.brightness} min={0} max={4} step={0.02} onChange={(v) => setFx(i, { brightness: v })} />
              <NumberField label="Contrast" value={e.contrast} min={0} max={4} step={0.02} onChange={(v) => setFx(i, { contrast: v })} />
              <NumberField label="Satur." value={e.saturation} min={0} max={4} step={0.02} onChange={(v) => setFx(i, { saturation: v })} />
              <NumberField label="Hue" value={e.hue} min={-360} max={360} onChange={(v) => setFx(i, { hue: v })} />
            </div>
          )}
          {e.type === 'tint' && (
            <div className="row">
              <ColorField value={e.color} onChange={(c) => setFx(i, { color: c ?? '#ffffff' })} />
              <NumberField label="Amount" value={e.amount} min={0} max={1} step={0.02} onChange={(v) => setFx(i, { amount: v })} />
            </div>
          )}
        </div>
      ))}
    </Section>
  );
}

function ParticleSection({ node }: { node: Extract<SceneNode, { type: 'particles' }> }) {
  const c = node.config;
  const set = (patch: Partial<ParticleConfig>) => patchNode(node.id, { config: { ...c, ...patch } }, 'Edit particles', 'particles');
  const N = (label: string, key: keyof ParticleConfig, opts: { min?: number; max?: number; step?: number; precision?: number } = {}) => (
    <NumberField label={label} value={c[key] as number} {...opts} onChange={(v) => set({ [key]: v } as Partial<ParticleConfig>)} />
  );
  return (
    <Section title="Particles">
      <Row name="Preset">
        <select style={{ flex: 1 }} value={c.preset} onChange={(e) => set({ ...PARTICLE_PRESETS[e.target.value], preset: e.target.value })}>
          {Object.keys(PARTICLE_PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </Row>
      <Row name="Shape">
        <select style={{ flex: 1 }} value={c.shape} onChange={(e) => set({ shape: e.target.value as ParticleConfig['shape'] })}>
          {['circle', 'square', 'streak', 'star', 'flake'].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </Row>
      <div className="grid2">{N('Rate', 'rate', { min: 0, max: 2000 })}{N('Life', 'life', { min: 0.05, max: 30, step: 0.05 })}</div>
      <div className="grid2">{N('Speed', 'speed', { min: 0 })}{N('Spread', 'spread', { min: 0, max: 180 })}</div>
      <div className="grid2">{N('Angle', 'angle')}{N('Drag', 'drag', { min: 0, max: 10, step: 0.05 })}</div>
      <div className="grid2">{N('Grav X', 'gravityX')}{N('Grav Y', 'gravityY')}</div>
      <div className="grid2">{N('Area W', 'width', { min: 0 })}{N('Area H', 'height', { min: 0 })}</div>
      <div className="grid2">{N('Size 0', 'sizeStart', { min: 0 })}{N('Size 1', 'sizeEnd', { min: 0 })}</div>
      <div className="grid2">{N('Alpha 0', 'alphaStart', { min: 0, max: 1, step: 0.02 })}{N('Alpha 1', 'alphaEnd', { min: 0, max: 1, step: 0.02 })}</div>
      <Row name="Colours">
        <ColorField value={c.colorStart} onChange={(v) => set({ colorStart: v ?? '#ffffff' })} title="Colour at birth" />
        <ColorField value={c.colorEnd} onChange={(v) => set({ colorEnd: v ?? '#ffffff' })} title="Colour at death" />
        {N('Seed', 'seed', { min: 0, precision: 0 })}
      </Row>
    </Section>
  );
}

function IKSection({ scene, node }: { scene: Scene; node: SceneNode }) {
  const related = scene.constraints.filter((c) => c.targetId === node.id || c.bones.includes(node.id));
  if (node.type !== 'bone' && related.length === 0) return null;
  return (
    <Section title="Inverse kinematics" defaultOpen={related.length > 0}>
      {node.type === 'bone' && (
        <button className="btn" onClick={() => addIKForBone(node.id)} title="Creates a target the limb reaches for, so feet and hands can stay planted">
          <Plus size={13} /> Add IK target for this bone
        </button>
      )}
      {related.map((c) => (
        <div key={c.id} style={{ background: 'var(--bg-2)', padding: 6, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="row">
            <input type="checkbox" checked={c.enabled} onChange={(e) => patchConstraint(c.id, { enabled: e.target.checked })} />
            <b style={{ flex: 1 }}>{c.name}</b>
            <button className="icon-btn sm" title="Flip bend direction" onClick={() => patchConstraint(c.id, { bendPositive: !c.bendPositive })}><FlipHorizontal2 size={12} /></button>
            <button className="icon-btn sm" title="Remove" onClick={() => removeConstraint(c.id)}><Trash2 size={12} /></button>
          </div>
          <NumberField label="Mix" value={c.mix} min={0} max={1} step={0.02} onChange={(v) => patchConstraint(c.id, { mix: v })} />
        </div>
      ))}
    </Section>
  );
}

/** Lip-syncs a typed line of dialogue at the playhead (no audio needed). */
function SpeakRow({ id }: { id: ID }) {
  const [text, setText] = useState('');
  const speak = () => {
    const line = text.trim();
    if (!line) return;
    const p = doc.project!;
    const shapes = textToVisemes(line, p.fps, ui().frame);
    const end = shapes[shapes.length - 1].frame;
    doc.transact('Lip-sync text', () => {
      setKeys(shapes.map((v) => ({ target: id, prop: 'mouth', f: v.frame, v: v.viseme, e: 'step' as const })), 'Lip-sync text');
      if (end >= currentScene().duration) patchScene({ duration: end + 12 }, 'Extend scene');
    });
    ui().toast(`Mouth keyed from frame ${shapes[0].frame} to ${end}. Fine-tune the shapes on the "mouth" track.`, 'success');
    setText('');
  };
  return (
    <div className="row">
      <input
        type="text" style={{ flex: 1 }} placeholder="Type a line to lip-sync at the playhead" value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') speak(); }}
      />
      <button className="icon-btn" title="Key the mouth shapes for this line" disabled={!text.trim()} onClick={speak}><MessageSquareText size={14} /></button>
    </div>
  );
}

function NodeProperties({ scene, ids }: { scene: Scene; ids: ID[] }) {
  const setup = useUI((u) => u.setupMode);
  const frame = useUI((u) => u.frame);
  const node = scene.nodes[ids[0]];
  if (!node) return null;
  const sameType = ids.every((id) => scene.nodes[id]?.type === node.type);
  const isBone = node.type === 'bone';
  const nonBones = ids.filter((id) => scene.nodes[id]?.type !== 'bone');
  return (
    <>
      <div style={{ padding: 8, display: 'flex', gap: 6, alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
        {ids.length === 1 ? <TextField value={node.name} onChange={(v) => v && patchNode(node.id, { name: v }, 'Rename')} /> : <b style={{ flex: 1 }}>{ids.length} layers selected</b>}
        <span className="chip">{sameType ? node.type : 'mixed'}</span>
      </div>

      <Section title={isBone ? (setup ? 'Bone rest pose (setup)' : 'Bone pose') : 'Transform'}>
        <div className="grid2"><Num ids={ids} prop="x" label="X" /><Num ids={ids} prop="y" label="Y" /></div>
        <div className="grid2">
          <Num ids={ids} prop="rotation" label="Rot" suffix="°" />
          {isBone && ids.length === 1 ? (
            <NumberField label="Len" value={node.length} min={0} onChange={(v) => patchNode(node.id, { length: v }, 'Bone length', 'bonelen')} disabled={!setup} title={setup ? 'Bone length' : 'Switch to Setup to change bone length'} />
          ) : <span />}
        </div>
        <div className="row">
          <div className="grid2"><Num ids={ids} prop="scaleX" label="SX" step={0.01} precision={3} /><Num ids={ids} prop="scaleY" label="SY" step={0.01} precision={3} /></div>
          <button className="icon-btn sm" title="Make scale uniform" onClick={() => { const v = currentValue(ids[0], 'scaleX'); if (typeof v === 'number') setPropsMany(ids.map((id) => ({ id, values: { scaleY: v } })), { label: 'Uniform scale' }); }}><Link2 size={12} /></button>
          <button className="icon-btn sm" title="Flip horizontally" onClick={() => setPropsMany(ids.map((id) => ({ id, values: { scaleX: -((currentValue(id, 'scaleX') as number) ?? 1) } })), { label: 'Flip' })}><FlipHorizontal2 size={12} /></button>
        </div>
        {!isBone && (
          <>
            <div className="grid2"><Num ids={ids} prop="opacity" label="Opacity" scale={100} min={0} max={100} precision={0} suffix="%" /><Num ids={ids} prop="zOrder" label="Order" precision={0} /></div>
            <Row name="Depth" title="Distance from the camera plane. Positive is further away; layers at different depths slide at different speeds when the camera moves.">
              <Num ids={ids} prop="depth" label="" step={5} />
            </Row>
            <Row name="Blend">
              <select style={{ flex: 1 }} value={node.blend} onChange={(e) => ids.forEach((id) => patchNode(id, { blend: e.target.value as BlendMode }, 'Blend mode'))}>
                {['normal', 'multiply', 'screen', 'overlay', 'lighter', 'darken', 'lighten'].map((b) => <option key={b}>{b}</option>)}
              </select>
            </Row>
          </>
        )}
        {isBone && !setup && <div className="hint">Pose values are offsets from the rest pose. Switch to Setup (above the viewport) to change the rig itself.</div>}
      </Section>

      {sameType && node.type === 'shape' && (
        <Section title="Shape">
          <Row name="Fill"><Color ids={ids} prop="fill" allowNone /></Row>
          <Row name="Stroke"><Color ids={ids} prop="stroke" allowNone /></Row>
          <Row name="Width"><Num ids={ids} prop="strokeWidth" label="" min={0} step={0.5} /></Row>
          <Row name="Skin">
            {node.skin ? (
              <>
                <span className="chip">{node.skin.bones.length} bones</span>
                <button className="btn" onClick={() => unbindSkin(ids)}>Unbind</button>
              </>
            ) : (
              <button className="btn" title="Deform this shape with the bones of its character (or all bones in the scene)" onClick={() => { const n = bindSkin(ids); ui().toast(n ? `Bound ${n} shape${n > 1 ? 's' : ''} to bones` : 'No bones found to bind to', n ? 'success' : 'error'); }}>Bind to bones</button>
            )}
          </Row>
        </Section>
      )}

      {sameType && node.type === 'text' && ids.length === 1 && (
        <Section title="Text">
          <TextField multiline value={node.text} onChange={(v) => patchNode(node.id, { text: v }, 'Edit text')} />
          <Row name="Font">
            <select style={{ flex: 1 }} value={node.font} onChange={(e) => patchNode(node.id, { font: e.target.value }, 'Font')}>
              {['Inter, system-ui, sans-serif', 'Georgia, serif', "'Courier New', monospace", "'Comic Sans MS', 'Comic Neue', cursive", 'Impact, sans-serif', "'Trebuchet MS', sans-serif", "'Arial Black', sans-serif"].map((f) => <option key={f} value={f}>{f.split(',')[0].replace(/'/g, '')}</option>)}
            </select>
          </Row>
          <div className="grid2"><Num ids={ids} prop="size" label="Size" min={1} /><NumberField label="Weight" value={node.weight} min={100} max={900} step={100} precision={0} onChange={(v) => patchNode(node.id, { weight: v }, 'Weight')} /></div>
          <Row name="Align">
            <div className="seg">
              {(['left', 'center', 'right'] as const).map((a) => <button key={a} className={node.align === a ? 'on' : ''} onClick={() => patchNode(node.id, { align: a }, 'Align')}>{a}</button>)}
            </div>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={node.italic} onChange={(e) => patchNode(node.id, { italic: e.target.checked }, 'Italic')} /> Italic</label>
          </Row>
          <Row name="Fill"><Color ids={ids} prop="fill" allowNone /></Row>
          <Row name="Outline"><Color ids={ids} prop="stroke" allowNone /></Row>
          <Row name="Width"><Num ids={ids} prop="strokeWidth" label="" min={0} step={0.5} /></Row>
        </Section>
      )}

      {sameType && node.type === 'image' && ids.length === 1 && (
        <Section title="Image">
          <div className="grid2">
            <NumberField label="W" value={node.width} min={1} onChange={(v) => patchNode(node.id, { width: v, height: (v * node.height) / node.width }, 'Resize image', 'imgsize')} />
            <NumberField label="H" value={node.height} min={1} onChange={(v) => patchNode(node.id, { height: v }, 'Resize image', 'imgsize')} />
          </div>
          <Row name="Mesh">
            {node.mesh ? (
              <>
                <span className="chip">{node.mesh.cols} x {node.mesh.rows}</span>
                {node.skin ? <button className="btn" onClick={() => unbindSkin(ids)}>Unbind</button> : <button className="btn" onClick={() => { const n = bindSkin(ids); ui().toast(n ? 'Mesh bound to bones' : 'No bones found to bind to', n ? 'success' : 'error'); }}>Bind to bones</button>}
                <button className="btn" onClick={() => patchNode(node.id, { mesh: undefined, skin: undefined }, 'Remove mesh')}>Remove</button>
              </>
            ) : (
              <button className="btn" title="Turn the image into a grid that bones can bend" onClick={() => makeMesh(node.id, 10, 10)}>Create deform mesh</button>
            )}
          </Row>
          <Row name="Vector">
            <button className="btn" title="Turn this picture into editable flat-colour vector shapes" onClick={() => ui().set({ dialog: 'trace' })}>Trace to vector shapes…</button>
          </Row>
          <Row name="3D">
            <button className="btn" title="Puff this picture up into a rounded 3D object that can turn in depth. Works best on a cut-out of a single object." onClick={() => { if (imageTo3D(node.id)) ui().toast('Turned into a 3D object. Use Turn, Tilt and Roll to rotate it.', 'success'); }}>Make it a 3D object</button>
          </Row>
        </Section>
      )}

      {sameType && node.type === 'model3d' && ids.length === 1 && <Model3DSection node={node} />}

      {isBone && ids.length === 1 && (() => {
        // A bone of a 3D character can also turn in depth, which the flat skeleton cannot express.
        const owner = ancestorOfType(scene, node.id, 'character');
        const body = owner?.children.map((c) => scene.nodes[c]).find((c) => c?.type === 'model3d');
        return body ? (
          <Section title="3D turn">
            <JointTurn bodyId={body.id} joint={node.name} />
            <div className="hint">Turns this joint in depth, for example to look left and right or reach toward the viewer.</div>
          </Section>
        ) : null;
      })()}

      {sameType && node.type === 'character' && ids.length === 1 && (
        <Section title="Character">
          <Row name="View">
            <StepSelect id={node.id} prop="currentView" options={node.views.map((v) => ({ value: v, label: VIEW_LABEL[v] ?? v }))} />
          </Row>
          <Row name="Mouth"><StepSelect id={node.id} prop="mouth" options={VISEMES.map((v) => ({ value: v, label: v }))} /></Row>
          <Row name="Eyes"><StepSelect id={node.id} prop="eyes" options={['open', 'closed', 'happy'].map((v) => ({ value: v, label: v }))} /></Row>
          <SpeakRow id={node.id} />
          <div className="hint">View, mouth and eyes can be keyed to turn the character, blink or lip-sync during a shot. Actions are in the Actions tab.</div>
        </Section>
      )}

      {sameType && node.type === 'switch' && ids.length === 1 && (
        <Section title="Switch">
          {node.source ? (
            <div className="hint">Follows the character's "{node.source}" setting.</div>
          ) : (
            <Row name="Showing"><StepSelect id={node.id} prop="active" options={node.children.map((c) => ({ value: scene.nodes[c]?.name ?? c, label: scene.nodes[c]?.name ?? c }))} /></Row>
          )}
        </Section>
      )}

      {sameType && node.type === 'drawing' && ids.length === 1 && (() => {
        const frames = exposureFrames(node.frames);
        const exp = exposureAt(node.frames, Math.floor(frame));
        const prev = [...frames].reverse().find((f) => f < Math.floor(frame));
        return (
          <Section title="Drawing layer">
            <div className="hint">{frames.length} drawing{frames.length === 1 ? '' : 's'}. {exp === null ? 'Nothing drawn yet at this frame.' : exp === Math.floor(frame) ? 'This frame has its own drawing.' : `Showing the drawing from frame ${exp} (held).`}</div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn" disabled={exp === Math.floor(frame)} onClick={() => setDrawingFrame(node.id, frame, [], 'Insert blank drawing')}>Blank frame</button>
              <button className="btn" disabled={prev === undefined || exp === Math.floor(frame)} onClick={() => prev !== undefined && setDrawingFrame(node.id, frame, [...node.frames[String(prev)]], 'Duplicate drawing')}>Copy previous</button>
              <button className="btn danger" disabled={exp !== Math.floor(frame)} onClick={() => setDrawingFrame(node.id, frame, null, 'Delete drawing')}>Delete</button>
            </div>
          </Section>
        );
      })()}

      {sameType && node.type === 'particles' && ids.length === 1 && <ParticleSection node={node} />}
      {ids.length === 1 && <IKSection scene={scene} node={node} />}
      {ids.length === 1 && !isBone && <EffectsSection node={node} />}
      {nonBones.length === 0 && isBone && ids.length === 1 && (
        <Section title="Bone display" defaultOpen={false}>
          <Row name="Colour"><ColorField value={node.color ?? '#ffd166'} onChange={(c) => patchNode(node.id, { color: c ?? undefined }, 'Bone colour', 'bonecolor')} /></Row>
        </Section>
      )}
    </>
  );
}

function CamNum(props: { prop: (typeof CAMERA_ANIM_PROPS)[number]; label: string; step?: number; min?: number; max?: number; precision?: number }) {
  const s = currentScene();
  const frame = useUI((u) => u.frame);
  const tr = s.anim[CAMERA_ID]?.[props.prop];
  const base = (s.camera as unknown as Record<string, number>)[props.prop];
  const sampled = sampleTrack(tr, frame);
  const v = typeof sampled === 'number' ? sampled : base;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <NumberField label={props.label} value={v} step={props.step} min={props.min} max={props.max} precision={props.precision} undoLabel="Edit camera"
          onChange={(nv) => setCamera({ [props.prop]: nv }, { mergeKey: `cam:${props.prop}` })} />
      </div>
      <KeyDot state={keyState(s, CAMERA_ID, props.prop, frame)} onClick={() => toggleKey(CAMERA_ID, props.prop, v)} />
    </div>
  );
}

function SceneProperties({ scene }: { scene: Scene }) {
  const p = doc.project!;
  return (
    <>
      <Section title="Scene">
        <Row name="Length">
          <NumberField label="Frames" value={scene.duration} min={1} max={100000} precision={0} onChange={(v) => patchScene({ duration: Math.max(1, Math.round(v)) }, 'Scene length', 'scenedur')} />
          <NumberField label="Sec" value={scene.duration / p.fps} min={0.04} step={0.1} onChange={(v) => patchScene({ duration: Math.max(1, Math.round(v * p.fps)) }, 'Scene length', 'scenedur')} />
        </Row>
        <Row name="Background"><ColorField value={scene.background} onChange={(c) => patchScene({ background: c ?? '#000000' }, 'Background', 'scenebg')} /></Row>
        <Row name="Next cut" title="How this scene hands over to the next one when the whole project plays or exports">
          <select style={{ flex: 1 }} value={scene.transition.type} onChange={(e) => patchScene({ transition: { ...scene.transition, type: e.target.value as Transition['type'] } }, 'Transition')}>
            {[['cut', 'Cut'], ['fade', 'Fade through black'], ['dissolve', 'Cross dissolve'], ['wipeLeft', 'Wipe left'], ['wipeRight', 'Wipe right'], ['slideLeft', 'Slide left'], ['slideRight', 'Slide right']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {scene.transition.type !== 'cut' && <NumberField label="Fr" value={scene.transition.duration} min={1} max={240} precision={0} onChange={(v) => patchScene({ transition: { ...scene.transition, duration: Math.round(v) } }, 'Transition', 'transdur')} />}
        </Row>
      </Section>
      <Section title="Camera">
        <div className="grid2"><CamNum prop="x" label="X" /><CamNum prop="y" label="Y" /></div>
        <div className="grid2"><CamNum prop="zoom" label="Zoom" step={0.01} min={0.05} max={50} precision={3} /><CamNum prop="rotation" label="Roll" /></div>
        <div className="grid2"><CamNum prop="z" label="Dolly" step={5} /><CamNum prop="focal" label="Lens" step={10} min={100} max={10000} precision={0} /></div>
        <Row name="Depth of field">
          <input type="checkbox" checked={scene.camera.dofEnabled} onChange={(e) => patchScene({ camera: { ...scene.camera, dofEnabled: e.target.checked } }, 'Depth of field')} />
        </Row>
        {scene.camera.dofEnabled && <div className="grid2"><CamNum prop="focusDepth" label="Focus" step={5} /><CamNum prop="aperture" label="Blur" step={0.2} min={0} max={100} /></div>}
        <div className="hint">Dolly moves the camera into the scene: near layers grow faster than far ones. A shorter lens exaggerates the effect. Give layers a Depth to see it.</div>
      </Section>
      <Section title="Project" defaultOpen={false}>
        <Row name="Size">
          <NumberField label="W" value={p.width} min={16} max={8192} precision={0} onChange={(v) => patchProject({ width: Math.round(v) }, 'Project size')} />
          <NumberField label="H" value={p.height} min={16} max={8192} precision={0} onChange={(v) => patchProject({ height: Math.round(v) }, 'Project size')} />
        </Row>
        <Row name="Frame rate"><NumberField label="fps" value={p.fps} min={1} max={120} precision={0} onChange={(v) => patchProject({ fps: Math.round(v) }, 'Frame rate')} /></Row>
      </Section>
    </>
  );
}

export function Properties() {
  useDocRevision();
  useUI((u) => u.frame);
  useUI((u) => u.setupMode);
  const selection = useUI((u) => u.selection);
  const sceneId = useUI((u) => u.sceneId);
  const p = doc.project;
  if (!p) return null;
  const scene = p.scenes.find((s) => s.id === sceneId) ?? p.scenes[0];
  const ids = selection.filter((id) => scene.nodes[id]);
  return ids.length ? <NodeProperties scene={scene} ids={ids} /> : <SceneProperties scene={scene} />;
}

export { VIEW_LABEL, VIEW_NAMES };
