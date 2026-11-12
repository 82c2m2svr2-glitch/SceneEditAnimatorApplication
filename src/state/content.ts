/**
 * Higher-level authoring operations built on the command layer: inserting characters, applying
 * actions, importing media, rigging helpers and the clipboard.
 */
import { boneTip, nameIndex } from '../core/anim';
import { builtinActions } from '../core/character/actions';
import { buildCharacter } from '../core/character/build';
import { buildCharacter3D } from '../core/character/model3d';
import { humanoidSpec, type HumanoidParams } from '../core/character/humanoid';
import type { CharacterSpec } from '../core/character/spec';
import { createGroup, createImage, createModel3D, createParticles, createShape } from '../core/factory';
import { newId } from '../core/ids';
import { layerOverPlate, PLATE_TAG, type GenerationRecord, type Rect01 } from '../core/localGen';
import { apply, IDENTITY, invert } from '../core/math';
import { PARTICLE_PRESETS } from '../core/particles';
import { transformPath } from '../core/path';
import { autoWeights, computeBind, gridMesh, type BoneSegment } from '../core/skin';
import type { TracedShape } from '../core/trace';
import { ancestorOfType, extractSubtree, insertBundle, subtreeIds, topLevel, type RigFile } from '../core/tree';
import type { ActionClip, Asset, ID, ImageNode, Keyframe, ShapeNode, SolidShape, Track } from '../core/types';
import { imageSize } from '../render/images';
import { addAction, addAsset, addConstraint, addNode, addNodes, addStrip, evalNow, patchNode, scene } from './commands';
import { doc, project } from './store';
import { ui } from './ui';

// --- characters ------------------------------------------------------------------------------

export function addCharacterFromSpec(spec: CharacterSpec, at?: { x: number; y: number }): ID {
  const p = project();
  const built = buildCharacter(spec);
  const root = built.nodes.find((n) => n.id === built.rootId)!;
  root.x = at?.x ?? p.width / 2;
  root.y = at?.y ?? Math.round(p.height * 0.86);
  addNodes(built.nodes, [built.rootId], null, 'Add character');
  ui().select([built.rootId]);
  return built.rootId;
}

export function addHumanoid(params: Partial<HumanoidParams> = {}, at?: { x: number; y: number }): ID {
  return addCharacterFromSpec(humanoidSpec(params), at);
}

/**
 * Adds a character whose body is a 3D model generated from the same turnaround. It keeps the 2D
 * skeleton, so posing, actions, views and lip-sync work exactly as they do for a flat character.
 */
export function addCharacter3DFromSpec(spec: CharacterSpec, at?: { x: number; y: number }): ID {
  const p = project();
  // Fails early, with a readable message, if the turnaround cannot be turned into a solid body.
  const height = buildCharacter3D(spec).height;
  const built = buildCharacter(spec, { skeletonOnly: true });
  const root = built.nodes.find((n) => n.id === built.rootId)!;
  root.x = at?.x ?? p.width / 2;
  root.y = at?.y ?? Math.round(p.height * 0.86);
  const asset: Asset = { id: newId('mdl'), name: `${spec.name || 'Character'} (3D)`, kind: 'character3d', mime: 'application/json', dataUrl: '', spec };
  // The model is drawn in a box big enough for raised arms and jumps, centred on the middle of the body.
  const body = createModel3D('Body (3D)', asset.id, height * 1.7, { y: -height / 2, parent: root.id, locked: true });
  root.children.unshift(body.id);
  doc.transact('Add 3D character', () => {
    addAsset(asset);
    addNodes([...built.nodes, body], [built.rootId], null, 'Add 3D character');
  });
  ui().select([built.rootId]);
  return built.rootId;
}

// --- actions ---------------------------------------------------------------------------------

let builtinCache: ActionClip[] | null = null;

export function builtins(): ActionClip[] {
  return (builtinCache ??= builtinActions());
}

export function findAction(idOrName: string): ActionClip | null {
  const p = project();
  if (p.actions[idOrName]) return p.actions[idOrName];
  const lower = idOrName.toLowerCase();
  const all = [...Object.values(p.actions), ...builtins()];
  return (
    all.find((a) => a.id === idOrName) ?? all.find((a) => a.name.toLowerCase() === lower) ??
    all.find((a) => a.id.toLowerCase() === `builtin_${lower}`) ?? all.find((a) => a.name.toLowerCase().includes(lower)) ?? null
  );
}

