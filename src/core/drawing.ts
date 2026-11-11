import type { Stroke } from './types';

/** The exposure (keyed drawing frame) showing at `frame`, or null if none exists at or before it. */
export function exposureAt(frames: Record<string, Stroke[]>, frame: number): number | null {
  let best: number | null = null;
  for (const k in frames) {
    const f = Number(k);
    if (f <= frame && (best === null || f > best)) best = f;
  }
  return best;
}

export function exposureFrames(frames: Record<string, Stroke[]>): number[] {
  return Object.keys(frames).map(Number).sort((a, b) => a - b);
}
