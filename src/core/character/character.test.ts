import { describe, expect, it } from 'vitest';
import { evaluateScene } from '../anim';
import { createProject } from '../factory';
import { VIEW_NAMES } from '../types';
import { builtinActions } from './actions';
import { buildCharacter } from './build';
import { humanoidSpec } from './humanoid';
import { BONE_NAMES, VISEMES } from './spec';
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
    const rest = evaluateScene(p, s, 0, { setup: true }).nodes.get(built.bones['upperLeg.R'])!.rotation;
    const posed = evaluateScene(p, s, 0).nodes.get(built.bones['upperLeg.R'])!.rotation;
    expect(posed - rest).toBeCloseTo(-25, 3);
    const looped = evaluateScene(p, s, 24).nodes.get(built.bones['upperLeg.R'])!.rotation;
    expect(looped).toBeCloseTo(posed, 3);
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
