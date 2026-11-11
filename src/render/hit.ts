import { animated, boneTip, type EvalNode, type EvalScene } from '../core/anim';
import { exposureAt } from '../core/drawing';
import { apply, distToSegment, invert, mul, rectCorners, rectFromPoints, type Rect, type Vec } from '../core/math';
import { distToPath, pathBounds, pathContains } from '../core/path';
import type { Camera, ID, Mat, Project, TextNode } from '../core/types';
import { buildItems, flattenItems, meshWorldVerts, skinnedPath, strokePath2D, textFont } from './draw';
import { viewMatrix } from './view';

let scratch: CanvasRenderingContext2D | null = null;

export function scratchCtx(): CanvasRenderingContext2D {
  if (!scratch) scratch = document.createElement('canvas').getContext('2d')!;
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  return scratch;
}

export function textBounds(n: TextNode, en: EvalNode): Rect {
  const ctx = scratchCtx();
  const size = animated<number>(en, 'size');
  const lines = String(animated(en, 'text')).split('\n');
  ctx.font = textFont(n, size);
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  const h = lines.length * size * n.lineHeight;
  const x = n.align === 'left' ? 0 : n.align === 'right' ? -w : -w / 2;
  return { x, y: -h / 2, w, h };
}

/** Bounds of a node's own content in its local space (null for containers and skinned content). */
export function contentBounds(en: EvalNode, frame: number): Rect | null {
  const n = en.node;
  switch (n.type) {
    case 'shape': {
      const b = pathBounds(n.path);
      if (!b) return null;
      const pad = n.stroke ? n.strokeWidth / 2 : 0;
      return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    }
    case 'image':
      return { x: -n.width / 2, y: -n.height / 2, w: n.width, h: n.height };
    case 'text':
      return textBounds(n, en);
    case 'drawing': {
      const exp = exposureAt(n.frames, Math.floor(frame + 1e-6));
      if (exp === null) return null;
      const pts: Vec[] = [];
      for (const s of n.frames[String(exp)] ?? []) {
        const r = s.fill ? 0 : s.size / 2;
        for (const q of s.pts) pts.push({ x: q.x - r, y: q.y - r }, { x: q.x + r, y: q.y + r });
      }
      return pts.length ? rectFromPoints(pts) : null;
    }
    case 'particles': {
      const w = Math.max(60, n.config.width);
      const h = Math.max(60, n.config.height);
      return { x: -w / 2, y: -h / 2, w, h };
    }
    default:
      return null;
  }
}

/** World-space points enclosing a node and (optionally) its descendants. */
export function worldPoints(es: EvalScene, id: ID, deep = true, out: Vec[] = []): Vec[] {
  const en = es.nodes.get(id);
  if (!en) return out;
  const n = en.node;
  if (n.type === 'shape' && n.skin) {
    const b = pathBounds(skinnedPath(es, en)!);
    if (b) out.push(...rectCorners(b));
  } else if (n.type === 'image' && n.mesh) {
    const v = meshWorldVerts(es, en)!;
    for (let i = 0; i < v.length; i += 2) out.push({ x: v[i], y: v[i + 1] });
  } else if (n.type === 'bone') {
    out.push({ x: en.world[4], y: en.world[5] }, boneTip(en));
  } else {
    const b = contentBounds(en, es.frame);
    if (b) for (const c of rectCorners(b)) out.push(apply(en.world, c.x, c.y));
  }
  if (deep) for (const c of n.children) if (es.nodes.get(c)?.visible !== false) worldPoints(es, c, true, out);
  return out;
}

/** Bounds of a node (with descendants) expressed in its own local space, for an oriented box. */
export function localBounds(es: EvalScene, id: ID): Rect | null {
  const en = es.nodes.get(id);
  if (!en) return null;
  const pts = worldPoints(es, id);
  if (pts.length === 0) return null;
  const inv = invert(en.world);
  return rectFromPoints(pts.map((p) => apply(inv, p.x, p.y)));
}

