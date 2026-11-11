import { getEval } from '../core/anim';
import { renderFrame } from '../render/draw';
import { scene } from '../state/commands';
import { doc } from '../state/store';
import { ui } from '../state/ui';

/** Renders the current frame as the camera sees it and returns a JPEG data URL. */
export function captureFrame(maxSize = 896, frame = ui().frame): string {
  const p = doc.project!;
  const k = Math.min(1, maxSize / Math.max(p.width, p.height));
  const w = Math.max(1, Math.round(p.width * k));
  const h = Math.max(1, Math.round(p.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  renderFrame(canvas.getContext('2d')!, p, getEval(p, scene(p), frame), w, h);
  return canvas.toDataURL('image/jpeg', 0.85);
}
