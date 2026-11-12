import { createBone, createCharacter, createGroup, createShape, createSwitch } from '../factory';
import { apply, invert, mul, trs, type Rect, unionRect } from '../math';
import { parseSvgPath, pathBounds, transformPath } from '../path';
import { VIEW_NAMES, type BoneNode, type BoneRest, type ID, type Mat, type SceneNode, type ViewName } from '../types';
import {
  BONE_DEFS, BONE_NAMES, VISEMES, completeJoints, type BoneName, type CharacterSpec, type FaceSpec, type PartPath,
  type ViewSpec, type Viseme,
} from './spec';

export interface BuiltCharacter {
  nodes: SceneNode[];
  rootId: ID;
  bones: Record<BoneName, ID>;
}

export interface ViewFrame {
  /** View image coordinates -> character space (origin at the ground between the feet). */
  norm: Mat;
  scale: number;
  /** World (character-space) rest matrix of every bone in this view. */
  world: Record<BoneName, Mat>;
  rest: Record<BoneName, BoneRest>;
}

export function frameFor(view: ViewSpec, height: number): ViewFrame {
  const j = completeJoints(view.joints);
  const ground = Math.max(j['toe.L'][1], j['toe.R'][1], j['ankle.L'][1], j['ankle.R'][1]);
  const top = j.headTop[1];
  const h = Math.max(1, ground - top);
  const k = height / h;
  const ox = (j['ankle.L'][0] + j['ankle.R'][0]) / 2;
  const norm: Mat = [k, 0, 0, k, -ox * k, -ground * k];
  const world = { root: [1, 0, 0, 1, 0, 0] } as Record<BoneName, Mat>;
  const rest = { root: { x: 0, y: 0, rotation: 0, length: 0 } } as Record<BoneName, BoneRest>;
  const angles = { root: 0 } as Record<BoneName, number>;
  for (const name of BONE_NAMES) {
    if (name === 'root') continue;
    const def = BONE_DEFS[name];
    const a = apply(norm, j[def.from][0], j[def.from][1]);
    const b = apply(norm, j[def.to][0], j[def.to][1]);
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const local = apply(invert(world[def.parent]), a.x, a.y);
    angles[name] = angle;
    world[name] = trs(a.x, a.y, angle, 1, 1);
    rest[name] = { x: local.x, y: local.y, rotation: angle - angles[def.parent], length };
  }
  return { norm, scale: k, world, rest };
}

const BONE_COLORS: Record<string, string> = { L: '#4cc9f0', R: '#f72585', C: '#ffd166' };

function partNodes(name: string, paths: PartPath[], toLocal: Mat, scale: number, view: ViewName, z: number): SceneNode[] {
  const shapes = paths.map((p, i) =>
    createShape(
      paths.length > 1 ? `${name}.${i + 1}` : name,
      transformPath(parseSvgPath(p.d), toLocal),
      { fill: p.fill, stroke: p.stroke ?? null, strokeWidth: (p.strokeWidth ?? 0) * scale },
    ),
  );
  if (shapes.length === 1) {
    shapes[0].view = view;
    shapes[0].zOrder = z;
    return shapes;
  }
  const g = createGroup(name, { view, zOrder: z });
  for (const s of shapes) {
    s.parent = g.id;
    s.zOrder = z;
    g.children.push(s.id);
  }
  return [g, ...shapes];
}

