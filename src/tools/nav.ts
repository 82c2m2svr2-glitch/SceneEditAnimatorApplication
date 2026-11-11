import { applyVec, invert, IDENTITY } from '../core/math';
import { viewMatrix } from '../render/view';
import { setCamera } from '../state/commands';
import { doc } from '../state/store';
import { ui, useUI } from '../state/ui';
import type { Tool } from './env';

/** Zooms the editor view around a screen point. */
export function zoomAt(screenX: number, screenY: number, factor: number): void {
  const u = ui();
  const zoom = Math.max(0.02, Math.min(64, u.zoom * factor));
  const k = zoom / u.zoom;
  useUI.setState({ zoom, panX: screenX - (screenX - u.panX) * k, panY: screenY - (screenY - u.panY) * k });
}

let panStart: { x: number; y: number; panX: number; panY: number } | null = null;

export const handTool: Tool = {
  id: 'hand',
  cursor: 'grab',
  down(p) {
    const u = ui();
    panStart = { x: p.screen.x, y: p.screen.y, panX: u.panX, panY: u.panY };
  },
  move(p, _env, dragging) {
    if (!dragging || !panStart) return;
    useUI.setState({ panX: panStart.panX + p.screen.x - panStart.x, panY: panStart.panY + p.screen.y - panStart.y });
  },
  up() {
    panStart = null;
  },
  cancel() {
    panStart = null;
  },
};

export const zoomTool: Tool = {
  id: 'zoom',
  cursor: 'zoom-in',
  down(p) {
    zoomAt(p.screen.x, p.screen.y, p.alt ? 1 / 1.5 : 1.5);
  },
};

let camStart: { sx: number; sy: number; x: number; y: number } | null = null;

/** Drags the scene camera. In stage view the frame moves; in camera view the world slides. */
export const cameraTool: Tool = {
  id: 'camera',
  cursor: 'move',
  down(p, env) {
    camStart = { sx: p.stage.x, sy: p.stage.y, x: env.es.camera.x, y: env.es.camera.y };
    doc.begin('Move camera');
  },
  move(p, env, dragging) {
    if (!dragging || !camStart) return;
    const view = viewMatrix(env.camera, env.project.width, env.project.height, 0) ?? IDENTITY;
    const d = applyVec(invert(view), p.stage.x - camStart.sx, p.stage.y - camStart.sy);
    // Looking through the camera, dragging pulls the world, so the camera moves the other way.
    const dir = ui().viewMode === 'camera' ? -1 : 1;
    setCamera({ x: camStart.x + d.x * dir, y: camStart.y + d.y * dir }, { label: 'Move camera' });
  },
  up() {
    if (camStart) doc.commit();
    camStart = null;
  },
  cancel() {
    if (camStart) doc.rollback();
    camStart = null;
  },
};
