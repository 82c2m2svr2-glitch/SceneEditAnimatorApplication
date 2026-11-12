/**
 * The command layer. Every way of changing a project (menus, viewport tools, panels, the AI
 * assistant) calls these functions; nothing else touches the document. Each call is one undo step
 * unless it runs inside `doc.transact` / `doc.begin`.
 */
import {
  animated, COMMON_ANIM_PROPS, EXTRA_ANIM_PROPS, getEval, hasKeyAt, removeKeyAt, upsertKey, type EvalScene, evaluateScene,
} from '../core/anim';
import { exposureAt } from '../core/drawing';
import { createGroup, createImage, createScene } from '../core/factory';
import { newId } from '../core/ids';
import { PLATE_DEPTH, PLATE_TAG, plateLayout, type PlateInfo, type StylePreset } from '../core/localGen';
import { apply, decompose, IDENTITY, invert, mul, type Vec } from '../core/math';
import { ancestorOfType, extractSubtree, insertBundle, subtreeIds, topLevel, uniqueName, type RigFile } from '../core/tree';
import {
  CAMERA_ID, type ActionClip, type ActionStrip, type Asset, type AudioClip, type BoneNode, type Camera, type Ease,
  type ID, type IKConstraint, type Keyframe, type KeyValue, type Mat, type Project, type Scene, type SceneNode,
  type Stroke, type Track,
} from '../core/types';
import { doc, project } from './store';
import { ui, useUI, type KeyRef } from './ui';

const BONE_CHANNELS = new Set(['x', 'y', 'rotation', 'scaleX', 'scaleY']);

// ---------------------------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------------------------

export function scene(p: Project = project()): Scene {
  const id = ui().sceneId;
  return p.scenes.find((s) => s.id === id) ?? p.scenes[0];
}

/** The current scene inside a store recipe draft. */
function S(d: Project): Scene {
  return scene(d);
}

export function node(id: ID): SceneNode | undefined {
  return scene().nodes[id];
}

export function evalNow(): EvalScene {
  const u = ui();
  return getEval(project(), scene(), u.frame, u.setupMode);
}

export function isAnimatable(n: SceneNode, prop: string): boolean {
  if (n.type === 'model3d' && prop.startsWith('j:')) return true;
  return COMMON_ANIM_PROPS.includes(prop) || (EXTRA_ANIM_PROPS[n.type] ?? []).includes(prop);
}

/** Current (animated) value of a property as shown in the UI. For bones the channels are pose deltas. */
export function currentValue(id: ID, prop: string): KeyValue | undefined {
  const es = evalNow();
  const en = es.nodes.get(id);
  if (!en) return undefined;
  const n = en.node;
  if (n.type === 'bone' && BONE_CHANNELS.has(prop)) {
    const rest = (en.view && n.viewRest?.[en.view]) || n;
    if (ui().setupMode) return prop === 'x' || prop === 'y' || prop === 'rotation' ? rest[prop] : n[prop as 'scaleX'];
    switch (prop) {
      case 'x': return en.x - rest.x;
      case 'y': return en.y - rest.y;
      case 'rotation': return en.rotation - rest.rotation;
      case 'scaleX': return n.scaleX === 0 ? 1 : en.scaleX / n.scaleX;
      default: return n.scaleY === 0 ? 1 : en.scaleY / n.scaleY;
    }
  }
  if (COMMON_ANIM_PROPS.includes(prop) && prop !== 'visible') return (en as unknown as Record<string, number>)[prop];
  return animated(en, prop);
}

// ---------------------------------------------------------------------------------------------
// Property edits (animation aware)
// ---------------------------------------------------------------------------------------------

export interface SetOptions {
  frame?: number;
  /** true = always key, false = never key, 'auto' (default) = follow auto-key and existing tracks. */
  key?: boolean | 'auto';
  ease?: Ease;
  setup?: boolean;
  label?: string;
  mergeKey?: string;
}

