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

/**
 * The standard skeleton. Besides the main chain it has a chest above the waist, collarbones for
 * shrugging, separate fingers and thumbs, bending toes, and a hair bone for secondary motion.
 * Parents always come before their children in this list.
 */
export const BONE_NAMES = [
  'root', 'hips', 'torso', 'chest', 'neck', 'head', 'hair',
  'clavicle.L', 'upperArm.L', 'lowerArm.L', 'hand.L', 'fingers.L', 'thumb.L',
  'clavicle.R', 'upperArm.R', 'lowerArm.R', 'hand.R', 'fingers.R', 'thumb.R',
  'upperLeg.L', 'lowerLeg.L', 'foot.L', 'toes.L', 'upperLeg.R', 'lowerLeg.R', 'foot.R', 'toes.R',
] as const;
export type BoneName = (typeof BONE_NAMES)[number];

/** Landmarks every view must supply. */
export const CORE_JOINT_NAMES = [
  'hips', 'waist', 'neck', 'head', 'headTop',
  'shoulder.L', 'elbow.L', 'wrist.L', 'handTip.L', 'shoulder.R', 'elbow.R', 'wrist.R', 'handTip.R',
  'hip.L', 'knee.L', 'ankle.L', 'toe.L', 'hip.R', 'knee.R', 'ankle.R', 'toe.R',
] as const;
export type CoreJointName = (typeof CORE_JOINT_NAMES)[number];

/** Finer landmarks. A view may supply them; any it leaves out are placed from the core ones. */
export const EXTRA_JOINT_NAMES = [
  'chest', 'hairRoot', 'hairTip',
  'collar.L', 'knuckle.L', 'thumbBase.L', 'thumbTip.L', 'ball.L',
  'collar.R', 'knuckle.R', 'thumbBase.R', 'thumbTip.R', 'ball.R',
] as const;
export type ExtraJointName = (typeof EXTRA_JOINT_NAMES)[number];

export const JOINT_NAMES = [...CORE_JOINT_NAMES, ...EXTRA_JOINT_NAMES] as const;
export type JointName = (typeof JOINT_NAMES)[number];

type Point = [number, number];
export type ViewJoints = Record<CoreJointName, Point> & Partial<Record<ExtraJointName, Point>>;

/** Each bone runs from its first joint to its second, and hangs off `parent`. */
export const BONE_DEFS: Record<Exclude<BoneName, 'root'>, { from: JointName; to: JointName; parent: BoneName }> = {
  hips: { from: 'hips', to: 'waist', parent: 'root' },
  torso: { from: 'waist', to: 'chest', parent: 'hips' },
  chest: { from: 'chest', to: 'neck', parent: 'torso' },
  neck: { from: 'neck', to: 'head', parent: 'chest' },
  head: { from: 'head', to: 'headTop', parent: 'neck' },
  hair: { from: 'hairRoot', to: 'hairTip', parent: 'head' },
  'clavicle.L': { from: 'collar.L', to: 'shoulder.L', parent: 'chest' },
  'upperArm.L': { from: 'shoulder.L', to: 'elbow.L', parent: 'clavicle.L' },
  'lowerArm.L': { from: 'elbow.L', to: 'wrist.L', parent: 'upperArm.L' },
  'hand.L': { from: 'wrist.L', to: 'knuckle.L', parent: 'lowerArm.L' },
  'fingers.L': { from: 'knuckle.L', to: 'handTip.L', parent: 'hand.L' },
  'thumb.L': { from: 'thumbBase.L', to: 'thumbTip.L', parent: 'hand.L' },
  'clavicle.R': { from: 'collar.R', to: 'shoulder.R', parent: 'chest' },
  'upperArm.R': { from: 'shoulder.R', to: 'elbow.R', parent: 'clavicle.R' },
  'lowerArm.R': { from: 'elbow.R', to: 'wrist.R', parent: 'upperArm.R' },
  'hand.R': { from: 'wrist.R', to: 'knuckle.R', parent: 'lowerArm.R' },
  'fingers.R': { from: 'knuckle.R', to: 'handTip.R', parent: 'hand.R' },
  'thumb.R': { from: 'thumbBase.R', to: 'thumbTip.R', parent: 'hand.R' },
  'upperLeg.L': { from: 'hip.L', to: 'knee.L', parent: 'hips' },
  'lowerLeg.L': { from: 'knee.L', to: 'ankle.L', parent: 'upperLeg.L' },
  'foot.L': { from: 'ankle.L', to: 'ball.L', parent: 'lowerLeg.L' },
  'toes.L': { from: 'ball.L', to: 'toe.L', parent: 'foot.L' },
  'upperLeg.R': { from: 'hip.R', to: 'knee.R', parent: 'hips' },
  'lowerLeg.R': { from: 'knee.R', to: 'ankle.R', parent: 'upperLeg.R' },
  'foot.R': { from: 'ankle.R', to: 'ball.R', parent: 'lowerLeg.R' },
  'toes.R': { from: 'ball.R', to: 'toe.R', parent: 'foot.R' },
};

