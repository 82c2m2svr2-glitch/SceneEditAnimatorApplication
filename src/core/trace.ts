import { pt } from './path';
import type { Contour, PathData } from './types';

export interface TraceImage {
  /** RGBA, 4 bytes per pixel, row by row (the layout of a canvas ImageData). */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface TraceOptions {
  /** Most colours to keep, 2 to 32. Default 12. */
  colors?: number;
  /** Regions smaller than this many pixels are absorbed by their surroundings. Default 12. */
  minArea?: number;
  /** How far, in pixels, an outline may stray from the pixel edge. Higher gives fewer points. Default 1. */
  tolerance?: number;
  /** Fit curves through rounded outlines instead of leaving straight segments. Default true. */
  smooth?: boolean;
}

export interface TracedShape {
  /** Fill colour as `#rrggbb`. */
  color: string;
  /** Closed contours in image pixel coordinates. Fill with the `evenodd` rule: holes are extra contours. */
  path: PathData;
}

type P = { x: number; y: number };

// ---------------------------------------------------------------------------------------------
// Colour quantisation
// ---------------------------------------------------------------------------------------------

const BITS = 5;
const BINS = 1 << (BITS * 3);
const binOf = (r: number, g: number, b: number) => ((r >> (8 - BITS)) << (BITS * 2)) | ((g >> (8 - BITS)) << BITS) | (b >> (8 - BITS));

/** Median cut over a coarse colour histogram, refined with a few k-means passes. */
function buildPalette(image: TraceImage, maxColors: number): { palette: number[][]; binToColor: Int16Array } {
  const { data } = image;
  const count = new Float64Array(BINS);
  const sum = [new Float64Array(BINS), new Float64Array(BINS), new Float64Array(BINS)];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const bin = binOf(data[i], data[i + 1], data[i + 2]);
    count[bin]++;
    sum[0][bin] += data[i];
    sum[1][bin] += data[i + 1];
    sum[2][bin] += data[i + 2];
  }
  const used: number[] = [];
  for (let b = 0; b < BINS; b++) if (count[b]) used.push(b);
  const binToColor = new Int16Array(BINS).fill(-1);
  if (!used.length) return { palette: [], binToColor };
  const mean = (b: number, ch: number) => sum[ch][b] / count[b];

