import type { ActionClip, Ease, KeyValue, Track, ViewName } from '../types';

/**
 * Built-in action clips for the standard skeleton (see spec.ts). Bone channels are pose deltas, so
 * a clip works on any character built from a CharacterSpec, whatever its proportions.
 *
 * Rotation sign reminder (degrees, clockwise on screen): for a limb hanging down in a view that
 * faces screen-right, a NEGATIVE delta swings it forward.
 */

type Key = [frame: number, value: KeyValue, ease?: Ease];

function track(keys: Key[], ease: Ease = 'easeInOut'): Track {
  return { keys: keys.map(([f, v, e]) => ({ f, v, e: e ?? ease })) };
}

function clip(
  id: string, name: string, category: string, duration: number, views: ViewName[], loop: boolean,
  tracks: Record<string, Record<string, Key[]>>, ease: Ease = 'easeInOut',
): ActionClip {
  const out: ActionClip['tracks'] = {};
  for (const node in tracks) {
    out[node] = {};
    for (const prop in tracks[node]) out[node][prop] = track(tracks[node][prop], ease);
  }
  return { id: `builtin_${id}`, name, category, duration, fps: 24, loop, views, tracks: out };
}

/** Shifts a looping key list by `offset` frames, wrapping at `duration`. */
function phase(keys: Key[], offset: number, duration: number): Key[] {
  const body = keys.filter(([f]) => f < duration);
  const shifted = body.map(([f, v, e]) => [(f + offset) % duration, v, e] as Key).sort((a, b) => a[0] - b[0]);
  // Close the loop: the value at `duration` equals the value at 0.
  if (shifted[0][0] === 0) shifted.push([duration, shifted[0][1], shifted[0][2]]);
  else {
    const last = shifted[shifted.length - 1];
    const first = shifted[0];
    const span = duration - last[0] + first[0];
    const t = (duration - last[0]) / span;
    const wrap = typeof last[1] === 'number' && typeof first[1] === 'number' ? last[1] + (first[1] - last[1]) * t : first[1];
    shifted.unshift([0, wrap, 'linear']);
    shifted.push([duration, wrap, 'linear']);
  }
  return shifted;
}

const SIDE: ViewName[] = ['side', 'threeQuarter', 'backThreeQuarter'];
const FACING: ViewName[] = ['front', 'threeQuarter'];
const FLAT: ViewName[] = ['front', 'back'];

function walkCycle(id: string, name: string, dur: number, k: number, lean: number, bob: number): ActionClip {
  const s = dur / 24;
  const F = (f: number) => Math.round(f * s * 100) / 100;
  const upper: Key[] = [[0, -25 * k], [F(3), -18 * k], [F(6), 0], [F(9), 12 * k], [F(12), 22 * k], [F(15), 8 * k], [F(18), -14 * k], [F(21), -28 * k], [dur, -25 * k]];
  const lower: Key[] = [[0, 5], [F(3), 16 * k], [F(6), 5], [F(9), 5], [F(12), 16 * k], [F(15), 58 * k], [F(18), 62 * k], [F(21), 24 * k], [dur, 5]];
  const foot: Key[] = [[0, -16], [F(3), 0], [F(9), 4], [F(12), 22], [F(15), 30], [F(18), 8], [F(21), -12], [dur, -16]];
  const arm: Key[] = [[0, 24 * k], [F(12), -24 * k], [dur, 24 * k]];
  const fore: Key[] = [[0, -8 * k], [F(12), -34 * k], [dur, -8 * k]];
  const half = dur / 2;
  const lin = (keys: Key[]): Key[] => keys.map(([f, v]) => [f, v, 'linear']);
  return clip(id, name, 'Locomotion', dur, SIDE, true, {
    hips: { y: [[0, 0], [F(3), bob], [F(9), -bob * 0.7], [F(12), 0], [F(15), bob], [F(21), -bob * 0.7], [dur, 0]] },
    torso: { rotation: [[0, lean - 1.5], [F(6), lean + 1.5], [F(12), lean - 1.5], [F(18), lean + 1.5], [dur, lean - 1.5]] },
    head: { rotation: [[0, -lean * 0.5 + 1], [F(6), -lean * 0.5 - 1], [F(12), -lean * 0.5 + 1], [F(18), -lean * 0.5 - 1], [dur, -lean * 0.5 + 1]] },
    'upperLeg.R': { rotation: lin(upper) },
    'lowerLeg.R': { rotation: lin(lower) },
    'foot.R': { rotation: lin(foot) },
    'upperLeg.L': { rotation: phase(lin(upper), half, dur) },
    'lowerLeg.L': { rotation: phase(lin(lower), half, dur) },
    'foot.L': { rotation: phase(lin(foot), half, dur) },
    'upperArm.R': { rotation: arm },
    'lowerArm.R': { rotation: fore },
    'upperArm.L': { rotation: phase(arm, half, dur) },
    'lowerArm.L': { rotation: phase(fore, half, dur) },
  });
}