/** Places an action on the timeline for a character or group. Returns the strip id. */
export function applyAction(
  targetId: ID, action: string, opts: { start?: number; duration?: number; repeat?: number; speed?: number; blend?: number; track?: number } = {},
): ID | null {
  const clip = findAction(action);
  const s = scene();
  if (!clip || !s.nodes[targetId]) return null;
  const p = project();
  const speed = opts.speed ?? 1;
  const one = (clip.duration * (p.fps / clip.fps)) / speed;
  const duration = Math.max(1, Math.round(opts.duration ?? one * (opts.repeat ?? 1)));
  const start = Math.round(opts.start ?? ui().frame);
  const blend = opts.blend ?? Math.min(4, Math.floor(duration / 4));
  const used = s.strips.filter((st) => st.targetId === targetId && st.start < start + duration && st.start + st.duration > start).map((st) => st.track);
  let track = opts.track ?? 0;
  if (opts.track === undefined) while (used.includes(track)) track++;
  return doc.transact('Apply action', () => {
    if (!project().actions[clip.id]) addAction(clip);
    return addStrip({ actionId: clip.id, targetId, start, duration, speed, blendIn: blend, blendOut: blend, weight: 1, track, muted: false });
  });
}

/**
 * Captures the keyframes of a character (or group) between two frames as a reusable action.
 * Tracks are stored by node name so the clip can drive any rig with the same names.
 */
export function saveAsAction(targetId: ID, name: string, from: number, to: number, loop: boolean): ID | null {
  const s = scene();
  const p = project();
  const target = s.nodes[targetId];
  if (!target || to <= from) return null;
  const tracks: ActionClip['tracks'] = {};
  for (const id of subtreeIds(s, targetId)) {
    const src = s.anim[id];
    if (!src) continue;
    const nodeName = id === targetId ? '@' : s.nodes[id].name;
    for (const prop in src) {
      const keys: Keyframe[] = src[prop].keys.filter((k) => k.f >= from && k.f <= to).map((k) => ({ ...k, f: k.f - from }));
      if (keys.length === 0) continue;
      ((tracks[nodeName] ??= {}) as Record<string, Track>)[prop] = { keys };
    }
  }
  if (Object.keys(tracks).length === 0) return null;
  const view = target.type === 'character' ? [target.currentView] : [];
  return addAction({ id: newId('act'), name, category: 'My actions', duration: to - from, fps: p.fps, loop, views: view, tracks });
}

// --- media -----------------------------------------------------------------------------------

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}

export async function importImage(name: string, dataUrl: string, mime = 'image/png'): Promise<Asset> {
  const { width, height } = await imageSize(dataUrl);
  const asset: Asset = { id: newId('img'), name, kind: 'image', mime, dataUrl, width, height };
  addAsset(asset);
  return asset;
}

/** Adds a locally generated image to the project's assets, with everything needed to reproduce it. */
export async function importGeneratedImage(name: string, dataUrl: string, generation: GenerationRecord): Promise<Asset> {
  const { width, height } = await imageSize(dataUrl);
  const asset: Asset = { id: newId('img'), name, kind: 'image', mime: 'image/png', dataUrl, width, height, generation };
  addAsset(asset);
  return asset;
}

/** Adds an image asset to the scene, scaled down to fit the stage if it is larger. */
export function placeImage(asset: Asset, at?: { x: number; y: number }): ID {
  const p = project();
  const w = asset.width ?? 256;
  const h = asset.height ?? 256;
  const k = Math.min(1, (p.width * 0.9) / w, (p.height * 0.9) / h);
  const node = createImage(asset.name.replace(/\.[a-z0-9]+$/i, ''), asset.id, Math.round(w * k), Math.round(h * k));
  node.x = at?.x ?? p.width / 2;
  node.y = at?.y ?? p.height / 2;
  addNode(node, null, undefined, 'Place image');
  ui().select([node.id]);
  return node.id;
}

/** Places a generated shot so it fills the stage, for judging it at the size it will be seen. */
export function placeFullFrame(asset: Asset): ID {
  const p = project();
  const id = placeImage(asset);
  if (asset.width && asset.height) {
    const k = Math.max(p.width / asset.width, p.height / asset.height);
    patchNode(id, { width: Math.round(asset.width * k), height: Math.round(asset.height * k), x: p.width / 2, y: p.height / 2 }, 'Fill the frame');
  }
  return id;
}

/**
 * Places a picture over part of a background plate layer in the current scene, lined up with the
 * part of the plate it was generated from (`r`, 0..1 of the plate image). It sits at the plate's
 * depth, just in front of it, so the plate itself is never changed.
 */
