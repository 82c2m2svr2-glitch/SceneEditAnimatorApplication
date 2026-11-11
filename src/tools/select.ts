import { boneTip } from '../core/anim';
import { apply, applyVec, IDENTITY, invert, mul, rectFromPoints, rectsIntersect, shortestAngle, type Rect, type Vec } from '../core/math';
import { topLevel } from '../core/tree';
import type { ID, Mat, Scene } from '../core/types';
import { hitBone, hitTest, localBounds, worldPoints } from '../render/hit';
import { viewMatrix } from '../render/view';
import { currentValue, patchNode, setProps, setPropsMany } from '../state/commands';
import { doc } from '../state/store';
import { ui, useUI } from '../state/ui';
import type { Pointer, Tool, ToolEnv } from './env';

const HANDLE = 5;
const ROTATE_OFFSET = 26;

type Drag =
  | { kind: 'move'; start: Vec; moved: boolean; items: { id: ID; depth: number; x: number; y: number; parentInv: Mat }[] }
  | { kind: 'rotate'; id: ID; center: Vec; last: number; total: number; startRot: number; sign: number }
  | { kind: 'scale'; id: ID; hx: number; hy: number; toLocal: Mat; hLocal: Vec; sx: number; sy: number }
  | { kind: 'tip'; id: ID; depth: number; parentInv: Mat; origin: Vec; parentRot: number }
  | { kind: 'marquee'; start: Vec; cur: Vec; additive: boolean };

let drag: Drag | null = null;

/** Root-most unlocked ancestor of a node, or null if any ancestor is locked. */
function outermost(scene: Scene, id: ID): ID | null {
  let cur = id;
  for (;;) {
    const n = scene.nodes[cur];
    if (!n || n.locked) return null;
    if (!n.parent) return cur;
    cur = n.parent;
  }
}

interface Gizmo {
  id: ID;
  depth: number;
  bounds: Rect;
  world: Mat;
  /** Screen positions: 8 scale handles (corners then edge midpoints) and the rotate handle. */
  handles: { hx: number; hy: number; local: Vec; screen: Vec }[];
  rotate: Vec;
  origin: Vec;
  corners: Vec[];
}

function gizmoFor(env: ToolEnv): Gizmo | null {
  const sel = ui().selection;
  if (sel.length !== 1) return null;
  const en = env.es.nodes.get(sel[0]);
  if (!en || en.node.type === 'bone' || en.node.locked) return null;
  const b = localBounds(env.es, sel[0]);
  if (!b) return null;
  const depth = en.worldDepth;
  const toScreen = (lx: number, ly: number) => env.worldToScreen(apply(en.world, lx, ly), depth);
  const handles: Gizmo['handles'] = [];
  for (const [hx, hy] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const local = { x: b.x + ((hx + 1) / 2) * b.w, y: b.y + ((hy + 1) / 2) * b.h };
    handles.push({ hx, hy, local, screen: toScreen(local.x, local.y) });
  }
  const corners = handles.slice(0, 4).map((h) => h.screen);
  const top = handles[4].screen;
  const bottom = handles[6].screen;
  const ux = top.x - bottom.x;
  const uy = top.y - bottom.y;
  const len = Math.hypot(ux, uy) || 1;
  return {
    id: sel[0], depth, bounds: b, world: en.world, handles, corners,
    rotate: { x: top.x + (ux / len) * ROTATE_OFFSET, y: top.y + (uy / len) * ROTATE_OFFSET },
    origin: toScreen(0, 0),
  };
}

function parentWorld(env: ToolEnv, id: ID): Mat {
  const parent = env.es.nodes.get(id)?.node.parent;
  return parent ? env.es.nodes.get(parent)?.world ?? IDENTITY : IDENTITY;
}

function beginMove(p: Pointer, env: ToolEnv): void {
  const ids = topLevel(env.scene, ui().selection).filter((id) => !env.scene.nodes[id].locked);
  drag = {
    kind: 'move', start: p.stage, moved: false,
    items: ids.map((id) => ({
      id,
      depth: env.es.nodes.get(id)?.worldDepth ?? 0,
      x: (currentValue(id, 'x') as number) ?? 0,
      y: (currentValue(id, 'y') as number) ?? 0,
      parentInv: invert(parentWorld(env, id)),
    })),
  };
  doc.begin('Move');
}

