import type { ActionClip, Ease, KeyValue, Track, ViewName } from '../types';

/**
 * Built-in action clips for the standard skeleton (see spec.ts). Bone channels are pose deltas, so
 * a clip works on any character built from a CharacterSpec, whatever its proportions.
 *
 * Rotation sign reminder (degrees, clockwise on screen): for a limb hanging down in a view that
 * faces screen-right, a NEGATIVE delta swings it forward.
 *
 * A character can be shown from five angles, and a 2D pose only reads correctly from the angle it
 * was drawn for, so clips carry a version per view where one is needed (see `viewTracks`).
 */

type Key = [frame: number, value: KeyValue, ease?: Ease];

function track(keys: Key[], ease: Ease = 'easeInOut'): Track {
  return { keys: keys.map(([f, v, e]) => ({ f, v, e: e ?? ease })) };
}

type Tracks = Record<string, Record<string, Key[]>>;

function build(tracks: Tracks, ease: Ease): ActionClip['tracks'] {
  const out: ActionClip['tracks'] = {};
  for (const node in tracks) {
    out[node] = {};
    for (const prop in tracks[node]) out[node][prop] = track(tracks[node][prop], ease);
  }
  return out;
}

function clip(
  id: string, name: string, category: string, duration: number, views: ViewName[], loop: boolean,
  tracks: Tracks, variants: Partial<Record<ViewName, Tracks>> = {}, ease: Ease = 'easeInOut',
): ActionClip {
  const out: ActionClip = { id: `builtin_${id}`, name, category, duration, fps: 24, loop, views, tracks: build(tracks, ease) };
  const names = Object.keys(variants) as ViewName[];
  if (names.length) out.viewTracks = Object.fromEntries(names.map((v) => [v, build(variants[v]!, ease)]));
  return out;
}

const mapKeys = (keys: Key[], f: (v: number) => number): Key[] => keys.map(([frame, v, e]) => [frame, typeof v === 'number' ? f(v) : v, e]);
const ARM = /^(clavicle|upperArm|lowerArm|hand|fingers|thumb)\./;

/**
 * A clip drawn for a character facing the viewer, as seen from behind: left and right swap sides
 * on screen, so every turn and sideways shift reverses.
 */
function fromBehind(t: Tracks): Tracks {
  const out: Tracks = {};
  for (const node in t) {
    out[node] = {};
    for (const prop in t[node]) out[node][prop] = prop === 'rotation' || prop === 'x' ? mapKeys(t[node][prop], (v) => -v) : t[node][prop];
  }
  return out;
}

/**
 * A clip drawn for a character facing the viewer, as seen in profile (facing screen-right): arms
 * that were raised out to the side are raised forward instead, and sideways tilts of the body,
 * which a profile cannot show, are dropped.
 */
function inProfile(t: Tracks): Tracks {
  const out: Tracks = {};
  for (const node in t) {
    out[node] = {};
    const arm = ARM.test(node);
    const right = node.endsWith('.R');
    for (const prop in t[node]) {
      const keys = t[node][prop];
      if (prop === 'x') continue;
      if (prop !== 'rotation' || node === '@') out[node][prop] = keys;
      else if (/^(upperArm|lowerArm)\./.test(node)) out[node][prop] = mapKeys(keys, (v) => -Math.abs(v));
      else if (arm) out[node][prop] = right ? mapKeys(keys, (v) => -v) : keys;
    }
    if (!Object.keys(out[node]).length) delete out[node];
  }
  return out;
}

/** Every view for a clip drawn facing the viewer. */
const facingViews = (t: Tracks): Partial<Record<ViewName, Tracks>> => ({ side: inProfile(t), backThreeQuarter: fromBehind(t), back: fromBehind(t) });

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

const FLAT: ViewName[] = ['front', 'back'];

