import { newId } from './ids';
import { rectPath } from './path';
import type {
  AnimMode, BoneNode, Camera, CharacterNode, DrawingNode, GroupNode, ImageNode, NodeBase, PathData,
  Paint, ParticleConfig, ParticlesNode, Project, Scene, ShapeNode, SwitchNode, TextNode, ViewName,
} from './types';

export interface CanvasPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const CANVAS_PRESETS: CanvasPreset[] = [
  { id: 'hd', label: 'Widescreen HD 1920 x 1080', width: 1920, height: 1080 },
  { id: 'vertical', label: 'Vertical 1080 x 1920', width: 1080, height: 1920 },
  { id: 'square', label: 'Square 1080 x 1080', width: 1080, height: 1080 },
  { id: '4k', label: '4K UHD 3840 x 2160', width: 3840, height: 2160 },
  { id: '720', label: 'HD 1280 x 720', width: 1280, height: 720 },
];

export const FPS_PRESETS = [12, 24, 25, 30, 60];

export function defaultCamera(width: number, height: number): Camera {
  return {
    x: width / 2, y: height / 2, z: 0, zoom: 1, rotation: 0, focal: 1000,
    dofEnabled: false, focusDepth: 0, aperture: 8,
  };
}

export function createScene(name: string, width: number, height: number, fps: number): Scene {
  return {
    id: newId('s'), name, duration: fps * 5, background: '#20232b', nodes: {}, roots: [],
    camera: defaultCamera(width, height), anim: {}, strips: [], constraints: [], audio: [], markers: [],
    transition: { type: 'cut', duration: Math.round(fps / 2) },
  };
}

export function createProject(opts: { name: string; width: number; height: number; fps: number; mode: AnimMode }): Project {
  const now = Date.now();
  return {
    format: 'dreamforge', version: 1, id: newId('p'), name: opts.name, width: opts.width, height: opts.height,
    fps: opts.fps, mode: opts.mode, scenes: [createScene('Scene 1', opts.width, opts.height, opts.fps)],
    assets: {}, actions: {}, createdAt: now, modifiedAt: now,
  };
}

function base(name: string, init: Partial<NodeBase> = {}): NodeBase {
  return {
    id: newId('n'), name, parent: null, children: [], visible: true, locked: false,
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, depth: 0, zOrder: 0, blend: 'normal', effects: [],
    ...init,
  };
}

export function createGroup(name = 'Group', init: Partial<GroupNode> = {}): GroupNode {
  return { ...base(name), type: 'group', ...init };
}

export function createShape(
  name: string,
  path: PathData,
  style: { fill?: Paint | null; stroke?: string | null; strokeWidth?: number } = {},
  init: Partial<ShapeNode> = {},
): ShapeNode {
  return {
    ...base(name), type: 'shape', path,
    fill: style.fill === undefined ? '#7c5cff' : style.fill,
    stroke: style.stroke === undefined ? null : style.stroke,
    strokeWidth: style.strokeWidth ?? 0,
    lineCap: 'round', lineJoin: 'round', fillRule: 'nonzero',
    ...init,
  };
}

export function createRect(name: string, w: number, h: number, fill: Paint = '#7c5cff', radius = 0): ShapeNode {
  return createShape(name, rectPath(-w / 2, -h / 2, w, h, radius), { fill });
}

export function createText(text: string, init: Partial<TextNode> = {}): TextNode {
  return {
    ...base(text.slice(0, 24) || 'Text'), type: 'text', text, font: 'Inter, system-ui, sans-serif', size: 72,
    weight: 700, italic: false, align: 'center', lineHeight: 1.2, fill: '#ffffff', stroke: null, strokeWidth: 0,
    ...init,
  };
}

export function createImage(name: string, assetId: string, width: number, height: number, init: Partial<ImageNode> = {}): ImageNode {
  return { ...base(name), type: 'image', assetId, width, height, ...init };
}

export function createBone(name: string, length: number, init: Partial<BoneNode> = {}): BoneNode {
  return { ...base(name), type: 'bone', length, pose: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, ...init };
}

export function createCharacter(name: string, views: ViewName[] = ['front'], init: Partial<CharacterNode> = {}): CharacterNode {
  return { ...base(name), type: 'character', views, currentView: views[0] ?? 'front', mouth: 'rest', eyes: 'open', ...init };
}

export function createSwitch(name: string, active: string, init: Partial<SwitchNode> = {}): SwitchNode {
  return { ...base(name), type: 'switch', active, ...init };
}

export function createDrawing(name = 'Drawing', init: Partial<DrawingNode> = {}): DrawingNode {
  return { ...base(name), type: 'drawing', frames: {}, ...init };
}

export const DEFAULT_PARTICLES: ParticleConfig = {
  preset: 'sparks', seed: 1, rate: 40, life: 1.6, lifeJitter: 0.4, width: 0, height: 0, speed: 260, speedJitter: 0.5,
  angle: -90, spread: 50, gravityX: 0, gravityY: 500, drag: 0.2, sizeStart: 10, sizeEnd: 2, sizeJitter: 0.4, spin: 0,
  colorStart: '#ffd166', colorEnd: '#ef476f', alphaStart: 1, alphaEnd: 0, shape: 'circle', prewarm: 0, maxParticles: 800,
};

export function createParticles(name = 'Particles', config: Partial<ParticleConfig> = {}, init: Partial<ParticlesNode> = {}): ParticlesNode {
  return { ...base(name), type: 'particles', config: { ...DEFAULT_PARTICLES, ...config }, ...init };
}