  let boxes: number[][] = [used];
  while (boxes.length < maxColors) {
    // Split the box whose colours are spread widest, weighted by how many pixels it holds.
    let best = -1;
    let bestScore = 0;
    let bestAxis = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      let pixels = 0;
      for (const b of box) pixels += count[b];
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255;
        let hi = 0;
        for (const b of box) {
          const v = mean(b, ch);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const score = (hi - lo) * Math.sqrt(pixels);
        if (score > bestScore) {
          bestScore = score;
          best = index;
          bestAxis = ch;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best].slice().sort((a, b) => mean(a, bestAxis) - mean(b, bestAxis));
    let total = 0;
    for (const b of box) total += count[b];
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += count[box[i]];
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    boxes = [...boxes.slice(0, best), box.slice(0, cut), box.slice(cut), ...boxes.slice(best + 1)];
  }

  let palette = boxes.map((box) => {
    let n = 0;
    const c = [0, 0, 0];
    for (const b of box) {
      n += count[b];
      for (let ch = 0; ch < 3; ch++) c[ch] += sum[ch][b];
    }
    return c.map((v) => v / n);
  });
  const nearest = (r: number, g: number, b: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const d = (palette[k][0] - r) ** 2 + (palette[k][1] - g) ** 2 + (palette[k][2] - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
  for (let pass = 0; pass < 4; pass++) {
    const acc = palette.map(() => [0, 0, 0, 0]);
    for (const b of used) {
      const k = nearest(mean(b, 0), mean(b, 1), mean(b, 2));
      binToColor[b] = k;
      acc[k][0] += sum[0][b];
      acc[k][1] += sum[1][b];
      acc[k][2] += sum[2][b];
      acc[k][3] += count[b];
    }
    palette = palette.map((c, k) => (acc[k][3] ? [acc[k][0] / acc[k][3], acc[k][1] / acc[k][3], acc[k][2] / acc[k][3]] : c));
  }
  for (const b of used) binToColor[b] = nearest(mean(b, 0), mean(b, 1), mean(b, 2));
  return { palette, binToColor };
}

// ---------------------------------------------------------------------------------------------
// Label clean-up
// ---------------------------------------------------------------------------------------------

/**
 * Anti-aliased edges leave a one-pixel rim whose colour is a blend of the two regions it
 * separates. Left alone it traces as a sliver, so such pixels join whichever side they resemble.
 */
function absorbBlendedEdges(labels: Int16Array, image: TraceImage, palette: number[][]): void {
  const { width: w, height: h, data } = image;
  const n = palette.length;
  // between[c * n * n + a * n + b]: colour c sits on the line from colour a to colour b.
  const between = new Uint8Array(n * n * n);
  for (let c = 0; c < n; c++) {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (a === b || a === c || b === c) continue;
        const A = palette[a];
        const B = palette[b];
        const C = palette[c];
        const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
        const t = ((C[0] - A[0]) * ab[0] + (C[1] - A[1]) * ab[1] + (C[2] - A[2]) * ab[2]) / len2;
        if (t < 0.1 || t > 0.9) continue;
        const off = Math.hypot(C[0] - A[0] - ab[0] * t, C[1] - A[1] - ab[1] * t, C[2] - A[2] - ab[2] * t);
        if (off < 0.12 * Math.sqrt(len2) + 6) between[c * n * n + a * n + b] = 1;
      }
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = labels.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = labels[i];
        if (c < 0) continue;
        const around = [x > 0 ? labels[i - 1] : -1, x < w - 1 ? labels[i + 1] : -1, y > 0 ? labels[i - w] : -1, y < h - 1 ? labels[i + w] : -1];
        let done = false;
        for (let p = 0; p < 4 && !done; p++) {
          const a = around[p];
          if (a < 0 || a === c) continue;
          for (let q = p + 1; q < 4; q++) {
            const b = around[q];
            if (b < 0 || b === c || b === a || !between[c * n * n + a * n + b]) continue;
            const dist = (k: number) => (palette[k][0] - data[i * 4]) ** 2 + (palette[k][1] - data[i * 4 + 1]) ** 2 + (palette[k][2] - data[i * 4 + 2]) ** 2;
            next[i] = dist(a) <= dist(b) ? a : b;
            done = true;
            break;
          }
        }
      }
    }
    labels.set(next);
  }
}

/** Gives every connected region smaller than `minArea` to the neighbour it shares most border with. */
function absorbSpecks(labels: Int16Array, w: number, h: number, minArea: number, colors: number): void {
  if (minArea <= 1) return;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const members: number[] = [];
  const border = new Int32Array(colors + 1);
  for (let start = 0; start < w * h; start++) {
    if (seen[start]) continue;
    const label = labels[start];
    members.length = 0;
    border.fill(0);
    stack.push(start);
    seen[start] = 1;
    let small = true;
    while (stack.length) {
      const i = stack.pop()!;
      if (small) {
        members.push(i);
        if (members.length >= minArea) small = false;
      }
      const x = i % w;
      const visit = (j: number) => {
        if (labels[j] === label) {
          if (!seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        } else if (small) border[labels[j] + 1]++;
      };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i < w * (h - 1)) visit(i + w);
    }
    if (!small) continue;
    let best = -2;
    let bestCount = 0;
    for (let k = 0; k <= colors; k++) {
      if (border[k] > bestCount) {
        bestCount = border[k];
        best = k - 1;
      }
    }
    // A speck that fills the whole image has no neighbour and stays as it is.
    if (best === -2) continue;
    for (const i of members) labels[i] = best;
  }
}

