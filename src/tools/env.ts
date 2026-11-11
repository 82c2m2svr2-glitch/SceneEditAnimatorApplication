import { getEval, type EvalScene } from '../core/anim';
import { defaultCamera } from '../core/factory';
import { apply, invert, type Vec } from '../core/math';
import type { Camera, Project, Scene } from '../core/types';
import { viewMatrix } from '../render/view';
import { scene as currentScene } from '../state/commands';
import { project } from '../state/store';
import { ui, type ToolId } from '../state/ui';

export interface Pointer {
  /** Position in stage pixels. */
  stage: Vec;
  /** Position in CSS pixels relative to the viewport canvas. */
  screen: Vec;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  button: number;
  pressure: number;
  pen: boolean;
}

export interface ToolEnv {
  project: Project;
  scene: Scene;
  es: EvalScene;
  /** Camera the viewport is currently looking through. */
  camera: Camera;
  /** CSS pixels per stage pixel. */
  zoom: number;
  stageToWorld(p: Vec, depth: number): Vec;
  worldToStage(p: Vec, depth: number): Vec;
  stageToScreen(p: Vec): Vec;
  worldToScreen(p: Vec, depth: number): Vec;
}

/** The camera the editor viewport looks through for the current view mode. */
export function activeCamera(p: Project, es: EvalScene): Camera {
  return ui().viewMode === 'camera' ? es.camera : defaultCamera(p.width, p.height);
}

export function makeEnv(): ToolEnv {
  const p = project();
  const s = currentScene();
  const u = ui();
  const es = getEval(p, s, u.frame, u.setupMode);
  const camera = activeCamera(p, es);
  const view = (depth: number) => viewMatrix(camera, p.width, p.height, depth) ?? [1, 0, 0, 1, 0, 0];
  const env: ToolEnv = {
    project: p, scene: s, es, camera, zoom: u.zoom,
    stageToWorld: (pt, depth) => apply(invert(view(depth)), pt.x, pt.y),
    worldToStage: (pt, depth) => apply(view(depth), pt.x, pt.y),
    stageToScreen: (pt) => ({ x: pt.x * u.zoom + u.panX, y: pt.y * u.zoom + u.panY }),
    worldToScreen: (pt, depth) => env.stageToScreen(env.worldToStage(pt, depth)),
  };
  return env;
}

export interface Tool {
  id: ToolId;
  cursor: string;
  down?(p: Pointer, env: ToolEnv): void;
  /** Called for every pointer move; `dragging` is true between down and up. */
  move?(p: Pointer, env: ToolEnv, dragging: boolean): void;
  up?(p: Pointer, env: ToolEnv): void;
  dblclick?(p: Pointer, env: ToolEnv): void;
  /** Return true when the key was handled. */
  key?(e: KeyboardEvent, env: ToolEnv): boolean;
  /** Draws tool feedback in CSS-pixel space on top of the scene. */
  overlay?(g: CanvasRenderingContext2D, env: ToolEnv): void;
  /** Tool switched away or Escape pressed. */
  cancel?(): void;
}
