import type { Contour, Mat, PathData, PathPoint } from './types';
import { apply, applyVec, DEG, type Rect, type Vec } from './math';

export function pt(x: number, y: number, ix = 0, iy = 0, ox = 0, oy = 0): PathPoint {
  return { x, y, ix, iy, ox, oy };
}

// --- primitives --------------------------------------------------------------------------------

export function rectPath(x: number, y: number, w: number, h: number, radius = 0): PathData {
  const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2));
  if (r === 0) {
    return { contours: [{ closed: true, pts: [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)] }] };
  }
  const k = r * 0.5523;
  return {
    contours: [
      {
        closed: true,
        pts: [
          pt(x + r, y, -k, 0, 0, 0),
          pt(x + w - r, y, 0, 0, k, 0),
          pt(x + w, y + r, 0, -k, 0, 0),
          pt(x + w, y + h - r, 0, 0, 0, k),
          pt(x + w - r, y + h, k, 0, 0, 0),
          pt(x + r, y + h, 0, 0, -k, 0),
          pt(x, y + h - r, 0, k, 0, 0),
          pt(x, y + r, 0, 0, 0, -k),
        ],
      },
    ],
  };
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathData {
  const kx = rx * 0.5523;
  const ky = ry * 0.5523;
  return {
    contours: [
      {
        closed: true,
        pts: [
          pt(cx, cy - ry, -kx, 0, kx, 0),
          pt(cx + rx, cy, 0, -ky, 0, ky),
          pt(cx, cy + ry, kx, 0, -kx, 0),
          pt(cx - rx, cy, 0, ky, 0, -ky),
        ],
      },
    ],
  };
}

export function polygonPath(cx: number, cy: number, radius: number, sides: number, rotationDeg = -90): PathData {
  const pts: PathPoint[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotationDeg * DEG + (i / sides) * Math.PI * 2;
    pts.push(pt(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius));
  }
  return { contours: [{ closed: true, pts }] };
}

export function starPath(cx: number, cy: number, outer: number, inner: number, points: number): PathData {
  const pts: PathPoint[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? outer : inner;
    pts.push(pt(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return { contours: [{ closed: true, pts }] };
}

export function linePath(x1: number, y1: number, x2: number, y2: number): PathData {
  return { contours: [{ closed: false, pts: [pt(x1, y1), pt(x2, y2)] }] };
}

export function polylinePath(points: Vec[], closed: boolean): PathData {
  return { contours: [{ closed, pts: points.map((p) => pt(p.x, p.y)) }] };
}

/**
 * Smooth closed or open curve through the given points (Catmull-Rom converted to bezier handles).
 * Handy for organic shapes: bodies, hair, clouds.
 */
export function smoothPath(points: Vec[], closed: boolean, tension = 0.5): PathData {
  const n = points.length;
  const pts: PathPoint[] = points.map((p, i) => {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tx = ((next.x - prev.x) * tension) / 3;
    const ty = ((next.y - prev.y) * tension) / 3;
    const isEnd = !closed && (i === 0 || i === n - 1);
    return isEnd ? pt(p.x, p.y) : pt(p.x, p.y, -tx, -ty, tx, ty);
  });
  return { contours: [{ closed, pts }] };
}

// --- traversal ---------------------------------------------------------------------------------

export function pointCount(path: PathData): number {
  let n = 0;
  for (const c of path.contours) n += c.pts.length;
  return n;
}

export function clonePath(path: PathData): PathData {
  return { contours: path.contours.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => ({ ...p })) })) };
}

export function transformPath(path: PathData, m: Mat): PathData {
  return {
    contours: path.contours.map((c) => ({
      closed: c.closed,
      pts: c.pts.map((p) => {
        const a = apply(m, p.x, p.y);
        const i = applyVec(m, p.ix, p.iy);
        const o = applyVec(m, p.ox, p.oy);
        return { x: a.x, y: a.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y };
      }),
    })),
  };
}

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** Emits the path into a canvas context, Path2D or any sink with the same methods. */
export function tracePath(sink: PathSink, path: PathData): void {
  for (const c of path.contours) traceContour(sink, c);
}

