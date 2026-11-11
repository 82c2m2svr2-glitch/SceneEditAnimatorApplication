import { exposureAt } from '../core/drawing';
import { createDrawing, createShape, createText } from '../core/factory';
import { apply, invert, type Vec } from '../core/math';
import { ellipsePath, linePath, polygonPath, rectPath, starPath } from '../core/path';
import type { PathData, PathPoint, Stroke, StrokePoint } from '../core/types';
import { drawStrokes } from '../render/draw';
import { addNode, addStroke, setDrawingFrame } from '../state/commands';
import { doc } from '../state/store';
import { requestRepaint, ui, type ToolId } from '../state/ui';
import type { Pointer, Tool, ToolEnv } from './env';

// ---------------------------------------------------------------------------------------------
// Rectangle / ellipse / polygon / star / line
// ---------------------------------------------------------------------------------------------

function shapeTool(id: ToolId, label: string, build: (w: number, h: number, a: Vec, b: Vec) => PathData, opts: { line?: boolean } = {}): Tool {
  let start: Vec | null = null;
  let cur: Vec | null = null;
  let mods = { shift: false, alt: false };

  const box = () => {
    if (!start || !cur) return null;
    let x0 = start.x, y0 = start.y, x1 = cur.x, y1 = cur.y;
    if (opts.line) {
      if (mods.shift) {
        const ang = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x1 - x0, y1 - y0);
        x1 = x0 + Math.cos(ang) * len;
        y1 = y0 + Math.sin(ang) * len;
      }
      return { x0, y0, x1, y1 };
    }
    let w = x1 - x0;
    let h = y1 - y0;
    if (mods.shift) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    if (mods.alt) {
      x0 -= w;
      y0 -= h;
      w *= 2;
      h *= 2;
    }
    x1 = x0 + w;
    y1 = y0 + h;
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  };

  return {
    id,
    cursor: 'crosshair',
    down(p, env) {
      start = env.stageToWorld(p.stage, 0);
      cur = start;
      mods = { shift: p.shift, alt: p.alt };
    },
    move(p, env, dragging) {
      if (!dragging || !start) return;
      cur = env.stageToWorld(p.stage, 0);
      mods = { shift: p.shift, alt: p.alt };
      requestRepaint();
    },
    up() {
      const b = box();
      start = null;
      cur = null;
      if (!b) return;
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      if (Math.hypot(w, h) < 3) return;
      const u = ui();
      const cx = (b.x0 + b.x1) / 2;
      const cy = (b.y0 + b.y1) / 2;
      const path = build(Math.abs(w), Math.abs(h), { x: b.x0 - cx, y: b.y0 - cy }, { x: b.x1 - cx, y: b.y1 - cy });
      const node = createShape(label, path, {
        fill: opts.line ? null : u.fill,
        stroke: opts.line ? u.stroke ?? '#ffffff' : u.strokeWidth > 0 ? u.stroke : null,
        strokeWidth: opts.line ? Math.max(2, u.strokeWidth) : u.strokeWidth,
      });
      node.x = cx;
      node.y = cy;
      addNode(node, null, undefined, `Draw ${label.toLowerCase()}`);
      u.select([node.id]);
      u.set({ tool: 'select' });
    },
    cancel() {
      start = null;
      cur = null;
    },
    overlay(g, env) {
      const b = box();
      if (!b) return;
      const a = env.worldToScreen({ x: b.x0, y: b.y0 }, 0);
      const c = env.worldToScreen({ x: b.x1, y: b.y1 }, 0);
      g.strokeStyle = '#4cc9f0';
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      g.beginPath();
      if (opts.line) {
        g.moveTo(a.x, a.y);
        g.lineTo(c.x, c.y);
      } else g.rect(a.x, a.y, c.x - a.x, c.y - a.y);
      g.stroke();
      g.setLineDash([]);
    },
  };
}

export const rectTool = shapeTool('rect', 'Rectangle', (w, h) => rectPath(-w / 2, -h / 2, w, h));
export const ellipseTool = shapeTool('ellipse', 'Ellipse', (w, h) => ellipsePath(0, 0, w / 2, h / 2));
export const polygonTool = shapeTool('polygon', 'Polygon', (w, h) => {
  const p = polygonPath(0, 0, 0.5, ui().polygonSides);
  for (const q of p.contours[0].pts) {
    q.x *= w;
    q.y *= h;
  }
  return p;
});
export const starTool = shapeTool('star', 'Star', (w, h) => {
  const p = starPath(0, 0, 0.5, 0.21, 5);
  for (const q of p.contours[0].pts) {
    q.x *= w;
    q.y *= h;
  }
  return p;
});
export const lineTool = shapeTool('line', 'Line', (_w, _h, a, b) => linePath(a.x, a.y, b.x, b.y), { line: true });