/** Writes values into a scene draft, keying or editing base values as appropriate. */
export function writeProps(s: Scene, id: ID, values: Record<string, KeyValue>, o: Required<Pick<SetOptions, 'frame' | 'key' | 'setup'>> & { ease: Ease; autoKey: boolean }): void {
  const n = s.nodes[id];
  if (!n) return;
  const rec = n as unknown as Record<string, KeyValue>;
  for (const prop in values) {
    const v = values[prop];
    if (v === undefined) continue;
    const boneChannel = n.type === 'bone' && BONE_CHANNELS.has(prop);
    if (boneChannel && o.setup) {
      const bone = n as BoneNode;
      const ch = ancestorOfType(s, id, 'character');
      const rest = ch && bone.viewRest?.[ch.currentView];
      if ((prop === 'x' || prop === 'y' || prop === 'rotation') && rest) rest[prop] = v as number;
      else rec[prop] = v;
      continue;
    }
    const track = s.anim[id]?.[prop];
    const canKey = isAnimatable(n, prop);
    const shouldKey = canKey && (o.key === true || (o.key === 'auto' && (!!track || (o.autoKey && !o.setup && o.frame > 0))));
    if (shouldKey && o.key !== false) {
      const tracks = (s.anim[id] ??= {});
      const tr = (tracks[prop] ??= { keys: [] });
      if (tr.keys.length === 0 && o.key === 'auto' && o.frame > 0) {
        // First auto-key away from frame 0: pin the old value at the start so the change animates.
        const old = boneChannel ? (n as BoneNode).pose[prop as keyof BoneNode['pose']] : rec[prop] ?? (prop.startsWith('j:') ? 0 : undefined);
        if (old !== undefined) tr.keys.push({ f: 0, v: old, e: o.ease });
      }
      const existing = tr.keys.find((k) => Math.abs(k.f - o.frame) < 1e-6);
      upsertKey(tr.keys, existing ? { f: o.frame, v } : { f: o.frame, v, e: o.ease });
    } else if (boneChannel) {
      (n as BoneNode).pose[prop as keyof BoneNode['pose']] = v as number;
    } else {
      rec[prop] = v;
    }
  }
}

function resolveSetOptions(opts: SetOptions) {
  const u = ui();
  return {
    frame: opts.frame ?? u.frame,
    key: opts.key ?? ('auto' as const),
    setup: opts.setup ?? u.setupMode,
    ease: opts.ease ?? u.defaultEase,
    autoKey: u.autoKey,
  };
}

/** Sets one or more properties on a node, creating keyframes when animating. */
export function setProps(id: ID, values: Record<string, KeyValue>, opts: SetOptions = {}): void {
  const o = resolveSetOptions(opts);
  doc.apply(opts.label ?? 'Edit properties', (d) => writeProps(S(d), id, values, o), { mergeKey: opts.mergeKey });
}

export function setPropsMany(edits: { id: ID; values: Record<string, KeyValue> }[], opts: SetOptions = {}): void {
  const o = resolveSetOptions(opts);
  doc.apply(
    opts.label ?? 'Edit properties',
    (d) => {
      const s = S(d);
      for (const e of edits) writeProps(s, e.id, e.values, o);
    },
    { mergeKey: opts.mergeKey },
  );
}

/** Raw structural patch for properties that are never animated (name, text content, path, ...). */
export function patchNode(id: ID, patch: Record<string, unknown>, label = 'Edit', mergeKey?: string): void {
  doc.apply(
    label,
    (d) => {
      const n = S(d).nodes[id];
      if (n) Object.assign(n, patch);
    },
    { mergeKey },
  );
}

export function setCamera(values: Partial<Camera>, opts: SetOptions = {}): void {
  const o = resolveSetOptions(opts);
  doc.apply(
    opts.label ?? 'Edit camera',
    (d) => {
      const s = S(d);
      const cam = s.camera as unknown as Record<string, KeyValue>;
      for (const prop in values) {
        const v = (values as Record<string, KeyValue>)[prop];
        const numeric = typeof v === 'number';
        const track = s.anim[CAMERA_ID]?.[prop];
        const shouldKey = numeric && (o.key === true || (o.key === 'auto' && (!!track || (o.autoKey && o.frame > 0))));
        if (shouldKey) {
          const tr = ((s.anim[CAMERA_ID] ??= {})[prop] ??= { keys: [] });
          if (tr.keys.length === 0 && o.key === 'auto' && o.frame > 0) tr.keys.push({ f: 0, v: cam[prop], e: o.ease });
          const existing = tr.keys.find((k) => Math.abs(k.f - o.frame) < 1e-6);
          upsertKey(tr.keys, existing ? { f: o.frame, v } : { f: o.frame, v, e: o.ease });
        } else cam[prop] = v;
      }
    },
    { mergeKey: opts.mergeKey },
  );
}

