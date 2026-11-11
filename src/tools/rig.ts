import { solveIkChain } from '../core/anim';
import { createBone } from '../core/factory';
import { apply, IDENTITY, invert, type Vec } from '../core/math';
import type { ID, Mat } from '../core/types';
import { hitBone } from '../render/hit';
import { addNode, currentValue, setPropsMany } from '../state/commands';
import { doc } from '../state/store';
import { requestRepaint, ui } from '../state/ui';
import type { Tool, ToolEnv } from './env';

// ---------------------------------------------------------------------------------------------
// Bone tool: drag to create a bone. A selected bone becomes the parent, so repeated drags chain.
// ---------------------------------------------------------------------------------------------

let boneStart: Vec | null = null;
let boneEnd: Vec | null = null;

export const boneTool: Tool = {
  id: 'bone',
  cursor: 'crosshair',
  down(p, env) {
    const u = ui();
    // Snap the start to the tip of the selected bone when clicking close to it.
    const sel = u.selection.length === 1 ? env.es.nodes.get(u.selection[0]) : undefined;
    let w = env.stageToWorld(p.stage, sel?.worldDepth ?? 0);
    if (sel && sel.node.type === 'bone') {
      const tip = apply(sel.world, sel.length, 0);
      const ts = env.worldToScreen(tip, sel.worldDepth);
      if (Math.hypot(ts.x - p.screen.x, ts.y - p.screen.y) < 14) w = tip;
    }
    boneStart = w;
    boneEnd = w;
  },
  move(p, env, dragging) {
    if (!dragging || !boneStart) return;
    const sel = ui().selection.length === 1 ? env.es.nodes.get(ui().selection[0]) : undefined;
    boneEnd = env.stageToWorld(p.stage, sel?.worldDepth ?? 0);
    requestRepaint();
  },
  up(_p, env) {
    const a = boneStart;
    const b = boneEnd;
    boneStart = null;
    boneEnd = null;
    if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 4) return;
    const u = ui();
    const parentEn = u.selection.length === 1 ? env.es.nodes.get(u.selection[0]) : undefined;
    const parentOk = parentEn && ['bone', 'character', 'group'].includes(parentEn.node.type);
    const pw: Mat = parentOk ? parentEn.world : IDENTITY;
    const inv = invert(pw);
    const la = apply(inv, a.x, a.y);
    const lb = apply(inv, b.x, b.y);
    const count = Object.values(env.scene.nodes).filter((n) => n.type === 'bone').length;
    const bone = createBone(`Bone ${count + 1}`, Math.hypot(lb.x - la.x, lb.y - la.y), {
      x: la.x, y: la.y, rotation: (Math.atan2(lb.y - la.y, lb.x - la.x) * 180) / Math.PI,
    });
    addNode(bone, parentOk ? parentEn.node.id : null, undefined, 'Add bone');
    u.select([bone.id]);
  },
  cancel() {
    boneStart = null;
    boneEnd = null;
  },
  overlay(g, env) {
    if (!boneStart || !boneEnd) return;
    const sel = ui().selection.length === 1 ? env.es.nodes.get(ui().selection[0]) : undefined;
    const a = env.worldToScreen(boneStart, sel?.worldDepth ?? 0);
    const b = env.worldToScreen(boneEnd, sel?.worldDepth ?? 0);
    g.strokeStyle = '#ffd166';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  },
};

// ---------------------------------------------------------------------------------------------
// IK tool: drag a bone and its parent follows so the bone's tip tracks the pointer.
// ---------------------------------------------------------------------------------------------

let ik: { a: ID | null; b: ID; depth: number; bend: boolean } | null = null;

function ikDrag(target: Vec, env: ToolEnv): void {
  if (!ik) return;
  const es = env.es;
  const b = es.nodes.get(ik.b);
  if (!b) return;
  const world = env.stageToWorld(target, ik.depth);
  const setup = ui().setupMode;
  // Values written are pose deltas in animate mode, so convert solved local rotations back.
  const toChannel = (id: ID, localRot: number): number => {
    const en = es.nodes.get(id)!;
    const cur = (currentValue(id, 'rotation') as number) ?? 0;
    return cur + (localRot - en.rotation);
  };
  if (ik.a) {
    const a = es.nodes.get(ik.a);
    if (!a) return;
    const pw = a.node.parent ? es.nodes.get(a.node.parent)?.world ?? IDENTITY : IDENTITY;
    const t = apply(invert(pw), world.x, world.y);
    const sol = solveIkChain(a, b, t, ik.bend);
    setPropsMany(
      [
        { id: ik.a, values: { rotation: toChannel(ik.a, sol.a) } },
        { id: ik.b, values: { rotation: toChannel(ik.b, sol.b) } },
      ],
      { label: 'IK pose', setup },
    );
  } else {
    const pw = b.node.parent ? es.nodes.get(b.node.parent)?.world ?? IDENTITY : IDENTITY;
    const t = apply(invert(pw), world.x, world.y);
    const rot = (Math.atan2(t.y - b.y, t.x - b.x) * 180) / Math.PI;
    setPropsMany([{ id: ik.b, values: { rotation: toChannel(ik.b, rot) } }], { label: 'IK pose', setup });
  }
}

export const ikTool: Tool = {
  id: 'ik',
  cursor: 'grab',
  down(p, env) {
    const id = hitBone(env.project, env.es, env.camera, p.stage, 10 / env.zoom);
    if (!id) return;
    const b = env.es.nodes.get(id)!;
    const parent = b.node.parent ? env.es.nodes.get(b.node.parent) : undefined;
    const a = parent && parent.node.type === 'bone' && parent.length > 1 ? parent : null;
    // Keep bending the way the limb already bends.
    let bend = true;
    if (a) {
      const bx = b.world[4] - a.world[4];
      const by = b.world[5] - a.world[5];
      const tip = apply(b.world, b.length, 0);
      const cross = bx * (tip.y - b.world[5]) - by * (tip.x - b.world[4]);
      const pw = a.node.parent ? env.es.nodes.get(a.node.parent)?.world ?? IDENTITY : IDENTITY;
      const flipped = pw[0] * pw[3] - pw[1] * pw[2] < 0;
      bend = Math.abs(cross) < 1e-3 ? true : cross > 0 !== flipped;
    }
    ik = { a: a ? a.node.id : null, b: id, depth: b.worldDepth, bend };
    ui().select(a ? [a.node.id, id] : [id]);
    doc.begin('IK pose');
    ikDrag(p.stage, env);
  },
  move(p, env, dragging) {
    if (dragging && ik) ikDrag(p.stage, env);
  },
  up() {
    if (ik) doc.commit();
    ik = null;
  },
  cancel() {
    if (ik) doc.rollback();
    ik = null;
  },
};
