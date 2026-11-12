import { isColorString, lerpColor } from './color';
import { applyEase } from './easing';
import { solveOneBone, solveTwoBone } from './ik';
import { apply, IDENTITY, invert, lerp, lerpAngle, mul, trs, type Vec } from './math';
import {
  CAMERA_ID, type ActionClip, type ActionStrip, type BoneNode, type Camera, type ID, type Keyframe,
  type KeyValue, type Mat, type Project, type Scene, type SceneNode, type Track, type ViewName,
} from './types';

// ---------------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------------

export function interpolate(a: KeyValue, b: KeyValue, t: number): KeyValue {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    const out = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) out[i] = lerp(a[i], b[i], t);
    return out;
  }
  if (isColorString(a) && isColorString(b)) return lerpColor(a, b, t);
  return t >= 1 ? b : a;
}

/** Value of a track at a frame. Holds the first/last key outside the keyed range. */
export function sampleTrack(track: Track | undefined, frame: number): KeyValue | undefined {
  if (!track) return undefined;
  const keys = track.keys;
  const n = keys.length;
  if (n === 0) return undefined;
  if (frame <= keys[0].f) return keys[0].v;
  if (frame >= keys[n - 1].f) return keys[n - 1].v;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].f <= frame) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.f - a.f;
  const t = span <= 0 ? 1 : applyEase(a.e, (frame - a.f) / span);
  return interpolate(a.v, b.v, t);
}

/** Inserts or replaces the key at `key.f`, keeping the array sorted. Mutates `keys`. */
export function upsertKey(keys: Keyframe[], key: Keyframe): void {
  for (let i = 0; i < keys.length; i++) {
    if (Math.abs(keys[i].f - key.f) < 1e-6) {
      keys[i] = { ...keys[i], ...key };
      return;
    }
    if (keys[i].f > key.f) {
      // Inherit the easing of the segment being split so the curve keeps its feel.
      const prev = keys[i - 1];
      keys.splice(i, 0, key.e === undefined && prev?.e !== undefined ? { ...key, e: prev.e } : key);
      return;
    }
  }
  keys.push(key);
}

export function removeKeyAt(keys: Keyframe[], frame: number): boolean {
  const i = keys.findIndex((k) => Math.abs(k.f - frame) < 1e-6);
  if (i < 0) return false;
  keys.splice(i, 1);
  return true;
}

