import { describe, expect, it } from 'vitest';
import { planSequence } from './sequence';
import type { Transition } from './types';

const sc = (duration: number, type: Transition['type'] = 'cut', t = 10) => ({ duration, transition: { type, duration: t } });

describe('planSequence', () => {
  it('plays cut scenes back to back', () => {
    const p = planSequence([sc(10), sc(5)]);
    expect(p.total).toBe(15);
    expect(p.sample(0).a).toEqual({ scene: 0, frame: 0 });
    expect(p.sample(9).a).toEqual({ scene: 0, frame: 9 });
    expect(p.sample(10).a).toEqual({ scene: 1, frame: 0 });
    expect(p.sample(14).a).toEqual({ scene: 1, frame: 4 });
    expect(p.sample(10).b).toBeUndefined();
  });

  it('overlaps scenes for a dissolve and shortens the total', () => {
    const p = planSequence([sc(20, 'dissolve', 6), sc(20)]);
    expect(p.total).toBe(34);
    expect(p.segments[1].start).toBe(14);
    const mid = p.sample(16);
    expect(mid.a).toEqual({ scene: 0, frame: 16 });
    expect(mid.b).toEqual({ scene: 1, frame: 2 });
    expect(mid.type).toBe('dissolve');
    expect(mid.t).toBeGreaterThan(0);
    expect(mid.t).toBeLessThan(1);
    expect(p.sample(20).b).toBeUndefined();
    expect(p.sample(20).a).toEqual({ scene: 1, frame: 6 });
  });

  it('never overlaps more than either scene is long', () => {
    const p = planSequence([sc(4, 'wipeLeft', 30), sc(3)]);
    expect(p.segments[1].start).toBe(1);
    expect(p.total).toBe(4);
  });

  it('fades through black without overlapping', () => {
    const p = planSequence([sc(20, 'fade', 8), sc(20)]);
    expect(p.total).toBe(40);
    expect(p.sample(5).black).toBe(0);
    expect(p.sample(19).black).toBe(1);
    expect(p.sample(20).black).toBeGreaterThan(0.5);
    expect(p.sample(30).black).toBe(0);
  });

  it('ignores the transition of the last scene', () => {
    const p = planSequence([sc(10, 'dissolve', 5)]);
    expect(p.total).toBe(10);
    expect(p.sample(9).b).toBeUndefined();
    expect(p.sample(9).black).toBe(0);
  });
});
