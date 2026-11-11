import { apply, invert, type Vec } from '../core/math';
import { clonePath } from '../core/path';
import type { ID, PathData, PathPoint, ShapeNode } from '../core/types';
import { hitTest } from '../render/hit';
import { patchNode } from '../state/commands';
import { doc } from '../state/store';
import { requestRepaint, ui } from '../state/ui';
import type { Pointer, Tool, ToolEnv } from './env';

/** Path point editing: drag anchors and bezier handles, insert and delete points. */

interface PointRef {
  c: number;
  i: number;
}

let selected: PointRef[] = [];
let drag: { id: ID; kind: 'anchor' | 'in' | 'out'; ref: PointRef; start: Vec; base: PathData; mirror: boolean } | null = null;

function target(env: ToolEnv): { node: ShapeNode; toLocal: (p: Pointer) => Vec; toScreen: (x: number, y: number) => Vec } | null {
  const sel = ui().selection;
  if (sel.length !== 1) return null;
  const en = env.es.nodes.get(sel[0]);
  if (!en || en.node.type !== 'shape' || en.node.skin) return null;
  const inv = invert(en.world);
  return {
    node: en.node,
    toLocal: (p) => {
      const w = env.stageToWorld(p.stage, en.worldDepth);
      return apply(inv, w.x, w.y);
    },
    toScreen: (x, y) => env.worldToScreen(apply(en.world, x, y), en.worldDepth),
  };
}

const isSel = (c: number, i: number) => selected.some((r) => r.c === c && r.i === i);

function splitCubic(a: PathPoint, b: PathPoint, t: number): { a: PathPoint; m: PathPoint; b: PathPoint } {
  const L = (p: number, q: number) => p + (q - p) * t;
  const p0 = [a.x, a.y], p1 = [a.x + a.ox, a.y + a.oy], p2 = [b.x + b.ix, b.y + b.iy], p3 = [b.x, b.y];
  const q0 = [L(p0[0], p1[0]), L(p0[1], p1[1])];
  const q1 = [L(p1[0], p2[0]), L(p1[1], p2[1])];
  const q2 = [L(p2[0], p3[0]), L(p2[1], p3[1])];
  const r0 = [L(q0[0], q1[0]), L(q0[1], q1[1])];
  const r1 = [L(q1[0], q2[0]), L(q1[1], q2[1])];
  const s = [L(r0[0], r1[0]), L(r0[1], r1[1])];
  return {
    a: { ...a, ox: q0[0] - a.x, oy: q0[1] - a.y },
    m: { x: s[0], y: s[1], ix: r0[0] - s[0], iy: r0[1] - s[1], ox: r1[0] - s[0], oy: r1[1] - s[1] },
    b: { ...b, ix: q2[0] - b.x, iy: q2[1] - b.y },
  };
}

function cubicPoint(a: PathPoint, b: PathPoint, t: number): Vec {
  const u = 1 - t;
  const f = (p0: number, p1: number, p2: number, p3: number) => u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  return { x: f(a.x, a.x + a.ox, b.x + b.ix, b.x), y: f(a.y, a.y + a.oy, b.y + b.iy, b.y) };
}

