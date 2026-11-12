import { apply, mul, type Rect } from '../math';
import { flattenPath, parseSvgPath } from '../path';
import { VIEW_NAMES, type Mat, type ViewName } from '../types';
import { boundsOf, frameFor, lidPath, mouthPaths, type ViewFrame } from './build';
import { BONE_DEFS, BONE_NAMES, JOINT_NAMES, VISEMES, completeJoints, type BoneName, type CharacterSpec, type JointName, type PartPath, type Viseme } from './spec';

/**
 * Builds a 3D character from a turnaround (a CharacterSpec).
 *
 * Model space: Y up, the character faces +Z, its own left is +X, the origin is on the ground
 * between the feet, and one unit is one project pixel at the spec's height.
 *
 * Each bone gets one rigid solid. Its shape is the volume that matches the part's outline from the
 * front and from the side (a visual hull, sliced horizontally), and its colour comes from the flat
 * artwork itself, projected on from the front and from the back. Solids hang off joints that mirror
 * the 2D skeleton, so the 2D rig, the action library and lip-sync drive the 3D body unchanged.
 */

/** How far each 2D view is turned from the front, in degrees about the vertical axis. */
export const VIEW_YAW: Record<ViewName, number> = { front: 0, threeQuarter: 45, side: 90, backThreeQuarter: 135, back: 180 };

export type Vec3 = [number, number, number];
export type EyeState = 'open' | 'closed' | 'happy';

/** One layer of flat artwork to paint into a texture; `slot` layers are filled in from the face state. */
export interface TexItem {
  z: number;
  paths?: PartPath[];
  slot?: 'eyes' | 'mouth';
}

/** Flat artwork for one half of a solid. `toUnit` maps view coordinates to the unit square (v down). */
export interface TexLayer {
  items: TexItem[];
  toUnit: Mat;
}

export interface Part3D {
  bone: BoneName;
  /** Triangles (9 numbers each), relative to the bone's joint. */
  positions: Float32Array;
  normals: Float32Array;
  /** The texture is an atlas: its left half is the front artwork, its right half the back. */
  uvs: Float32Array;
  /** Colour under the artwork, where the solid is wider than the drawing. */
  base: string;
  front: TexLayer;
  back: TexLayer;
  /** Suggested pixel size of one half of the atlas. */
  texW: number;
  texH: number;
  /** Head only: eye and mouth artwork per state, in the coordinates of the front layer. */
  face?: { eyes: Record<EyeState, PartPath[]>; mouth: Record<Viseme, PartPath[]> };
}

export interface Character3D {
  height: number;
  /** Rest position of every bone's joint in model space. */
  joints: Record<BoneName, Vec3>;
  /** Unit direction of every bone at rest (root has none). */
  directions: Record<BoneName, Vec3>;
  parts: Part3D[];
}

const RINGS = 22;
const SEGMENTS = 24;
/** Depth relative to width, used when a part was not drawn from the side. */
const DEPTH_RATIO: Partial<Record<string, number>> = { head: 0.95, hair: 0.9, torso: 0.62, chest: 0.62, hips: 0.72, hand: 0.6, fingers: 0.6, thumb: 0.8, foot: 1.6, toes: 1.4 };

type Interval = [number, number] | null;

/**
 * Closed outlines of a part's main filled shapes, in normalised view coordinates. Small shapes
 * (a nose bump, ears, buttons) are left out: they are painted on as artwork, but as geometry each
 * would turn into a ridge running right round the solid.
 */
function outlines(paths: PartPath[], norm: Mat): { x: number; y: number }[][] {
  const shapes: { area: number; lines: { x: number; y: number }[][] }[] = [];
  for (const p of paths) {
    if (!p.fill) continue;
    const lines = flattenPath(parseSvgPath(p.d), 10).filter((l) => l.length >= 3).map((l) => l.map((q) => apply(norm, q.x, q.y)));
    const y = rangeY(lines);
    if (!y) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const l of lines) {
      for (const q of l) {
        x0 = Math.min(x0, q.x);
        x1 = Math.max(x1, q.x);
      }
    }
    shapes.push({ area: (x1 - x0) * (y[1] - y[0]), lines });
  }
  const biggest = Math.max(0, ...shapes.map((s) => s.area));
  return shapes.filter((s) => s.area >= biggest * 0.25).flatMap((s) => s.lines);
}

