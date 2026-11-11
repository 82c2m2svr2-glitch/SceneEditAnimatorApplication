import type { Mat } from './types';

export interface Vec {
  x: number;
  y: number;
}

export const DEG = Math.PI / 180;

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolates angles in degrees along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + shortestAngle(b - a) * t;
}

/** Wraps an angle difference into (-180, 180]. */
export function shortestAngle(d: number): number {
  d = ((d % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

export function round(v: number, digits = 3): number {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

// --- matrices --------------------------------------------------------------------------------

/** Returns a * b (apply b first, then a). */
export function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, -m[4], -m[5]];
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

export function apply(m: Mat, x: number, y: number): Vec {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Transforms a direction (ignores translation). */
export function applyVec(m: Mat, x: number, y: number): Vec {
  return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y };
}

/** Local matrix for translate * rotate * scale. */
export function trs(x: number, y: number, rotationDeg: number, sx: number, sy: number): Mat {
  const r = rotationDeg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx, s * sx, -s * sy, c * sy, x, y];
}

export function translation(x: number, y: number): Mat {
  return [1, 0, 0, 1, x, y];
}

export function scaling(sx: number, sy = sx): Mat {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotationMat(deg: number): Mat {
  const r = deg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export interface Decomposed {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** Decomposes into translate/rotate/scale. Shear is dropped; a flip is reported as negative scaleY. */
export function decompose(m: Mat): Decomposed {
  const sx = Math.hypot(m[0], m[1]);
  const det = m[0] * m[3] - m[1] * m[2];
  const sy = sx === 0 ? 0 : det / sx;
  return { x: m[4], y: m[5], rotation: Math.atan2(m[1], m[0]) / DEG, scaleX: sx, scaleY: sy };
}

/** Rotation in degrees of the matrix x axis. */
export function matRotation(m: Mat): number {
  return Math.atan2(m[1], m[0]) / DEG;
}

/** Uniform-ish scale factor of a matrix (geometric mean of the axis lengths). */
export function matScale(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

// --- vectors / geometry ------------------------------------------------------------------------

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** Distance from a point to a segment, plus the parameter of the closest point. */
export function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return { d: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectFromPoints(pts: Vec[]): Rect {
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectCorners(r: Rect): Vec[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

export function transformRect(m: Mat, r: Rect): Rect {
  return rectFromPoints(rectCorners(r).map((p) => apply(m, p.x, p.y)));
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function pointInRect(p: Vec, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Deterministic PRNG (mulberry32). Returns a function yielding floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
