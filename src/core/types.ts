/**
 * DreamForge document model.
 *
 * Everything in a project file is plain JSON described by these types. The document is
 * immutable from the outside: it is only changed through the document store
 * (src/state/store.ts), which records undo patches for every change.
 *
 * Conventions
 * - Coordinates: pixels, origin at the top-left of the stage, y points down.
 * - Angles: degrees, clockwise positive (canvas convention).
 * - Time: frames (may be fractional during playback/export sampling).
 * - Depth: 0 is the focal plane; positive is further from the camera, negative is closer.
 */

export type ID = string;

/** Animation workflow chosen in the start menu. It tunes the default workspace, never the feature set. */
export type AnimMode = 'rig' | 'tween' | 'frame' | 'mesh';

export const VIEW_NAMES = ['front', 'threeQuarter', 'side', 'backThreeQuarter', 'back'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

// ---------------------------------------------------------------------------------------------
// Project / assets
// ---------------------------------------------------------------------------------------------

export interface Project {
  format: 'dreamforge';
  version: 1;
  id: ID;
  name: string;
  width: number;
  height: number;
  fps: number;
  mode: AnimMode;
  scenes: Scene[];
  assets: Record<ID, Asset>;
  /** Reusable animation clips (walk cycles, poses, gestures). */
  actions: Record<ID, ActionClip>;
  createdAt: number;
  modifiedAt: number;
}

export interface Asset {
  id: ID;
  name: string;
  kind: 'image' | 'audio';
  mime: string;
  /** Self-contained data URL so a project is a single portable file. */
  dataUrl: string;
  width?: number;
  height?: number;
  /** Seconds, audio only. */
  duration?: number;
}

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

export interface Scene {
  id: ID;
  name: string;
  /** Length in frames. */
  duration: number;
  background: string;
  nodes: Record<ID, SceneNode>;
  /** Top-level node ids in paint order (first is drawn first). */
  roots: ID[];
  camera: Camera;
  /** Animation tracks: target id (node id or CAMERA_ID) -> property name -> track. */
  anim: Record<ID, Record<string, Track>>;
  /** Action clips placed on the timeline for a character or group (non-linear animation). */
  strips: ActionStrip[];
  constraints: IKConstraint[];
  audio: AudioClip[];
  markers: Marker[];
  /** Transition into the NEXT scene when playing the whole project. */
  transition: Transition;
}

export const CAMERA_ID = 'camera';

export interface Camera {
  x: number;
  y: number;
  /** Dolly along the depth axis. Positive moves the camera into the scene. */
  z: number;
  zoom: number;
  rotation: number;
  /** Distance from the camera to depth 0. Smaller values exaggerate parallax. */
  focal: number;
  dofEnabled: boolean;
  /** Depth that is perfectly sharp when depth of field is enabled. */
  focusDepth: number;
  /** Blur strength in pixels per 1000 depth units away from the focus depth. */
  aperture: number;
}

export interface Transition {
  type: 'cut' | 'fade' | 'dissolve' | 'wipeLeft' | 'wipeRight' | 'slideLeft' | 'slideRight';
  /** Frames. */
  duration: number;
}

export interface Marker {
  id: ID;
  frame: number;
  name: string;
  color?: string;
}

export interface AudioClip {
  id: ID;
  assetId: ID;
  name: string;
  /** Timeline frame at which the clip starts. */
  start: number;
  /** Seconds trimmed from the head of the source audio. */
  offset: number;
  /** Seconds of source audio to play (after offset). */
  length: number;
  volume: number;
  muted: boolean;
  /** Row in the timeline audio area. */
  track: number;
}

// ---------------------------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------------------------

/** Interpolation from a key to the next one. A 4-tuple is a CSS-style cubic-bezier. */
export type Ease = 'linear' | 'step' | 'easeIn' | 'easeOut' | 'easeInOut' | [number, number, number, number];

export type KeyValue = number | string | boolean | number[];

export interface Keyframe {
  f: number;
  v: KeyValue;
  e?: Ease;
}

export interface Track {
  /** Sorted by frame, at most one key per frame. */
  keys: Keyframe[];
}

/**
 * A reusable clip. Tracks are addressed by node NAME (relative to the target the clip is applied
 * to), so the same clip drives any character that uses the standard bone names.
 */
export interface ActionClip {
  id: ID;
  name: string;
  /** Frames at the clip's own fps. */
  duration: number;
  fps: number;
  loop: boolean;
  /** Which character views the clip was authored for. Empty means any view. */
  views: ViewName[];
  category: string;
  /** node name -> property -> track */
  tracks: Record<string, Record<string, Track>>;
}

export interface ActionStrip {
  id: ID;
  actionId: ID;
  /** Character or group whose descendants are matched by name. */
  targetId: ID;
  start: number;
  /** Timeline frames the strip occupies. */
  duration: number;
  speed: number;
  blendIn: number;
  blendOut: number;
  weight: number;
  /** Row inside the target's strip area. Later rows override earlier ones. */
  track: number;
  muted: boolean;
}

/** Two-bone (or one-bone) inverse kinematics evaluated after the keyed pose. */
export interface IKConstraint {
  id: ID;
  name: string;
  /** Chain from parent to child, 1 or 2 bones. */
  bones: ID[];
  /** Node whose world position the chain tip reaches for. */
  targetId: ID;
  bendPositive: boolean;
  /** 0 = pure keyed pose, 1 = pure IK. */
  mix: number;
  enabled: boolean;
}

// ---------------------------------------------------------------------------------------------
// Vector paths
// ---------------------------------------------------------------------------------------------

/** Anchor with bezier handles stored as offsets from the anchor. */
export interface PathPoint {
  x: number;
  y: number;
  /** Incoming handle offset. */
  ix: number;
  iy: number;
  /** Outgoing handle offset. */
  ox: number;
  oy: number;
}

export interface Contour {
  pts: PathPoint[];
  closed: boolean;
}

export interface PathData {
  contours: Contour[];
}

export interface GradientStop {
  offset: number;
  color: string;
}

export interface Gradient {
  type: 'linear' | 'radial';
  /** Gradient line in the shape's local space (radial: centre -> edge). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: GradientStop[];
}

export type Paint = string | Gradient;

// ---------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------

export type Effect =
  | { type: 'blur'; enabled: boolean; radius: number }
  | { type: 'glow'; enabled: boolean; radius: number; color: string; strength: number }
  | { type: 'shadow'; enabled: boolean; dx: number; dy: number; radius: number; color: string }
  | {
      type: 'color';
      enabled: boolean;
      brightness: number;
      contrast: number;
      saturation: number;
      hue: number;
    }
  | { type: 'tint'; enabled: boolean; color: string; amount: number };

// ---------------------------------------------------------------------------------------------
// Skinning / meshes
// ---------------------------------------------------------------------------------------------

/**
 * Binds the vertices of a shape or image mesh to bones.
 * Vertex order: for shapes, every PathPoint of every contour in order; for meshes, mesh verts.
 */
export interface Skin {
  bones: ID[];
  /** Per bone: matrix taking a rest vertex (node-local) into that bone's local space. */
  bind: Mat[];
  /** Per vertex: flat [boneIndex, weight, boneIndex, weight, ...]. */
  weights: number[][];
}

/** 2D affine matrix [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Mat = [number, number, number, number, number, number];

export interface Mesh {
  /** Rest vertex positions, node-local, flat [x0, y0, x1, y1, ...]. */
  verts: number[];
  /** Texture coordinates 0..1, flat. */
  uvs: number[];
  /** Triangle vertex indices, flat. */
  tris: number[];
  cols: number;
  rows: number;
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

export interface NodeBase {
  id: ID;
  name: string;
  parent: ID | null;
  children: ID[];
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  opacity: number;
  /** Depth offset relative to the parent (multiplane camera). */
  depth: number;
  /** Paint order inside the nearest sorting ancestor (character or scene). Higher is in front. */
  zOrder: number;
  blend: BlendMode;
  effects: Effect[];
  /** When set, the node only shows while its character is in this view. */
  view?: ViewName;
  /** Free-form tag used by tools and the AI ("mouth", "eye.L", "prop", ...). */
  tag?: string;
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'lighter' | 'darken' | 'lighten';

export interface GroupNode extends NodeBase {
  type: 'group';
}

export interface ShapeNode extends NodeBase {
  type: 'shape';
  path: PathData;
  fill: Paint | null;
  stroke: string | null;
  strokeWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  fillRule: 'nonzero' | 'evenodd';
  skin?: Skin;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  assetId: ID;
  width: number;
  height: number;
  /** Present once the image has been converted to a deformable mesh. */
  mesh?: Mesh;
  skin?: Skin;
}

export interface TextNode extends NodeBase {
  type: 'text';
  text: string;
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
}

export interface BonePose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export interface BoneRest {
  x: number;
  y: number;
  rotation: number;
  length: number;
}

/**
 * A bone. `x/y/rotation` are the REST (setup) transform. Animation never touches the rest
 * transform: keyed channels `x/y/rotation/scaleX/scaleY` on a bone are deltas stored in `pose`
 * and layered on top of the rest. This keeps a rig re-posable from any view.
 */
export interface BoneNode extends NodeBase {
  type: 'bone';
  length: number;
  color?: string;
  pose: BonePose;
  /** Per-view rest overrides for turnaround characters. */
  viewRest?: Partial<Record<ViewName, BoneRest>>;
}

export interface CharacterNode extends NodeBase {
  type: 'character';
  /** Views this character has art for. */
  views: ViewName[];
  /** Current view. Keyable (step) to turn the character during a shot. */
  currentView: ViewName;
  /** Current mouth shape (viseme name). Keyable; every view's mouth switch follows it. */
  mouth: string;
  /** Current eye state ("open", "closed", "happy"). Keyable. */
  eyes: string;
}

/** Shows exactly one child, selected by name. Used for mouths, eyes, hands. */
export interface SwitchNode extends NodeBase {
  type: 'switch';
  active: string;
  /**
   * When set, the switch follows that property of the enclosing character ("mouth", "eyes")
   * instead of its own `active`, so one keyed value drives the matching switch in every view.
   */
  source?: string;
}

export interface StrokePoint {
  x: number;
  y: number;
  /** Pressure 0..1. */
  p: number;
}

export interface Stroke {
  pts: StrokePoint[];
  color: string;
  size: number;
  /** 0 = constant width, 1 = fully pressure driven. */
  thinning: number;
  eraser?: boolean;
  /** Closed filled region instead of a brush line. */
  fill?: boolean;
}

/** Frame-by-frame drawing layer. Each exposure holds until the next keyed frame. */
export interface DrawingNode extends NodeBase {
  type: 'drawing';
  /** frame number (as string key) -> strokes */
  frames: Record<string, Stroke[]>;
}

export interface ParticleConfig {
  preset: string;
  seed: number;
  /** Particles emitted per second. */
  rate: number;
  /** Seconds. */
  life: number;
  lifeJitter: number;
  /** Emitter area in local space. */
  width: number;
  height: number;
  speed: number;
  speedJitter: number;
  /** Degrees, 0 = +x. */
  angle: number;
  spread: number;
  gravityX: number;
  gravityY: number;
  drag: number;
  sizeStart: number;
  sizeEnd: number;
  sizeJitter: number;
  spin: number;
  colorStart: string;
  colorEnd: string;
  alphaStart: number;
  alphaEnd: number;
  shape: 'circle' | 'square' | 'streak' | 'star' | 'flake';
  /** Simulate this many seconds before frame 0 so the effect starts full. */
  prewarm: number;
  maxParticles: number;
}

export interface ParticlesNode extends NodeBase {
  type: 'particles';
  config: ParticleConfig;
}

export type SceneNode =
  | GroupNode
  | ShapeNode
  | ImageNode
  | TextNode
  | BoneNode
  | CharacterNode
  | SwitchNode
  | DrawingNode
  | ParticlesNode;

export type NodeType = SceneNode['type'];

export type NodeOfType<T extends NodeType> = Extract<SceneNode, { type: T }>;