// ---------------------------------------------------------------------------------------------
// Outline tracing
// ---------------------------------------------------------------------------------------------

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** Closed outlines of every pixel whose rank is at least `level`, walked along pixel edges. */
function traceLoops(rank: Int16Array, w: number, h: number, level: number): P[][] {
  const vw = w + 1;
  // Per grid vertex, a bit for each direction (right, down, left, up) an outline edge leaves in.
  const out = new Uint8Array(vw * (h + 1));
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && rank[y * w + x] >= level;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rank[y * w + x] < level) continue;
      // Edges run clockwise around the pixel, so the filled side is always on the right.
      if (!inside(x, y - 1)) out[y * vw + x] |= 1;
      if (!inside(x + 1, y)) out[y * vw + x + 1] |= 2;
      if (!inside(x, y + 1)) out[(y + 1) * vw + x + 1] |= 4;
      if (!inside(x - 1, y)) out[(y + 1) * vw + x] |= 8;
    }
  }
  const loops: P[][] = [];
  for (let start = 0; start < out.length; start++) {
    while (out[start]) {
      let dir = 0;
      while (!(out[start] & (1 << dir))) dir++;
      const loop: P[] = [];
      let v = start;
      let prevDir = -1;
      do {
        // Only corners are recorded; straight runs collapse to their two ends.
        if (dir !== prevDir) loop.push({ x: v % vw, y: Math.floor(v / vw) });
        out[v] &= ~(1 << dir);
        v += DX[dir] + DY[dir] * vw;
        prevDir = dir;
        // Where two regions touch only at a corner, turning right keeps them as separate outlines.
        const options = out[v];
        const right = (dir + 1) & 3;
        const left = (dir + 3) & 3;
        dir = options & (1 << right) ? right : options & (1 << dir) ? dir : left;
      } while (v !== start);
      // The start vertex is redundant if the outline runs straight through it.
      if (loop.length > 2 && prevDir === dirBetween(loop[0], loop[1])) loop.shift();
      if (loop.length >= 4) loops.push(unstep(loop));
    }
  }
  return loops;
}

/**
 * A slanted or curved edge reaches us as a staircase of pixel corners that zigzags either side of
 * the true outline. The middle of every step lies on that outline, so the staircase is replaced
 * by its edge midpoints. A corner is kept only where two runs of at least two pixels meet, which
 * a staircase never produces: that is a real corner of the shape.
 */
function unstep(loop: P[]): P[] {
  const n = loop.length;
  const run = loop.map((a, i) => Math.abs(loop[(i + 1) % n].x - a.x) + Math.abs(loop[(i + 1) % n].y - a.y));
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    if (run[i] >= 2 && run[(i + n - 1) % n] >= 2) out.push(a);
    out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return out;
}

function dirBetween(a: P, b: P): number {
  return b.x > a.x ? 0 : b.y > a.y ? 1 : b.x < a.x ? 2 : 3;
}

