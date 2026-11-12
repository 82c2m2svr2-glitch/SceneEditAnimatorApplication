import { shade } from '../color';
import { pathToSvg, smoothPath } from '../path';
import { VIEW_NAMES, type ViewName } from '../types';
import type { CharacterSpec, FaceSpec, JointName, PartPath, PartSpec, ViewJoints, ViewSpec } from './spec';

export interface HumanoidParams {
  name: string;
  /** Height in project pixels. */
  height: number;
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  shoes: string;
  eyes: string;
  /** Outline colour, or null for a line-less flat look. */
  outline: string | null;
  /** 0.8 slim .. 1.3 stocky. */
  build: number;
  /** 1 = realistic-ish, 1.4 = big cartoon head. */
  headScale: number;
  hairStyle: 'short' | 'long' | 'spiky' | 'bald';
  sleeves: 'short' | 'long';
  views: ViewName[];
}

export const DEFAULT_HUMANOID: HumanoidParams = {
  name: 'Character', height: 600, skin: '#f2c6a0', hair: '#4a2f22', shirt: '#3d7dd8', pants: '#2b3350',
  shoes: '#1d1d24', eyes: '#2a1c14', outline: '#2a1f1f', build: 1, headScale: 1.25, hairStyle: 'short',
  sleeves: 'short', views: [...VIEW_NAMES],
};

const VIEW_ANGLE: Record<ViewName, number> = { front: 0, threeQuarter: 45, side: 90, backThreeQuarter: 135, back: 180 };

type P2 = [number, number];
const U = 1000;

function capsule(a: P2, b: P2, ra: number, rb: number): string {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const f = (v: number) => v.toFixed(1);
  return (
    `M${f(a[0] + nx * ra)} ${f(a[1] + ny * ra)}L${f(b[0] + nx * rb)} ${f(b[1] + ny * rb)}` +
    `A${f(rb)} ${f(rb)} 0 0 0 ${f(b[0] - nx * rb)} ${f(b[1] - ny * rb)}` +
    `L${f(a[0] - nx * ra)} ${f(a[1] - ny * ra)}A${f(ra)} ${f(ra)} 0 0 0 ${f(a[0] + nx * ra)} ${f(a[1] + ny * ra)}Z`
  );
}

