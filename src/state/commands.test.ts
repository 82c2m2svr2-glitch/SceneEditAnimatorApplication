import { describe, expect, it } from 'vitest';
import { evaluateScene } from '../core/anim';
import { createGroup, createProject, createRect } from '../core/factory';
import { addNode, moveNodes, setKeys } from './commands';
import { doc } from './store';

describe('moveNodes', () => {
  it('keeps an animated layer on the same path when it moves into a moved, turned and scaled group', () => {
    const p = createProject({ name: 't', width: 1920, height: 1080, fps: 24, mode: 'tween' });
    doc.load(p);
    const box = addNode(createRect('Box', 100, 100));
    const group = addNode(createGroup('Group', { x: 300, y: -120, rotation: 40, scaleX: 2, scaleY: 2 }));
    setKeys([
      { target: box, prop: 'x', f: 0, v: 100 }, { target: box, prop: 'x', f: 24, v: 900 },
      { target: box, prop: 'y', f: 0, v: 200 }, { target: box, prop: 'y', f: 24, v: 600 },
      { target: box, prop: 'rotation', f: 0, v: 0 }, { target: box, prop: 'rotation', f: 24, v: 170 },
    ]);
    const at = (f: number) => evaluateScene(doc.project!, doc.project!.scenes[0], f).nodes.get(box)!.world;
    const before = [0, 24].map(at);
    moveNodes([box], group);
    expect(doc.project!.scenes[0].nodes[box].parent).toBe(group);
    [0, 24].forEach((f, i) => at(f).forEach((v, k) => expect(v).toBeCloseTo(before[i][k], 4)));
    // One undo puts everything back.
    doc.undo();
    expect(doc.project!.scenes[0].nodes[box].parent).toBeNull();
    [0, 24].forEach((f, i) => at(f).forEach((v, k) => expect(v).toBeCloseTo(before[i][k], 4)));
  });
});