// ---------------------------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------------------------

export function setKey(target: ID, prop: string, frame: number, value: KeyValue, ease?: Ease, label = 'Set keyframe'): void {
  doc.apply(label, (d) => {
    const s = S(d);
    const tr = ((s.anim[target] ??= {})[prop] ??= { keys: [] });
    const key: Keyframe = { f: frame, v: value };
    if (ease !== undefined) key.e = ease;
    else if (!tr.keys.some((k) => Math.abs(k.f - frame) < 1e-6)) key.e = ui().defaultEase;
    upsertKey(tr.keys, key);
  });
}

/** Sets many keys in one undo step. Used by the AI and by paste. */
export function setKeys(keys: { target: ID; prop: string; f: number; v: KeyValue; e?: Ease }[], label = 'Set keyframes'): void {
  doc.apply(label, (d) => {
    const s = S(d);
    for (const k of keys) {
      const tr = ((s.anim[k.target] ??= {})[k.prop] ??= { keys: [] });
      upsertKey(tr.keys, { f: k.f, v: k.v, e: k.e ?? ui().defaultEase });
    }
  });
}

function cleanTracks(s: Scene, target: ID): void {
  const tracks = s.anim[target];
  if (!tracks) return;
  for (const prop in tracks) if (tracks[prop].keys.length === 0) delete tracks[prop];
  if (Object.keys(tracks).length === 0) delete s.anim[target];
}

export function deleteKeys(refs: KeyRef[]): void {
  if (refs.length === 0) return;
  doc.apply('Delete keyframes', (d) => {
    const s = S(d);
    for (const r of refs) {
      const tr = s.anim[r.target]?.[r.prop];
      if (tr) removeKeyAt(tr.keys, r.f);
    }
    for (const t of new Set(refs.map((r) => r.target))) cleanTracks(s, t);
  });
  useUI.setState({ selectedKeys: [] });
}