/** Walking toward or away from the viewer: the legs cannot swing sideways, so they shorten as the knees lift. */
function walkToward(dur: number, k: number, bob: number): Tracks {
  const q = dur / 4;
  const lift = Math.max(0.6, 1 - 0.16 * k);
  const leg = (start: number): Key[] => phase([[0, 1], [q, lift], [2 * q, 1], [dur, 1]], start, dur);
  const reach = (start: number): Key[] => phase([[0, 1], [q, Math.max(0.75, 1 - 0.1 * k)], [2 * q, 1], [dur, 1]], start, dur);
  return {
    hips: { y: [[0, 0], [q, -bob], [2 * q, 0], [3 * q, -bob], [dur, 0]], rotation: [[0, -1.5 * k], [2 * q, 1.5 * k], [dur, -1.5 * k]] },
    chest: { rotation: [[0, 2.5 * k], [2 * q, -2.5 * k], [dur, 2.5 * k]] },
    'upperLeg.L': { scaleX: leg(0) },
    'upperLeg.R': { scaleX: leg(2 * q) },
    'upperArm.L': { rotation: [[0, 4 * k], [2 * q, -4 * k], [dur, 4 * k]], scaleX: reach(2 * q) },
    'upperArm.R': { rotation: [[0, 4 * k], [2 * q, -4 * k], [dur, 4 * k]], scaleX: reach(0) },
  };
}

function walkCycle(id: string, name: string, dur: number, k: number, lean: number, bob: number): ActionClip {
  const s = dur / 24;
  const F = (f: number) => Math.round(f * s * 100) / 100;
  const upper: Key[] = [[0, -25 * k], [F(3), -18 * k], [F(6), 0], [F(9), 12 * k], [F(12), 22 * k], [F(15), 8 * k], [F(18), -14 * k], [F(21), -28 * k], [dur, -25 * k]];
  const lower: Key[] = [[0, 5], [F(3), 16 * k], [F(6), 5], [F(9), 5], [F(12), 16 * k], [F(15), 58 * k], [F(18), 62 * k], [F(21), 24 * k], [dur, 5]];
  const foot: Key[] = [[0, -16], [F(3), 0], [F(9), 4], [F(12), 22], [F(15), 30], [F(18), 8], [F(21), -12], [dur, -16]];
  // The toes stay flat on the ground while the heel peels off, then follow the foot through the swing.
  const toes: Key[] = [[0, 0], [F(9), -3], [F(12), -20], [F(15), -26], [F(18), -6], [F(21), 0], [dur, 0]];
  const arm: Key[] = [[0, 24 * k], [F(12), -24 * k], [dur, 24 * k]];
  const fore: Key[] = [[0, -8 * k], [F(12), -34 * k], [dur, -8 * k]];
  const half = dur / 2;
  const lin = (keys: Key[]): Key[] => keys.map(([f, v]) => [f, v, 'linear']);
  const toward = walkToward(dur, k, bob * 0.9);
  return clip(id, name, 'Locomotion', dur, [], true, {
    hips: { y: [[0, 0], [F(3), bob], [F(9), -bob * 0.7], [F(12), 0], [F(15), bob], [F(21), -bob * 0.7], [dur, 0]] },
    torso: { rotation: [[0, lean - 1.5], [F(6), lean + 1.5], [F(12), lean - 1.5], [F(18), lean + 1.5], [dur, lean - 1.5]] },
    head: { rotation: [[0, -lean * 0.5 + 1], [F(6), -lean * 0.5 - 1], [F(12), -lean * 0.5 + 1], [F(18), -lean * 0.5 - 1], [dur, -lean * 0.5 + 1]] },
    'upperLeg.R': { rotation: lin(upper) },
    'lowerLeg.R': { rotation: lin(lower) },
    'foot.R': { rotation: lin(foot) },
    'toes.R': { rotation: lin(toes) },
    'upperLeg.L': { rotation: phase(lin(upper), half, dur) },
    'lowerLeg.L': { rotation: phase(lin(lower), half, dur) },
    'foot.L': { rotation: phase(lin(foot), half, dur) },
    'toes.L': { rotation: phase(lin(toes), half, dur) },
    'upperArm.R': { rotation: arm },
    'lowerArm.R': { rotation: fore },
    'upperArm.L': { rotation: phase(arm, half, dur) },
    'lowerArm.L': { rotation: phase(fore, half, dur) },
  }, { front: toward, back: fromBehind(toward) });
}

/**
 * The built-in library. Every clip plays correctly from all five views: clips drawn in profile
 * carry a version for facing toward or away from the viewer, and clips drawn facing the viewer
 * carry profile and from-behind versions.
 */
