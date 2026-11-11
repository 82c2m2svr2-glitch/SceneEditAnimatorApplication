import { clamp, DEG } from './math';

export interface TwoBoneSolution {
  /** Absolute angle (degrees) of the first segment in the solving space. */
  a1: number;
  /** Angle (degrees) of the second segment relative to the first. */
  a2: number;
  /** False when the target was out of reach and the chain was straightened/folded. */
  reached: boolean;
}

/**
 * Analytic two-bone IK. The chain starts at (ax, ay) with segment lengths l1 and l2 and reaches
 * for (tx, ty). `bendPositive` picks which side the middle joint bends to.
 */
export function solveTwoBone(
  ax: number, ay: number, l1: number, l2: number, tx: number, ty: number, bendPositive: boolean,
): TwoBoneSolution {
  const dx = tx - ax;
  const dy = ty - ay;
  const rawD = Math.hypot(dx, dy);
  const minD = Math.abs(l1 - l2) + 1e-4;
  const maxD = l1 + l2 - 1e-4;
  const d = clamp(rawD, minD, Math.max(minD, maxD));
  const base = Math.atan2(dy, dx);
  if (l1 < 1e-6 || l2 < 1e-6) return { a1: base / DEG, a2: 0, reached: rawD <= l1 + l2 };
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const cosB = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
  const inner = Math.acos(cosA);
  const elbow = Math.PI - Math.acos(cosB);
  const sign = bendPositive ? 1 : -1;
  return {
    a1: (base - sign * inner) / DEG,
    a2: (sign * elbow) / DEG,
    reached: rawD >= minD && rawD <= maxD,
  };
}

/** One-bone IK: aim the segment at the target. Returns the absolute angle in degrees. */
export function solveOneBone(ax: number, ay: number, tx: number, ty: number): number {
  return Math.atan2(ty - ay, tx - ax) / DEG;
}
