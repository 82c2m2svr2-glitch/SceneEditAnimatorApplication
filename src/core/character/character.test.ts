import { describe, expect, it } from 'vitest';
import { evaluateScene } from '../anim';
import { createProject } from '../factory';
import { VIEW_NAMES, type CharacterNode, type ViewName } from '../types';
import { builtinActions } from './actions';
import { buildCharacter } from './build';
import { humanoidSpec } from './humanoid';
import { buildCharacter3D, poseTo3D } from './model3d';
import { BONE_DEFS, BONE_NAMES, CORE_JOINT_NAMES, JOINT_NAMES, VISEMES, completeJoints, type BoneName, type ViewJoints } from './spec';
import { textToVisemes } from './speech';

function sceneWithCharacter() {
  const p = createProject({ name: 't', width: 1920, height: 1080, fps: 24, mode: 'rig' });
  const built = buildCharacter(humanoidSpec({ name: 'Hero', height: 600 }));
  const s = p.scenes[0];
  for (const n of built.nodes) s.nodes[n.id] = n;
  s.roots.push(built.rootId);
  return { p, s, built };
}

describe('buildCharacter', () => {
  it('creates every bone with a rest pose for every view', () => {
    const { s, built } = sceneWithCharacter();
    for (const name of BONE_NAMES) {
      const b = s.nodes[built.bones[name]];
      expect(b.type).toBe('bone');
      if (b.type === 'bone') for (const v of VIEW_NAMES) expect(b.viewRest?.[v]).toBeDefined();
    }
  });

  it('stands on the ground with the requested height', () => {
    const { p, s, built } = sceneWithCharacter();
    const es = evaluateScene(p, s, 0);
    const head = es.nodes.get(built.bones.head)!;
    const tipY = head.world[1] * head.length + head.world[5];
    expect(tipY).toBeCloseTo(-600, 0);
    const foot = es.nodes.get(built.bones['foot.L'])!;
    expect(foot.world[5]).toBeLessThan(0);
    expect(foot.world[5]).toBeGreaterThan(-60);
  });

  it('shows only the parts of the current view', () => {
    const { p, s, built } = sceneWithCharacter();
    const ch = s.nodes[built.rootId];
    if (ch.type !== 'character') throw new Error('not a character');
    ch.currentView = 'side';
    const es = evaluateScene(p, s, 0);
    const visibleViews = new Set([...es.nodes.values()].filter((e) => e.visible && e.node.view).map((e) => e.node.view));
    expect([...visibleViews]).toEqual(['side']);
  });

  it('drives every view\'s mouth switch from the character', () => {
    const { p, s, built } = sceneWithCharacter();
    s.anim[built.rootId] = { mouth: { keys: [{ f: 0, v: 'rest', e: 'step' }, { f: 5, v: 'O', e: 'step' }] } };
    const es = evaluateScene(p, s, 6);
    const mouths = [...es.nodes.values()].filter((e) => e.node.type === 'switch' && e.node.tag === 'mouth');
    expect(mouths.length).toBe(3);
    for (const m of mouths) {
      const shown = m.node.children.filter((c) => es.nodes.get(c)!.visible || es.nodes.get(c)!.node.name === 'O');
      const visibleNames = m.node.children.map((c) => es.nodes.get(c)!).filter((c) => c.node.name === 'O');
      expect(visibleNames.length).toBe(1);
      expect(shown.length).toBeGreaterThan(0);
    }
  });

  it('has a mouth shape for every viseme', () => {
    const { s } = sceneWithCharacter();
    const mouth = Object.values(s.nodes).find((n) => n.type === 'switch' && n.tag === 'mouth')!;
    expect(mouth.children.map((c) => s.nodes[c].name).sort()).toEqual([...VISEMES].sort());
  });
});

