import { getStroke } from 'perfect-freehand';
import { animated, type EvalNode, type EvalScene } from '../core/anim';
import { exposureAt } from '../core/drawing';
import { withAlpha } from '../core/color';
import { apply, matScale, mul, scaling } from '../core/math';
import { simulateParticles } from '../core/particles';
import { tracePath } from '../core/path';
import { deformPath, deformVerts, skinMatrices } from '../core/skin';
import type {
  Camera, DrawingNode, Effect, ID, ImageNode, Mat, Paint, ParticlesNode, PathData, Project, ShapeNode, Stroke,
  TextNode,
} from '../core/types';
import { getImage } from './images';
import { dofBlur, viewMatrix } from './view';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface RenderOptions {
  /** Maps stage pixels to target canvas pixels (editor pan/zoom, device pixel ratio, export scale). */
  outer: Mat;
  camera: Camera;
  /** Paint the scene background colour over the stage rectangle. */
  background: boolean;
  /** Clip everything to the stage rectangle (camera view and export). */
  clip: boolean;
  alpha?: number;
  /** When set, only these nodes (and their descendants) are drawn. */
  only?: Set<ID>;
}

// ---------------------------------------------------------------------------------------------
// Draw list
// ---------------------------------------------------------------------------------------------

export interface DrawItem {
  en: EvalNode;
  /** Own opacity times the opacity of pass-through group ancestors. */
  alpha: number;
  index: number;
  /** Present for sorting contexts (characters and isolated groups). */
  children?: DrawItem[];
}

function activeEffects(en: EvalNode): Effect[] {
  const fx = en.node.effects;
  return fx.length ? fx.filter((e) => e.enabled) : fx;
}

function isContext(en: EvalNode): boolean {
  const n = en.node;
  return n.type === 'character' || en.opacity < 0.999 || n.blend !== 'normal' || activeEffects(en).length > 0;
}

function sortItems(items: DrawItem[]): void {
  items.sort((a, b) => b.en.worldDepth - a.en.worldDepth || a.en.zOrder - b.en.zOrder || a.index - b.index);
}

const itemCache = new WeakMap<EvalScene, DrawItem[]>();

/** Visible drawables in paint order (far to near, then zOrder, then tree order). */
export function buildItems(es: EvalScene): DrawItem[] {
  const hit = itemCache.get(es);
  if (hit) return hit;
  let counter = 0;
  const gather = (ids: ID[], out: DrawItem[], alpha: number) => {
    for (const id of ids) {
      const en = es.nodes.get(id);
      if (!en || !en.visible) continue;
      const n = en.node;
      const container = n.type === 'group' || n.type === 'bone' || n.type === 'character' || n.type === 'switch';
      if (!container) {
        out.push({ en, alpha: alpha * en.opacity, index: counter++ });
      } else if (n.type !== 'bone' && isContext(en)) {
        const kids: DrawItem[] = [];
        const index = counter++;
        gather(n.children, kids, 1);
        sortItems(kids);
        out.push({ en, alpha: alpha * en.opacity, index, children: kids });
      } else {
        gather(n.children, out, alpha * (n.type === 'bone' ? 1 : en.opacity));
      }
    }
  };
  const items: DrawItem[] = [];
  gather(es.scene.roots, items, 1);
  sortItems(items);
  itemCache.set(es, items);
  return items;
}

