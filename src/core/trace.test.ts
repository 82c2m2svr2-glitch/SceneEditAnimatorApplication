import { describe, expect, it } from 'vitest';
import { flattenPath } from './path';
import { traceImage, type TracedShape } from './trace';
import type { PathData } from './types';

type RGBA = [number, number, number, number];
const CLEAR: RGBA = [0, 0, 0, 0];
const RED: RGBA = [220, 30, 30, 255];
const BLUE: RGBA = [30, 60, 220, 255];
const WHITE: RGBA = [255, 255, 255, 255];

/** Builds an image by asking a function for the colour of every pixel. */
function paint(width: number, height: number, at: (x: number, y: number) => RGBA) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(at(x, y), (y * width + x) * 4);
  return { data, width, height };
}

const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

/** Area a path covers under the even-odd rule (outer contours minus holes, for non-overlapping contours). */
function areaOf(path: PathData): number {
  const areas = flattenPath(path, 16).map((poly) => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a / 2);
  }).sort((a, b) => b - a);
  return areas.reduce((sum, a, i) => (i === 0 ? a : sum - a), 0);
}

const corners = (shape: TracedShape) => shape.path.contours[0].pts.map((p) => `${p.x},${p.y}`).sort();

describe('traceImage', () => {
  it('traces a solid square on a transparent background as four sharp corners', () => {
    const shapes = traceImage(paint(40, 40, (x, y) => (inRect(x, y, 10, 8, 30, 28) ? RED : CLEAR)));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].color).toBe('#dc1e1e');
    expect(shapes[0].path.contours).toHaveLength(1);
    expect(shapes[0].path.contours[0].closed).toBe(true);
    expect(corners(shapes[0])).toEqual(['10,28', '10,8', '30,28', '30,8']);
    for (const p of shapes[0].path.contours[0].pts) expect([p.ix, p.iy, p.ox, p.oy]).toEqual([0, 0, 0, 0]);
  });

  it('returns nothing for a fully transparent image', () => {
    expect(traceImage(paint(8, 8, () => CLEAR))).toEqual([]);
  });

  it('keeps a hole as a second contour', () => {
    const shapes = traceImage(paint(40, 40, (x, y) => (inRect(x, y, 4, 4, 36, 36) && !inRect(x, y, 14, 14, 26, 26) ? RED : CLEAR)));
    expect(shapes).toHaveLength(1);
    expect(shapes[0].path.contours).toHaveLength(2);
    expect(areaOf(shapes[0].path)).toBeCloseTo(32 * 32 - 12 * 12, 6);
  });

  it('stacks two touching colours back to front with no gap between them', () => {
    // Red takes 60% of the width, so it is the larger region and goes at the back.
    const shapes = traceImage(paint(50, 20, (x) => (x < 30 ? RED : BLUE)));
    expect(shapes.map((s) => s.color)).toEqual(['#dc1e1e', '#1e3cdc']);
    // The back shape covers the whole image; the front one sits on top of its own area.
    expect(areaOf(shapes[0].path)).toBeCloseTo(50 * 20, 6);
    expect(areaOf(shapes[1].path)).toBeCloseTo(20 * 20, 6);
    expect(corners(shapes[1])).toEqual(['30,0', '30,20', '50,0', '50,20']);
  });

  it('lets a back colour show through a ring in front of it', () => {
    const shapes = traceImage(paint(60, 60, (x, y) => (inRect(x, y, 15, 15, 45, 45) && !inRect(x, y, 22, 22, 38, 38) ? BLUE : WHITE)));
    expect(shapes.map((s) => s.color)).toEqual(['#ffffff', '#1e3cdc']);
    expect(shapes[0].path.contours).toHaveLength(1);
    expect(shapes[1].path.contours).toHaveLength(2);
  });

  it('absorbs specks smaller than minArea', () => {
    const image = paint(40, 40, (x, y) => {
      if (inRect(x, y, 5, 5, 7, 7)) return BLUE; // 4 px speck inside the square
      if (inRect(x, y, 36, 36, 38, 38)) return RED; // 4 px speck on the empty background
      if (inRect(x, y, 20, 20, 23, 23)) return CLEAR; // 9 px pinhole
      return inRect(x, y, 2, 2, 32, 32) ? RED : CLEAR;
    });
    const clean = traceImage(image, { minArea: 12 });
    expect(clean).toHaveLength(1);
    expect(clean[0].path.contours).toHaveLength(1);
    expect(areaOf(clean[0].path)).toBeCloseTo(30 * 30, 6);
    const kept = traceImage(image, { minArea: 0 });
    expect(kept.map((s) => s.color)).toEqual(['#dc1e1e', '#1e3cdc']);
    expect(kept[0].path.contours).toHaveLength(3);
  });

  it('fits curves to a circle and keeps its area', () => {
    const r = 30;
    const shapes = traceImage(paint(80, 80, (x, y) => ((x + 0.5 - 40) ** 2 + (y + 0.5 - 40) ** 2 <= r * r ? BLUE : CLEAR)));
    expect(shapes).toHaveLength(1);
    const pts = shapes[0].path.contours[0].pts;
    expect(pts.length).toBeLessThan(40);
    expect(pts.every((p) => p.ox !== 0 || p.oy !== 0)).toBe(true);
    expect(Math.abs(areaOf(shapes[0].path) - Math.PI * r * r) / (Math.PI * r * r)).toBeLessThan(0.02);
  });

  it('leaves straight segments when smoothing is off and uses fewer points at higher tolerance', () => {
    const circle = paint(80, 80, (x, y) => ((x + 0.5 - 40) ** 2 + (y + 0.5 - 40) ** 2 <= 900 ? BLUE : CLEAR));
    const sharp = traceImage(circle, { smooth: false });
    expect(sharp[0].path.contours[0].pts.every((p) => p.ox === 0 && p.oy === 0 && p.ix === 0 && p.iy === 0)).toBe(true);
    const fine = traceImage(circle, { tolerance: 0.6 })[0].path.contours[0].pts.length;
    const coarse = traceImage(circle, { tolerance: 3 })[0].path.contours[0].pts.length;
    expect(coarse).toBeLessThan(fine);
  });

  it('folds an anti-aliased edge into its two sides instead of tracing a sliver', () => {
    const blend: RGBA = [125, 45, 125, 255];
    const shapes = traceImage(paint(60, 30, (x) => (x < 30 ? RED : x === 30 ? blend : BLUE)), { minArea: 0 });
    expect(shapes).toHaveLength(2);
  });

  it('limits the palette to the requested number of colours', () => {
    const shapes = traceImage(paint(64, 16, (x) => [x * 4, 80, 255 - x * 4, 255]), { colors: 4, minArea: 0 });
    expect(shapes.length).toBeLessThanOrEqual(4);
    expect(shapes.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects data that does not match the stated size', () => {
    expect(() => traceImage({ data: new Uint8ClampedArray(16), width: 4, height: 4 })).toThrow(/width and height/);
  });
});