export const nodeTool: Tool = {
  id: 'node',
  cursor: 'default',

  down(p, env) {
    const t = target(env);
    if (t) {
      const near = (x: number, y: number, r = 8) => {
        const s = t.toScreen(x, y);
        return Math.hypot(s.x - p.screen.x, s.y - p.screen.y) <= r;
      };
      const path = t.node.path;
      // Handles of selected points first: they sit on top of anchors.
      for (const r of selected) {
        const q = path.contours[r.c]?.pts[r.i];
        if (!q) continue;
        for (const kind of ['out', 'in'] as const) {
          const hx = kind === 'out' ? q.ox : q.ix;
          const hy = kind === 'out' ? q.oy : q.iy;
          if ((hx || hy) && near(q.x + hx, q.y + hy, 7)) {
            const collinear = Math.abs(q.ix * q.oy - q.iy * q.ox) < 0.02 * (Math.hypot(q.ix, q.iy) * Math.hypot(q.ox, q.oy) + 1e-6);
            drag = { id: t.node.id, kind, ref: r, start: t.toLocal(p), base: path, mirror: collinear && !p.alt };
            doc.begin('Edit path');
            return;
          }
        }
      }
      for (let c = 0; c < path.contours.length; c++) {
        const pts = path.contours[c].pts;
        for (let i = 0; i < pts.length; i++) {
          if (!near(pts[i].x, pts[i].y)) continue;
          if (p.shift) selected = isSel(c, i) ? selected.filter((r) => !(r.c === c && r.i === i)) : [...selected, { c, i }];
          else if (!isSel(c, i)) selected = [{ c, i }];
          drag = { id: t.node.id, kind: 'anchor', ref: { c, i }, start: t.toLocal(p), base: path, mirror: false };
          doc.begin('Edit path');
          requestRepaint();
          return;
        }
      }
    }
    const leaf = hitTest(env.project, env.es, env.camera, p.stage, 4 / env.zoom);
    selected = [];
    ui().select(leaf ? [leaf] : []);
  },

  move(p, env, dragging) {
    if (!dragging || !drag) return;
    const t = target(env);
    if (!t || t.node.id !== drag.id) return;
    const cur = t.toLocal(p);
    const dx = cur.x - drag.start.x;
    const dy = cur.y - drag.start.y;
    const next = clonePath(drag.base);
    if (drag.kind === 'anchor') {
      for (const r of selected) {
        const q = next.contours[r.c]?.pts[r.i];
        if (!q) continue;
        q.x += dx;
        q.y += dy;
      }
    } else {
      const q = next.contours[drag.ref.c].pts[drag.ref.i];
      if (drag.kind === 'out') {
        q.ox += dx;
        q.oy += dy;
        if (drag.mirror) {
          const len = Math.hypot(q.ix, q.iy);
          const ol = Math.hypot(q.ox, q.oy) || 1;
          q.ix = (-q.ox / ol) * len;
          q.iy = (-q.oy / ol) * len;
        }
      } else {
        q.ix += dx;
        q.iy += dy;
        if (drag.mirror) {
          const len = Math.hypot(q.ox, q.oy);
          const il = Math.hypot(q.ix, q.iy) || 1;
          q.ox = (-q.ix / il) * len;
          q.oy = (-q.iy / il) * len;
        }
      }
    }
    patchNode(drag.id, { path: next }, 'Edit path');
  },

  up() {
    if (drag) doc.commit();
    drag = null;
  },

  dblclick(p, env) {
    const t = target(env);
    if (!t) return;
    const path = t.node.path;
    // Double-click an anchor: toggle between corner and smooth.
    for (let c = 0; c < path.contours.length; c++) {
      const pts = path.contours[c].pts;
      for (let i = 0; i < pts.length; i++) {
        const s = t.toScreen(pts[i].x, pts[i].y);
        if (Math.hypot(s.x - p.screen.x, s.y - p.screen.y) > 8) continue;
        const next = clonePath(path);
        const q = next.contours[c].pts[i];
        if (q.ix || q.iy || q.ox || q.oy) Object.assign(q, { ix: 0, iy: 0, ox: 0, oy: 0 });
        else {
          const n = pts.length;
          const prev = pts[(i - 1 + n) % n];
          const nxt = pts[(i + 1) % n];
          const tx = (nxt.x - prev.x) / 6;
          const ty = (nxt.y - prev.y) / 6;
          Object.assign(q, { ix: -tx, iy: -ty, ox: tx, oy: ty });
        }
        patchNode(t.node.id, { path: next }, 'Convert point');
        return;
      }
    }
    // Double-click a segment: insert a point there.
    const local = t.toLocal(p);
    let best: { c: number; i: number; t: number; d: number } | null = null;
    path.contours.forEach((con, c) => {
      const n = con.pts.length;
      const segs = con.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        for (let k = 1; k < 20; k++) {
          const tt = k / 20;
          const q = cubicPoint(con.pts[i], con.pts[(i + 1) % n], tt);
          const d = Math.hypot(q.x - local.x, q.y - local.y);
          if (!best || d < best.d) best = { c, i, t: tt, d };
        }
      }
    });
    const b = best as { c: number; i: number; t: number; d: number } | null;
    if (!b || b.d * env.zoom > 12) return;
    const next = clonePath(path);
    const pts = next.contours[b.c].pts;
    const j = (b.i + 1) % pts.length;
    const sp = splitCubic(pts[b.i], pts[j], b.t);
    pts[b.i] = sp.a;
    pts[j] = sp.b;
    pts.splice(b.i + 1, 0, sp.m);
    selected = [{ c: b.c, i: b.i + 1 }];
    patchNode(t.node.id, { path: next }, 'Insert point');
  },

  key(e, env) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
      const t = target(env);
      if (!t) return false;
      const next = clonePath(t.node.path);
      next.contours.forEach((con, c) => {
        con.pts = con.pts.filter((_q, i) => !isSel(c, i));
      });
      next.contours = next.contours.filter((con) => con.pts.length >= 2);
      selected = [];
      if (next.contours.length) patchNode(t.node.id, { path: next }, 'Delete points');
      return true;
    }
    return false;
  },

  cancel() {
    if (drag) doc.rollback();
    drag = null;
    selected = [];
  },

  overlay(g, env) {
    const t = target(env);
    if (!t) return;
    const path = t.node.path;
    g.lineWidth = 1;
    g.strokeStyle = '#4cc9f0';
    g.beginPath();
    for (const con of path.contours) {
      const n = con.pts.length;
      const segs = con.closed ? n : n - 1;
      const s0 = t.toScreen(con.pts[0].x, con.pts[0].y);
      g.moveTo(s0.x, s0.y);
      for (let i = 0; i < segs; i++) {
        const a = con.pts[i];
        const b = con.pts[(i + 1) % n];
        const c1 = t.toScreen(a.x + a.ox, a.y + a.oy);
        const c2 = t.toScreen(b.x + b.ix, b.y + b.iy);
        const e = t.toScreen(b.x, b.y);
        g.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
      }
    }
    g.stroke();
    path.contours.forEach((con, c) => {
      con.pts.forEach((q, i) => {
        const a = t.toScreen(q.x, q.y);
        const sel = isSel(c, i);
        if (sel) {
          for (const [hx, hy] of [[q.ix, q.iy], [q.ox, q.oy]]) {
            if (!hx && !hy) continue;
            const h = t.toScreen(q.x + hx, q.y + hy);
            g.strokeStyle = 'rgba(76,201,240,0.7)';
            g.beginPath();
            g.moveTo(a.x, a.y);
            g.lineTo(h.x, h.y);
            g.stroke();
            g.fillStyle = '#4cc9f0';
            g.beginPath();
            g.arc(h.x, h.y, 3.5, 0, Math.PI * 2);
            g.fill();
          }
        }
        g.fillStyle = sel ? '#ffd166' : '#ffffff';
        g.strokeStyle = '#14151a';
        g.beginPath();
        g.rect(a.x - 3.5, a.y - 3.5, 7, 7);
        g.fill();
        g.stroke();
      });
    });
  },
};