describe('built-in actions', () => {
  it('only reference bones that exist and loop cleanly', () => {
    for (const clip of builtinActions()) {
      for (const node in clip.tracks) {
        if (node !== '@') expect(BONE_NAMES as readonly string[]).toContain(node);
        for (const prop in clip.tracks[node]) {
          const keys = clip.tracks[node][prop].keys;
          for (let i = 1; i < keys.length; i++) expect(keys[i].f).toBeGreaterThan(keys[i - 1].f);
          expect(keys[keys.length - 1].f).toBeLessThanOrEqual(clip.duration);
          if (clip.loop && typeof keys[0].v === 'number' && keys[0].f === 0 && keys[keys.length - 1].f === clip.duration) {
            expect(keys[keys.length - 1].v).toBeCloseTo(keys[0].v as number, 5);
          }
        }
      }
    }
  });

  it('pose a character through a strip', () => {
    const { p, s, built } = sceneWithCharacter();
    const walk = builtinActions().find((a) => a.name === 'Walk')!;
    p.actions[walk.id] = walk;
    s.strips.push({ id: 'st', actionId: walk.id, targetId: built.rootId, start: 0, duration: 48, speed: 1, blendIn: 0, blendOut: 0, weight: 1, track: 0, muted: false });
    (s.nodes[built.rootId] as CharacterNode).currentView = 'side';
    const rest = evaluateScene(p, s, 0, { setup: true }).nodes.get(built.bones['upperLeg.R'])!.rotation;
    const posed = evaluateScene(p, s, 0).nodes.get(built.bones['upperLeg.R'])!.rotation;
    expect(posed - rest).toBeCloseTo(-25, 3);
    const looped = evaluateScene(p, s, 24).nodes.get(built.bones['upperLeg.R'])!.rotation;
    expect(looped).toBeCloseTo(posed, 3);
  });

  /** Pose change of a bone at a frame, with a clip applied and the character in a given view. */
  function delta(action: string, view: ViewName, bone: BoneName, frame: number, prop: 'rotation' | 'scaleX' = 'rotation') {
    const { p, s, built } = sceneWithCharacter();
    const clip = builtinActions().find((a) => a.id === `builtin_${action}`)!;
    p.actions[clip.id] = clip;
    (s.nodes[built.rootId] as CharacterNode).currentView = view;
    s.strips.push({ id: 'st', actionId: clip.id, targetId: built.rootId, start: 0, duration: 96, speed: 1, blendIn: 0, blendOut: 0, weight: 1, track: 0, muted: false });
    const rest = evaluateScene(p, s, frame, { setup: true }).nodes.get(built.bones[bone])!;
    const posed = evaluateScene(p, s, frame).nodes.get(built.bones[bone])!;
    return prop === 'rotation' ? posed.rotation - rest.rotation : posed.scaleX / rest.scaleX;
  }

  it('every clip fits every view', () => {
    for (const clip of builtinActions()) {
      if (clip.id === 'builtin_walk_front') continue;
      expect(clip.views).toEqual([]);
    }
  });

  it('walks by swinging the legs in profile and by lifting the knees when facing the viewer', () => {
    for (const view of ['side', 'threeQuarter', 'backThreeQuarter'] as const) expect(delta('walk', view, 'upperLeg.R', 0)).toBeCloseTo(-25, 3);
    for (const view of ['front', 'back'] as const) {
      expect(delta('walk', view, 'upperLeg.R', 0)).toBeCloseTo(0, 3);
      expect(delta('walk', view, 'upperLeg.L', 6, 'scaleX')).toBeLessThan(0.9);
    }
  });

  it('waves outward from the front and from behind, and forward in profile', () => {
    expect(delta('wave', 'front', 'upperArm.R', 20)).toBeCloseTo(132, 3);
    expect(delta('wave', 'threeQuarter', 'upperArm.R', 20)).toBeCloseTo(132, 3);
    expect(delta('wave', 'back', 'upperArm.R', 20)).toBeCloseTo(-132, 3);
    expect(delta('wave', 'backThreeQuarter', 'upperArm.R', 20)).toBeCloseTo(-132, 3);
    expect(delta('wave', 'side', 'upperArm.R', 20)).toBeCloseTo(-132, 3);
    // In profile both arms of a cheer go forward and up; from the front they mirror each other.
    expect(delta('cheer', 'side', 'upperArm.L', 20)).toBeCloseTo(delta('cheer', 'side', 'upperArm.R', 20), 3);
    expect(delta('cheer', 'front', 'upperArm.L', 20)).toBeCloseTo(-delta('cheer', 'front', 'upperArm.R', 20), 3);
  });

  it('uses the finer bones: toes roll in a walk, collarbones lift in a shrug, fingers move in a wave', () => {
    expect(delta('walk', 'side', 'toes.R', 15)).toBeLessThan(-10);
    expect(delta('shrug', 'front', 'clavicle.R', 12)).toBeCloseTo(16, 3);
    expect(delta('shrug', 'back', 'clavicle.R', 12)).toBeCloseTo(-16, 3);
    expect(Math.abs(delta('wave', 'front', 'fingers.R', 15))).toBeGreaterThan(5);
  });
});