function rangeY(polys: { x: number; y: number }[][]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const poly of polys) {
    for (const p of poly) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
  }
  return hi > lo ? [lo, hi] : null;
}

/** Leftmost and rightmost point of the outlines on the horizontal line at `y`. */
function span(polys: { x: number; y: number }[][], y: number): Interval {
  let lo = Infinity;
  let hi = -Infinity;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a.y <= y === b.y <= y) continue;
      const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return hi >= lo ? [lo, hi] : null;
}

/** Recovers each joint's 3D position from where it appears in every available view. */
function solveJoints(frames: Partial<Record<ViewName, ViewFrame>>, spec: CharacterSpec): Record<JointName, Vec3> {
  const out = {} as Record<JointName, Vec3>;
  for (const name of JOINT_NAMES) {
    // A view turned by yaw sees the joint at screen x = X cos(yaw) + Z sin(yaw): least squares for X and Z.
    let cc = 0;
    let cs = 0;
    let ss = 0;
    let cx = 0;
    let sx = 0;
    let y = 0;
    let n = 0;
    for (const v of VIEW_NAMES) {
      const f = frames[v];
      if (!f) continue;
      const p = apply(f.norm, ...completeJoints(spec.views[v]!.joints)[name]);
      const yaw = (VIEW_YAW[v] * Math.PI) / 180;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      cc += c * c;
      cs += c * s;
      ss += s * s;
      cx += c * p.x;
      sx += s * p.x;
      y += p.y;
      n++;
    }
    const det = cc * ss - cs * cs;
    let X: number;
    let Z: number;
    if (Math.abs(det) > 1e-6) {
      X = (cx * ss - sx * cs) / det;
      Z = (sx * cc - cx * cs) / det;
    } else {
      // Only one direction was drawn: the other axis is unknown and stays on the centre line.
      X = cc > 1e-6 ? cx / cc : 0;
      Z = ss > 1e-6 ? sx / ss : 0;
    }
    out[name] = [X, -y / n, Z];
  }
  return out;
}

const partsOf = (spec: CharacterSpec, view: ViewName, bone: BoneName) =>
  (spec.views[view]?.parts ?? []).filter((p) => (BONE_NAMES.includes(p.bone) ? p.bone : 'root') === bone).sort((a, b) => a.z - b.z);

const kindOf = (bone: BoneName) => bone.replace(/\.[LR]$/, '').replace(/^(upper|lower)(Arm|Leg)$/, 'limb');