const ell = (cx: number, cy: number, rx: number, ry: number) =>
  `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;

/** Procedural mouth artwork for a viseme, fitted to a mouth centre and width. */
export function mouthPaths(v: Viseme, cx: number, cy: number, w: number, face: FaceSpec): PartPath[] {
  const W = w * (face.mouthScale ?? 1);
  const l = cx - W / 2;
  const r = cx + W / 2;
  const line = face.lineColor ?? '#3a2a2a';
  const inside = '#5c1f2a';
  const tongue = '#e0667a';
  const teeth = '#ffffff';
  const sw = Math.max(1, w * 0.07);
  const lip = { stroke: line, strokeWidth: sw };
  const open = (top: number, bottom: number): string =>
    `M${l} ${cy}Q${cx} ${cy - top * w} ${r} ${cy}Q${cx} ${cy + bottom * w} ${l} ${cy}Z`;
  switch (v) {
    case 'rest':
      return face.mouth?.restPaths?.length
        ? face.mouth.restPaths
        : [{ d: `M${l} ${cy - 0.03 * w}Q${cx} ${cy + 0.2 * w} ${r} ${cy - 0.03 * w}`, fill: null, ...lip }];
    case 'MBP':
      return [{ d: `M${l + W * 0.06} ${cy}L${r - W * 0.06} ${cy}`, fill: null, ...lip }];
    case 'AI':
      return [
        { d: open(0.14, 0.95), fill: inside, ...lip },
        { d: `M${l + W * 0.14} ${cy + 0.01 * w}Q${cx} ${cy - 0.06 * w} ${r - W * 0.14} ${cy + 0.01 * w}L${r - W * 0.2} ${cy + 0.13 * w}L${l + W * 0.2} ${cy + 0.13 * w}Z`, fill: teeth },
        { d: ell(cx, cy + 0.34 * w, W * 0.22, w * 0.11), fill: tongue },
      ];
    case 'E':
      return [
        { d: open(0.1, 0.5), fill: inside, ...lip },
        { d: `M${l + W * 0.1} ${cy + 0.01 * w}Q${cx} ${cy - 0.04 * w} ${r - W * 0.1} ${cy + 0.01 * w}L${r - W * 0.17} ${cy + 0.15 * w}L${l + W * 0.17} ${cy + 0.15 * w}Z`, fill: teeth },
      ];
    case 'O':
      return [{ d: ell(cx, cy + 0.08 * w, W * 0.28, w * 0.36), fill: inside, ...lip }];
    case 'U':
      return [{ d: ell(cx, cy + 0.04 * w, W * 0.17, w * 0.2), fill: inside, ...lip }];
    case 'WQ':
      return [{ d: ell(cx, cy + 0.03 * w, W * 0.21, w * 0.15), fill: inside, ...lip }];
    case 'FV':
      return [
        { d: `M${l + W * 0.12} ${cy - 0.02 * w}L${r - W * 0.12} ${cy - 0.02 * w}L${r - W * 0.18} ${cy + 0.1 * w}L${l + W * 0.18} ${cy + 0.1 * w}Z`, fill: teeth, ...lip },
        { d: `M${l + W * 0.1} ${cy + 0.12 * w}Q${cx} ${cy + 0.22 * w} ${r - W * 0.1} ${cy + 0.12 * w}`, fill: null, ...lip },
      ];
    case 'L':
      return [
        { d: open(0.1, 0.62), fill: inside, ...lip },
        { d: ell(cx, cy + 0.12 * w, W * 0.2, w * 0.13), fill: tongue },
      ];
    default:
      return [
        { d: open(0.06, 0.32), fill: inside, ...lip },
        { d: `M${l + W * 0.14} ${cy + 0.01 * w}L${r - W * 0.14} ${cy + 0.01 * w}L${r - W * 0.2} ${cy + 0.1 * w}L${l + W * 0.2} ${cy + 0.1 * w}Z`, fill: teeth },
      ];
  }
}

/** The line drawn in place of an eye when it is closed, or curved upward in a smile. */
export function lidPath(state: 'closed' | 'happy', b: Rect, line: string, width: number): PartPath {
  const d = state === 'closed'
    ? `M${b.x} ${b.y + b.h * 0.55}Q${b.x + b.w / 2} ${b.y + b.h * 0.95} ${b.x + b.w} ${b.y + b.h * 0.55}`
    : `M${b.x} ${b.y + b.h * 0.7}Q${b.x + b.w / 2} ${b.y + b.h * 0.05} ${b.x + b.w} ${b.y + b.h * 0.7}`;
  return { d, fill: null, stroke: line, strokeWidth: width };
}

export function boundsOf(paths: PartPath[]): Rect | null {
  let b: Rect | null = null;
  for (const p of paths) b = unionRect(b, pathBounds(parseSvgPath(p.d)));
  return b;
}

/** Builds the rigged node hierarchy for a character spec. Nodes are linked but not yet in a scene. */
export function buildCharacter(spec: CharacterSpec, opts: { skeletonOnly?: boolean } = {}): BuiltCharacter {
  const views = VIEW_NAMES.filter((v) => spec.views[v]);
  if (views.length === 0) throw new Error('Character spec has no views');
  const height = spec.height ?? 600;
  const frames = {} as Record<ViewName, ViewFrame>;
  for (const v of views) frames[v] = frameFor(spec.views[v]!, height);

  const nodes: SceneNode[] = [];
  const character = createCharacter(spec.name || 'Character', views);
  nodes.push(character);
  const byId = new Map<ID, SceneNode>([[character.id, character]]);
  const link = (child: SceneNode, parentId: ID) => {
    child.parent = parentId;
    byId.get(parentId)!.children.push(child.id);
    if (!byId.has(child.id)) {
      byId.set(child.id, child);
      nodes.push(child);
    }
  };

  // Skeleton: base rest comes from the first view; every view also stores its own rest.
  const first = frames[views[0]];
  const bones = {} as Record<BoneName, ID>;
  const boneNodes = {} as Record<BoneName, BoneNode>;
  for (const name of BONE_NAMES) {
    const r = first.rest[name];
    const side = name.endsWith('.L') ? 'L' : name.endsWith('.R') ? 'R' : 'C';
    const b = createBone(name, r.length, { x: r.x, y: r.y, rotation: r.rotation, color: BONE_COLORS[side], viewRest: {} });
    for (const v of views) b.viewRest![v] = { ...frames[v].rest[name] };
    bones[name] = b.id;
    boneNodes[name] = b;
    link(b, name === 'root' ? character.id : bones[BONE_DEFS[name].parent]);
  }

  // A 3D character keeps the same skeleton, but its artwork is a 3D model instead of flat parts.
  if (opts.skeletonOnly) return { nodes, rootId: character.id, bones };

  for (const v of views) {
    const vs = spec.views[v]!;
    const f = frames[v];
    const toBone = (bone: BoneName): Mat => mul(invert(f.world[bone]), f.norm);
    for (const part of vs.parts) {
      const bone: BoneName = BONE_NAMES.includes(part.bone) ? part.bone : 'root';
      const made = partNodes(part.name, part.paths, toBone(bone), f.scale, v, part.z);
      link(made[0], bones[bone]);
      for (const m of made.slice(1)) {
        byId.set(m.id, m);
        nodes.push(m);
      }
    }
    const face = vs.face;
    if (!face) continue;
    const headMat = toBone('head');
    const line = face.lineColor ?? '#3a2a2a';
    if (face.eyes.length) {
      const z = Math.max(...face.eyes.map((e) => e.z));
      const sw = createSwitch('eyes', 'open', { source: 'eyes', view: v, zOrder: z, tag: 'eyes' });
      link(sw, bones.head);
      const addState = (state: string, build: (eye: FaceSpec['eyes'][number], b: Rect) => PartPath[]) => {
        const g = createGroup(state, { zOrder: z });
        link(g, sw.id);
        for (const eye of face.eyes) {
          const b = boundsOf(eye.paths);
          if (!b) continue;
          for (const m of partNodes(eye.name, build(eye, b), headMat, f.scale, v, z)) {
            if (m.parent === null) link(m, g.id);
            else {
              byId.set(m.id, m);
              nodes.push(m);
            }
            delete m.view;
          }
        }
      };
      addState('open', (eye) => eye.paths);
      const lid = Math.max(1.5, 0.012 * (height / f.scale));
      addState('closed', (_e, b) => [lidPath('closed', b, line, lid)]);
      addState('happy', (_e, b) => [lidPath('happy', b, line, lid)]);
    }
    if (face.mouth) {
      const m = face.mouth;
      const sw = createSwitch('mouth', 'rest', { source: 'mouth', view: v, zOrder: m.z, tag: 'mouth' });
      link(sw, bones.head);
      for (const vis of VISEMES) {
        const made = partNodes(vis, mouthPaths(vis, m.cx, m.cy, m.width, face), headMat, f.scale, v, m.z);
        // A viseme must be a single named child of the switch.
        if (made.length === 1) {
          delete made[0].view;
          link(made[0], sw.id);
        } else {
          delete made[0].view;
          link(made[0], sw.id);
          for (const x of made.slice(1)) {
            byId.set(x.id, x);
            nodes.push(x);
          }
        }
      }
    }
  }
  return { nodes, rootId: character.id, bones };
}
