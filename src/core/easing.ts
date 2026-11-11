import type { Ease } from './types';

export const EASE_PRESETS: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  backOut: [0.34, 1.56, 0.64, 1],
  backIn: [0.36, 0, 0.66, -0.56],
  anticipate: [0.68, -0.6, 0.32, 1.6],
  snap: [0.1, 0.9, 0.2, 1],
};

/** Solves a CSS cubic-bezier easing curve for progress x in [0, 1]. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  // Newton-Raphson, then bisection as a fallback for flat derivatives.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-6) return ((ay * t + by) * t + cy) * t;
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 32; i++) {
    const v = sampleX(t);
    if (Math.abs(v - x) < 1e-6) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return ((ay * t + by) * t + cy) * t;
}

/** Maps linear progress t in [0, 1] through an ease. 'step' holds the first value until t reaches 1. */
export function applyEase(ease: Ease | undefined, t: number): number {
  if (!ease || ease === 'linear') return t;
  if (ease === 'step') return t >= 1 ? 1 : 0;
  const bz = typeof ease === 'string' ? EASE_PRESETS[ease] : ease;
  if (!bz) return t;
  return cubicBezier(bz[0], bz[1], bz[2], bz[3], t);
}

export function easeToBezier(ease: Ease | undefined): [number, number, number, number] {
  if (!ease) return [0, 0, 1, 1];
  if (Array.isArray(ease)) return ease;
  return EASE_PRESETS[ease] ?? [0, 0, 1, 1];
}