export function hasKeyAt(track: Track | undefined, frame: number): boolean {
  return !!track && track.keys.some((k) => Math.abs(k.f - frame) < 1e-6);
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

export interface EvalNode {
  node: SceneNode;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
  depth: number;
  zOrder: number;
  /** Effective visibility: own flag, ancestors, view tag and parent switch. */
  visible: boolean;
  /** Animated values of non-transform properties (fill, active, currentView, ...). */
  props: Record<string, KeyValue>;
  local: Mat;
  world: Mat;
  /** Sum of depth offsets from the scene root down to this node. */
  worldDepth: number;
  /** View of the enclosing character, if any. */
  view: ViewName | null;
  /** Bone length in the current view (bones only). */
  length: number;
}

export interface EvalScene {
  scene: Scene;
  frame: number;
  nodes: Map<ID, EvalNode>;
  camera: Camera;
}

export interface EvalOptions {
  /** Setup mode: bones show their rest pose, actions and IK are ignored. */
  setup?: boolean;
}

const TRANSFORM_PROPS = new Set(['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity', 'depth', 'zOrder', 'visible']);

interface ResolvedStrip {
  strip: ActionStrip;
  clip: ActionClip;
  tracks: Record<string, Track>;
  /** This node's tracks in each view-specific version of the clip (empty when that version leaves the node alone). */
  byView?: Partial<Record<ViewName, Record<string, Track>>>;
}

const nameIndexCache = new WeakMap<Scene['nodes'], Map<ID, Map<string, ID>>>();

/** name -> node id for the target itself and all its descendants (first match in tree order wins). */
export function nameIndex(scene: Scene, targetId: ID): Map<string, ID> {
  let perScene = nameIndexCache.get(scene.nodes);
  if (!perScene) {
    perScene = new Map();
    nameIndexCache.set(scene.nodes, perScene);
  }
  let idx = perScene.get(targetId);
  if (idx) return idx;
  idx = new Map();
  // '@' addresses the target itself, so clips can key the character's own mouth/eyes/view.
  idx.set('@', targetId);
  const walk = (id: ID) => {
    const n = scene.nodes[id];
    if (!n) return;
    if (!idx!.has(n.name)) idx!.set(n.name, id);
    for (const c of n.children) walk(c);
  };
  walk(targetId);
  perScene.set(targetId, idx);
  return idx;
}

function resolveStrips(project: Project, scene: Scene): Map<ID, ResolvedStrip[]> {
  const out = new Map<ID, ResolvedStrip[]>();
  if (scene.strips.length === 0) return out;
  const ordered = [...scene.strips].sort((a, b) => a.track - b.track || a.start - b.start);
  for (const strip of ordered) {
    if (strip.muted) continue;
    const clip = project.actions[strip.actionId];
    if (!clip || !scene.nodes[strip.targetId]) continue;
    const idx = nameIndex(scene, strip.targetId);
    const names = new Set(Object.keys(clip.tracks));
    for (const v in clip.viewTracks) for (const name in clip.viewTracks[v as ViewName]) names.add(name);
    for (const name of names) {
      const id = idx.get(name);
      if (!id) continue;
      let list = out.get(id);
      if (!list) out.set(id, (list = []));
      let byView: ResolvedStrip['byView'];
      if (clip.viewTracks) {
        byView = {};
        for (const v in clip.viewTracks) byView[v as ViewName] = clip.viewTracks[v as ViewName]![name] ?? {};
      }
      list.push({ strip, clip, tracks: clip.tracks[name] ?? {}, byView });
    }
  }
  return out;
}

/** Frame inside the clip and blend weight for a strip at a timeline frame; null when inactive. */
export function stripSample(strip: ActionStrip, clip: ActionClip, frame: number, projectFps: number): { f: number; w: number } | null {
  if (frame < strip.start || frame >= strip.start + strip.duration) return null;
  const rel = frame - strip.start;
  let f = rel * strip.speed * (clip.fps / projectFps);
  if (clip.duration > 0) f = clip.loop ? f % clip.duration : Math.min(f, clip.duration);
  let w = strip.weight;
  if (strip.blendIn > 0) w *= Math.min(1, rel / strip.blendIn);
  if (strip.blendOut > 0) w *= Math.min(1, (strip.duration - rel) / strip.blendOut);
  return { f, w };
}

export function evaluateScene(project: Project, scene: Scene, frame: number, opts: EvalOptions = {}): EvalScene {
  const nodes = new Map<ID, EvalNode>();
  const strips = opts.setup ? new Map<ID, ResolvedStrip[]>() : resolveStrips(project, scene);

  const visit = (
    id: ID, parent: EvalNode | null, view: ViewName | null, parentVisible: boolean, switchActive: string | null,
    charState: Record<string, KeyValue> | null,
  ) => {
    const node = scene.nodes[id];
    if (!node) return;
    const isBone = node.type === 'bone';
    const frozen = isBone && opts.setup;
    const tracks = frozen ? undefined : scene.anim[id];
    const myStrips = frozen ? undefined : strips.get(id);
    const props: Record<string, KeyValue> = {};
    // A clip may have a version per character view; a character picks by its own view, its parts by the view they are in.
    const stripView = node.type === 'character' ? ((sampleTrack(tracks?.currentView, frame) as ViewName | undefined) ?? node.currentView) : view;
    const tracksOf = (rs: ResolvedStrip) => (stripView && rs.byView?.[stripView]) || rs.tracks;

    const value = (prop: string, base: KeyValue): KeyValue => {
      let v = base;
      if (myStrips) {
        for (const rs of myStrips) {
          const tr = tracksOf(rs)[prop];
          if (!tr) continue;
          const s = stripSample(rs.strip, rs.clip, frame, project.fps);
          if (!s) continue;
          const sv = sampleTrack(tr, s.f);
          if (sv === undefined) continue;
          v = s.w >= 1 ? sv : interpolate(v, sv, s.w);
        }
      }
      const tr = tracks?.[prop];
      if (tr) {
        const tv = sampleTrack(tr, frame);
        if (tv !== undefined) v = tv;
      }
      return v;
    };
    const num = (prop: string, base: number): number => {
      const v = value(prop, base);
      return typeof v === 'number' ? v : base;
    };

    let x: number;
    let y: number;
    let rotation: number;
    let scaleX: number;
    let scaleY: number;
    let length = 0;
    if (isBone) {
      const bone = node as BoneNode;
      const rest = (view && bone.viewRest?.[view]) || bone;
      length = rest.length;
      x = rest.x + num('x', bone.pose.x);
      y = rest.y + num('y', bone.pose.y);
      rotation = rest.rotation + num('rotation', bone.pose.rotation);
      scaleX = bone.scaleX * num('scaleX', bone.pose.scaleX);
      scaleY = bone.scaleY * num('scaleY', bone.pose.scaleY);
    } else {
      x = num('x', node.x);
      y = num('y', node.y);
      rotation = num('rotation', node.rotation);
      scaleX = num('scaleX', node.scaleX);
      scaleY = num('scaleY', node.scaleY);
    }

    // Non-transform animated properties.
    const collect = (source: Record<string, Track> | undefined) => {
      if (!source) return;
      for (const prop in source) {
        if (TRANSFORM_PROPS.has(prop) || prop in props) continue;
        const base = (node as unknown as Record<string, KeyValue>)[prop];
        props[prop] = value(prop, base);
      }
    };
    collect(tracks);
    if (myStrips) for (const rs of myStrips) collect(tracksOf(rs));

    const ownVisible = value('visible', node.visible);
    let visible = parentVisible && ownVisible !== false && ownVisible !== 0;
    if (node.view && view && node.view !== view) visible = false;
    if (switchActive !== null && node.name !== switchActive) visible = false;

    const local = trs(x, y, rotation, scaleX, scaleY);
    const en: EvalNode = {
      node, x, y, rotation, scaleX, scaleY,
      opacity: num('opacity', node.opacity),
      depth: num('depth', node.depth),
      zOrder: num('zOrder', node.zOrder),
      visible, props, local,
      world: parent ? mul(parent.world, local) : local,
      worldDepth: 0,
      view, length,
    };
    en.worldDepth = (parent ? parent.worldDepth : 0) + en.depth;
    nodes.set(id, en);

    let childView = view;
    let childState = charState;
    if (node.type === 'character') {
      childView = ((props.currentView as ViewName) ?? node.currentView) as ViewName;
      childState = { mouth: value('mouth', node.mouth), eyes: value('eyes', node.eyes) };
    }
    let childSwitch: string | null = null;
    if (node.type === 'switch') {
      const linked = node.source && charState ? charState[node.source] : undefined;
      childSwitch = String(linked ?? props.active ?? node.active);
    }
    for (const c of node.children) visit(c, en, childView, visible, childSwitch, childState);
  };

  for (const id of scene.roots) visit(id, null, null, true, null, null);

  const es: EvalScene = { scene, frame, nodes, camera: evaluateCamera(scene, frame) };
  if (!opts.setup) applyConstraints(es);
  return es;
}

export function evaluateCamera(scene: Scene, frame: number): Camera {
  const tracks = scene.anim[CAMERA_ID];
  if (!tracks) return scene.camera;
  const cam: Camera = { ...scene.camera };
  for (const prop in tracks) {
    const v = sampleTrack(tracks[prop], frame);
    if (v !== undefined && prop in cam) (cam as unknown as Record<string, KeyValue>)[prop] = v;
  }
  return cam;
}

/** Recomputes local/world matrices for a node and its subtree from the evaluated channels. */
export function recomputeSubtree(es: EvalScene, id: ID): void {
  const en = es.nodes.get(id);
  if (!en) return;
  const parent = en.node.parent ? es.nodes.get(en.node.parent) : undefined;
  en.local = trs(en.x, en.y, en.rotation, en.scaleX, en.scaleY);
  en.world = parent ? mul(parent.world, en.local) : en.local;
  for (const c of en.node.children) recomputeSubtree(es, c);
}

function applyConstraints(es: EvalScene): void {
  for (const c of es.scene.constraints) {
    if (!c.enabled || c.mix <= 0) continue;
    const target = es.nodes.get(c.targetId);
    const a = es.nodes.get(c.bones[0]);
    if (!target || !a) continue;
    const parentWorld = a.node.parent ? es.nodes.get(a.node.parent)?.world ?? IDENTITY : IDENTITY;
    const t = apply(invert(parentWorld), target.world[4], target.world[5]);
    const b = c.bones.length > 1 ? es.nodes.get(c.bones[1]) : undefined;
    if (!b) {
      a.rotation = lerpAngle(a.rotation, solveOneBone(a.x, a.y, t.x, t.y), c.mix);
    } else {
      const sol = solveIkChain(a, b, t, c.bendPositive);
      a.rotation = lerpAngle(a.rotation, sol.a, c.mix);
      b.rotation = lerpAngle(b.rotation, sol.b, c.mix);
    }
    recomputeSubtree(es, a.node.id);
  }
}

/**
 * Local rotations for a two-bone chain (a -> b) so that b's tip reaches `target`, which is given
 * in the space of a's parent.
 */
export function solveIkChain(a: EvalNode, b: EvalNode, target: Vec, bendPositive: boolean): { a: number; b: number } {
  const bx = b.x * a.scaleX;
  const by = b.y * a.scaleY;
  const l1 = Math.hypot(bx, by);
  const off = (Math.atan2(by, bx) * 180) / Math.PI;
  const l2 = b.length * Math.abs(a.scaleX * b.scaleX);
  const sol = solveTwoBone(a.x, a.y, l1, l2, target.x, target.y, bendPositive);
  return { a: sol.a1 - off, b: sol.a2 + off };
}

// ---------------------------------------------------------------------------------------------
// Helpers on evaluated nodes
// ---------------------------------------------------------------------------------------------

/** Current value of a property, animated if it has a track, otherwise the stored value. */
export function animated<T = KeyValue>(en: EvalNode, prop: string): T {
  const v = en.props[prop];
  return (v !== undefined ? v : (en.node as unknown as Record<string, unknown>)[prop]) as T;
}

export function worldOrigin(en: EvalNode): Vec {
  return { x: en.world[4], y: en.world[5] };
}

export function boneTip(en: EvalNode): Vec {
  return apply(en.world, en.length, 0);
}

/** Property names that can be keyed on a node of the given type (besides the common transform set). */
export const COMMON_ANIM_PROPS = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity', 'depth', 'zOrder', 'visible'];

export const EXTRA_ANIM_PROPS: Record<string, string[]> = {
  shape: ['fill', 'stroke', 'strokeWidth'],
  text: ['fill', 'stroke', 'strokeWidth', 'size', 'text'],
  switch: ['active'],
  character: ['currentView', 'mouth', 'eyes'],
  image: [],
  model3d: ['rotX', 'rotY', 'rotZ', 'clipTime'],
  bone: [],
  group: [],
  drawing: [],
  particles: [],
};

export const CAMERA_ANIM_PROPS = ['x', 'y', 'z', 'zoom', 'rotation', 'focal', 'focusDepth', 'aperture'];

// Single-entry memo: the renderer, overlays and hit-testing all ask for the same frame.
let memo: { project: Project; scene: Scene; frame: number; setup: boolean; es: EvalScene } | null = null;

export function getEval(project: Project, scene: Scene, frame: number, setup = false): EvalScene {
  if (memo && memo.project === project && memo.scene === scene && memo.frame === frame && memo.setup === setup) return memo.es;
  const es = evaluateScene(project, scene, frame, { setup });
  memo = { project, scene, frame, setup, es };
  return es;
}