export function placeOverPlate(asset: Asset, plateNodeId: ID, r: Rect01): ID | null {
  const s = scene();
  const plate = s.nodes[plateNodeId];
  if (!plate || plate.type !== 'image') return null;
  const box = layerOverPlate(plate, r);
  const node = createImage(asset.name.replace(/\.[a-z0-9]+$/i, ''), asset.id, Math.round(box.width), Math.round(box.height), {
    x: box.x, y: box.y, depth: plate.depth, zOrder: plate.zOrder + 1,
  });
  const list = plate.parent ? s.nodes[plate.parent]?.children ?? s.roots : s.roots;
  addNode(node, plate.parent, list.indexOf(plate.id) + 1, 'Place over plate');
  ui().select([node.id]);
  return node.id;
}

/** The background plate layer for an image in the current scene, if it has been placed there. */
export function plateNodeFor(assetId: ID): ImageNode | null {
  const n = Object.values(scene().nodes).find((x) => x.type === 'image' && x.assetId === assetId && x.tag === PLATE_TAG);
  return (n as ImageNode | undefined) ?? null;
}

const MODEL_FORMATS: Record<string, Asset['format']> = { glb: 'glb', gltf: 'gltf', obj: 'obj' };

/** File extension check for 3D model files DreamForge can import. */
export function isModelFile(name: string): boolean {
  return (name.split('.').pop() ?? '').toLowerCase() in MODEL_FORMATS;
}

/** Imports a 3D model file (.glb, .gltf or .obj) as an asset. */
export async function importModel(file: File): Promise<Asset> {
  const format = MODEL_FORMATS[(file.name.split('.').pop() ?? '').toLowerCase()];
  if (!format) throw new Error(`"${file.name}" is not a 3D model DreamForge can import (use .glb, .gltf or .obj).`);
  const asset: Asset = { id: newId('mdl'), name: file.name, kind: 'model', mime: file.type || 'model/gltf-binary', dataUrl: await readAsDataUrl(file), format };
  addAsset(asset);
  return asset;
}

/** Adds a 3D model asset to the scene as a cel-shaded layer. */
export function placeModel(asset: Asset, at?: { x: number; y: number }): ID {
  const p = project();
  const node = createModel3D(asset.name.replace(/\.[a-z0-9]+$/i, ''), asset.id, Math.round(Math.min(p.width, p.height) * 0.5));
  node.x = at?.x ?? p.width / 2;
  node.y = at?.y ?? p.height / 2;
  addNode(node, null, undefined, 'Place 3D model');
  ui().select([node.id]);
  return node.id;
}

/** Adds a built-in 3D solid (box, sphere, ...) to the scene. */
export function addSolid(shape: SolidShape, color = '#7c5cff', at?: { x: number; y: number }): ID {
  const name = shape[0].toUpperCase() + shape.slice(1);
  const asset: Asset = { id: newId('mdl'), name: `${name} (3D)`, kind: 'model', mime: '', dataUrl: '', format: 'solid', solid: { shape, color } };
  return doc.transact('Add 3D shape', () => {
    addAsset(asset);
    const id = placeModel(asset, at);
    patchNode(id, { name, rotX: 20, rotY: 30 }, 'Add 3D shape');
    return id;
  });
}

/**
 * Turns a picture into a 3D object: the picture is puffed up into a rounded solid that can turn in
 * depth. Works best on a cut-out (transparent background) of a single object.
 */
export function addReliefModel(name: string, dataUrl: string, size?: { width?: number; height?: number }, at?: { x: number; y: number }): ID {
  const asset: Asset = { id: newId('mdl'), name: `${name} (3D)`, kind: 'model', mime: 'image/png', dataUrl, format: 'relief', depth: 0.55, width: size?.width, height: size?.height };
  return doc.transact('Add 3D object', () => {
    addAsset(asset);
    const id = placeModel(asset, at);
    patchNode(id, { name, outline: 0, rotY: -25 }, 'Add 3D object');
    return id;
  });
}

/** Replaces an image layer with a 3D object made from the same picture. The image is kept, hidden. */
export function imageTo3D(imageId: ID): ID | null {
  const n = scene().nodes[imageId] as ImageNode | undefined;
  const asset = n && n.type === 'image' ? project().assets[n.assetId] : undefined;
  if (!n || !asset) return null;
  return doc.transact('Turn into 3D object', () => {
    const id = addReliefModel(n.name, asset.dataUrl, asset, { x: n.x, y: n.y });
    // The camera frames the model's bounding sphere, so the box is a little larger than the picture.
    const box = Math.hypot(n.width, n.height) * 1.12;
    patchNode(id, { width: box, height: box, rotation: n.rotation, scaleX: n.scaleX, scaleY: n.scaleY, depth: n.depth, zOrder: n.zOrder, opacity: n.opacity, rotY: 0 }, 'Turn into 3D object');
    patchNode(imageId, { visible: false }, 'Turn into 3D object');
    return id;
  });
}