export function builtinActions(): ActionClip[] {
  const stepLeg = (start: number): Key[] => phase([[0, 1], [6, 0.84], [12, 1], [24, 1]], start, 24);

  const idle: Tracks = {
    torso: { scaleX: [[0, 1], [24, 1.014], [48, 1]] },
    chest: { scaleX: [[0, 1], [24, 1.02], [48, 1]] },
    head: { rotation: [[0, 0], [24, 1.6], [48, 0]] },
    'upperArm.L': { rotation: [[0, 0], [24, -2.5], [48, 0]] },
    'upperArm.R': { rotation: [[0, 0], [24, 2.5], [48, 0]] },
  };
  const wave: Tracks = {
    'upperArm.R': { rotation: [[0, 0], [10, 132], [38, 132], [48, 0]] },
    'lowerArm.R': { rotation: [[0, 0], [10, 30], [15, 62], [20, 26], [25, 62], [30, 26], [35, 52], [48, 0]] },
    'hand.R': { rotation: [[0, 0], [10, 8], [15, 16], [20, -4], [25, 16], [30, -4], [48, 0]] },
    'fingers.R': { rotation: [[0, 0], [10, -6], [15, 10], [20, -8], [25, 10], [30, -8], [38, 0], [48, 0]] },
    'thumb.R': { rotation: [[0, 0], [10, -22], [38, -22], [48, 0]] },
    head: { rotation: [[0, 0], [10, -4], [38, -4], [48, 0]] },
  };
  const cheer: Tracks = {
    'upperArm.R': { rotation: [[0, 0], [8, 150, [0.34, 1.56, 0.64, 1]], [28, 150], [36, 0]] },
    'upperArm.L': { rotation: [[0, 0], [8, -150, [0.34, 1.56, 0.64, 1]], [28, -150], [36, 0]] },
    'lowerArm.R': { rotation: [[0, 0], [8, 18], [14, -8], [20, 18], [36, 0]] },
    'lowerArm.L': { rotation: [[0, 0], [8, -18], [14, 8], [20, -18], [36, 0]] },
    'fingers.R': { rotation: [[0, 0], [8, -12], [28, -12], [36, 0]] },
    'fingers.L': { rotation: [[0, 0], [8, 12], [28, 12], [36, 0]] },
    hips: { y: [[0, 0], [5, 12], [10, -34], [16, 0], [21, -22], [27, 0], [36, 0]] },
    '@': { eyes: [[0, 'open', 'step'], [8, 'happy', 'step'], [30, 'open', 'step']], mouth: [[0, 'rest', 'step'], [8, 'AI', 'step'], [30, 'rest', 'step']] },
  };
  // The collarbones lift the shoulders; the forearms turn out, palms up.
  const shrug: Tracks = {
    'clavicle.R': { rotation: [[0, 0], [8, 16], [20, 16], [30, 0]] },
    'clavicle.L': { rotation: [[0, 0], [8, -16], [20, -16], [30, 0]] },
    'upperArm.R': { rotation: [[0, 0], [8, 8], [20, 8], [30, 0]] },
    'upperArm.L': { rotation: [[0, 0], [8, -8], [20, -8], [30, 0]] },
    'lowerArm.R': { rotation: [[0, 0], [8, -70], [20, -70], [30, 0]] },
    'lowerArm.L': { rotation: [[0, 0], [8, 70], [20, 70], [30, 0]] },
    head: { rotation: [[0, 0], [8, 6], [20, 6], [30, 0]] },
  };
  const talk: Tracks = {
    head: { rotation: [[0, 0], [8, 3], [16, -2], [26, 2.5], [36, -1.5], [48, 0]] },
    chest: { rotation: [[0, 0], [12, 1.2], [30, -1], [48, 0]] },
    'lowerArm.R': { rotation: [[0, 0], [10, -22], [22, -10], [34, -26], [48, 0]] },
    'lowerArm.L': { rotation: [[0, 0], [14, 14], [28, 4], [40, 16], [48, 0]] },
    'fingers.R': { rotation: [[0, 0], [10, 10], [22, 2], [34, 12], [48, 0]] },
  };
  const jumpArc: Key[] = [[0, 0], [7, 42], [10, -30, 'easeOut'], [16, -190], [22, -20, 'easeIn'], [25, 40, 'easeOut'], [30, 0]];
  const crouch: Key[] = [[0, 1], [7, 0.76], [11, 1], [16, 0.9], [22, 1], [25, 0.78], [30, 1]];
  const jumpToward: Tracks = {
    hips: { y: jumpArc },
    'upperLeg.R': { scaleX: crouch },
    'upperLeg.L': { scaleX: crouch },
    'lowerLeg.R': { scaleX: crouch },
    'lowerLeg.L': { scaleX: crouch },
    'upperArm.R': { rotation: [[0, 0], [7, -18], [12, 150], [20, 112], [25, -12], [30, 0]] },
    'upperArm.L': { rotation: [[0, 0], [7, 18], [12, -150], [20, -112], [25, 12], [30, 0]] },
  };
  const nodToward: Tracks = {
    head: { y: [[0, 0], [5, 7], [10, -1], [15, 6], [24, 0]], scaleX: [[0, 1], [5, 0.94], [10, 1], [15, 0.95], [24, 1]] },
  };

  return [
    clip('idle', 'Idle (breathing)', 'Basics', 48, [], true, idle, { backThreeQuarter: fromBehind(idle), back: fromBehind(idle) }),
    clip('blink', 'Blink', 'Face', 72, [], true, {
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
    clip('wave', 'Wave', 'Gestures', 48, [], false, wave, facingViews(wave)),
    clip('cheer', 'Cheer', 'Gestures', 36, [], false, cheer, facingViews(cheer)),
    clip('shrug', 'Shrug', 'Gestures', 30, [], false, shrug, facingViews(shrug)),
    clip('talk', 'Talk (body language)', 'Gestures', 48, [], true, talk, { backThreeQuarter: fromBehind(talk), back: fromBehind(talk) }),
    clip('nod', 'Nod', 'Gestures', 24, [], false, {
      head: { rotation: [[0, 0], [5, 14], [10, -3], [15, 12], [24, 0]] },
    }, { front: nodToward, back: nodToward }),
    clip('jump', 'Jump', 'Locomotion', 30, [], false, {
      hips: { y: jumpArc },
      torso: { rotation: [[0, 0], [7, 16], [12, -6], [22, 4], [25, 14], [30, 0]] },
      'upperLeg.R': { rotation: [[0, 0], [7, -52], [11, 6], [16, -30], [22, -8], [25, -46], [30, 0]] },
      'upperLeg.L': { rotation: [[0, 0], [7, -52], [11, 6], [16, -22], [22, -8], [25, -46], [30, 0]] },
      'lowerLeg.R': { rotation: [[0, 0], [7, 96], [11, 4], [16, 60], [22, 8], [25, 86], [30, 0]] },
      'lowerLeg.L': { rotation: [[0, 0], [7, 96], [11, 4], [16, 48], [22, 8], [25, 86], [30, 0]] },
      'foot.R': { rotation: [[0, 0], [7, -42], [11, 34], [16, 20], [22, -6], [25, -38], [30, 0]] },
      'foot.L': { rotation: [[0, 0], [7, -42], [11, 34], [16, 20], [22, -6], [25, -38], [30, 0]] },
      'toes.R': { rotation: [[0, 0], [9, -30], [11, 0], [30, 0]] },
      'toes.L': { rotation: [[0, 0], [9, -30], [11, 0], [30, 0]] },
      'upperArm.R': { rotation: [[0, 0], [7, 46], [12, -150], [20, -110], [25, 20], [30, 0]] },
      'upperArm.L': { rotation: [[0, 0], [7, 46], [12, -150], [20, -110], [25, 20], [30, 0]] },
    }, { front: jumpToward, back: fromBehind(jumpToward) }),
    clip('surprise', 'Surprised', 'Face', 30, [], false, {
      '@': { mouth: [[0, 'rest', 'step'], [3, 'O', 'step'], [24, 'rest', 'step']] },
      head: { rotation: [[0, 0], [4, -6, [0.34, 1.56, 0.64, 1]], [24, -4], [30, 0]], y: [[0, 0], [4, -8], [24, -6], [30, 0]] },
    }),
  ];
}

/** Whether a clip is intended for the given view (clips with no views work everywhere). */
export function actionFitsView(clipDef: ActionClip, view: ViewName): boolean {
  return clipDef.views.length === 0 || clipDef.views.includes(view);
}
