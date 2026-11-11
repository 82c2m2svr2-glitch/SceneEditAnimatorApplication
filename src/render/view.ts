import { mul, rotationMat, scaling, translation } from '../core/math';
import type { Camera, Mat } from '../core/types';

/** Depths closer than this to the camera plane are culled. */
const NEAR = 20;

/** Perspective scale of a plane at `depth` as seen by the camera. Null when behind the camera. */
export function depthScale(cam: Camera, depth: number): number | null {
  const d = cam.focal + depth - cam.z;
  if (d < NEAR) return null;
  return (cam.zoom * cam.focal) / d;
}

/**
 * Matrix taking world coordinates on the plane at `depth` to stage pixels (0..width, 0..height).
 * This is the whole multiplane camera: planes further away scale down around the optical axis, so
 * moving the camera slides them less (parallax) and dollying changes their relative size.
 */
export function viewMatrix(cam: Camera, width: number, height: number, depth: number): Mat | null {
  const s = depthScale(cam, depth);
  if (s === null) return null;
  return mul(translation(width / 2, height / 2), mul(rotationMat(-cam.rotation), mul(scaling(s), translation(-cam.x, -cam.y))));
}

/** Depth-of-field blur radius in stage pixels for a plane at `depth`. */
export function dofBlur(cam: Camera, depth: number): number {
  if (!cam.dofEnabled || cam.aperture <= 0) return 0;
  return (cam.aperture * Math.abs(depth - cam.focusDepth)) / 1000;
}