/** Decodes an image asset to pixels, scaled down so its longer side is at most `maxSide`. */
export async function imagePixels(asset: Asset, maxSide = 900): Promise<ImageData> {
  const img = new Image();
  img.src = asset.dataUrl;
  await img.decode();
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Replaces an image layer with the vector shapes traced from it: a group in the same place, one
 * shape per colour, back to front. The image is hidden, not deleted, so the trace can be redone.
 * `traced` is the pixel size the shapes were traced at.
 */
export function addTracedShapes(imageId: ID, shapes: TracedShape[], traced: { width: number; height: number }): ID | null {
  const n = scene().nodes[imageId] as ImageNode | undefined;
  if (!n || n.type !== 'image' || !shapes.length) return null;
  const sx = n.width / traced.width;
  const sy = n.height / traced.height;
  const group = createGroup(`${n.name} (vector)`, {
    x: n.x, y: n.y, rotation: n.rotation, scaleX: n.scaleX, scaleY: n.scaleY, opacity: n.opacity,
    depth: n.depth, zOrder: n.zOrder, blend: n.blend, view: n.view, tag: n.tag,
  });
  const parts = shapes.map((shape, i) => {
    // Image pixels run from the top-left corner; a layer's own space is centred on the image.
    const path = transformPath(shape.path, [sx, 0, 0, sy, -n.width / 2, -n.height / 2]);
    const part = createShape(`Colour ${i + 1}`, path, { fill: shape.color }, { fillRule: 'evenodd', parent: group.id });
    group.children.push(part.id);
    return part;
  });
  doc.transact('Trace image', () => {
    addNodes([group, ...parts], [group.id], n.parent, 'Trace image');
    patchNode(imageId, { visible: false }, 'Trace image');
  });
  ui().select([group.id]);
  return group.id;
}

export function addParticlePreset(preset: string): ID {
  const p = project();
  const cfg = PARTICLE_PRESETS[preset] ?? {};
  const top = ['rain', 'snow', 'confetti'].includes(preset);
  const node = createParticles(preset[0].toUpperCase() + preset.slice(1), { ...cfg, preset, width: cfg.width ? Math.max(cfg.width, p.width * 1.3) : 0 });
  node.x = p.width / 2;
  node.y = top ? -40 : cfg.height ? p.height / 2 : p.height * 0.7;
  addNode(node, null, undefined, 'Add particles');
  ui().select([node.id]);
  return node.id;
}

// --- rigging ---------------------------------------------------------------------------------

/** Bones a node should bind to by default: all bones of its character, else every bone in the scene. */
function defaultBones(id: ID): ID[] {
  const s = scene();
  const ch = ancestorOfType(s, id, 'character');
  const pool = ch ? subtreeIds(s, ch.id) : Object.keys(s.nodes);
  return pool.filter((b) => s.nodes[b].type === 'bone' && (s.nodes[b] as { length: number }).length > 1);
}

/** Binds shapes/meshes to bones with automatic weights, at the current pose. */
export function bindSkin(nodeIds: ID[], boneIds?: ID[], opts: { influences?: number; falloff?: number } = {}): number {
  const es = evalNow();
  let bound = 0;
  doc.transact('Bind to bones', () => {
    for (const id of nodeIds) {
      const en = es.nodes.get(id);
      if (!en) continue;
      const n = en.node;
      if (n.type !== 'shape' && !(n.type === 'image' && n.mesh)) continue;
      const bones = (boneIds?.length ? boneIds : defaultBones(id)).filter((b) => es.nodes.get(b));
      if (bones.length === 0) continue;
      const worlds = bones.map((b) => es.nodes.get(b)!.world);
      const segs: BoneSegment[] = bones.map((b) => {
        const be = es.nodes.get(b)!;
        const tip = boneTip(be);
        return { ax: be.world[4], ay: be.world[5], bx: tip.x, by: tip.y };
      });
      const local: { x: number; y: number }[] = [];
      if (n.type === 'shape') for (const c of n.path.contours) for (const q of c.pts) local.push({ x: q.x, y: q.y });
      else for (let i = 0; i < n.mesh!.verts.length; i += 2) local.push({ x: n.mesh!.verts[i], y: n.mesh!.verts[i + 1] });
      const verts = local.map((q) => apply(en.world, q.x, q.y));
      const weights = autoWeights(verts, segs, { maxInfluences: opts.influences ?? 2, falloff: opts.falloff ?? 4 });
      patchNode(id, { skin: { bones, bind: computeBind(en.world, worlds), weights } }, 'Bind to bones');
      bound++;
    }
  });
  return bound;
}

export function unbindSkin(nodeIds: ID[]): void {
  doc.transact('Unbind', () => {
    for (const id of nodeIds) patchNode(id, { skin: undefined }, 'Unbind');
  });
}

/** Converts an image into a deformable grid mesh. */
export function makeMesh(id: ID, cols = 8, rows = 8): boolean {
  const n = scene().nodes[id] as ImageNode | undefined;
  if (!n || n.type !== 'image') return false;
  patchNode(id, { mesh: gridMesh(n.width, n.height, Math.max(1, cols), Math.max(1, rows)), skin: undefined }, 'Create mesh');
  return true;
}

/** Adds an IK target for a bone: the bone and its parent bone will reach for the target. */
export function addIKForBone(boneId: ID): ID | null {
  const es = evalNow();
  const b = es.nodes.get(boneId);
  if (!b || b.node.type !== 'bone') return null;
  const parent = b.node.parent ? es.nodes.get(b.node.parent) : undefined;
  const chain = parent && parent.node.type === 'bone' && parent.length > 1 ? [parent.node.id, boneId] : [boneId];
  const s = scene();
  const ch = ancestorOfType(s, boneId, 'character');
  // The target lives beside the skeleton (not under the chain) so posing the body leaves it planted.
  const holder = ch ? ch.id : null;
  const holderWorld = holder ? es.nodes.get(holder)?.world ?? IDENTITY : IDENTITY;
  const tip = boneTip(b);
  const local = apply(invert(holderWorld), tip.x, tip.y);
  const a = es.nodes.get(chain[0])!;
  const bx = b.world[4] - a.world[4];
  const by = b.world[5] - a.world[5];
  const cross = bx * (tip.y - b.world[5]) - by * (tip.x - b.world[4]);
  return doc.transact('Add IK', () => {
    const target = createGroup(`IK ${b.node.name}`, { x: local.x, y: local.y, tag: 'ik-target' });
    addNode(target, holder, undefined, 'Add IK target');
    addConstraint({ name: `IK ${b.node.name}`, bones: chain, targetId: target.id, bendPositive: cross >= 0, mix: 1, enabled: true });
    ui().select([target.id]);
    return target.id;
  });
}

// --- clipboard and rig files -----------------------------------------------------------------

let clipboard: RigFile | null = null;

export function copySelection(): boolean {
  const ids = topLevel(scene(), ui().selection);
  if (ids.length === 0) return false;
  clipboard = extractSubtree(project(), scene(), ids, 'Clipboard');
  return true;
}

export function paste(): ID[] {
  if (!clipboard) return [];
  const bundle = clipboard;
  let roots: ID[] = [];
  doc.apply('Paste', (d) => {
    const s = d.scenes.find((x) => x.id === ui().sceneId) ?? d.scenes[0];
    roots = insertBundle(d, s, bundle, null);
    for (const r of roots) {
      const n = s.nodes[r];
      if (n.type !== 'bone') {
        n.x += 24;
        n.y += 24;
      }
    }
  });
  ui().select(roots);
  return roots;
}

export function exportRig(ids: ID[]): RigFile | null {
  const s = scene();
  const tops = topLevel(s, ids);
  if (tops.length === 0) return null;
  return extractSubtree(project(), s, tops, s.nodes[tops[0]].name);
}

export function importRig(file: RigFile): ID[] {
  if (file?.format !== 'dreamforge-rig' || !file.nodes || !Array.isArray(file.roots)) throw new Error('Not a DreamForge character file');
  let roots: ID[] = [];
  doc.apply('Import character', (d) => {
    const s = d.scenes.find((x) => x.id === ui().sceneId) ?? d.scenes[0];
    roots = insertBundle(d, s, file, null);
  });
  ui().select(roots);
  return roots;
}

/** Name -> id lookup under a character, for tools that address bones by name. */
export function boneByName(characterId: ID, name: string): ID | undefined {
  return nameIndex(scene(), characterId).get(name);
}

export function shapeVertexCount(n: ShapeNode): number {
  return n.path.contours.reduce((a, c) => a + c.pts.length, 0);
}

