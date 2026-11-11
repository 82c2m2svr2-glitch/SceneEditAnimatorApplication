import { describe, expect, it } from 'vitest';
import { analyzeVisemes } from './lipsync';
import { SR, VOWELS, hiss, join, silence, tone, vowel } from './synth.testutil';
import { computePeaks } from './waveform';

const FPS = 24;
const shapes = (samples: Float32Array, opts = {}) => analyzeVisemes(samples, SR, FPS, opts);
const at = (changes: { frame: number; viseme: string }[], frame: number) => changes.filter((c) => c.frame <= frame).at(-1)!.viseme;

describe('analyzeVisemes', () => {
  it('keeps the mouth closed through silence and empty input', () => {
    expect(shapes(silence(1))).toEqual([{ frame: 0, viseme: 'rest' }]);
    expect(shapes(new Float32Array(0))).toEqual([{ frame: 0, viseme: 'rest' }]);
  });

  it('holds one open shape for a steady tone', () => {
    const out = shapes(tone(440, 1));
    expect(out).toHaveLength(1);
    expect(out[0].frame).toBe(0);
    expect(out[0].viseme).not.toBe('rest');
  });

  it('presses the lips before a burst that follows silence, then closes again', () => {
    const out = shapes(join(silence(0.25), vowel(VOWELS.a, 0.5), silence(0.25)));
    expect(out.map((c) => c.viseme)).toEqual(['rest', 'MBP', 'AI', 'rest']);
    expect(out[2].frame).toBe(6);
    expect(out[1].frame).toBe(4);
    expect(out[3].frame).toBe(18);
  });

  it('tells open, spread and rounded vowels apart', () => {
    const mid = (v: [number, number, number]) => at(shapes(join(silence(0.25), vowel(v, 0.5), silence(0.25))), 12);
    expect(mid(VOWELS.a)).toBe('AI');
    expect(mid(VOWELS.e)).toBe('E');
    expect(mid(VOWELS.i)).toBe('E');
    expect(['O', 'U']).toContain(mid(VOWELS.o));
    expect(['O', 'U']).toContain(mid(VOWELS.u));
  });

  it('uses the teeth-on-lip shape for hiss', () => {
    const out = shapes(join(vowel(VOWELS.a, 0.3), hiss(0.3), silence(0.25)));
    expect(at(out, 11)).toBe('FV');
    expect(at(out, 3)).toBe('AI');
  });

  it('never holds a shape for less than minHold frames', () => {
    const blip = () => join(vowel(VOWELS.a, 1 / FPS), silence(1 / FPS));
    const samples = join(...Array.from({ length: 12 }, blip), silence(0.5));
    for (const minHold of [1, 2, 4]) {
      const out = shapes(samples, { minHold });
      for (let i = 1; i < out.length; i++) expect(out[i].frame - out[i - 1].frame).toBeGreaterThanOrEqual(minHold);
    }
    expect(shapes(samples, { minHold: 4 }).length).toBeLessThan(shapes(samples, { minHold: 1 }).length);
  });

  it('opens the mouth for quieter sound as sensitivity goes up', () => {
    const samples = join(vowel(VOWELS.a, 0.5), vowel(VOWELS.a, 0.5, 0.04), silence(0.25));
    expect(at(shapes(samples, { sensitivity: 0.5 }), 18)).toBe('rest');
    expect(at(shapes(samples, { sensitivity: 2 }), 18)).not.toBe('rest');
  });

  it('always starts at frame 0 with frames in increasing order', () => {
    const out = shapes(join(silence(0.1), vowel(VOWELS.o, 0.2), hiss(0.2), vowel(VOWELS.i, 0.3)));
    expect(out[0].frame).toBe(0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].frame).toBeGreaterThan(out[i - 1].frame);
      expect(out[i].viseme).not.toBe(out[i - 1].viseme);
    }
  });
});

describe('computePeaks', () => {
  it('returns the min and max of each bucket', () => {
    const peaks = computePeaks(Float32Array.from([0, 1, -1, 0.5, 0.2, 0.3, -0.4, -0.1]), 4);
    const expected = [0, 1, -1, 0.5, 0.2, 0.3, -0.4, -0.1];
    expect(peaks).toHaveLength(8);
    expected.forEach((v, i) => expect(peaks[i]).toBeCloseTo(v, 6));
  });

  it('handles more buckets than samples and empty input', () => {
    const peaks = computePeaks(Float32Array.from([0.5, -0.5]), 4);
    expect(Array.from(peaks)).toEqual([0.5, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5]);
    expect(Array.from(computePeaks(new Float32Array(0), 3))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
