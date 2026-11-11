import { evaluateScene } from '../core/anim';
import { buildCharacter } from '../core/character/build';
import type { CharacterSpec } from '../core/character/spec';
import { createProject } from '../core/factory';
import type { Mat, ViewName } from '../core/types';
import { renderScene } from './draw';

/** Draws a character spec (one view) into a canvas, fitted and standing on a ground line. */
export function renderSpecPreview(canvas: HTMLCanvasElement, spec: CharacterSpec, view: ViewName, background = '#1b1d24'): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 400;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const height = 600;
  const built = buildCharacter({ ...spec, height });
  const p = createProject({ name: 'preview', width: 700, height: 760, fps: 24, mode: 'rig' });
  const scene = p.scenes[0];
  for (const n of built.nodes) scene.nodes[n.id] = n;
  scene.roots.push(built.rootId);
  const root = scene.nodes[built.rootId];
  if (root.type === 'character') root.currentView = root.views.includes(view) ? view : root.views[0];
  root.x = 350;
  root.y = 700;
  const k = Math.min(canvas.width / p.width, canvas.height / p.height);
  const outer: Mat = [k, 0, 0, k, (canvas.width - p.width * k) / 2, (canvas.height - p.height * k) / 2];
  renderScene(ctx, p, evaluateScene(p, scene, 0), { outer, camera: scene.camera, background: false, clip: false });
}
