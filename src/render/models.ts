import { animated, type EvalNode, type EvalScene } from '../core/anim';
import { VIEW_YAW } from '../core/character/model3d';
import type { Asset, BoneNode, ID, Model3DNode, Project, ViewName } from '../core/types';
import { requestRepaint } from '../state/ui';
import type { BonePose, CharacterPose, LoadedModel, ModelState } from './three/engine';

/**
 * Bridge between the 2D renderer and the 3D engine. The engine (and three.js with it) is only
 * downloaded when a project actually contains a 3D model; until a model has loaded, its layer is
 * simply not drawn and a repaint follows as soon as it is ready.
 */

interface Entry {
  asset: Asset;
  model: LoadedModel | null;
  error: string | null;
  pending: Promise<void>;
}

const entries = new Map<ID, Entry>();
/** Last picture drawn for each node, reused while nothing about the model has changed. */
const pictures = new Map<ID, { key: string; canvas: HTMLCanvasElement }>();

const engine = () => import('./three/engine');

function entry(asset: Asset): Entry {
  let e = entries.get(asset.id);
  if (!e || e.asset !== asset) {
    e?.model?.dispose();
    const fresh: Entry = { asset, model: null, error: null, pending: Promise.resolve() };
    fresh.pending = engine()
      .then((m) => m.loadModel(asset))
      .then(
        (model) => {
          // The asset may have been replaced while this one was loading.
          if (entries.get(asset.id) === fresh) fresh.model = model;
          else model.dispose();
        },
        (err) => {
          fresh.error = err instanceof Error ? err.message : String(err);
        },
      )
      .then(() => requestRepaint());
    entries.set(asset.id, fresh);
    e = fresh;
  }
  return e;
}

/** Animation clips inside a model file, once it has loaded. */
export function modelClips(asset: Asset | undefined): { name: string; duration: number }[] {
  return (asset && entries.get(asset.id)?.model?.clips) || [];
}

/** Names of every joint of a model that can be posed, once it has loaded. */
export function modelJoints(asset: Asset | undefined): string[] {
  return (asset && entries.get(asset.id)?.model?.joints) || [];
}

/** Why a model could not be shown, if loading it failed. */
export function modelError(asset: Asset | undefined): string | null {
  return (asset && entries.get(asset.id)?.error) || null;
}

/** Resolves once every 3D model in the project is ready to draw. Export waits on this. */
export async function preloadModels(project: Project): Promise<void> {
  const used = new Set<ID>();
  for (const s of project.scenes) for (const n of Object.values(s.nodes)) if (n.type === 'model3d') used.add(n.assetId);
  await Promise.all([...used].map((id) => project.assets[id]).filter(Boolean).map((a) => entry(a).pending));
}

/**
 * Reads the pose of the 2D skeleton a 3D character hangs from. The 2D rig stays the single source
 * of truth, so posing tools, action clips, IK and lip-sync all drive the 3D body.
 */
export function characterPose(es: EvalScene, en: EvalNode): CharacterPose | undefined {
  let owner: EvalNode | undefined = en;
  while (owner && owner.node.type !== 'character') owner = owner.node.parent ? es.nodes.get(owner.node.parent) : undefined;
  if (!owner) return undefined;
  const view = animated<ViewName>(owner, 'currentView');
  const bones: Record<string, BonePose> = {};
  const visit = (id: ID, parentAngle: number) => {
    const child = es.nodes.get(id);
    if (!child || child.node.type !== 'bone') return;
    const bone = child.node as BoneNode;
    const rest = (view && bone.viewRest?.[view]) || bone;
    bones[bone.name] = {
      rot: child.rotation - rest.rotation,
      dx: child.x - rest.x,
      dy: child.y - rest.y,
      sx: child.scaleX / (bone.scaleX || 1),
      parentAngle,
    };
    for (const c of bone.children) visit(c, parentAngle + rest.rotation);
  };
  for (const c of owner.node.children) visit(c, 0);
  return { yaw: VIEW_YAW[view] ?? 0, mouth: String(animated(owner, 'mouth') ?? 'rest'), eyes: String(animated(owner, 'eyes') ?? 'open'), bones };
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * The finished 2D picture of a 3D model node at its evaluated state, `pixels` tall, or null while
 * the model is still loading.
 */
export function modelPicture(project: Project, es: EvalScene, en: EvalNode, pixels: number): HTMLCanvasElement | null {
  const n = en.node as Model3DNode;
  const asset = project.assets[n.assetId];
  if (!asset || (asset.kind !== 'model' && asset.kind !== 'character3d')) return null;
  const e = entry(asset);
  if (!e.model) return null;
  const num = (prop: keyof Model3DNode) => Number(animated(en, prop));
  const clip = n.clip;
  // Hand-set joint turns live on the node as `j:<joint>:<axis>` values, keyed like any other property.
  const joints: Record<string, [number, number, number]> = {};
  for (const key of new Set([...Object.keys(n), ...Object.keys(en.props)])) {
    const m = /^j:(.+):([xyz])$/.exec(key);
    const v = m ? Number(animated(en, key)) || 0 : 0;
    if (m && v) (joints[m[1]] ??= [0, 0, 0])['xyz'.indexOf(m[2])] = v;
  }
  const state: ModelState = {
    rotX: num('rotX'), rotY: num('rotY'), rotZ: num('rotZ'),
    shadeSteps: n.shadeSteps, shade: n.shade, outline: n.outline, outlineColor: n.outlineColor, lightAngle: n.lightAngle,
    clip, time: clip ? num('clipTime') + (es.frame / project.fps) * n.clipSpeed : 0,
    pose: asset.kind === 'character3d' ? characterPose(es, en) : undefined,
    joints,
  };
  const h = Math.min(2048, Math.max(16, Math.ceil(pixels / 16) * 16));
  const w = Math.max(16, Math.round((h * n.width) / Math.max(1, n.height)));
  const key = JSON.stringify([w, h, state], (_k, v) => (typeof v === 'number' ? round(v) : v));
  let pic = pictures.get(n.id);
  if (pic && pic.key === key) return pic.canvas;
  const out = e.model.render(state, w, h);
  if (!pic) pictures.set(n.id, (pic = { key, canvas: document.createElement('canvas') }));
  pic.key = key;
  if (pic.canvas.width !== w || pic.canvas.height !== h) {
    pic.canvas.width = w;
    pic.canvas.height = h;
  }
  const ctx = pic.canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(out.canvas, out.sx, out.sy, out.w, out.h, 0, 0, w, h);
  return pic.canvas;
}
