import { apply, distToSegment, invert, mul } from './math';
import type { Mat, PathData, Skin } from './types';

export interface BoneSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** bind[i] takes a rest vertex in node-local space into bone i's local space. */
export function computeBind(nodeWorld: Mat, boneWorlds: Mat[]): Mat[] {
  return boneWorlds.map((bw) => mul(invert(bw), nodeWorld));
}

/**
 * Automatic skin weights from distance to bone segments.
 * Each vertex keeps its `maxInfluences` nearest bones; `falloff` controls how sharply influence
 * drops with distance (higher = more rigid, lower = smoother bends).
 */
export function autoWeights(
  verts: { x: number; y: number }[],
  bones: BoneSegment[],
  opts: { maxInfluences?: number; falloff?: number } = {},
): number[][] {
  const maxInf = opts.maxInfluences ?? 2;
  const falloff = opts.falloff ?? 4;
  return verts.map((v) => {
    const ds = bones.map((b, i) => ({ i, d: distToSegment(v.x, v.y, b.ax, b.ay, b.bx, b.by).d }));
    ds.sort((a, b) => a.d - b.d);
    const near = ds.slice(0, Math.max(1, maxInf));
    const d0 = Math.max(near[0].d, 1e-3);
    let sum = 0;
    const ws = near.map((n) => {
      const w = Math.pow(d0 / Math.max(n.d, 1e-3), falloff);
      sum += w;
      return w;
    });
    const out: number[] = [];
    near.forEach((n, k) => {
      const w = ws[k] / sum;
      if (w > 0.01) out.push(n.i, w);
    });
    // Renormalise after dropping negligible influences.
    let s = 0;
    for (let k = 1; k < out.length; k += 2) s += out[k];
    for (let k = 1; k < out.length; k += 2) out[k] /= s;
    return out;
  });
}

/** Blended skinning matrix for one vertex. */
function blend(skinMats: Mat[], w: number[]): Mat {
  if (w.length === 2) return skinMats[w[0]];
  const m: Mat = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < w.length; k += 2) {
    const s = skinMats[w[k]];
    const wt = w[k + 1];
    if (!s) continue;
    for (let j = 0; j < 6; j++) m[j] += s[j] * wt;
  }
  return m;
}

/** Per-bone matrices taking rest node-local vertices to current world space. */
export function skinMatrices(skin: Skin, boneWorlds: (Mat | undefined)[], fallback: Mat): Mat[] {
  return skin.bones.map((_, i) => {
    const bw = boneWorlds[i];
    return bw ? mul(bw, skin.bind[i]) : fallback;
  });
}

/** Deforms a path's anchors and handles into world space. */
export function deformPath(path: PathData, skin: Skin, mats: Mat[], fallback: Mat): PathData {
  let vi = 0;
  return {
    contours: path.contours.map((c) => ({
      closed: c.closed,
      pts: c.pts.map((p) => {
        const w = skin.weights[vi++];
        const m = w && w.length ? blend(mats, w) : fallback;
        const a = apply(m, p.x, p.y);
        const i = apply(m, p.x + p.ix, p.y + p.iy);
        const o = apply(m, p.x + p.ox, p.y + p.oy);
        return { x: a.x, y: a.y, ix: i.x - a.x, iy: i.y - a.y, ox: o.x - a.x, oy: o.y - a.y };
      }),
    })),
  };
}

/** Deforms flat mesh vertices [x0, y0, ...] into world space. */
export function deformVerts(verts: number[], skin: Skin, mats: Mat[], fallback: Mat): number[] {
  const out = new Array<number>(verts.length);
  for (let i = 0; i < verts.length; i += 2) {
    const w = skin.weights[i / 2];
    const m = w && w.length ? blend(mats, w) : fallback;
    const p = apply(m, verts[i], verts[i + 1]);
    out[i] = p.x;
    out[i + 1] = p.y;
  }
  return out;
}

/** Regular grid mesh over a width x height image whose origin is its centre. */
export function gridMesh(width: number, height: number, cols: number, rows: number) {
  const verts: number[] = [];
  const uvs: number[] = [];
  const tris: number[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const v = r / rows;
      verts.push(-width / 2 + u * width, -height / 2 + v * height);
      uvs.push(u, v);
    }
  }
  const idx = (c: number, r: number) => r * (cols + 1) + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tris.push(idx(c, r), idx(c + 1, r), idx(c + 1, r + 1), idx(c, r), idx(c + 1, r + 1), idx(c, r + 1));
    }
  }
  return { verts, uvs, tris, cols, rows };
}
