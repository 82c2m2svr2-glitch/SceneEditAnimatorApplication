import { newId } from './ids';
import type { ActionClip, Asset, ID, IKConstraint, ActionStrip, Project, Scene, SceneNode, Track } from './types';

/** The node and all its descendants, parents before children. */
export function subtreeIds(scene: Scene, id: ID, out: ID[] = []): ID[] {
  const n = scene.nodes[id];
  if (!n) return out;
  out.push(id);
  for (const c of n.children) subtreeIds(scene, c, out);
  return out;
}

export function isAncestor(scene: Scene, ancestor: ID, id: ID): boolean {
  let cur = scene.nodes[id]?.parent ?? null;
  while (cur) {
    if (cur === ancestor) return true;
    cur = scene.nodes[cur]?.parent ?? null;
  }
  return false;
}

/** Drops ids whose ancestor is also in the list, so operations do not act on a node twice. */
export function topLevel(scene: Scene, ids: ID[]): ID[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let cur = scene.nodes[id]?.parent ?? null;
    while (cur) {
      if (set.has(cur)) return false;
      cur = scene.nodes[cur]?.parent ?? null;
    }
    return !!scene.nodes[id];
  });
}

export function ancestorOfType<T extends SceneNode['type']>(scene: Scene, id: ID, type: T): Extract<SceneNode, { type: T }> | null {
  let cur: ID | null = id;
  while (cur) {
    const n: SceneNode | undefined = scene.nodes[cur];
    if (!n) return null;
    if (n.type === type) return n as Extract<SceneNode, { type: T }>;
    cur = n.parent;
  }
  return null;
}

/** All nodes in paint (tree) order. */
export function allIds(scene: Scene): ID[] {
  const out: ID[] = [];
  for (const r of scene.roots) subtreeIds(scene, r, out);
  return out;
}

export function findByName(scene: Scene, name: string, under?: ID): SceneNode | null {
  const ids = under ? subtreeIds(scene, under) : allIds(scene);
  const lower = name.toLowerCase();
  let partial: SceneNode | null = null;
  for (const id of ids) {
    const n = scene.nodes[id];
    if (n.name === name) return n;
    if (!partial && n.name.toLowerCase() === lower) partial = n;
  }
  return partial;
}

export function uniqueName(scene: Scene, base: string): string {
  const names = new Set(Object.values(scene.nodes).map((n) => n.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\s+\d+$/, '');
  for (let i = 2; ; i++) {
    const name = `${stem} ${i}`;
    if (!names.has(name)) return name;
  }
}

// ---------------------------------------------------------------------------------------------
// Portable subtrees: duplication, copy/paste and character (.dfrig) files
// ---------------------------------------------------------------------------------------------

export interface RigFile {
  format: 'dreamforge-rig';
  version: 1;
  name: string;
  nodes: Record<ID, SceneNode>;
  roots: ID[];
  anim: Record<ID, Record<string, Track>>;
  constraints: IKConstraint[];
  strips: ActionStrip[];
  actions: Record<ID, ActionClip>;
  assets: Record<ID, Asset>;
}

/** Extracts nodes plus everything they reference into a self-contained bundle. */
export function extractSubtree(project: Project, scene: Scene, rootIds: ID[], name = 'Rig'): RigFile {
  const ids = new Set<ID>();
  for (const r of topLevel(scene, rootIds)) for (const id of subtreeIds(scene, r)) ids.add(id);
  const nodes: Record<ID, SceneNode> = {};
  const anim: RigFile['anim'] = {};
  const assets: Record<ID, Asset> = {};
  for (const id of ids) {
    const n = scene.nodes[id];
    nodes[id] = n;
    if (scene.anim[id]) anim[id] = scene.anim[id];
    if ((n.type === 'image' || n.type === 'model3d') && project.assets[n.assetId]) assets[n.assetId] = project.assets[n.assetId];
  }
  const constraints = scene.constraints.filter((c) => ids.has(c.targetId) && c.bones.every((b) => ids.has(b)));
  const strips = scene.strips.filter((s) => ids.has(s.targetId));
  const actions: Record<ID, ActionClip> = {};
  for (const s of strips) if (project.actions[s.actionId]) actions[s.actionId] = project.actions[s.actionId];
  return {
    format: 'dreamforge-rig', version: 1, name, nodes, roots: topLevel(scene, rootIds), anim, constraints, strips,
    actions, assets,
  };
}

/** Deep copy of a bundle with fresh node ids (asset and action ids are kept: they are content). */
export function remapBundle(file: RigFile): RigFile {
  const map = new Map<ID, ID>();
  for (const id in file.nodes) map.set(id, newId('n'));
  const re = (id: ID) => map.get(id) ?? id;
  const nodes: Record<ID, SceneNode> = {};
  for (const id in file.nodes) {
    const n = structuredClone(file.nodes[id]) as SceneNode;
    n.id = re(id);
    n.parent = n.parent && map.has(n.parent) ? re(n.parent) : null;
    n.children = n.children.filter((c) => map.has(c)).map(re);
    if ((n.type === 'shape' || n.type === 'image') && n.skin) n.skin.bones = n.skin.bones.map(re);
    nodes[n.id] = n;
  }
  const anim: RigFile['anim'] = {};
  for (const id in file.anim) anim[re(id)] = structuredClone(file.anim[id]);
  return {
    ...file,
    nodes,
    roots: file.roots.map(re),
    anim,
    constraints: file.constraints.map((c) => ({ ...c, id: newId('ik'), bones: c.bones.map(re), targetId: re(c.targetId) })),
    strips: file.strips.map((s) => ({ ...s, id: newId('st'), targetId: re(s.targetId) })),
  };
}

/** Inserts a bundle into a scene (mutates `scene` and `project`; call inside a store recipe). */
export function insertBundle(project: Project, scene: Scene, file: RigFile, parentId: ID | null = null): ID[] {
  const b = remapBundle(file);
  for (const id in b.nodes) scene.nodes[id] = b.nodes[id];
  for (const id in b.anim) scene.anim[id] = b.anim[id];
  for (const r of b.roots) {
    b.nodes[r].parent = parentId;
    if (parentId && scene.nodes[parentId]) scene.nodes[parentId].children.push(r);
    else scene.roots.push(r);
  }
  scene.constraints.push(...b.constraints);
  scene.strips.push(...b.strips);
  for (const id in b.assets) if (!project.assets[id]) project.assets[id] = b.assets[id];
  for (const id in b.actions) if (!project.actions[id]) project.actions[id] = b.actions[id];
  return b.roots;
}