export function worldBounds(es: EvalScene, ids: ID[]): Rect | null {
  const pts: Vec[] = [];
  for (const id of ids) worldPoints(es, id, true, pts);
  return pts.length ? rectFromPoints(pts) : null;
}

/**
 * Topmost visible drawable under a stage-space point. `tolerance` is in stage pixels.
 * Returns the leaf node id; callers decide which ancestor to select.
 */
export function hitTest(project: Project, es: EvalScene, camera: Camera, stage: Vec, tolerance = 4): ID | null {
  const leaves = flattenItems(buildItems(es));
  for (let i = leaves.length - 1; i >= 0; i--) {
    const en = leaves[i].en;
    const n = en.node;
    if (n.locked) continue;
    const view = viewMatrix(camera, project.width, project.height, en.worldDepth);
    if (!view) continue;
    const wp = apply(invert(view), stage.x, stage.y);
    const tol = tolerance / Math.max(1e-6, Math.hypot(view[0], view[1]));
    if (n.type === 'shape') {
      const skinned = skinnedPath(es, en);
      let path = n.path;
      let p = wp;
      let t = tol;
      if (skinned) path = skinned;
      else {
        p = apply(invert(en.world), wp.x, wp.y);
        t = tol / Math.max(1e-6, Math.hypot(en.world[0], en.world[1]));
      }
      const hasFill = !!animated(en, 'fill');
      if (hasFill && pathContains(path, p.x, p.y)) return n.id;
      const sw = n.stroke ? animated<number>(en, 'strokeWidth') : 0;
      if (distToPath(path, p.x, p.y) <= sw / 2 + t) return n.id;
      continue;
    }
    if (n.type === 'image' && n.mesh) {
      const v = meshWorldVerts(es, en)!;
      const tr = n.mesh.tris;
      for (let k = 0; k < tr.length; k += 3) {
        if (inTriangle(wp, v, tr[k], tr[k + 1], tr[k + 2])) return n.id;
      }
      continue;
    }
    const lp = apply(invert(en.world), wp.x, wp.y);
    if (n.type === 'drawing') {
      const exp = exposureAt(n.frames, Math.floor(es.frame + 1e-6));
      if (exp === null) continue;
      const ctx = scratchCtx();
      for (const s of n.frames[String(exp)] ?? []) if (ctx.isPointInPath(strokePath2D(s), lp.x, lp.y)) return n.id;
      continue;
    }
    const b = contentBounds(en, es.frame);
    if (b && lp.x >= b.x - tol && lp.x <= b.x + b.w + tol && lp.y >= b.y - tol && lp.y <= b.y + b.h + tol) return n.id;
  }
  return null;
}

function inTriangle(p: Vec, v: number[], a: number, b: number, c: number): boolean {
  const sign = (x1: number, y1: number, x2: number, y2: number) => (p.x - x2) * (y1 - y2) - (x1 - x2) * (p.y - y2);
  const d1 = sign(v[a * 2], v[a * 2 + 1], v[b * 2], v[b * 2 + 1]);
  const d2 = sign(v[b * 2], v[b * 2 + 1], v[c * 2], v[c * 2 + 1]);
  const d3 = sign(v[c * 2], v[c * 2 + 1], v[a * 2], v[a * 2 + 1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Nearest bone under a stage-space point, preferring bones drawn later (children over parents). */
export function hitBone(project: Project, es: EvalScene, camera: Camera, stage: Vec, tolerance: number): ID | null {
  let best: ID | null = null;
  let bestD = tolerance;
  for (const en of es.nodes.values()) {
    if (en.node.type !== 'bone' || !en.visible || en.node.locked) continue;
    const view = viewMatrix(camera, project.width, project.height, en.worldDepth);
    if (!view) continue;
    const m: Mat = mul(view, en.world);
    const a = apply(m, 0, 0);
    const b = apply(m, en.length, 0);
    const d = distToSegment(stage.x, stage.y, a.x, a.y, b.x, b.y).d;
    if (d <= bestD) {
      bestD = d;
      best = en.node.id;
    }
  }
  return best;
}