function traceContour(sink: PathSink, c: Contour): void {
  const pts = c.pts;
  if (pts.length === 0) return;
  sink.moveTo(pts[0].x, pts[0].y);
  const n = pts.length;
  const segs = c.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (a.ox === 0 && a.oy === 0 && b.ix === 0 && b.iy === 0) sink.lineTo(b.x, b.y);
    else sink.bezierCurveTo(a.x + a.ox, a.y + a.oy, b.x + b.ix, b.y + b.iy, b.x, b.y);
  }
  if (c.closed) sink.closePath();
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Samples the path into polylines, one per contour. */
export function flattenPath(path: PathData, stepsPerCurve = 12): Vec[][] {
  const out: Vec[][] = [];
  for (const c of path.contours) {
    const pts = c.pts;
    const n = pts.length;
    if (n === 0) continue;
    const line: Vec[] = [{ x: pts[0].x, y: pts[0].y }];
    const segs = c.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (a.ox === 0 && a.oy === 0 && b.ix === 0 && b.iy === 0) {
        line.push({ x: b.x, y: b.y });
      } else {
        for (let s = 1; s <= stepsPerCurve; s++) {
          const t = s / stepsPerCurve;
          line.push({
            x: cubicAt(a.x, a.x + a.ox, b.x + b.ix, b.x, t),
            y: cubicAt(a.y, a.y + a.oy, b.y + b.iy, b.y, t),
          });
        }
      }
    }
    out.push(line);
  }
  return out;
}

export function pathBounds(path: PathData): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const line of flattenPath(path, 8)) {
    for (const p of line) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// --- SVG path data -----------------------------------------------------------------------------

const r3 = (v: number) => Math.round(v * 100) / 100;

export function pathToSvg(path: PathData): string {
  const parts: string[] = [];
  tracePath(
    {
      moveTo: (x, y) => parts.push(`M${r3(x)} ${r3(y)}`),
      lineTo: (x, y) => parts.push(`L${r3(x)} ${r3(y)}`),
      bezierCurveTo: (a, b, c, d, x, y) => parts.push(`C${r3(a)} ${r3(b)} ${r3(c)} ${r3(d)} ${r3(x)} ${r3(y)}`),
      closePath: () => parts.push('Z'),
    },
    path,
  );
  return parts.join('');
}

/**
 * Parses an SVG path `d` attribute. Supports every command (M L H V C S Q T A Z, absolute and
 * relative). Quadratics and arcs are converted to cubic beziers.
 */
export function parseSvgPath(d: string): PathData {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const contours: Contour[] = [];
  let cur: Contour | null = null;
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastCtrlX = 0;
  let lastCtrlY = 0;
  let lastCmd = '';

  const num = (): number => {
    const v = parseFloat(tokens[i++]);
    return Number.isFinite(v) ? v : 0;
  };
  const hasNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);
  const begin = (px: number, py: number) => {
    cur = { closed: false, pts: [pt(px, py)] };
    contours.push(cur);
  };
  const ensure = () => {
    if (!cur) begin(x, y);
  };
  const last = () => cur!.pts[cur!.pts.length - 1];
  const lineTo = (px: number, py: number) => {
    ensure();
    cur!.pts.push(pt(px, py));
  };
  const curveTo = (c1x: number, c1y: number, c2x: number, c2y: number, px: number, py: number) => {
    ensure();
    const a = last();
    a.ox = c1x - a.x;
    a.oy = c1y - a.y;
    cur!.pts.push(pt(px, py, c2x - px, c2y - py));
  };

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (cmd === '') {
      i++;
      continue;
    } else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (C) {
      case 'M': {
        x = num() + ox;
        y = num() + oy;
        startX = x;
        startY = y;
        begin(x, y);
        break;
      }
      case 'L': {
        x = num() + ox;
        y = num() + oy;
        lineTo(x, y);
        break;
      }
      case 'H': {
        x = num() + ox;
        lineTo(x, y);
        break;
      }
      case 'V': {
        y = num() + oy;
        lineTo(x, y);
        break;
      }
      case 'C': {
        const c1x = num() + ox, c1y = num() + oy, c2x = num() + ox, c2y = num() + oy;
        x = num() + ox;
        y = num() + oy;
        curveTo(c1x, c1y, c2x, c2y, x, y);
        lastCtrlX = c2x;
        lastCtrlY = c2y;
        break;
      }
      case 'S': {
        const smooth = 'CS'.includes(lastCmd.toUpperCase());
        const c1x = smooth ? 2 * x - lastCtrlX : x;
        const c1y = smooth ? 2 * y - lastCtrlY : y;
        const c2x = num() + ox, c2y = num() + oy;
        x = num() + ox;
        y = num() + oy;
        curveTo(c1x, c1y, c2x, c2y, x, y);
        lastCtrlX = c2x;
        lastCtrlY = c2y;
        break;
      }
      case 'Q':
      case 'T': {
        let qx: number;
        let qy: number;
        if (C === 'Q') {
          qx = num() + ox;
          qy = num() + oy;
        } else {
          const smooth = 'QT'.includes(lastCmd.toUpperCase());
          qx = smooth ? 2 * x - lastCtrlX : x;
          qy = smooth ? 2 * y - lastCtrlY : y;
        }
        const ex = num() + ox, ey = num() + oy;
        curveTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        x = ex;
        y = ey;
        lastCtrlX = qx;
        lastCtrlY = qy;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const ex = num() + ox, ey = num() + oy;
        for (const s of arcToCubics(x, y, rx, ry, rot, large !== 0, sweep !== 0, ex, ey)) {
          curveTo(s[0], s[1], s[2], s[3], s[4], s[5]);
        }
        x = ex;
        y = ey;
        break;
      }
      case 'Z': {
        if (cur) {
          const c: Contour = cur;
          c.closed = true;
          // Drop a duplicated closing point, keeping its incoming handle.
          const first = c.pts[0];
          const end = c.pts[c.pts.length - 1];
          if (c.pts.length > 1 && Math.abs(first.x - end.x) < 1e-6 && Math.abs(first.y - end.y) < 1e-6) {
            first.ix = end.ix;
            first.iy = end.iy;
            c.pts.pop();
          }
        }
        x = startX;
        y = startY;
        cur = null;
        break;
      }
      default: {
        // Unknown command: skip its numbers so parsing can continue.
        while (hasNum()) i++;
      }
    }
    lastCmd = cmd;
    if (C === 'Z') continue;
  }
  return { contours: contours.filter((c) => c.pts.length > 0) };
}

