import type { Scene, Transition } from './types';

/** What to show for one output frame when several scenes are played back to back. */
export interface SequenceSample {
  a: { scene: number; frame: number };
  /** Present during an overlapping transition (dissolve, wipe, slide). */
  b?: { scene: number; frame: number };
  type: Transition['type'];
  /** Transition progress 0..1 when `b` is present. */
  t: number;
  /** Black overlay opacity 0..1 (fade through black). */
  black: number;
}

export interface SequencePlan {
  total: number;
  /** Output frame at which each scene's frame 0 lands, and how many frames of it play. */
  segments: { scene: number; start: number; duration: number }[];
  sample(index: number): SequenceSample;
}

type SceneTiming = Pick<Scene, 'duration' | 'transition'>;

/**
 * Lays scenes out on one timeline. Dissolves, wipes and slides overlap the end of one scene with
 * the start of the next (shortening the total); a fade through black does not overlap.
 */
export function planSequence(scenes: SceneTiming[]): SequencePlan {
  const segments: SequencePlan['segments'] = [];
  const overlaps: number[] = [];
  let cursor = 0;
  scenes.forEach((s, i) => {
    segments.push({ scene: i, start: cursor, duration: s.duration });
    const next = scenes[i + 1];
    const tr = s.transition;
    const overlapping = !!next && tr.type !== 'cut' && tr.type !== 'fade';
    const overlap = overlapping ? Math.max(0, Math.min(Math.round(tr.duration), s.duration, next.duration)) : 0;
    overlaps.push(overlap);
    cursor += s.duration - overlap;
  });
  const total = Math.max(0, cursor);

  const sample = (index: number): SequenceSample => {
    // The last segment that has started is the incoming scene during an overlap.
    let i = 0;
    for (let k = 0; k < segments.length; k++) if (segments[k].start <= index) i = k;
    const seg = segments[i];
    const local = index - seg.start;
    const prev = i > 0 ? segments[i - 1] : null;
    const prevOverlap = i > 0 ? overlaps[i - 1] : 0;
    if (prev && prevOverlap > 0 && local < prevOverlap) {
      return {
        a: { scene: prev.scene, frame: prev.duration - prevOverlap + local },
        b: { scene: seg.scene, frame: local },
        type: scenes[prev.scene].transition.type,
        t: (local + 1) / (prevOverlap + 1),
        black: 0,
      };
    }
    let black = 0;
    const out = scenes[seg.scene].transition;
    if (i < segments.length - 1 && out.type === 'fade') {
      const half = Math.max(1, Math.min(Math.round(out.duration / 2), seg.duration));
      const left = seg.duration - 1 - local;
      if (left < half) black = Math.max(black, 1 - left / half);
    }
    if (prev && scenes[prev.scene].transition.type === 'fade') {
      const half = Math.max(1, Math.min(Math.round(scenes[prev.scene].transition.duration / 2), seg.duration));
      if (local < half) black = Math.max(black, 1 - (local + 1) / (half + 1));
    }
    return { a: { scene: seg.scene, frame: Math.min(local, seg.duration - 1) }, type: 'cut', t: 0, black };
  };

  return { total, segments, sample };
}