/** Shifts keys in time. Keys landing on an occupied frame replace the key that was there. */
export function moveKeys(refs: KeyRef[], delta: number): KeyRef[] {
  if (refs.length === 0 || delta === 0) return refs;
  const moved: KeyRef[] = [];
  doc.apply('Move keyframes', (d) => {
    const s = S(d);
    const groups = new Map<string, KeyRef[]>();
    for (const r of refs) {
      const k = `${r.target}\n${r.prop}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    for (const list of groups.values()) {
      const tr = s.anim[list[0].target]?.[list[0].prop];
      if (!tr) continue;
      const lifted: Keyframe[] = [];
      for (const r of list) {
        const i = tr.keys.findIndex((k) => Math.abs(k.f - r.f) < 1e-6);
        if (i >= 0) lifted.push(tr.keys.splice(i, 1)[0]);
      }
      for (const k of lifted) {
        const f = Math.max(0, k.f + delta);
        upsertKey(tr.keys, { ...k, f });
        moved.push({ target: list[0].target, prop: list[0].prop, f });
      }
    }
  });
  useUI.setState({ selectedKeys: moved });
  return moved;
}

export function setKeysEase(refs: KeyRef[], ease: Ease): void {
  doc.apply('Set easing', (d) => {
    const s = S(d);
    for (const r of refs) {
      const k = s.anim[r.target]?.[r.prop]?.keys.find((kk) => Math.abs(kk.f - r.f) < 1e-6);
      if (k) k.e = ease;
    }
  });
}

export function setKeyValue(ref: KeyRef, value: KeyValue, mergeKey?: string): void {
  doc.apply(
    'Edit keyframe',
    (d) => {
      const k = S(d).anim[ref.target]?.[ref.prop]?.keys.find((kk) => Math.abs(kk.f - ref.f) < 1e-6);
      if (k) k.v = value;
    },
    { mergeKey },
  );
}

export function clearTrack(target: ID, prop?: string): void {
  doc.apply('Clear animation', (d) => {
    const s = S(d);
    if (!s.anim[target]) return;
    if (prop) delete s.anim[target][prop];
    else delete s.anim[target];
    cleanTracks(s, target);
  });
}

/** Keys the current value of the given properties (default: the transform channels) at the playhead. */
export function keyNodes(ids: ID[], props?: string[]): void {
  const es = evalNow();
  const frame = ui().frame;
  const keys: { target: ID; prop: string; f: number; v: KeyValue }[] = [];
  for (const id of ids) {
    const n = es.nodes.get(id)?.node;
    if (!n) continue;
    const list = props ?? (n.type === 'bone' ? ['rotation', 'x', 'y'] : ['x', 'y', 'rotation', 'scaleX', 'scaleY']);
    for (const prop of list) {
      const v = currentValue(id, prop);
      if (v !== undefined) keys.push({ target: id, prop, f: frame, v });
    }
  }
  if (keys.length) setKeys(keys, 'Insert keyframe');
}

export function hasKey(target: ID, prop: string, frame = ui().frame): boolean {
  return hasKeyAt(scene().anim[target]?.[prop], frame);
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

function attach(s: Scene, id: ID, parentId: ID | null, index?: number): void {
  const list = parentId && s.nodes[parentId] ? s.nodes[parentId].children : s.roots;
  s.nodes[id].parent = parentId && s.nodes[parentId] ? parentId : null;
  if (index === undefined || index < 0 || index > list.length) list.push(id);
  else list.splice(index, 0, id);
}

function detach(s: Scene, id: ID): void {
  const n = s.nodes[id];
  if (!n) return;
  const list = n.parent && s.nodes[n.parent] ? s.nodes[n.parent].children : s.roots;
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

/** Adds a single node. Returns its id. */
export function addNode(n: SceneNode, parentId: ID | null = null, index?: number, label?: string): ID {
  doc.apply(label ?? `Add ${n.type}`, (d) => {
    const s = S(d);
    const copy = structuredClone(n) as SceneNode;
    copy.name = uniqueName(s, copy.name);
    copy.children = [];
    s.nodes[copy.id] = copy;
    attach(s, copy.id, parentId, index);
  });
  return n.id;
}

/** Adds a prebuilt hierarchy (nodes already linked to each other). */
export function addNodes(nodes: SceneNode[], rootIds: ID[], parentId: ID | null = null, label = 'Add'): ID[] {
  doc.apply(label, (d) => {
    const s = S(d);
    const names = new Map(rootIds.map((r) => [r, uniqueName(s, nodes.find((n) => n.id === r)?.name ?? 'Node')]));
    for (const n of nodes) s.nodes[n.id] = structuredClone(n) as SceneNode;
    for (const r of rootIds) {
      s.nodes[r].name = names.get(r)!;
      attach(s, r, parentId);
    }
  });
  return rootIds;
}

function purge(s: Scene, id: ID): void {
  for (const sub of subtreeIds(s, id)) {
    delete s.nodes[sub];
    delete s.anim[sub];
  }
}

export function deleteNodes(ids: ID[]): void {
  const s0 = scene();
  const tops = topLevel(s0, ids).filter((id) => !s0.nodes[id].locked);
  if (tops.length === 0) return;
  doc.apply('Delete', (d) => {
    const s = S(d);
    for (const id of tops) {
      detach(s, id);
      purge(s, id);
    }
    s.constraints = s.constraints.filter((c) => s.nodes[c.targetId] && c.bones.every((b) => s.nodes[b]));
    s.strips = s.strips.filter((st) => s.nodes[st.targetId]);
    for (const n of Object.values(s.nodes)) {
      if ((n.type === 'shape' || n.type === 'image') && n.skin && n.skin.bones.some((b) => !s.nodes[b])) delete n.skin;
    }
  });
  const left = scene();
  useUI.setState({ selection: ui().selection.filter((id) => left.nodes[id]), selectedKeys: [] });
}

export function duplicateNodes(ids: ID[], offset = 30): ID[] {
  const p = project();
  const s0 = scene();
  const tops = topLevel(s0, ids);
  if (tops.length === 0) return [];
  let roots: ID[] = [];
  doc.apply('Duplicate', (d) => {
    const s = S(d);
    for (const id of tops) {
      const bundle = extractSubtree(p, s0, [id]);
      const parent = s0.nodes[id].parent;
      const [root] = insertBundle(d, s, bundle, parent);
      // insertBundle appends; move the copy right above its source.
      const list = parent ? s.nodes[parent].children : s.roots;
      list.splice(list.indexOf(root), 1);
      list.splice(list.indexOf(id) + 1, 0, root);
      s.nodes[root].name = uniqueName(s, s.nodes[root].name);
      if (s.nodes[root].type !== 'bone') {
        s.nodes[root].x += offset;
        s.nodes[root].y += offset;
      }
      roots = [...roots, root];
    }
  });
  useUI.setState({ selection: roots });
  return roots;
}

/**
 * Moves nodes to a new parent (null = scene root) at an index. With `keepWorld`, each node's
 * transform is rewritten so it stays where it is on screen.
 */
export function moveNodes(ids: ID[], newParent: ID | null, index?: number, keepWorld = true): void {
  const s0 = scene();
  const p0 = project();
  const es = evalNow();
  const tops = topLevel(s0, ids).filter((id) => id !== newParent && !(newParent && subtreeIds(s0, id).includes(newParent)));
  if (tops.length === 0) return;
  doc.apply('Reparent', (d) => {
    const s = S(d);
    let at = index;
    for (const id of tops) {
      const n = s.nodes[id];
      const oldParent = n.parent;
      const oldList = oldParent ? s.nodes[oldParent].children : s.roots;
      const oldIndex = oldList.indexOf(id);
      detach(s, id);
      if (at !== undefined && oldParent === newParent && oldIndex < at) at--;
      attach(s, id, newParent, at);
      if (at !== undefined) at++;
      if (keepWorld && oldParent !== newParent) {
        const world = es.nodes.get(id)?.world ?? IDENTITY;
        const pw = newParent ? es.nodes.get(newParent)?.world ?? IDENTITY : IDENTITY;
        const local = decompose(mul(invert(pw), world));
        const en = es.nodes.get(id);
        const depthDelta = (en?.worldDepth ?? 0) - (newParent ? es.nodes.get(newParent)?.worldDepth ?? 0 : 0);
        if (n.type === 'bone') {
          n.x = local.x;
          n.y = local.y;
          n.rotation = local.rotation;
        } else {
          Object.assign(n, { x: local.x, y: local.y, rotation: local.rotation, scaleX: local.scaleX, scaleY: local.scaleY });
        }
        n.depth = depthDelta;
        // A layer whose position is animated must keep its whole path, not just today's frame:
        // every keyed frame is re-expressed in the new parent's space as that parent is then.
        const tracks = n.type === 'bone' ? undefined : s.anim[id];
        const moved = ['x', 'y', 'rotation', 'scaleX', 'scaleY'].filter((prop) => tracks?.[prop]?.keys.length);
        if (tracks && moved.length) {
          const frames = [...new Set(moved.flatMap((prop) => tracks[prop].keys.map((k) => k.f)))].sort((a, b) => a - b);
          const at = frames.map((f) => {
            const then = evaluateScene(p0, s0, f);
            const w = then.nodes.get(id)?.world ?? IDENTITY;
            const parentThen = newParent ? then.nodes.get(newParent)?.world ?? IDENTITY : IDENTITY;
            return decompose(mul(invert(parentThen), w));
          });
          for (const prop of ['x', 'y', 'rotation', 'scaleX', 'scaleY'] as const) {
            const old = tracks[prop]?.keys ?? [];
            // Rotation is unwrapped so a turn never takes the long way round between two keys.
            let last = 0;
            tracks[prop] = {
              keys: frames.map((f, i) => {
                let v = at[i][prop];
                if (prop === 'rotation') {
                  if (i > 0) v += Math.round((last - v) / 360) * 360;
                  last = v;
                }
                return { f, v, e: old.find((k) => k.f === f)?.e ?? old[0]?.e ?? 'easeInOut' };
              }),
            };
          }
        }
      }
    }
  });
}

/** Moves a node one step in paint order among its siblings. */
export function reorder(id: ID, dir: 'up' | 'down' | 'top' | 'bottom'): void {
  doc.apply('Reorder', (d) => {
    const s = S(d);
    const n = s.nodes[id];
    if (!n) return;
    const list = n.parent ? s.nodes[n.parent].children : s.roots;
    const i = list.indexOf(id);
    const j = dir === 'up' ? i + 1 : dir === 'down' ? i - 1 : dir === 'top' ? list.length - 1 : 0;
    if (j < 0 || j >= list.length || j === i) return;
    list.splice(i, 1);
    list.splice(j, 0, id);
  });
}

export function groupNodes(ids: ID[], name = 'Group'): ID | null {
  const s0 = scene();
  const tops = topLevel(s0, ids);
  if (tops.length === 0) return null;
  const first = s0.nodes[tops[0]];
  const parent = first.parent;
  const list = parent ? s0.nodes[parent].children : s0.roots;
  const index = Math.max(...tops.map((id) => list.indexOf(id)).filter((i) => i >= 0), 0);
  const g = createGroup(name);
  doc.transact('Group', () => {
    addNode(g, parent, index + 1);
    moveNodes(tops, g.id, undefined, true);
  });
  useUI.setState({ selection: [g.id] });
  return g.id;
}

export function ungroup(id: ID): void {
  const n = node(id);
  if (!n || n.children.length === 0) return;
  const kids = [...n.children];
  const parent = n.parent;
  const list = parent ? scene().nodes[parent].children : scene().roots;
  const index = list.indexOf(id);
  doc.transact('Ungroup', () => {
    moveNodes(kids, parent, index, true);
    deleteNodes([id]);
  });
  useUI.setState({ selection: kids });
}

/** Converts a world-space point into the local space of a node's parent. */
export function worldToParent(id: ID, world: Vec): Vec {
  const es = evalNow();
  const parent = es.nodes.get(id)?.node.parent;
  const pw: Mat = parent ? es.nodes.get(parent)?.world ?? IDENTITY : IDENTITY;
  return apply(invert(pw), world.x, world.y);
}

// ---------------------------------------------------------------------------------------------
// Drawing layers
// ---------------------------------------------------------------------------------------------

export function addStroke(id: ID, stroke: Stroke, frame = ui().frame, newExposure = true): void {
  doc.apply('Draw stroke', (d) => {
    const n = S(d).nodes[id];
    if (!n || n.type !== 'drawing') return;
    const f = Math.round(frame);
    const exp = exposureAt(n.frames, f);
    const key = String(newExposure || exp === null ? f : exp);
    // A new exposure starts from a copy of nothing: frame-by-frame drawings are independent.
    (n.frames[key] ??= []).push(stroke);
  });
}

export function setDrawingFrame(id: ID, frame: number, strokes: Stroke[] | null, label = 'Edit drawing'): void {
  doc.apply(label, (d) => {
    const n = S(d).nodes[id];
    if (!n || n.type !== 'drawing') return;
    const key = String(Math.round(frame));
    if (strokes === null) delete n.frames[key];
    else n.frames[key] = strokes;
  });
}

// ---------------------------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------------------------

export function patchScene(patch: Partial<Scene>, label = 'Edit scene', mergeKey?: string): void {
  doc.apply(label, (d) => void Object.assign(S(d), patch), { mergeKey });
}

export function addScene(name?: string): ID {
  const p = project();
  const sc = createScene(name ?? `Scene ${p.scenes.length + 1}`, p.width, p.height, p.fps);
  doc.apply('Add scene', (d) => void d.scenes.push(sc));
  useUI.setState({ sceneId: sc.id, selection: [], selectedKeys: [], frame: 0 });
  return sc.id;
}

export function duplicateScene(id: ID): ID | null {
  const p = project();
  const src = p.scenes.find((s) => s.id === id);
  if (!src) return null;
  const bundle: RigFile = extractSubtree(p, src, src.roots, src.name);
  const sc = createScene(`${src.name} copy`, p.width, p.height, p.fps);
  doc.apply('Duplicate scene', (d) => {
    const copy: Scene = { ...sc, duration: src.duration, background: src.background, camera: { ...src.camera }, transition: { ...src.transition } };
    if (src.anim[CAMERA_ID]) copy.anim[CAMERA_ID] = structuredClone(src.anim[CAMERA_ID]) as Record<string, Track>;
    copy.audio = src.audio.map((a) => ({ ...a, id: newId('au') }));
    copy.markers = src.markers.map((m) => ({ ...m, id: newId('mk') }));
    insertBundle(d, copy, bundle, null);
    d.scenes.splice(d.scenes.findIndex((s) => s.id === id) + 1, 0, copy);
  });
  useUI.setState({ sceneId: sc.id, selection: [], selectedKeys: [], frame: 0 });
  return sc.id;
}

export function deleteScene(id: ID): void {
  const p = project();
  if (p.scenes.length <= 1) return;
  const i = p.scenes.findIndex((s) => s.id === id);
  if (i < 0) return;
  doc.apply('Delete scene', (d) => void d.scenes.splice(i, 1));
  if (ui().sceneId === id) useUI.setState({ sceneId: project().scenes[Math.max(0, i - 1)].id, selection: [], selectedKeys: [], frame: 0 });
}

export function moveScene(id: ID, toIndex: number): void {
  doc.apply('Reorder scenes', (d) => {
    const i = d.scenes.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [sc] = d.scenes.splice(i, 1);
    d.scenes.splice(Math.max(0, Math.min(d.scenes.length, toIndex)), 0, sc);
  });
}

export function patchSceneById(id: ID, patch: Partial<Scene>, label = 'Edit scene'): void {
  doc.apply(label, (d) => {
    const sc = d.scenes.find((s) => s.id === id);
    if (sc) Object.assign(sc, patch);
  });
}

export function patchProject(patch: Partial<Project>, label = 'Edit project'): void {
  doc.apply(label, (d) => void Object.assign(d, patch));
}

// ---------------------------------------------------------------------------------------------
// Assets, actions, strips, constraints, audio, markers
// ---------------------------------------------------------------------------------------------

export function addAsset(asset: Asset): ID {
  doc.apply('Import asset', (d) => void (d.assets[asset.id] = asset));
  return asset.id;
}

export function removeAsset(id: ID): void {
  doc.apply('Remove asset', (d) => {
    delete d.assets[id];
    for (const s of d.scenes) s.audio = s.audio.filter((a) => a.assetId !== id);
  });
}

/** Marks an image as the fixed background of a camera angle, or clears the mark with null. */
export function setAssetPlate(id: ID, plate: PlateInfo | null): void {
  doc.apply(plate ? 'Mark background plate' : 'Unmark background plate', (d) => {
    const a = d.assets[id];
    if (!a) return;
    if (plate) a.plate = { angle: plate.angle.trim() || a.name };
    else delete a.plate;
  });
}

/**
 * Puts a background plate, unchanged, behind everything in each listed scene that does not have it
 * yet. The layer is locked so drawing characters and foreground on top cannot move it. Returns how
 * many scenes received it.
 */
export function placePlate(assetId: ID, sceneIds: ID[]): number {
  let placed = 0;
  doc.apply('Place background plate', (d) => {
    const a = d.assets[assetId];
    if (!a || a.kind !== 'image') return;
    const w = a.width || d.width;
    const h = a.height || d.height;
    for (const s of d.scenes) {
      if (!sceneIds.includes(s.id)) continue;
      if (Object.values(s.nodes).some((n) => n.type === 'image' && n.assetId === assetId && n.tag === PLATE_TAG)) continue;
      const box = plateLayout(d, { width: w, height: h }, s.camera, PLATE_DEPTH);
      const name = uniqueName(s, `${a.plate?.angle ?? a.name.replace(/\.[a-z0-9]+$/i, '')} (plate)`);
      const n = createImage(name, assetId, Math.round(box.width), Math.round(box.height), { x: box.x, y: box.y, depth: box.depth, locked: true, tag: PLATE_TAG });
      s.nodes[n.id] = n;
      s.roots.unshift(n.id);
      placed++;
    }
  });
  return placed;
}

/** Adds or replaces a style preset saved with the project. */
export function saveStylePreset(preset: StylePreset): void {
  doc.apply('Save style preset', (d) => {
    const list = (d.styles ??= []);
    const copy = { id: preset.id, name: preset.name.trim() || 'Style', positive: preset.positive, negative: preset.negative };
    const i = list.findIndex((x) => x.id === copy.id);
    if (i >= 0) list[i] = copy;
    else list.push(copy);
  });
}

export function removeStylePreset(id: ID): void {
  doc.apply('Delete style preset', (d) => {
    d.styles = (d.styles ?? []).filter((x) => x.id !== id);
  });
}

export function addAction(clip: ActionClip): ID {
  doc.apply('Save action', (d) => void (d.actions[clip.id] = clip));
  return clip.id;
}

export function removeAction(id: ID): void {
  doc.apply('Delete action', (d) => {
    delete d.actions[id];
    for (const s of d.scenes) s.strips = s.strips.filter((st) => st.actionId !== id);
  });
}

export function addStrip(strip: Omit<ActionStrip, 'id'>): ID {
  const id = newId('st');
  doc.apply('Add action strip', (d) => void S(d).strips.push({ ...strip, id }));
  return id;
}

export function patchStrip(id: ID, patch: Partial<ActionStrip>, mergeKey?: string): void {
  doc.apply(
    'Edit action strip',
    (d) => {
      const st = S(d).strips.find((x) => x.id === id);
      if (st) Object.assign(st, patch);
    },
    { mergeKey },
  );
}

export function removeStrip(id: ID): void {
  doc.apply('Remove action strip', (d) => {
    const s = S(d);
    s.strips = s.strips.filter((x) => x.id !== id);
  });
}

export function addConstraint(c: Omit<IKConstraint, 'id'>): ID {
  const id = newId('ik');
  doc.apply('Add IK constraint', (d) => void S(d).constraints.push({ ...c, id }));
  return id;
}

export function patchConstraint(id: ID, patch: Partial<IKConstraint>): void {
  doc.apply('Edit IK constraint', (d) => {
    const c = S(d).constraints.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
  });
}

export function removeConstraint(id: ID): void {
  doc.apply('Remove IK constraint', (d) => {
    const s = S(d);
    s.constraints = s.constraints.filter((x) => x.id !== id);
  });
}

export function addAudioClip(clip: Omit<AudioClip, 'id'>): ID {
  const id = newId('au');
  doc.apply('Add audio', (d) => void S(d).audio.push({ ...clip, id }));
  return id;
}

export function patchAudioClip(id: ID, patch: Partial<AudioClip>, mergeKey?: string): void {
  doc.apply(
    'Edit audio',
    (d) => {
      const a = S(d).audio.find((x) => x.id === id);
      if (a) Object.assign(a, patch);
    },
    { mergeKey },
  );
}

export function removeAudioClip(id: ID): void {
  doc.apply('Remove audio', (d) => {
    const s = S(d);
    s.audio = s.audio.filter((x) => x.id !== id);
  });
}

export function addMarker(frame: number, name: string): ID {
  const id = newId('mk');
  doc.apply('Add marker', (d) => void S(d).markers.push({ id, frame, name }));
  return id;
}

export function removeMarker(id: ID): void {
  doc.apply('Remove marker', (d) => {
    const s = S(d);
    s.markers = s.markers.filter((m) => m.id !== id);
  });
}

// ---------------------------------------------------------------------------------------------
// Playhead helpers
// ---------------------------------------------------------------------------------------------

export function setFrame(frame: number): void {
  const max = Math.max(0, scene().duration - 1);
  useUI.setState({ frame: Math.max(0, Math.min(max, frame)) });
}

/** All keyed frames on the given targets, sorted and unique. */
export function keyedFrames(targets: ID[]): number[] {
  const s = scene();
  const out = new Set<number>();
  for (const t of targets) {
    const tracks = s.anim[t];
    if (!tracks) continue;
    for (const prop in tracks) for (const k of tracks[prop].keys) out.add(k.f);
  }
  return [...out].sort((a, b) => a - b);
}

export function jumpKey(dir: 1 | -1): void {
  const u = ui();
  const targets = u.selection.length ? u.selection : [...Object.keys(scene().anim)];
  const frames = keyedFrames(targets);
  const f = dir > 0 ? frames.find((x) => x > u.frame + 1e-6) : [...frames].reverse().find((x) => x < u.frame - 1e-6);
  if (f !== undefined) setFrame(f);
}