export function buildCharacter3D(spec: CharacterSpec): Character3D {
  const height = spec.height ?? 600;
  const frames: Partial<Record<ViewName, ViewFrame>> = {};
  for (const v of VIEW_NAMES) if (spec.views[v]) frames[v] = frameFor(spec.views[v]!, height);
  if (!Object.keys(frames).length) throw new Error('Character spec has no views');
  // Width comes from a view that looks along the body's depth; depth from the side view.
  const wide: ViewName | undefined = frames.front ? 'front' : frames.back ? 'back' : undefined;
  if (!wide) throw new Error('A 3D character needs a front or back view.');
  const mirror = wide === 'back' ? -1 : 1;

  const j3 = solveJoints(frames, spec);
  const joints = { root: [0, 0, 0] } as Record<BoneName, Vec3>;
  const directions = { root: [0, 1, 0] } as Record<BoneName, Vec3>;
  for (const name of BONE_NAMES) {
    if (name === 'root') continue;
    const def = BONE_DEFS[name];
    const a = j3[def.from];
    const b = j3[def.to];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
    joints[name] = a;
    directions[name] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len];
  }

  const parts: Part3D[] = [];
  /** What later bones need to know about a finished solid: its box and paint order from the front, and its middle depth. */
  const done: Partial<Record<BoneName, { box: [number, number, number, number]; z: number; depth: number }>> = {};
  for (const bone of BONE_NAMES) {
    const wideParts = partsOf(spec, wide, bone);
    const wideNorm = frames[wide]!.norm;
    const wPolys = outlines(wideParts.flatMap((p) => p.paths), wideNorm);
    const wy = rangeY(wPolys);
    if (!wy) continue;
    const sideParts = frames.side ? partsOf(spec, 'side', bone) : [];
    const sPolys = frames.side ? outlines(sideParts.flatMap((p) => p.paths), frames.side.norm) : [];
    const sy = rangeY(sPolys);

    // Rings from top to bottom, packed closer near the ends so the caps come out round.
    const origin = joints[bone];
    const def = bone === 'root' ? null : BONE_DEFS[bone];
    const zFrom = def ? j3[def.from] : origin;
    const zTo = def ? j3[def.to] : origin;
    const ratio = DEPTH_RATIO[kindOf(bone)] ?? 1;
    const rings: { y: number; cx: number; cz: number; a: number; b: number }[] = [];
    let last: [number, number] = [0, 0];
    for (let i = 0; i < RINGS; i++) {
      const t = (1 - Math.cos((Math.PI * (i + 0.5)) / RINGS)) / 2;
      const yn = wy[0] + t * (wy[1] - wy[0]);
      const w = span(wPolys, yn);
      const xs: [number, number] = w ? [w[0] * mirror, w[1] * mirror] : [last[0], last[0]];
      if (w) last = [(xs[0] + xs[1]) / 2, 0];
      const a = Math.abs(xs[1] - xs[0]) / 2;
      const cx = (xs[0] + xs[1]) / 2;
      const Y = -yn;
      const d = sy ? span(sPolys, sy[0] + t * (sy[1] - sy[0])) : null;
      let cz: number;
      let b: number;
      if (d) {
        cz = (d[0] + d[1]) / 2;
        b = (d[1] - d[0]) / 2;
      } else {
        // No side drawing: follow the bone, and make the part as deep as it is wide (or its usual ratio).
        const span3 = zTo[1] - zFrom[1];
        const k = Math.abs(span3) > 1e-6 ? Math.min(1, Math.max(0, (Y - zFrom[1]) / span3)) : 0;
        b = a * ratio;
        cz = zFrom[2] + (zTo[2] - zFrom[2]) * k + (kindOf(bone) === 'foot' || kindOf(bone) === 'toes' ? b * 0.3 : 0);
      }
      rings.push({ y: Y, cx, cz, a: Math.max(a, 0.01), b: Math.max(b, 0.01) });
    }
    // A part painted behind its parent and largely hidden by it (long hair behind a head, a cape
    // behind a chest) must also sit behind it in depth, or it would wrap around the parent's front.
    let bx0 = Infinity;
    let bx1 = -Infinity;
    for (const r of rings) {
      bx0 = Math.min(bx0, r.cx - r.a);
      bx1 = Math.max(bx1, r.cx + r.a);
    }
    const box: [number, number, number, number] = [bx0, -wy[1], bx1, -wy[0]];
    const order = Math.max(...wideParts.map((p) => p.z)) * (wide === 'back' ? -1 : 1);
    const owner = def ? done[def.parent] : undefined;
    if (owner && order < owner.z) {
      const overlap = Math.max(0, Math.min(box[2], owner.box[2]) - Math.max(box[0], owner.box[0])) * Math.max(0, Math.min(box[3], owner.box[3]) - Math.max(box[1], owner.box[1]));
      if (overlap > 0.35 * (box[2] - box[0]) * (box[3] - box[1])) {
        for (const r of rings) {
          const backEdge = r.cz - r.b;
          const frontEdge = Math.min(r.cz + r.b, owner.depth);
          r.b = Math.max(0.01, (frontEdge - backEdge) / 2);
          r.cz = Math.min(owner.depth - r.b, (frontEdge + backEdge) / 2);
        }
      }
    }
    done[bone] = { box, z: order, depth: rings.reduce((sum, r) => sum + r.cz, 0) / rings.length };
    const top = { y: -wy[0], cx: rings[0].cx, cz: rings[0].cz };
    const bottom = { y: -wy[1], cx: rings[RINGS - 1].cx, cz: rings[RINGS - 1].cz };

    // Grid of ring points. Slightly squared-off rings read better than pure ellipses for torsos and heads.
    const P = 2 / 2.4;
    const grid: Vec3[][] = rings.map((r) =>
      Array.from({ length: SEGMENTS }, (_, j) => {
        const phi = (2 * Math.PI * j) / SEGMENTS;
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        return [r.cx + r.a * Math.sign(c) * Math.abs(c) ** P, r.y, r.cz + r.b * Math.sign(s) * Math.abs(s) ** P] as Vec3;
      }),
    );
    const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const cross = (p: Vec3, q: Vec3): Vec3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const unit = (p: Vec3): Vec3 => {
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      return [p[0] / l, p[1] / l, p[2] / l];
    };
    const topPoint: Vec3 = [top.cx, top.y, top.cz];
    const bottomPoint: Vec3 = [bottom.cx, bottom.y, bottom.cz];
    const normals: Vec3[][] = grid.map((ring, i) =>
      ring.map((p, j) => {
        const along = sub(ring[(j + 1) % SEGMENTS], ring[(j + SEGMENTS - 1) % SEGMENTS]);
        const down = sub(i + 1 < RINGS ? grid[i + 1][j] : bottomPoint, i > 0 ? grid[i - 1][j] : topPoint);
        let n = unit(cross(along, down));
        const out = sub(p, [rings[i].cx, p[1], rings[i].cz]);
        if (n[0] * out[0] + n[2] * out[2] < 0) n = [-n[0], -n[1], -n[2]];
        return n;
      }),
    );

    // Texture space: the box around the drawn part, as seen from the front and from behind.
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const poly of wPolys) {
      for (const p of poly) {
        x0 = Math.min(x0, p.x * mirror);
        x1 = Math.max(x1, p.x * mirror);
      }
    }
    const pad = Math.max(x1 - x0, wy[1] - wy[0]) * 0.02;
    x0 -= pad;
    x1 += pad;
    const yTop = wy[0] - pad;
    const yBot = wy[1] + pad;
    // u from model X; v from height. `flip` mirrors a view drawn from the opposite direction.
    const unitMat = (norm: Mat, flip: number, ya: number, yb: number): Mat =>
      mul([flip / (x1 - x0), 0, 0, 1 / (yb - ya), -x0 / (x1 - x0), -ya / (yb - ya)], norm);
    const items = (list: typeof wideParts): TexItem[] => list.map((p) => ({ z: p.z, paths: p.paths }));
    const sameSide: TexLayer = { items: items(wideParts), toUnit: unitMat(wideNorm, mirror, yTop, yBot) };
    const other: ViewName = wide === 'front' ? 'back' : 'front';
    const otherParts = frames[other] ? partsOf(spec, other, bone) : [];
    const oy = frames[other] ? rangeY(outlines(otherParts.flatMap((p) => p.paths), frames[other]!.norm)) : null;
    const oPad = oy ? (oy[1] - oy[0]) * 0.02 : 0;
    const otherSide: TexLayer = oy
      ? { items: items(otherParts), toUnit: unitMat(frames[other]!.norm, -mirror, oy[0] - oPad, oy[1] + oPad) }
      : sameSide;
    const front = wide === 'front' ? sameSide : otherSide;
    const back = wide === 'front' ? otherSide : sameSide;

    let face: Part3D['face'];
    const faceSpec = spec.views.front?.face;
    if (bone === 'head' && faceSpec && frames.front) {
      const line = faceSpec.lineColor ?? '#3a2a2a';
      const lid = Math.max(1.5, 0.012 * (height / frames.front.scale));
      const lids = (state: 'closed' | 'happy') =>
        faceSpec.eyes.map((e) => boundsOf(e.paths)).filter((b): b is Rect => !!b).map((b) => lidPath(state, b, line, lid));
      const m = faceSpec.mouth;
      face = {
        eyes: { open: faceSpec.eyes.flatMap((e) => e.paths), closed: lids('closed'), happy: lids('happy') },
        mouth: Object.fromEntries(VISEMES.map((v) => [v, m ? mouthPaths(v, m.cx, m.cy, m.width, faceSpec) : []])) as Record<Viseme, PartPath[]>,
      };
      const frontItems = [...front.items];
      if (faceSpec.eyes.length) frontItems.push({ z: Math.max(...faceSpec.eyes.map((e) => e.z)), slot: 'eyes' });
      if (m) frontItems.push({ z: m.z, slot: 'mouth' });
      front.items = frontItems.sort((a, b) => a.z - b.z);
    }

    // Triangles. Columns on the +Z side take the front half of the atlas, the rest the back half.
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const emit = (p: Vec3, n: Vec3, isFront: boolean) => {
      pos.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
      nor.push(n[0], n[1], n[2]);
      const u = Math.min(0.985, Math.max(0.015, (p[0] - x0) / (x1 - x0)));
      const v = Math.min(0.985, Math.max(0.015, (-p[1] - yTop) / (yBot - yTop)));
      uv.push(isFront ? u * 0.5 : 0.5 + u * 0.5, 1 - v);
    };
    const UP: Vec3 = [0, 1, 0];
    const DOWN: Vec3 = [0, -1, 0];
    for (let j = 0; j < SEGMENTS; j++) {
      const k = (j + 1) % SEGMENTS;
      const isFront = j < SEGMENTS / 2;
      emit(topPoint, UP, isFront);
      emit(grid[0][k], normals[0][k], isFront);
      emit(grid[0][j], normals[0][j], isFront);
      for (let i = 0; i + 1 < RINGS; i++) {
        emit(grid[i][j], normals[i][j], isFront);
        emit(grid[i][k], normals[i][k], isFront);
        emit(grid[i + 1][j], normals[i + 1][j], isFront);
        emit(grid[i][k], normals[i][k], isFront);
        emit(grid[i + 1][k], normals[i + 1][k], isFront);
        emit(grid[i + 1][j], normals[i + 1][j], isFront);
      }
      emit(bottomPoint, DOWN, isFront);
      emit(grid[RINGS - 1][j], normals[RINGS - 1][j], isFront);
      emit(grid[RINGS - 1][k], normals[RINGS - 1][k], isFront);
    }

    // The colour of the biggest filled shape stands in wherever the artwork does not reach.
    let base = '#888888';
    let baseArea = -1;
    for (const p of wideParts.flatMap((q) => q.paths)) {
      const b = p.fill ? boundsOf([p]) : null;
      if (b && b.w * b.h > baseArea) {
        baseArea = b.w * b.h;
        base = p.fill!;
      }
    }
    const texH = Math.round(Math.min(640, Math.max(48, ((yBot - yTop) / height) * 1500)));
    const texW = Math.round(Math.min(640, Math.max(32, (texH * (x1 - x0)) / (yBot - yTop))));
    parts.push({ bone, positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(uv), base, front, back, texW, texH, face });
  }
  if (!parts.length) throw new Error('The character has no drawn parts to build a 3D body from.');
  return { height, joints, directions, parts };
}

/**
 * Converts one bone's 2D pose into the matching 3D joint transform.
 *
 * A 2D pose turns a bone in the plane of the picture, so in 3D it turns the joint about the axis
 * that points from the model toward the viewer of that view. `yaw` is the view's VIEW_YAW;
 * rotation is in degrees, clockwise on screen; dx/dy are the pose offset in the parent bone's 2D
 * frame, whose rest direction on screen is `parentAngle` degrees.
 */
export function poseTo3D(yaw: number, rotation: number, dx: number, dy: number, parentAngle: number): { quat: [number, number, number, number]; offset: Vec3 } {
  const psi = (yaw * Math.PI) / 180;
  const half = (-rotation * Math.PI) / 360;
  const s = Math.sin(half);
  const pa = (parentAngle * Math.PI) / 180;
  const sx = dx * Math.cos(pa) - dy * Math.sin(pa);
  const sy = dx * Math.sin(pa) + dy * Math.cos(pa);
  return {
    quat: [-Math.sin(psi) * s, 0, Math.cos(psi) * s, Math.cos(half)],
    offset: [Math.cos(psi) * sx, -sy, Math.sin(psi) * sx],
  };
}