/**
 * Returns a full set of landmarks for a view: the ones it supplies, plus any finer landmark it
 * left out, placed from the core landmarks. Throws if a core landmark is missing.
 */
export function completeJoints(joints: ViewJoints): Record<JointName, Point> {
  for (const name of CORE_JOINT_NAMES) {
    const p = joints[name];
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error(`Character view is missing joint "${name}"`);
  }
  const out = { ...joints } as Record<JointName, Point>;
  const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const ok = (p: Point | undefined): p is Point => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const fill = (name: ExtraJointName, make: () => Point) => {
    if (!ok(joints[name])) out[name] = make();
  };
  // Which way the character faces on screen, read from the feet: 0 when it faces the viewer or away.
  const reach = (joints['toe.L'][0] - joints['ankle.L'][0] + joints['toe.R'][0] - joints['ankle.R'][0]) / 2;
  const head = Math.hypot(joints.headTop[0] - joints.head[0], joints.headTop[1] - joints.head[1]);
  const facing = Math.abs(reach) > head * 0.12 ? Math.sign(reach) : 0;

  fill('chest', () => lerp(joints.waist, joints.neck, 0.5));
  fill('hairRoot', () => lerp(joints.head, joints.headTop, 0.9));
  fill('hairTip', () => [out.hairRoot[0] - facing * head * 0.3, out.hairRoot[1] + head * 0.8]);
  for (const s of ['L', 'R'] as const) {
    const wrist = joints[`wrist.${s}`];
    const tip = joints[`handTip.${s}`];
    fill(`collar.${s}`, () => lerp(joints.neck, joints[`shoulder.${s}`], 0.3));
    fill(`knuckle.${s}`, () => lerp(wrist, tip, 0.5));
    fill(`thumbBase.${s}`, () => lerp(wrist, tip, 0.2));
    fill(`thumbTip.${s}`, () => {
      // The thumb points forward when the character is seen from the side, otherwise toward the body.
      const along: Point = [tip[0] - wrist[0], tip[1] - wrist[1]];
      const len = Math.hypot(along[0], along[1]);
      const toward = facing || Math.sign(joints.hips[0] - wrist[0]) || (s === 'L' ? -1 : 1);
      const base = out[`thumbBase.${s}`];
      return [base[0] + along[0] * 0.3 + toward * len * 0.45, base[1] + along[1] * 0.3];
    });
    fill(`ball.${s}`, () => lerp(joints[`ankle.${s}`], joints[`toe.${s}`], 0.6));
  }
  return out;
}

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
  joints: ViewJoints;
  parts: PartSpec[];
  face?: FaceSpec;
}

export interface CharacterSpec {
  name: string;
  /** Height the built character should have in project pixels. */
  height?: number;
  views: Partial<Record<ViewName, ViewSpec>>;
}