function beginRotate(p: Pointer, env: ToolEnv, id: ID): void {
  const en = env.es.nodes.get(id)!;
  const center = env.worldToStage({ x: en.world[4], y: en.world[5] }, en.worldDepth);
  const view = viewMatrix(env.camera, env.project.width, env.project.height, en.worldDepth) ?? IDENTITY;
  const m = mul(view, parentWorld(env, id));
  drag = {
    kind: 'rotate', id, center, total: 0,
    last: (Math.atan2(p.stage.y - center.y, p.stage.x - center.x) * 180) / Math.PI,
    startRot: (currentValue(id, 'rotation') as number) ?? 0,
    sign: m[0] * m[3] - m[1] * m[2] < 0 ? -1 : 1,
  };
  doc.begin('Rotate');
}

export const selectTool: Tool = {
  id: 'select',
  cursor: 'default',

  down(p, env) {
    const u = ui();
    const tol = 7 / env.zoom;

    const g = gizmoFor(env);
    if (g) {
      const near = (a: Vec) => Math.hypot(a.x - p.screen.x, a.y - p.screen.y) <= HANDLE + 4;
      if (near(g.rotate)) return beginRotate(p, env, g.id);
      const h = g.handles.find((x) => near(x.screen));
      if (h) {
        const view = viewMatrix(env.camera, env.project.width, env.project.height, g.depth) ?? IDENTITY;
        drag = {
          kind: 'scale', id: g.id, hx: h.hx, hy: h.hy, toLocal: invert(mul(view, g.world)), hLocal: h.local,
          sx: (currentValue(g.id, 'scaleX') as number) ?? 1, sy: (currentValue(g.id, 'scaleY') as number) ?? 1,
        };
        doc.begin('Scale');
        return;
      }
    }

    const boneId = u.showBones ? hitBone(env.project, env.es, env.camera, p.stage, tol) : null;
    if (boneId) {
      if (p.shift && !u.selection.includes(boneId)) u.select([...u.selection, boneId]);
      else if (!u.selection.includes(boneId)) u.select([boneId]);
      const en = env.es.nodes.get(boneId)!;
      const tipStage = env.worldToStage(boneTip(en), en.worldDepth);
      const nearTip = Math.hypot(tipStage.x - p.stage.x, tipStage.y - p.stage.y) <= tol * 1.3;
      if (en.length < 1 || p.alt) return beginMove(p, env);
      if (u.setupMode && nearTip) {
        const pw = parentWorld(env, boneId);
        drag = {
          kind: 'tip', id: boneId, depth: en.worldDepth, parentInv: invert(pw), origin: { x: en.x, y: en.y },
          parentRot: 0,
        };
        doc.begin('Resize bone');
        return;
      }
      return beginRotate(p, env, boneId);
    }

    const leaf = hitTest(env.project, env.es, env.camera, p.stage, 4 / env.zoom);
    const target = leaf ? (p.ctrl ? leaf : outermost(env.scene, leaf)) : null;
    if (target) {
      if (p.shift) u.select([target], true);
      else if (!u.selection.includes(target)) u.select([target]);
      if (ui().selection.includes(target)) beginMove(p, env);
      return;
    }
    drag = { kind: 'marquee', start: p.stage, cur: p.stage, additive: p.shift };
  },

  move(p, env, dragging) {
    if (!dragging || !drag) return;
    const d = drag;
    if (d.kind === 'move') {
      let dx = p.stage.x - d.start.x;
      let dy = p.stage.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * env.zoom < 3) return;
      d.moved = true;
      if (p.shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      setPropsMany(
        d.items.map((it) => {
          const a = env.stageToWorld(d.start, it.depth);
          const b = env.stageToWorld({ x: d.start.x + dx, y: d.start.y + dy }, it.depth);
          const delta = applyVec(it.parentInv, b.x - a.x, b.y - a.y);
          return { id: it.id, values: { x: it.x + delta.x, y: it.y + delta.y } };
        }),
        { label: 'Move' },
      );
    } else if (d.kind === 'rotate') {
      const ang = (Math.atan2(p.stage.y - d.center.y, p.stage.x - d.center.x) * 180) / Math.PI;
      d.total += shortestAngle(ang - d.last);
      d.last = ang;
      let rot = d.startRot + d.total * d.sign;
      if (p.shift) rot = Math.round(rot / 15) * 15;
      setProps(d.id, { rotation: rot }, { label: 'Rotate' });
    } else if (d.kind === 'scale') {
      const m = apply(d.toLocal, p.stage.x, p.stage.y);
      let fx = d.hx !== 0 && Math.abs(d.hLocal.x) > 1e-3 ? m.x / d.hLocal.x : 1;
      let fy = d.hy !== 0 && Math.abs(d.hLocal.y) > 1e-3 ? m.y / d.hLocal.y : 1;
      if (p.shift || (d.hx !== 0 && d.hy !== 0 && !p.alt)) {
        // Corner handles scale uniformly unless Alt is held; Shift forces uniform on any handle.
        const f = d.hx !== 0 && d.hy !== 0 ? (Math.abs(fx) > Math.abs(fy) ? fx : fy) : d.hx !== 0 ? fx : fy;
        fx = f;
        fy = f;
      }
      setProps(d.id, { scaleX: d.sx * fx, scaleY: d.sy * fy }, { label: 'Scale' });
    } else if (d.kind === 'tip') {
      const world = env.stageToWorld(p.stage, d.depth);
      const local = apply(d.parentInv, world.x, world.y);
      const dx = local.x - d.origin.x;
      const dy = local.y - d.origin.y;
      setProps(d.id, { rotation: (Math.atan2(dy, dx) * 180) / Math.PI }, { label: 'Resize bone', setup: true });
      patchNode(d.id, { length: Math.max(1, Math.hypot(dx, dy)) }, 'Resize bone');
    } else {
      d.cur = p.stage;
      useUI.setState({ repaint: ui().repaint + 1 });
    }
  },

  up(_p, env) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === 'marquee') {
      const box = rectFromPoints([d.start, d.cur]);
      if (box.w * env.zoom < 3 && box.h * env.zoom < 3) {
        if (!d.additive) ui().select([]);
        return;
      }
      const hits: ID[] = [];
      for (const id of env.scene.roots) {
        const en = env.es.nodes.get(id);
        if (!en || !en.visible || en.node.locked) continue;
        const pts = worldPoints(env.es, id).map((w) => env.worldToStage(w, en.worldDepth));
        if (pts.length && rectsIntersect(rectFromPoints(pts), box)) hits.push(id);
      }
      ui().select(d.additive ? [...new Set([...ui().selection, ...hits])] : hits);
      return;
    }
    doc.commit();
  },

  dblclick(p, env) {
    const leaf = hitTest(env.project, env.es, env.camera, p.stage, 4 / env.zoom);
    if (leaf) ui().select([leaf]);
  },

  cancel() {
    if (drag && drag.kind !== 'marquee') doc.rollback();
    drag = null;
  },

  overlay(g, env) {
    const u = ui();
    g.lineWidth = 1;
    // Outlines for every selected non-bone node.
    for (const id of u.selection) {
      const en = env.es.nodes.get(id);
      if (!en || en.node.type === 'bone') continue;
      const b = localBounds(env.es, id);
      if (!b) continue;
      const c = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) =>
        env.worldToScreen(apply(en.world, x, y), en.worldDepth),
      );
      g.strokeStyle = '#4cc9f0';
      g.beginPath();
      c.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      g.closePath();
      g.stroke();
    }
    const gz = gizmoFor(env);
    if (gz) {
      const top = gz.handles[4].screen;
      g.strokeStyle = '#4cc9f0';
      g.beginPath();
      g.moveTo(top.x, top.y);
      g.lineTo(gz.rotate.x, gz.rotate.y);
      g.stroke();
      g.fillStyle = '#14151a';
      for (const h of gz.handles) {
        g.beginPath();
        g.rect(h.screen.x - HANDLE, h.screen.y - HANDLE, HANDLE * 2, HANDLE * 2);
        g.fill();
        g.stroke();
      }
      g.beginPath();
      g.arc(gz.rotate.x, gz.rotate.y, HANDLE + 1, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // Pivot crosshair.
      g.strokeStyle = '#ffd166';
      g.beginPath();
      g.moveTo(gz.origin.x - 6, gz.origin.y);
      g.lineTo(gz.origin.x + 6, gz.origin.y);
      g.moveTo(gz.origin.x, gz.origin.y - 6);
      g.lineTo(gz.origin.x, gz.origin.y + 6);
      g.stroke();
    }
    if (drag?.kind === 'marquee') {
      const a = env.stageToScreen(drag.start);
      const b = env.stageToScreen(drag.cur);
      g.fillStyle = 'rgba(76,201,240,0.12)';
      g.strokeStyle = '#4cc9f0';
      g.beginPath();
      g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      g.fill();
      g.stroke();
    }
  },
};