describe('the skeleton', () => {
  it('has the finer bones, each hanging from a bone that comes earlier in the list', () => {
    for (const bone of ['chest', 'hair', 'clavicle.L', 'fingers.R', 'thumb.L', 'toes.R'] as const) expect(BONE_NAMES).toContain(bone);
    for (const name of BONE_NAMES) {
      if (name === 'root') continue;
      expect(BONE_NAMES.indexOf(BONE_DEFS[name].parent)).toBeLessThan(BONE_NAMES.indexOf(name));
    }
  });

  it('places finer landmarks a view leaves out, and keeps the ones it supplies', () => {
    const full = humanoidSpec().views.front!.joints;
    const core = Object.fromEntries(CORE_JOINT_NAMES.map((j) => [j, full[j]])) as ViewJoints;
    const done = completeJoints(core);
    for (const j of JOINT_NAMES) expect(done[j].every(Number.isFinite)).toBe(true);
    // The chest sits between the waist and the neck; the ball of the foot between ankle and toe.
    expect(done.chest[1]).toBeGreaterThan(core.neck[1]);
    expect(done.chest[1]).toBeLessThan(core.waist[1]);
    expect(done['ball.L'][1]).toBeGreaterThan(core['ankle.L'][1]);
    expect(completeJoints({ ...core, chest: [3, 4] }).chest).toEqual([3, 4]);
    expect(() => completeJoints({ ...core, neck: undefined } as unknown as ViewJoints)).toThrow(/neck/);
  });

  it('still builds a character from a turnaround that only has the core landmarks', () => {
    const spec = humanoidSpec({ views: ['front', 'side'] });
    for (const v of ['front', 'side'] as const) {
      const j = spec.views[v]!.joints;
      spec.views[v]!.joints = Object.fromEntries(CORE_JOINT_NAMES.map((n) => [n, j[n]])) as ViewJoints;
    }
    const built = buildCharacter(spec);
    for (const name of BONE_NAMES) expect(built.bones[name]).toBeDefined();
  });
});