/** Leaves in paint order, for hit testing. */
export function flattenItems(items: DrawItem[], out: DrawItem[] = []): DrawItem[] {
  for (const it of items) {
    if (it.children) flattenItems(it.children, out);
    else out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Geometry caches
// ---------------------------------------------------------------------------------------------

const path2dCache = new WeakMap<PathData, Path2D>();

export function toPath2D(path: PathData): Path2D {
  let p = path2dCache.get(path);
  if (!p) {
    p = new Path2D();
    tracePath(p, path);
    path2dCache.set(path, p);
  }
  return p;
}

const deformCache = new WeakMap<EvalScene, Map<ID, PathData>>();

/** World-space outline of a skinned shape at the evaluated pose. */
export function skinnedPath(es: EvalScene, en: EvalNode): PathData | null {
  const n = en.node as ShapeNode;
  if (!n.skin) return null;
  let per = deformCache.get(es);
  if (!per) deformCache.set(es, (per = new Map()));
  let out = per.get(n.id);
  if (!out) {
    const mats = skinMatrices(n.skin, n.skin.bones.map((b) => es.nodes.get(b)?.world), en.world);
    out = deformPath(n.path, n.skin, mats, en.world);
    per.set(n.id, out);
  }
  return out;
}

/** World-space vertices of an image mesh at the evaluated pose. */
export function meshWorldVerts(es: EvalScene, en: EvalNode): number[] | null {
  const n = en.node as ImageNode;
  if (!n.mesh) return null;
  const offsets = animated<number[] | undefined>(en, 'meshOffsets');
  let rest = n.mesh.verts;
  if (offsets && offsets.length === rest.length) rest = rest.map((v, i) => v + offsets[i]);
  if (n.skin) {
    const mats = skinMatrices(n.skin, n.skin.bones.map((b) => es.nodes.get(b)?.world), en.world);
    return deformVerts(rest, n.skin, mats, en.world);
  }
  const out = new Array<number>(rest.length);
  for (let i = 0; i < rest.length; i += 2) {
    const p = apply(en.world, rest[i], rest[i + 1]);
    out[i] = p.x;
    out[i + 1] = p.y;
  }
  return out;
}

const strokeCache = new WeakMap<Stroke, Path2D>();

export function strokePath2D(s: Stroke): Path2D {
  let p = strokeCache.get(s);
  if (p) return p;
  p = new Path2D();
  if (s.fill) {
    s.pts.forEach((q, i) => (i === 0 ? p!.moveTo(q.x, q.y) : p!.lineTo(q.x, q.y)));
    p.closePath();
  } else {
    const outline = getStroke(
      s.pts.map((q) => [q.x, q.y, q.p]),
      { size: s.size, thinning: s.thinning, smoothing: 0.6, streamline: 0.35, simulatePressure: false, last: true },
    );
    if (outline.length > 1) {
      p.moveTo(outline[0][0], outline[0][1]);
      for (let i = 1; i < outline.length; i++) {
        const a = outline[i];
        const b = outline[(i + 1) % outline.length];
        p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      p.closePath();
    }
  }
  strokeCache.set(s, p);
  return p;
}

// ---------------------------------------------------------------------------------------------
// Offscreen buffers
// ---------------------------------------------------------------------------------------------

interface Buffer {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: Ctx2D;
}

const pool: Buffer[] = [];

export function acquireBuffer(w: number, h: number): Buffer {
  const b = pool.pop();
  if (b) {
    if (b.canvas.width !== w || b.canvas.height !== h) {
      b.canvas.width = w;
      b.canvas.height = h;
    } else {
      b.ctx.setTransform(1, 0, 0, 1, 0, 0);
      b.ctx.globalAlpha = 1;
      b.ctx.globalCompositeOperation = 'source-over';
      b.ctx.filter = 'none';
      b.ctx.clearRect(0, 0, w, h);
    }
    return b;
  }
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return { canvas, ctx: canvas.getContext('2d') as Ctx2D };
}

export function releaseBuffer(b: Buffer): void {
  if (pool.length < 6) pool.push(b);
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

interface Env {
  project: Project;
  es: EvalScene;
  opts: RenderOptions;
  pixelScale: number;
  alpha: number;
  topLevel: boolean;
}

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', lighter: 'lighter',
  darken: 'darken', lighten: 'lighten',
};

function filterString(fx: Effect[], blur: number, scale: number): string {
  const parts: string[] = [];
  for (const e of fx) {
    if (e.type === 'blur' && e.radius > 0) parts.push(`blur(${(e.radius * scale).toFixed(2)}px)`);
    else if (e.type === 'color') {
      parts.push(`brightness(${e.brightness}) contrast(${e.contrast}) saturate(${e.saturation}) hue-rotate(${e.hue}deg)`);
    } else if (e.type === 'shadow') {
      parts.push(`drop-shadow(${(e.dx * scale).toFixed(2)}px ${(e.dy * scale).toFixed(2)}px ${(e.radius * scale).toFixed(2)}px ${e.color})`);
    } else if (e.type === 'glow') {
      const n = Math.max(1, Math.min(4, Math.round(e.strength)));
      for (let i = 0; i < n; i++) parts.push(`drop-shadow(0 0 ${(e.radius * scale).toFixed(2)}px ${e.color})`);
    }
  }
  if (blur > 0) parts.push(`blur(${blur.toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

function paintStyle(ctx: Ctx2D, paint: Paint): string | CanvasGradient {
  if (typeof paint === 'string') return paint;
  const g = paint.type === 'linear'
    ? ctx.createLinearGradient(paint.x1, paint.y1, paint.x2, paint.y2)
    : ctx.createRadialGradient(paint.x1, paint.y1, 0, paint.x1, paint.y1, Math.hypot(paint.x2 - paint.x1, paint.y2 - paint.y1) || 1);
  for (const s of paint.stops) g.addColorStop(Math.max(0, Math.min(1, s.offset)), s.color);
  return g;
}

function allowed(env: Env, en: EvalNode): boolean {
  const only = env.opts.only;
  if (!only) return true;
  let cur: ID | null = en.node.id;
  while (cur) {
    if (only.has(cur)) return true;
    cur = env.es.scene.nodes[cur]?.parent ?? null;
  }
  return false;
}

function drawItems(ctx: Ctx2D, items: DrawItem[], env: Env): void {
  for (const it of items) drawItem(ctx, it, env);
}

function drawItem(ctx: Ctx2D, it: DrawItem, env: Env): void {
  const en = it.en;
  if (!it.children && !allowed(env, en)) return;
  const fx = activeEffects(en);
  const blur = env.topLevel ? dofBlur(env.opts.camera, en.worldDepth) * env.pixelScale : 0;
  const blend = BLEND[en.node.blend] ?? 'source-over';
  const isolated = fx.length > 0 || blur > 0.3 || (!!it.children && (it.alpha < 0.999 || blend !== 'source-over'));
  if (!isolated) {
    if (it.children) drawItems(ctx, it.children, { ...env, alpha: env.alpha * it.alpha, topLevel: false });
    else drawLeaf(ctx, it, env, env.alpha * it.alpha, blend);
    return;
  }
  const buf = acquireBuffer(ctx.canvas.width, ctx.canvas.height);
  const inner: Env = { ...env, alpha: 1, topLevel: false };
  if (it.children) drawItems(buf.ctx, it.children, inner);
  else drawLeaf(buf.ctx, it, inner, 1, 'source-over');
  for (const e of fx) {
    if (e.type === 'tint' && e.amount > 0) {
      buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
      buf.ctx.globalCompositeOperation = 'source-atop';
      buf.ctx.globalAlpha = 1;
      buf.ctx.fillStyle = withAlpha(e.color, Math.min(1, e.amount));
      buf.ctx.fillRect(0, 0, buf.canvas.width, buf.canvas.height);
      buf.ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = env.alpha * it.alpha;
  ctx.globalCompositeOperation = blend;
  ctx.filter = filterString(fx, blur, env.pixelScale);
  ctx.drawImage(buf.canvas, 0, 0);
  ctx.restore();
  releaseBuffer(buf);
}

function setMat(ctx: Ctx2D, m: Mat): void {
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

function drawLeaf(ctx: Ctx2D, it: DrawItem, env: Env, alpha: number, blend: GlobalCompositeOperation): void {
  if (alpha <= 0.001) return;
  const en = it.en;
  const n = en.node;
  const p = env.project;
  const view = viewMatrix(env.opts.camera, p.width, p.height, en.worldDepth);
  if (!view) return;
  const base = mul(env.opts.outer, view);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = blend;
  switch (n.type) {
    case 'shape': {
      const skinned = skinnedPath(env.es, en);
      let path: Path2D;
      if (skinned) {
        setMat(ctx, base);
        path = new Path2D();
        tracePath(path, skinned);
      } else {
        setMat(ctx, mul(base, en.world));
        path = toPath2D(n.path);
      }
      const fill = animated<Paint | null>(en, 'fill');
      if (fill) {
        ctx.fillStyle = paintStyle(ctx, fill);
        ctx.fill(path, n.fillRule);
      }
      const stroke = animated<string | null>(en, 'stroke');
      const sw = animated<number>(en, 'strokeWidth');
      if (stroke && sw > 0) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw;
        ctx.lineCap = n.lineCap;
        ctx.lineJoin = n.lineJoin;
        ctx.stroke(path);
      }
      break;
    }
    case 'image': {
      const img = getImage(p.assets[n.assetId]);
      if (!img) break;
      if (n.mesh) {
        setMat(ctx, base);
        drawMesh(ctx, img, n, meshWorldVerts(env.es, en)!);
      } else {
        setMat(ctx, mul(base, en.world));
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, -n.width / 2, -n.height / 2, n.width, n.height);
      }
      break;
    }
    case 'text': {
      setMat(ctx, mul(base, en.world));
      drawText(ctx, n, en);
      break;
    }
    case 'drawing': {
      setMat(ctx, mul(base, en.world));
      drawDrawing(ctx, n, env.es.frame);
      break;
    }
    case 'particles': {
      setMat(ctx, mul(base, en.world));
      drawParticles(ctx, n, env.es.frame / p.fps, alpha);
      break;
    }
    default:
      break;
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

export function textFont(n: TextNode, size: number): string {
  return `${n.italic ? 'italic ' : ''}${n.weight} ${size}px ${n.font}`;
}

function drawText(ctx: Ctx2D, n: TextNode, en: EvalNode): void {
  const size = animated<number>(en, 'size');
  const text = String(animated(en, 'text'));
  const lines = text.split('\n');
  ctx.font = textFont(n, size);
  ctx.textAlign = n.align;
  ctx.textBaseline = 'middle';
  const lh = size * n.lineHeight;
  const y0 = -((lines.length - 1) * lh) / 2;
  const fill = animated<string | null>(en, 'fill');
  const stroke = animated<string | null>(en, 'stroke');
  const sw = animated<number>(en, 'strokeWidth');
  lines.forEach((line, i) => {
    if (stroke && sw > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = sw;
      ctx.lineJoin = 'round';
      ctx.strokeText(line, 0, y0 + i * lh);
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillText(line, 0, y0 + i * lh);
    }
  });
}

export function drawStrokes(ctx: Ctx2D, strokes: Stroke[]): void {
  for (const s of strokes) {
    ctx.fillStyle = s.color;
    ctx.fill(strokePath2D(s));
  }
}

function drawDrawing(ctx: Ctx2D, n: DrawingNode, frame: number): void {
  const exp = exposureAt(n.frames, Math.floor(frame + 1e-6));
  if (exp === null) return;
  drawStrokes(ctx, n.frames[String(exp)] ?? []);
}

function drawParticles(ctx: Ctx2D, n: ParticlesNode, t: number, alpha: number): void {
  const c = n.config;
  for (const q of simulateParticles(c, t)) {
    if (q.size <= 0 || q.alpha <= 0) continue;
    ctx.globalAlpha = alpha * q.alpha;
    ctx.fillStyle = q.color;
    const r = q.size / 2;
    switch (c.shape) {
      case 'square': {
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.rotate((q.rotation * Math.PI) / 180);
        ctx.fillRect(-r, -r * 0.6, q.size, q.size * 0.6);
        ctx.restore();
        break;
      }
      case 'streak': {
        const v = Math.hypot(q.vx, q.vy) || 1;
        const len = Math.min(60, v * 0.03) + q.size;
        ctx.strokeStyle = q.color;
        ctx.lineWidth = q.size;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x - (q.vx / v) * len, q.y - (q.vy / v) * len);
        ctx.stroke();
        break;
      }
      case 'star':
      case 'flake': {
        const spikes = c.shape === 'star' ? 4 : 6;
        const inner = c.shape === 'star' ? r * 0.28 : r * 0.45;
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.rotate((q.rotation * Math.PI) / 180);
        ctx.beginPath();
        for (let i = 0; i < spikes * 2; i++) {
          const a = (i / (spikes * 2)) * Math.PI * 2;
          const rr = i % 2 === 0 ? r : inner;
          if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
          else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      default: {
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Draws a textured triangle mesh with one affine-mapped, clipped draw per triangle. */
function drawMesh(ctx: Ctx2D, img: CanvasImageSource, n: ImageNode, verts: number[]): void {
  const mesh = n.mesh!;
  const iw = (img as HTMLImageElement).naturalWidth || (img as ImageBitmap).width;
  const ih = (img as HTMLImageElement).naturalHeight || (img as ImageBitmap).height;
  const t = mesh.tris;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i], b = t[i + 1], c = t[i + 2];
    const x0 = verts[a * 2], y0 = verts[a * 2 + 1];
    const x1 = verts[b * 2], y1 = verts[b * 2 + 1];
    const x2 = verts[c * 2], y2 = verts[c * 2 + 1];
    const u0 = mesh.uvs[a * 2] * iw, v0 = mesh.uvs[a * 2 + 1] * ih;
    const u1 = mesh.uvs[b * 2] * iw, v1 = mesh.uvs[b * 2 + 1] * ih;
    const u2 = mesh.uvs[c * 2] * iw, v2 = mesh.uvs[c * 2 + 1] * ih;
    const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (Math.abs(det) < 1e-9) continue;
    const ma = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
    const mb = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
    const mc = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
    const md = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
    const me = x0 - ma * u0 - mc * v0;
    const mf = y0 - mb * u0 - md * v0;
    // Grow the clip triangle slightly from its centroid so neighbouring triangles overlap and
    // antialiasing does not leave hairline seams.
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const grow = (x: number, y: number): [number, number] => {
      const dx = x - cx;
      const dy = y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return [x + (dx / len) * 0.7, y + (dy / len) * 0.7];
    };
    const g0 = grow(x0, y0), g1 = grow(x1, y1), g2 = grow(x2, y2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g0[0], g0[1]);
    ctx.lineTo(g1[0], g1[1]);
    ctx.lineTo(g2[0], g2[1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(ma, mb, mc, md, me, mf);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }
}

/** Renders an evaluated scene. The caller owns clearing the canvas. */
export function renderScene(ctx: Ctx2D, project: Project, es: EvalScene, opts: RenderOptions): void {
  ctx.save();
  if (opts.background || opts.clip) {
    setMat(ctx, opts.outer);
    if (opts.clip) {
      ctx.beginPath();
      ctx.rect(0, 0, project.width, project.height);
      ctx.clip();
    }
    if (opts.background) {
      ctx.globalAlpha = opts.alpha ?? 1;
      ctx.fillStyle = es.scene.background;
      ctx.fillRect(0, 0, project.width, project.height);
    }
  }
  drawItems(ctx, buildItems(es), {
    project, es, opts, pixelScale: matScale(opts.outer), alpha: opts.alpha ?? 1, topLevel: true,
  });
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
}

/** Renders one finished frame of a scene, as the audience sees it, into a width x height canvas. */
export function renderFrame(ctx: Ctx2D, project: Project, es: EvalScene, width: number, height: number, transparent = false): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  renderScene(ctx, project, es, {
    outer: scaling(width / project.width, height / project.height),
    camera: es.camera,
    background: !transparent,
    clip: true,
  });
}
