import { clamp, lerp } from './math';

export type RGBA = [number, number, number, number];

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a',
  gray: '#808080', grey: '#808080', cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00',
  navy: '#000080', teal: '#008080', maroon: '#800000', olive: '#808000', silver: '#c0c0c0',
  gold: '#ffd700', beige: '#f5f5dc', tan: '#d2b48c', salmon: '#fa8072', skyblue: '#87ceeb',
  transparent: '#00000000',
};

const cache = new Map<string, RGBA>();

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba() and common names. Unknown input is black. */
export function parseColor(input: string): RGBA {
  const hit = cache.get(input);
  if (hit) return hit;
  let s = input.trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  let out: RGBA = [0, 0, 0, 1];
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      const r = n(0), g = n(2), b = n(4);
      const a = h.length === 8 ? n(6) / 255 : 1;
      if (![r, g, b, a].some(Number.isNaN)) out = [r, g, b, a];
    }
  } else {
    const m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map((v) => (v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v)));
      if (p.length >= 3 && !p.slice(0, 3).some(Number.isNaN)) {
        const rawA = m[1].split(/[\s,/]+/).filter(Boolean)[3];
        const a = rawA === undefined ? 1 : rawA.endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
        out = [p[0], p[1], p[2], Number.isNaN(a) ? 1 : a];
      }
    }
  }
  cache.set(input, out);
  return out;
}

export function toCss(c: RGBA): string {
  const r = Math.round(clamp(c[0], 0, 255));
  const g = Math.round(clamp(c[1], 0, 255));
  const b = Math.round(clamp(c[2], 0, 255));
  const a = clamp(c[3], 0, 1);
  if (a >= 0.999) return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `rgba(${r},${g},${b},${Math.round(a * 1000) / 1000})`;
}

export function toHex(input: string): string {
  const c = parseColor(input);
  return '#' + [c[0], c[1], c[2]].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}

export function lerpColor(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  return toCss([lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t), lerp(ca[3], cb[3], t)]);
}

export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  return toCss([c[0], c[1], c[2], c[3] * alpha]);
}

/** Multiplies brightness: factor < 1 darkens, > 1 lightens. */
export function shade(color: string, factor: number): string {
  const c = parseColor(color);
  if (factor <= 1) return toCss([c[0] * factor, c[1] * factor, c[2] * factor, c[3]]);
  const k = factor - 1;
  return toCss([c[0] + (255 - c[0]) * k, c[1] + (255 - c[1]) * k, c[2] + (255 - c[2]) * k, c[3]]);
}

export function isColorString(v: unknown): v is string {
  return typeof v === 'string' && (v.startsWith('#') || v.startsWith('rgb') || v.toLowerCase() in NAMED);
}