const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${(cx - rx).toFixed(1)} ${cy.toFixed(1)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${(cx + rx).toFixed(1)} ${cy.toFixed(1)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${(cx - rx).toFixed(1)} ${cy.toFixed(1)}Z`;

const blob = (pts: P2[], tension = 0.9) => pathToSvg(smoothPath(pts.map(([x, y]) => ({ x, y })), true, tension));

function buildView(view: ViewName, p: HumanoidParams): ViewSpec {
  const th = (VIEW_ANGLE[view] * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const back = cos < -0.2;
  const b = p.build;
  const sw = p.outline ? 5 : 0;
  const ink = (fill: string | null, extra: Partial<PartPath> = {}): Pick<PartPath, 'fill' | 'stroke' | 'strokeWidth'> => ({
    fill, stroke: p.outline, strokeWidth: sw, ...extra,
  });

  // side: +1 = character's left, -1 = right. Screen x of a lateral offset and its nearness.
  const X = (side: number, lateral: number, forward = 0) => (side * lateral * cos + forward * sin) * U;
  const near = (side: number) => -side * sin;

  const hh = 0.17 * p.headScale;
  const y = {
    ankle: -0.045, knee: -0.26, hip: -0.48, hips: -0.5, waist: -0.6, neck: -0.815, headBase: -0.845,
    shoulder: -0.79, elbow: -0.625, wrist: -0.475, handTip: -0.41, chest: -0.7,
  };
  const headTop = y.headBase - hh;

  const joints = {} as ViewJoints & Record<JointName, P2>;
  const J = (name: JointName, x: number, yy: number) => {
    joints[name] = [x, yy * U];
  };
  J('hips', 0, y.hips);
  J('waist', 0, y.waist);
  J('neck', sin * 6, y.neck);
  J('head', sin * 10, y.headBase);
  J('headTop', sin * 12, headTop);
  for (const [s, tag] of [[1, 'L'], [-1, 'R']] as const) {
    J(`shoulder.${tag}`, X(s, 0.105 * b), y.shoulder);
    J(`elbow.${tag}`, X(s, 0.135 * b), y.elbow);
    J(`wrist.${tag}`, X(s, 0.15 * b), y.wrist);
    J(`handTip.${tag}`, X(s, 0.155 * b), y.handTip);
    J(`hip.${tag}`, X(s, 0.05 * b), y.hip);
    J(`knee.${tag}`, X(s, 0.055 * b), y.knee);
    J(`ankle.${tag}`, X(s, 0.055 * b), y.ankle);
    J(`toe.${tag}`, X(s, 0.075 * b, 0.085), 0);
    J(`collar.${tag}`, X(s, 0.03 * b), -0.8);
    J(`knuckle.${tag}`, X(s, 0.153 * b), -0.44);
    J(`thumbBase.${tag}`, X(s, 0.146 * b, 0.014), -0.462);
    J(`thumbTip.${tag}`, X(s, 0.136 * b, 0.05), -0.428);
    J(`ball.${tag}`, X(s, 0.068 * b, 0.05), -0.004);
  }
  J('chest', sin * 3, y.chest);
  J('hairRoot', sin * 12, headTop + 0.02);
  J('hairTip', X(1, 0, -0.075), y.headBase + 0.03);

  const parts: PartSpec[] = [];
  const armZ = (s: number) => (near(s) > 0.2 ? 22 : near(s) < -0.2 ? -22 : 20);
  const legZ = (s: number) => (near(s) > 0.2 ? -4 : near(s) < -0.2 ? -14 : -8);

  // Torso and pelvis: half-widths blend between front width and side depth as the body turns.
  const half = (front: number, side: number) => Math.hypot(front * cos, side * sin) * b * U;
  const ws = half(0.118, 0.07);
  const ww = half(0.092, 0.066);
  const wh = half(0.1, 0.072);
  const chestBulge = sin * 14 * (back ? -1 : 1);
  // The trunk is two overlapping pieces so the chest can bend and twist over the belly. The chest's
  // lower outline is covered by an unstroked patch, so no line shows across the shirt.
  const wc = (ws * 0.98 + ww) / 2;
  const seam = y.chest * U;
  parts.push({
    name: 'belly', bone: 'torso', z: 4,
    paths: [{
      d: blob([
        [-wc, seam - 46], [wc + chestBulge * 0.5, seam - 46], [ww, y.waist * U], [ww * 1.02, (y.waist + 0.035) * U],
        [-ww * 1.02, (y.waist + 0.035) * U], [-ww, y.waist * U],
      ], 0.8),
      ...ink(p.shirt),
    }],
  });
  parts.push({
    name: 'chest', bone: 'chest', z: 5,
    paths: [
      {
        d: blob([
          [-ws, y.shoulder * U + 6], [-ws * 0.55, y.neck * U - 4], [ws * 0.55, y.neck * U - 4], [ws, y.shoulder * U + 6],
          [ws * 0.98 + chestBulge, (y.shoulder + 0.08) * U], [wc + chestBulge * 0.4, seam + 34], [-wc, seam + 34], [-ws * 0.98, (y.shoulder + 0.08) * U],
        ], 0.8),
        ...ink(p.shirt),
      },
      { d: ellipse(chestBulge * 0.2, seam + 30, Math.max(8, wc - sw * 1.6), 16), fill: p.shirt },
    ],
  });
  parts.push({
    name: 'pelvis', bone: 'hips', z: 0,
    paths: [{
      d: blob([
        [-ww, (y.waist + 0.01) * U], [ww, (y.waist + 0.01) * U], [wh, y.hips * U], [wh * 0.9, (y.hip + 0.035) * U],
        [0, (y.hip + 0.055) * U], [-wh * 0.9, (y.hip + 0.035) * U], [-wh, y.hips * U],
      ], 0.8),
      ...ink(p.pants),
    }],
  });
  parts.push({
    name: 'neck', bone: 'neck', z: 3,
    paths: [{ d: capsule([joints.neck[0], y.neck * U + 14], [joints.head[0], y.headBase * U - 10], 30 * b, 28 * b), ...ink(p.skin) }],
  });

  for (const [s, tag] of [[1, 'L'], [-1, 'R']] as const) {
    const sh = joints[`shoulder.${tag}`];
    const el = joints[`elbow.${tag}`];
    const wr = joints[`wrist.${tag}`];
    const ht = joints[`handTip.${tag}`];
    const az = armZ(s);
    const upper: PartPath[] = [{ d: capsule(sh, el, 38 * b, 30 * b), ...ink(p.sleeves === 'long' ? p.shirt : p.skin) }];
    if (p.sleeves === 'short') {
      const mid: P2 = [sh[0] + (el[0] - sh[0]) * 0.55, sh[1] + (el[1] - sh[1]) * 0.55];
      upper.push({ d: capsule(sh, mid, 41 * b, 37 * b), ...ink(p.shirt) });
    }
    parts.push({ name: `upperArm.${tag}`, bone: `upperArm.${tag}`, z: az, paths: upper });
    parts.push({
      name: `lowerArm.${tag}`, bone: `lowerArm.${tag}`, z: az + 1,
      paths: [{ d: capsule(el, wr, 30 * b, 23 * b), ...ink(p.sleeves === 'long' ? p.shirt : p.skin) }],
    });
    // Hand: palm, a mitten of four fingers that can curl, and a thumb on the side that faces forward.
    const kn2 = joints[`knuckle.${tag}`]!;
    const tb = joints[`thumbBase.${tag}`]!;
    const tt = joints[`thumbTip.${tag}`]!;
    parts.push({
      name: `fingers.${tag}`, bone: `fingers.${tag}`, z: az + 2,
      paths: [{ d: capsule([kn2[0], kn2[1] - 6], [ht[0], ht[1] - 20], 23 * b, 21 * b), ...ink(p.skin) }],
    });
    parts.push({
      name: `thumb.${tag}`, bone: `thumb.${tag}`, z: az + (back ? 1.5 : 3.5),
      paths: [{ d: capsule([tb[0], tb[1] - 4], [tt[0], tt[1] - 8], 12 * b, 11 * b), ...ink(p.skin) }],
    });
    parts.push({
      name: `hand.${tag}`, bone: `hand.${tag}`, z: az + 3,
      paths: [{ d: capsule([wr[0], wr[1] + 6], [kn2[0], kn2[1] + 2], 25 * b, 27 * b), ...ink(p.skin) }],
    });

    const hp = joints[`hip.${tag}`];
    const kn = joints[`knee.${tag}`];
    const an = joints[`ankle.${tag}`];
    const toe = joints[`toe.${tag}`];
    const lz = legZ(s);
    parts.push({ name: `upperLeg.${tag}`, bone: `upperLeg.${tag}`, z: lz, paths: [{ d: capsule(hp, kn, 50 * b, 40 * b), ...ink(p.pants) }] });
    parts.push({ name: `lowerLeg.${tag}`, bone: `lowerLeg.${tag}`, z: lz + 1, paths: [{ d: capsule(kn, [an[0], an[1] - 8], 40 * b, 29 * b), ...ink(p.pants) }] });
    // Shoe: heel sits behind the ankle, toe box in front; both rest on the ground line.
    const heel: P2 = [an[0] - sin * 26, -24];
    const tip: P2 = [toe[0] - sin * 22, -24 - Math.abs(cos) * 6];
    // The shoe bends at the ball of the foot: heel and arch on the foot bone, toe cap on the toes.
    const ballX = joints[`ball.${tag}`]![0] - sin * 22;
    const tipY = tip[1] + Math.abs(cos) * 6;
    parts.push({
      name: `toes.${tag}`, bone: `toes.${tag}`, z: lz + 2,
      paths: [{ d: capsule([ballX - sin * 10, (heel[1] + tipY) / 2], [tip[0], tipY], 25.5 * b, 24 * b), ...ink(p.shoes) }],
    });
    parts.push({
      name: `foot.${tag}`, bone: `foot.${tag}`, z: lz + 2.5,
      paths: [{ d: capsule(heel, [ballX, (heel[1] + tipY) / 2], 27 * b, 26 * b), ...ink(p.shoes) }],
    });
  }

  // Head
  const cx = joints.head[0] + sin * 6;
  const cy = (y.headBase - hh * 0.52) * U;
  const rx = hh * U * Math.hypot(0.42 * cos, 0.47 * sin);
  const ry = hh * U * 0.52;
  const headPaths: PartPath[] = [];
  for (const s of [1, -1]) {
    const visible = near(s) > 0.2 || Math.abs(cos) > 0.9;
    if (!visible) continue;
    const ex = cx + s * cos * rx * 0.98 - sin * rx * 0.12;
    headPaths.push({ d: ellipse(ex, cy + ry * 0.12, rx * 0.16 + Math.abs(sin) * rx * 0.08, ry * 0.2), ...ink(shade(p.skin, 0.94)) });
  }
  headPaths.push({ d: ellipse(cx, cy, rx, ry), ...ink(p.skin) });
  if (!back && Math.abs(cos) < 0.3) {
    // Profile nose bump.
    const nx = cx + sin * rx * 0.97;
    const ny = cy + ry * 0.2;
    headPaths.push({ d: blob([[nx - sin * 12, ny - 26], [nx + sin * 30, ny + 8], [nx - sin * 10, ny + 22]], 1), fill: p.skin, stroke: p.outline, strokeWidth: sw });
    headPaths.push({ d: ellipse(nx - sin * 12, ny, 13, 22), fill: p.skin });
  }
  parts.push({ name: 'head', bone: 'head', z: 30, paths: headPaths });

  // Hair
  const hairDark = shade(p.hair, 0.85);
  if (p.hairStyle !== 'bald') {
    if (p.hairStyle === 'long') {
      parts.push({
        name: 'hairBack', bone: 'hair', z: back ? 36 : -30,
        paths: [{
          d: blob([
            [cx - rx * 1.12 - sin * 20, cy - ry * 0.2], [cx - sin * 30, cy - ry * 1.12], [cx + rx * 1.12 - sin * 30, cy - ry * 0.2],
            [cx + rx * 1.05 - sin * 50, cy + ry * 1.5], [cx - sin * 60, cy + ry * 1.75], [cx - rx * 1.05 - sin * 50, cy + ry * 1.5],
          ], 0.9),
          ...ink(hairDark),
        }],
      });
    }
    if (back) {
      parts.push({
        name: 'hair', bone: 'head', z: 37,
        paths: [{
          d: blob([
            [cx - rx * 1.06, cy + ry * 0.25], [cx - rx * 1.02, cy - ry * 0.6], [cx, cy - ry * 1.1], [cx + rx * 1.02, cy - ry * 0.6],
            [cx + rx * 1.06, cy + ry * 0.25], [cx + rx * 0.6, cy + ry * 0.78], [cx, cy + ry * 0.86], [cx - rx * 0.6, cy + ry * 0.78],
          ], 0.9),
          ...ink(p.hair),
        }],
      });
    } else {
      const shift = -sin * rx * 0.3;
      const spikes: P2[] = p.hairStyle === 'spiky'
        ? [[cx - rx * 0.7 + shift, cy - ry * 1.28], [cx - rx * 0.25 + shift, cy - ry * 1.02], [cx + shift, cy - ry * 1.4], [cx + rx * 0.3 + shift, cy - ry * 1.04], [cx + rx * 0.75 + shift, cy - ry * 1.26]]
        : [[cx - rx * 0.6 + shift, cy - ry * 1.02], [cx + shift, cy - ry * 1.12], [cx + rx * 0.6 + shift, cy - ry * 1.02]];
      parts.push({
        name: 'hair', bone: 'head', z: 36,
        paths: [{
          d: blob([
            [cx - rx * 1.07 - sin * rx * 0.1, cy + ry * (-0.05 + 0.3 * sin)], [cx - rx * 1.02 + shift, cy - ry * 0.7], ...spikes,
            [cx + rx * 1.0 + shift * 0.3, cy - ry * 0.7], [cx + rx * (1.07 - 0.14 * sin), cy - ry * (0.05 + 0.5 * sin)],
            [cx + rx * 0.55 + sin * rx * 0.15, cy - ry * 0.52], [cx + sin * rx * 0.3, cy - ry * 0.42], [cx - rx * 0.6 + sin * rx * 0.3, cy - ry * 0.5],
          ], p.hairStyle === 'spiky' ? 0.35 : 0.85),
          ...ink(p.hair),
        }],
      });
    }
  }

  // Face
  let face: FaceSpec | undefined;
  if (!back) {
    const faceX = cx + sin * rx * 0.34;
    const eyeY = cy + ry * 0.06;
    const eyes: FaceSpec['eyes'] = [];
    const brows: PartPath[] = [];
    for (const [s, tag] of [[1, 'L'], [-1, 'R']] as const) {
      if (Math.abs(cos) < 0.3 && near(s) < 0) continue;
      const ex = faceX + s * cos * rx * (0.42 - 0.1 * Math.abs(sin));
      const squash = near(s) < -0.2 ? 0.72 : 1;
      const ew = rx * (0.2 + 0.05 * Math.abs(sin)) * squash;
      const eh = ry * 0.2;
      const look = sin * ew * 0.3;
      eyes.push({
        name: `eye.${tag}`, z: 32,
        paths: [
          { d: ellipse(ex, eyeY, ew, eh), fill: '#ffffff', stroke: p.outline, strokeWidth: sw * 0.7 },
          { d: ellipse(ex + look, eyeY + eh * 0.08, ew * 0.5, eh * 0.62), fill: p.eyes },
          { d: ellipse(ex + look - ew * 0.16, eyeY - eh * 0.2, ew * 0.16, eh * 0.18), fill: '#ffffff' },
        ],
      });
      brows.push({
        d: `M${(ex - ew * 1.05).toFixed(1)} ${(eyeY - eh * 1.75).toFixed(1)}Q${ex.toFixed(1)} ${(eyeY - eh * 2.3).toFixed(1)} ${(ex + ew * 1.05).toFixed(1)} ${(eyeY - eh * 1.75).toFixed(1)}`,
        fill: null, stroke: hairDark, strokeWidth: 9,
      });
    }
    if (brows.length) parts.push({ name: 'brows', bone: 'head', z: 34, paths: brows });
    if (Math.abs(cos) >= 0.3) {
      // Front: a small curve. Three-quarter: the curve leans toward the facing side.
      const nx = faceX + sin * rx * 0.22;
      const ny = cy + ry * 0.3;
      const lean = sin * 14;
      parts.push({
        name: 'nose', bone: 'head', z: 33,
        paths: [{ d: `M${(nx - 9).toFixed(1)} ${ny.toFixed(1)}Q${(nx + lean).toFixed(1)} ${(ny + ry * 0.1).toFixed(1)} ${(nx + 9 + lean).toFixed(1)} ${(ny - Math.abs(lean) * 0.6).toFixed(1)}`, fill: null, stroke: shade(p.skin, 0.72), strokeWidth: 6 }],
      });
    }
    face = {
      eyes,
      mouth: { cx: cx + sin * rx * 0.58, cy: cy + ry * 0.56, width: rx * 0.8, z: 33 },
      mouthScale: 0.55 + 0.45 * Math.abs(cos),
      lineColor: p.outline ?? shade(p.skin, 0.5),
    };
  }

  return { joints, parts, face };
}

/** A complete procedural character spec with the requested turnaround views. */
export function humanoidSpec(params: Partial<HumanoidParams> = {}): CharacterSpec {
  const p = { ...DEFAULT_HUMANOID, ...params };
  const views: CharacterSpec['views'] = {};
  for (const v of p.views) views[v] = buildView(v, p);
  return { name: p.name, height: p.height, views };
}