describe('buildCharacter3D', () => {
  const model = buildCharacter3D(humanoidSpec({ height: 600, hairStyle: 'long' }));
  const part = (bone: BoneName) => model.parts.find((p) => p.bone === bone)!;
  const extent = (p: (typeof model.parts)[number], axis: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = axis; i < p.positions.length; i += 3) {
      lo = Math.min(lo, p.positions[i] + model.joints[p.bone][axis]);
      hi = Math.max(hi, p.positions[i] + model.joints[p.bone][axis]);
    }
    return [lo, hi];
  };

  it('makes a solid for every drawn bone, as tall as the character', () => {
    for (const bone of ['hips', 'torso', 'chest', 'head', 'hair', 'upperArm.L', 'fingers.R', 'thumb.L', 'foot.L', 'toes.R'] as const) expect(part(bone)).toBeDefined();
    let top = -Infinity;
    let bottom = Infinity;
    for (const p of model.parts) {
      const [lo, hi] = extent(p, 1);
      top = Math.max(top, hi);
      bottom = Math.min(bottom, lo);
      expect(p.positions.length % 9).toBe(0);
      expect(p.normals.length).toBe(p.positions.length);
      expect(p.uvs.length).toBe((p.positions.length / 3) * 2);
      expect(p.positions.every(Number.isFinite)).toBe(true);
    }
    expect(top).toBeGreaterThan(560);
    expect(top).toBeLessThan(680);
    expect(Math.abs(bottom)).toBeLessThan(12);
  });

  it('puts the left side at +X, the toes forward, and long hair behind the face', () => {
    expect(model.joints['upperArm.L'][0]).toBeGreaterThan(20);
    expect(model.joints['upperArm.R'][0]).toBeLessThan(-20);
    expect(extent(part('toes.L'), 2)[1]).toBeGreaterThan(extent(part('foot.L'), 2)[0] + 20);
    const head = extent(part('head'), 2);
    expect(extent(part('hair'), 2)[1]).toBeLessThanOrEqual((head[0] + head[1]) / 2 + 12);
  });

  it('gives the head a face for every mouth shape and eye state', () => {
    const face = part('head').face!;
    for (const v of VISEMES) expect(face.mouth[v].length).toBeGreaterThan(0);
    expect(face.eyes.open.length).toBeGreaterThan(0);
    expect(face.eyes.closed.length).toBe(2);
    expect(part('head').front.items.some((i) => i.slot === 'mouth')).toBe(true);
    expect(part('head').back.items.some((i) => i.slot)).toBe(false);
  });

  it('needs a front or back view', () => {
    expect(() => buildCharacter3D(humanoidSpec({ views: ['side'] }))).toThrow(/front or back/);
  });
});

describe('poseTo3D', () => {
  const turned = (yaw: number, rotation: number, v: [number, number, number]) => {
    const [x, y, z, w] = poseTo3D(yaw, rotation, 0, 0, 0).quat;
    // v' = v + 2w(q x v) + 2 q x (q x v)
    const cx = y * v[2] - z * v[1];
    const cy = z * v[0] - x * v[2];
    const cz = x * v[1] - y * v[0];
    return [v[0] + 2 * (w * cx + y * cz - z * cy), v[1] + 2 * (w * cy + z * cx - x * cz), v[2] + 2 * (w * cz + x * cy - y * cx)];
  };

  it('raises a hanging arm sideways in the front view and forward in the side view', () => {
    // Front view, clockwise on screen: down -> screen left (the character's right, -X) -> up.
    const front = turned(0, 90, [0, -1, 0]);
    expect(front[0]).toBeCloseTo(-1, 5);
    expect(front[1]).toBeCloseTo(0, 5);
    // Side view faces screen-right, so a negative turn swings a limb forward (+Z).
    const side = turned(90, -90, [0, -1, 0]);
    expect(side[2]).toBeCloseTo(1, 5);
    expect(side[0]).toBeCloseTo(0, 5);
  });

  it('moves pose offsets in the plane of the picture', () => {
    expect(poseTo3D(0, 0, 10, 5, 0).offset).toEqual([10, -5, 0]);
    const side = poseTo3D(90, 0, 10, 0, 0).offset;
    expect(side[0]).toBeCloseTo(0, 5);
    expect(side[2]).toBeCloseTo(10, 5);
    // A parent bone pointing straight down turns its local x into screen-down.
    expect(poseTo3D(0, 0, 10, 0, 90).offset[1]).toBeCloseTo(-10, 5);
  });
});

describe('textToVisemes', () => {
  it('starts at the start frame, ends at rest, and never repeats a shape', () => {
    const v = textToVisemes('Hello there, my friend!', 24, 10);
    expect(v[0].frame).toBe(10);
    expect(v[v.length - 1].viseme).toBe('rest');
    for (let i = 1; i < v.length; i++) {
      expect(v[i].frame).toBeGreaterThan(v[i - 1].frame);
      expect(v[i].viseme).not.toBe(v[i - 1].viseme);
    }
    expect(v.some((x) => x.viseme === 'MBP')).toBe(true);
  });
});