// ---------------------------------------------------------------------------------------------
// Pen (bezier)
// ---------------------------------------------------------------------------------------------

let penPts: PathPoint[] = [];
let penDragging = false;
let penHover: Vec | null = null;

function finishPen(closed: boolean): void {
  const pts = penPts;
  penPts = [];
  penDragging = false;
  penHover = null;
  if (pts.length < 2) return requestRepaint();
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const u = ui();
  const node = createShape(
    'Path',
    { contours: [{ closed, pts: pts.map((q) => ({ ...q, x: q.x - cx, y: q.y - cy })) }] },
    { fill: closed ? u.fill : null, stroke: closed ? (u.strokeWidth > 0 ? u.stroke : null) : u.stroke ?? '#ffffff', strokeWidth: closed ? u.strokeWidth : Math.max(2, u.strokeWidth) },
  );
  node.x = cx;
  node.y = cy;
  addNode(node, null, undefined, 'Draw path');
  u.select([node.id]);
}

export const penTool: Tool = {
  id: 'pen',
  cursor: 'crosshair',
  down(p, env) {
    const w = env.stageToWorld(p.stage, 0);
    if (penPts.length >= 2) {
      const f = env.worldToScreen(penPts[0], 0);
      if (Math.hypot(f.x - p.screen.x, f.y - p.screen.y) < 9) return finishPen(true);
    }
    penPts.push({ x: w.x, y: w.y, ix: 0, iy: 0, ox: 0, oy: 0 });
    penDragging = true;
    requestRepaint();
  },
  move(p, env, dragging) {
    const w = env.stageToWorld(p.stage, 0);
    if (dragging && penDragging && penPts.length) {
      const last = penPts[penPts.length - 1];
      last.ox = w.x - last.x;
      last.oy = w.y - last.y;
      last.ix = -last.ox;
      last.iy = -last.oy;
    } else penHover = w;
    if (penPts.length) requestRepaint();
  },
  up() {
    penDragging = false;
  },
  dblclick() {
    // The double-click's two downs added a duplicate point; drop it and finish the open path.
    if (penPts.length > 1) penPts.pop();
    finishPen(false);
  },
  key(e) {
    if (e.key === 'Enter') {
      finishPen(false);
      return true;
    }
    if (e.key === 'Escape' && penPts.length) {
      penPts = [];
      requestRepaint();
      return true;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && penPts.length) {
      penPts.pop();
      requestRepaint();
      return true;
    }
    return false;
  },
  cancel() {
    finishPen(false);
  },
  overlay(g, env) {
    if (!penPts.length) return;
    const S = (x: number, y: number) => env.worldToScreen({ x, y }, 0);
    g.strokeStyle = '#4cc9f0';
    g.lineWidth = 1.5;
    g.beginPath();
    penPts.forEach((q, i) => {
      const a = S(q.x, q.y);
      if (i === 0) return g.moveTo(a.x, a.y);
      const prev = penPts[i - 1];
      const c1 = S(prev.x + prev.ox, prev.y + prev.oy);
      const c2 = S(q.x + q.ix, q.y + q.iy);
      g.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, a.x, a.y);
    });
    if (penHover && !penDragging) {
      const last = penPts[penPts.length - 1];
      const c1 = S(last.x + last.ox, last.y + last.oy);
      const h = S(penHover.x, penHover.y);
      g.bezierCurveTo(c1.x, c1.y, h.x, h.y, h.x, h.y);
    }
    g.stroke();
    for (const [i, q] of penPts.entries()) {
      const a = S(q.x, q.y);
      if (q.ox || q.oy) {
        const o = S(q.x + q.ox, q.y + q.oy);
        const n = S(q.x + q.ix, q.y + q.iy);
        g.strokeStyle = 'rgba(76,201,240,0.6)';
        g.beginPath();
        g.moveTo(n.x, n.y);
        g.lineTo(o.x, o.y);
        g.stroke();
      }
      g.fillStyle = i === 0 ? '#ffd166' : '#ffffff';
      g.strokeStyle = '#14151a';
      g.beginPath();
      g.rect(a.x - 3.5, a.y - 3.5, 7, 7);
      g.fill();
      g.stroke();
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Brush and eraser (frame-by-frame drawing layers)
// ---------------------------------------------------------------------------------------------

let live: { id: string; toLocal: (p: Pointer, env: ToolEnv) => Vec; pts: StrokePoint[] } | null = null;

/** The drawing layer the brush paints on: the selected one, or a new layer. */
function targetDrawing(env: ToolEnv): string {
  const u = ui();
  const sel = u.selection.map((id) => env.scene.nodes[id]).find((n) => n?.type === 'drawing');
  if (sel) return sel.id;
  const node = createDrawing('Drawing');
  addNode(node, null, undefined, 'Add drawing layer');
  u.select([node.id]);
  return node.id;
}

function localPoint(id: string, p: Pointer, env: ToolEnv): Vec {
  const en = env.es.nodes.get(id);
  if (!en) return env.stageToWorld(p.stage, 0);
  const w = env.stageToWorld(p.stage, en.worldDepth);
  return apply(invert(en.world), w.x, w.y);
}

export const brushTool: Tool = {
  id: 'brush',
  cursor: 'crosshair',
  down(p, env) {
    const id = targetDrawing(env);
    const toLocal = (q: Pointer, e: ToolEnv) => localPoint(id, q, e);
    const a = toLocal(p, env);
    live = { id, toLocal, pts: [{ x: a.x, y: a.y, p: p.pen ? Math.max(0.05, p.pressure) : 0.5 }] };
  },
  move(p, env, dragging) {
    if (!dragging || !live) return;
    const a = live.toLocal(p, env);
    const last = live.pts[live.pts.length - 1];
    if (Math.hypot(a.x - last.x, a.y - last.y) * env.zoom < 1.2) return;
    live.pts.push({ x: a.x, y: a.y, p: p.pen ? Math.max(0.05, p.pressure) : 0.5 });
    requestRepaint();
  },
  up() {
    const l = live;
    live = null;
    if (!l) return;
    const u = ui();
    const round = (v: number) => Math.round(v * 10) / 10;
    const stroke: Stroke = {
      pts: l.pts.map((q) => ({ x: round(q.x), y: round(q.y), p: Math.round(q.p * 100) / 100 })),
      color: u.brushColor, size: u.brushSize, thinning: u.brushThinning,
    };
    addStroke(l.id, stroke, u.frame);
  },
  cancel() {
    live = null;
  },
  overlay(g, env) {
    if (!live) return;
    const en = env.es.nodes.get(live.id);
    const u = ui();
    // Preview in the layer's own space so it lines up exactly with the committed stroke.
    g.save();
    const w = en?.world ?? [1, 0, 0, 1, 0, 0];
    const o = env.worldToScreen({ x: 0, y: 0 }, en?.worldDepth ?? 0);
    const ex = env.worldToScreen({ x: 1, y: 0 }, en?.worldDepth ?? 0);
    const ey = env.worldToScreen({ x: 0, y: 1 }, en?.worldDepth ?? 0);
    g.transform(ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y);
    g.transform(w[0], w[1], w[2], w[3], w[4], w[5]);
    drawStrokes(g, [{ pts: live.pts, color: u.brushColor, size: u.brushSize, thinning: u.brushThinning }]);
    g.restore();
  },
};

let erasing: { id: string; exposure: number; strokes: Stroke[]; changed: boolean } | null = null;

function eraseAt(p: Pointer, env: ToolEnv): void {
  if (!erasing) return;
  const a = localPoint(erasing.id, p, env);
  const r = Math.max(6, ui().brushSize);
  const before = erasing.strokes.length;
  erasing.strokes = erasing.strokes.filter((s) => !s.pts.some((q) => Math.hypot(q.x - a.x, q.y - a.y) <= r + s.size / 2));
  if (erasing.strokes.length !== before) {
    erasing.changed = true;
    setDrawingFrame(erasing.id, erasing.exposure, erasing.strokes, 'Erase');
  }
}

export const eraserTool: Tool = {
  id: 'eraser',
  cursor: 'crosshair',
  down(p, env) {
    const u = ui();
    const n = u.selection.map((id) => env.scene.nodes[id]).find((x) => x?.type === 'drawing');
    if (!n || n.type !== 'drawing') {
      u.toast('Select a drawing layer to erase on.');
      return;
    }
    const exp = exposureAt(n.frames, Math.floor(u.frame + 1e-6));
    if (exp === null) return;
    erasing = { id: n.id, exposure: exp, strokes: [...(n.frames[String(exp)] ?? [])], changed: false };
    doc.begin('Erase');
    eraseAt(p, env);
  },
  move(p, env, dragging) {
    if (dragging) eraseAt(p, env);
  },
  up() {
    if (erasing) doc.commit();
    erasing = null;
  },
  cancel() {
    if (erasing) doc.rollback();
    erasing = null;
  },
};

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

export const textTool: Tool = {
  id: 'text',
  cursor: 'text',
  down(p, env) {
    const w = env.stageToWorld(p.stage, 0);
    const u = ui();
    const node = createText('Text', { x: w.x, y: w.y, fill: u.fill ?? '#ffffff' });
    addNode(node, null, undefined, 'Add text');
    u.select([node.id]);
    u.set({ tool: 'select', rightTab: 'properties' });
  },
};