export function builtinActions(): ActionClip[] {
  const stepLeg = (start: number): Key[] => phase([[0, 1], [6, 0.84], [12, 1], [24, 1]], start, 24);
  return [
    clip('idle', 'Idle (breathing)', 'Basics', 48, [], true, {
      torso: { scaleX: [[0, 1], [24, 1.014], [48, 1]] },
      head: { rotation: [[0, 0], [24, 1.6], [48, 0]] },
      'upperArm.L': { rotation: [[0, 0], [24, -2.5], [48, 0]] },
      'upperArm.R': { rotation: [[0, 0], [24, 2.5], [48, 0]] },
    }),
    clip('blink', 'Blink', 'Face', 72, ['front', 'threeQuarter', 'side'], true, {
      '@': { eyes: [[0, 'open', 'step'], [60, 'closed', 'step'], [63, 'open', 'step'], [72, 'open', 'step']] },
    }),
    walkCycle('walk', 'Walk', 24, 1, 3, 7),
    walkCycle('run', 'Run', 14, 1.55, 11, 12),
    walkCycle('sneak', 'Sneak', 36, 0.8, 14, 4),
    clip('walk_front', 'Walk in place (front/back)', 'Locomotion', 24, FLAT, true, {
      hips: { y: [[0, 0], [6, -7], [12, 0], [18, -7], [24, 0]], rotation: [[0, -1.5], [12, 1.5], [24, -1.5]] },
      torso: { rotation: [[0, 2], [12, -2], [24, 2]] },
      'upperLeg.L': { scaleX: stepLeg(0) },
      'upperLeg.R': { scaleX: stepLeg(12) },
      'upperArm.L': { rotation: [[0, 5], [12, -5], [24, 5]] },
      'upperArm.R': { rotation: [[0, 5], [12, -5], [24, 5]] },
    }),
    clip('wave', 'Wave', 'Gestures', 48, FACING, false, {
      'upperArm.R': { rotation: [[0, 0], [10, 132], [38, 132], [48, 0]] },
      'lowerArm.R': { rotation: [[0, 0], [10, 30], [15, 62], [20, 26], [25, 62], [30, 26], [35, 52], [48, 0]] },
      'hand.R': { rotation: [[0, 0], [10, 8], [15, 16], [20, -4], [25, 16], [30, -4], [48, 0]] },
      head: { rotation: [[0, 0], [10, -4], [38, -4], [48, 0]] },
    }),
    clip('cheer', 'Cheer', 'Gestures', 36, FLAT, false, {
      'upperArm.R': { rotation: [[0, 0], [8, 150, [0.34, 1.56, 0.64, 1]], [28, 150], [36, 0]] },
      'upperArm.L': { rotation: [[0, 0], [8, -150, [0.34, 1.56, 0.64, 1]], [28, -150], [36, 0]] },
      'lowerArm.R': { rotation: [[0, 0], [8, 18], [14, -8], [20, 18], [36, 0]] },
      'lowerArm.L': { rotation: [[0, 0], [8, -18], [14, 8], [20, -18], [36, 0]] },
      hips: { y: [[0, 0], [5, 12], [10, -34], [16, 0], [21, -22], [27, 0], [36, 0]] },
      '@': { eyes: [[0, 'open', 'step'], [8, 'happy', 'step'], [30, 'open', 'step']], mouth: [[0, 'rest', 'step'], [8, 'AI', 'step'], [30, 'rest', 'step']] },
    }),
    clip('shrug', 'Shrug', 'Gestures', 30, FLAT, false, {
      'upperArm.R': { rotation: [[0, 0], [8, 22], [20, 22], [30, 0]], y: [[0, 0], [8, -12], [20, -12], [30, 0]] },
      'upperArm.L': { rotation: [[0, 0], [8, -22], [20, -22], [30, 0]], y: [[0, 0], [8, -12], [20, -12], [30, 0]] },
      'lowerArm.R': { rotation: [[0, 0], [8, -70], [20, -70], [30, 0]] },
      'lowerArm.L': { rotation: [[0, 0], [8, 70], [20, 70], [30, 0]] },
      head: { rotation: [[0, 0], [8, 6], [20, 6], [30, 0]] },
    }),
    clip('talk', 'Talk (body language)', 'Gestures', 48, [], true, {
      head: { rotation: [[0, 0], [8, 3], [16, -2], [26, 2.5], [36, -1.5], [48, 0]] },
      torso: { rotation: [[0, 0], [12, 1.2], [30, -1], [48, 0]] },
      'lowerArm.R': { rotation: [[0, 0], [10, -22], [22, -10], [34, -26], [48, 0]] },
      'lowerArm.L': { rotation: [[0, 0], [14, 14], [28, 4], [40, 16], [48, 0]] },
    }),
    clip('nod', 'Nod', 'Gestures', 24, ['side', 'threeQuarter'], false, {
      head: { rotation: [[0, 0], [5, 14], [10, -3], [15, 12], [24, 0]] },
    }),
    clip('jump', 'Jump', 'Locomotion', 30, SIDE, false, {
      hips: { y: [[0, 0], [7, 42], [10, -30, 'easeOut'], [16, -190], [22, -20, 'easeIn'], [25, 40, 'easeOut'], [30, 0]] },
      torso: { rotation: [[0, 0], [7, 16], [12, -6], [22, 4], [25, 14], [30, 0]] },
      'upperLeg.R': { rotation: [[0, 0], [7, -52], [11, 6], [16, -30], [22, -8], [25, -46], [30, 0]] },
      'upperLeg.L': { rotation: [[0, 0], [7, -52], [11, 6], [16, -22], [22, -8], [25, -46], [30, 0]] },
      'lowerLeg.R': { rotation: [[0, 0], [7, 96], [11, 4], [16, 60], [22, 8], [25, 86], [30, 0]] },
      'lowerLeg.L': { rotation: [[0, 0], [7, 96], [11, 4], [16, 48], [22, 8], [25, 86], [30, 0]] },
      'foot.R': { rotation: [[0, 0], [7, -42], [11, 34], [16, 20], [22, -6], [25, -38], [30, 0]] },
      'foot.L': { rotation: [[0, 0], [7, -42], [11, 34], [16, 20], [22, -6], [25, -38], [30, 0]] },
      'upperArm.R': { rotation: [[0, 0], [7, 46], [12, -150], [20, -110], [25, 20], [30, 0]] },
      'upperArm.L': { rotation: [[0, 0], [7, 46], [12, -150], [20, -110], [25, 20], [30, 0]] },
    }),
    clip('surprise', 'Surprised', 'Face', 30, ['front', 'threeQuarter', 'side'], false, {
      '@': { mouth: [[0, 'rest', 'step'], [3, 'O', 'step'], [24, 'rest', 'step']] },
      head: { rotation: [[0, 0], [4, -6, [0.34, 1.56, 0.64, 1]], [24, -4], [30, 0]], y: [[0, 0], [4, -8], [24, -6], [30, 0]] },
    }),
  ];
}

/** Whether a clip is intended for the given view (clips with no views work everywhere). */
export function actionFitsView(clipDef: ActionClip, view: ViewName): boolean {
  return clipDef.views.length === 0 || clipDef.views.includes(view);
}