/** Converts an SVG elliptical arc into cubic bezier segments [c1x, c1y, c2x, c2y, x, y]. */
function arcToCubics(
  x1: number, y1: number, rxIn: number, ryIn: number, rotDeg: number,
  large: boolean, sweep: boolean, x2: number, y2: number,
): number[][] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
  const phi = rotDeg * DEG;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const numr = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, numr / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  else if (sweep && dth < 0) dth += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
  const delta = dth / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out: number[][] = [];
  const point = (a: number) => {
    const ex = rx * Math.cos(a);
    const ey = ry * Math.sin(a);
    return { x: cx + cosP * ex - sinP * ey, y: cy + sinP * ex + cosP * ey, dx: -cosP * rx * Math.sin(a) - sinP * ry * Math.cos(a), dy: -sinP * rx * Math.sin(a) + cosP * ry * Math.cos(a) };
  };
  for (let s = 0; s < segs; s++) {
    const a0 = th1 + s * delta;
    const a1 = a0 + delta;
    const p0 = point(a0);
    const p1 = point(a1);
    out.push([p0.x + t * p0.dx, p0.y + t * p0.dy, p1.x - t * p1.dx, p1.y - t * p1.dy, p1.x, p1.y]);
  }
  return out;
}

// --- hit testing (pure, used by tools and tests) -------------------------------------------------

/** Even-odd point-in-polygon over flattened contours. */
export function pathContains(path: PathData, x: number, y: number): boolean {
  let inside = false;
  for (const line of flattenPath(path, 10)) {
    for (let i = 0, j = line.length - 1; i < line.length; j = i++) {
      const a = line[i];
      const b = line[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from a point to the path outline. */
export function distToPath(path: PathData, x: number, y: number): number {
  let best = Infinity;
  const lines = flattenPath(path, 10);
  path.contours.forEach((c, ci) => {
    const line = lines[ci];
    if (!line) return;
    const n = line.length;
    const segs = c.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = line[i];
      const b = line[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
      const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
      if (d < best) best = d;
    }
  });
  return best;
}
