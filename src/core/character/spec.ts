import type { ViewName } from '../types';

/**
 * The "raw code" form of a character: for every view, a set of skeleton landmarks plus vector
 * parts, each assigned to a bone. This is what the Character Creator's AI conversion produces and
 * what the procedural generator emits; `buildCharacter` turns it into a rigged scene hierarchy.
 *
 * Coordinates are in the view's own image space (pixels, y down). The builder normalises scale
 * and origin, so views do not need to share a size.
 *
 * Left/right are the CHARACTER's left and right (anatomical), not the viewer's.
 */

export const BONE_NAMES = [
  'root', 'hips', 'torso', 'neck', 'head',
  'upperArm.L', 'lowerArm.L', 'hand.L', 'upperArm.R', 'lowerArm.R', 'hand.R',
  'upperLeg.L', 'lowerLeg.L', 'foot.L', 'upperLeg.R', 'lowerLeg.R', 'foot.R',
] as const;
export type BoneName = (typeof BONE_NAMES)[number];

export const JOINT_NAMES = [
  'hips', 'waist', 'neck', 'head', 'headTop',
  'shoulder.L', 'elbow.L', 'wrist.L', 'handTip.L', 'shoulder.R', 'elbow.R', 'wrist.R', 'handTip.R',
  'hip.L', 'knee.L', 'ankle.L', 'toe.L', 'hip.R', 'knee.R', 'ankle.R', 'toe.R',
] as const;
export type JointName = (typeof JOINT_NAMES)[number];

/** Each bone runs from its first joint to its second, and hangs off `parent`. */
export const BONE_DEFS: Record<Exclude<BoneName, 'root'>, { from: JointName; to: JointName; parent: BoneName }> = {
  hips: { from: 'hips', to: 'waist', parent: 'root' },
  torso: { from: 'waist', to: 'neck', parent: 'hips' },
  neck: { from: 'neck', to: 'head', parent: 'torso' },
  head: { from: 'head', to: 'headTop', parent: 'neck' },
  'upperArm.L': { from: 'shoulder.L', to: 'elbow.L', parent: 'torso' },
  'lowerArm.L': { from: 'elbow.L', to: 'wrist.L', parent: 'upperArm.L' },
  'hand.L': { from: 'wrist.L', to: 'handTip.L', parent: 'lowerArm.L' },
  'upperArm.R': { from: 'shoulder.R', to: 'elbow.R', parent: 'torso' },
  'lowerArm.R': { from: 'elbow.R', to: 'wrist.R', parent: 'upperArm.R' },
  'hand.R': { from: 'wrist.R', to: 'handTip.R', parent: 'lowerArm.R' },
  'upperLeg.L': { from: 'hip.L', to: 'knee.L', parent: 'hips' },
  'lowerLeg.L': { from: 'knee.L', to: 'ankle.L', parent: 'upperLeg.L' },
  'foot.L': { from: 'ankle.L', to: 'toe.L', parent: 'lowerLeg.L' },
  'upperLeg.R': { from: 'hip.R', to: 'knee.R', parent: 'hips' },
  'lowerLeg.R': { from: 'knee.R', to: 'ankle.R', parent: 'upperLeg.R' },
  'foot.R': { from: 'ankle.R', to: 'toe.R', parent: 'lowerLeg.R' },
};

/** Mouth shapes used for lip-sync. `rest` is the neutral closed mouth. */
export const VISEMES = ['rest', 'MBP', 'AI', 'E', 'O', 'U', 'FV', 'L', 'WQ', 'etc'] as const;
export type Viseme = (typeof VISEMES)[number];

export interface PartPath {
  /** SVG path data in view coordinates. */
  d: string;
  fill: string | null;
  stroke?: string | null;
  strokeWidth?: number;
}

export interface PartSpec {
  /** Unique within the view, e.g. "torso", "hairBack", "upperArm.L". */
  name: string;
  /** Bone the part follows. */
  bone: BoneName;
  /** Paint order within the character; higher is in front. */
  z: number;
  paths: PartPath[];
}

export interface FaceSpec {
  /** Open-eye artwork per eye; closed lids are generated from their bounds. */
  eyes: { name: string; z: number; paths: PartPath[] }[];
  /** Mouth centre and width in view coordinates; visemes are generated to fit. */
  mouth: { cx: number; cy: number; width: number; z: number; restPaths?: PartPath[] } | null;
  /** Fraction of the full mouth width visible in this view (1 = facing camera, ~0.5 = profile). */
  mouthScale?: number;
  lipColor?: string;
  lineColor?: string;
}

export interface ViewSpec {
  joints: Record<JointName, [number, number]>;
  parts: PartSpec[];
  face?: FaceSpec;
}

export interface CharacterSpec {
  name: string;
  /** Height the built character should have in project pixels. */
  height?: number;
  views: Partial<Record<ViewName, ViewSpec>>;
}