function polygonArea(pts: P[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function segmentDistance(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Ramer-Douglas-Peucker on a closed outline. Returns the indices of the points to keep, in order. */
function simplifyLoop(pts: P[], tolerance: number): number[] {
  const n = pts.length;
  if (n <= 3 || tolerance <= 0) return pts.map((_, i) => i);
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  // Ranges are index spans along the loop; the second one wraps back to point 0 (index n).
  const stack: [number, number][] = [[0, far], [far, n]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    const a = pts[from];
    const b = pts[to % n];
    let worst = -1;
    let worstD = tolerance;
    for (let i = from + 1; i < to; i++) {
      const d = segmentDistance(pts[i], a, b);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([from, worst], [worst, to]);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  // The two starting points were kept unconditionally; drop either if it sits on a straight run.
  return out.filter((index, k) => {
    if (out.length <= 3 || (index !== 0 && index !== far)) return true;
    const a = pts[out[(k + out.length - 1) % out.length]];
    const c = pts[out[(k + 1) % out.length]];
    return segmentDistance(pts[index], a, c) > 1e-9;
  });
}

/**
 * Turns a simplified outline into a contour. A vertex stays a sharp corner when the outline
 * clearly bends there (it sits far from the line joining its neighbours, or two dead-straight
 * runs meet at a real angle); every other vertex gets handles so the outline curves through it.
 */
function toContour(pts: P[], kept: number[], tolerance: number, smooth: boolean): Contour {
  const n = kept.length;
  const v = kept.map((i) => pts[i]);
  if (!smooth || n < 3) return { closed: true, pts: v.map((p) => pt(p.x, p.y)) };

  // How far the original outline strays from each simplified segment (segment i runs from i to i + 1).
  const stray = kept.map((from, i) => {
    const to = i + 1 < n ? kept[i + 1] : kept[0] + pts.length;
    const a = pts[from];
    const b = pts[to % pts.length];
    let worst = 0;
    for (let k = from + 1; k < to; k++) worst = Math.max(worst, segmentDistance(pts[k % pts.length], a, b));
    return worst;
  });

  return {
    closed: true,
    pts: v.map((b, i) => {
      const a = v[(i + n - 1) % n];
      const c = v[(i + 1) % n];
      const inLen = Math.hypot(b.x - a.x, b.y - a.y);
      const outLen = Math.hypot(c.x - b.x, c.y - b.y);
      const chord = Math.hypot(c.x - a.x, c.y - a.y);
      if (!inLen || !outLen || !chord) return pt(b.x, b.y);
      const cos = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (inLen * outLen);
      const turn = Math.acos(Math.min(1, Math.max(-1, cos)));
      const offLine = Math.abs((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / chord;
      const straightIn = stray[(i + n - 1) % n] <= 0.75 && inLen >= 3;
      const straightOut = stray[i] <= 0.75 && outLen >= 3;
      // On a circle traced within `tolerance`, a vertex is never more than 4 x tolerance off its neighbours' chord.
      const corner = offLine > 4.5 * tolerance || (turn > Math.PI / 3 && straightIn && straightOut);
      if (corner) return pt(b.x, b.y);
      const tx = (c.x - a.x) / chord;
      const ty = (c.y - a.y) / chord;
      // A long straight run next to a short curved one must not bulge: cap each handle by the shorter side.
      const cap = Math.min(inLen, outLen) * 0.6;
      const hi = Math.min(inLen / 3, cap);
      const ho = Math.min(outLen / 3, cap);
      return pt(b.x, b.y, -tx * hi, -ty * hi, tx * ho, ty * ho);
    }),
  };
}

// ---------------------------------------------------------------------------------------------

const hex = (c: number[]) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/**
 * Converts a bitmap into flat-coloured vector shapes.
 *
 * Shapes come back ordered back to front, largest colour area first, and are stacked: each shape
 * also covers the area of every shape in front of it, so neighbouring colours never show a seam
 * between them. Pixels with alpha below 128 are treated as empty.
 */
export function traceImage(image: TraceImage, opts: TraceOptions = {}): TracedShape[] {
  const { width: w, height: h, data } = image;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || data.length < w * h * 4) {
    throw new Error('traceImage needs RGBA data that matches the given width and height.');
  }
  const colors = Math.min(32, Math.max(2, Math.round(opts.colors ?? 12)));
  const minArea = Math.max(0, opts.minArea ?? 12);
  const tolerance = Math.max(0, opts.tolerance ?? 1);
  const smooth = opts.smooth ?? true;

  const { palette, binToColor } = buildPalette(image, colors);
  if (!palette.length) return [];
  const labels = new Int16Array(w * h);
  for (let i = 0; i < w * h; i++) {
    labels[i] = data[i * 4 + 3] < 128 ? -1 : binToColor[binOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])];
  }
  absorbBlendedEdges(labels, image, palette);
  absorbSpecks(labels, w, h, minArea, palette.length);

  const area = new Float64Array(palette.length);
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) area[labels[i]]++;
  const order = palette.map((_, k) => k).filter((k) => area[k] > 0).sort((a, b) => area[b] - area[a]);
  const rankOf = new Int16Array(palette.length).fill(-1);
  order.forEach((k, r) => (rankOf[k] = r));
  const rank = new Int16Array(w * h);
  for (let i = 0; i < labels.length; i++) rank[i] = labels[i] < 0 ? -1 : rankOf[labels[i]];

  const shapes: TracedShape[] = [];
  order.forEach((k, level) => {
    const contours: Contour[] = [];
    for (const loop of traceLoops(rank, w, h, level)) {
      if (Math.abs(polygonArea(loop)) < Math.max(1, minArea)) continue;
      const kept = simplifyLoop(loop, tolerance);
      if (kept.length >= 3) contours.push(toContour(loop, kept, tolerance, smooth));
    }
    if (contours.length) shapes.push({ color: hex(palette[k]), path: { contours } });
  });
  return shapes;
}
