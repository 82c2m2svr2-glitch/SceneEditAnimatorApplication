import type { Viseme } from '../core/character/spec';

export interface LipSyncOptions {
  /** Above 1 the mouth reacts to quieter sound and opens wider; below 1 it moves less. Default 1. */
  sensitivity?: number;
  /** Shortest time, in frames, any mouth shape is held. Default 2. */
  minHold?: number;
}

export interface VisemeChange {
  frame: number;
  viseme: Viseme;
}

/** What one animation frame of audio sounds like. */
interface FrameFeatures {
  rms: number;
  /** Share of spectral energy per band, after pre-emphasis: 80-600 Hz, 600-1400, 1400-3500, above. */
  low: number;
  mid: number;
  bright: number;
  hiss: number;
  /** Dominant frequency estimated from zero crossings, in Hz. */
  zcHz: number;
}

/** In-place radix-2 FFT. `re` and `im` must have a power-of-two length. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function percentile(sorted: Float32Array, p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

export function measure(samples: Float32Array, sampleRate: number, fps: number): FrameFeatures[] {
  const hop = sampleRate / fps;
  const frames = Math.max(1, Math.ceil(samples.length / hop));
  // About 40 ms of sound per analysis window, whatever the sample rate.
  let size = 256;
  while (size < sampleRate * 0.04 && size < 4096) size <<= 1;
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const binHz = sampleRate / size;
  const out: FrameFeatures[] = [];

  for (let f = 0; f < frames; f++) {
    const from = Math.floor(f * hop);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((f + 1) * hop)));
    let sum = 0;
    let crossings = 0;
    for (let i = from; i < to; i++) {
      sum += samples[i] * samples[i];
      if (i > from && samples[i] >= 0 !== samples[i - 1] >= 0) crossings++;
    }
    const length = to - from;
    const rms = Math.sqrt(sum / length);
    const zcHz = length > 1 ? (crossings / (length - 1)) * sampleRate * 0.5 : 0;

    // Spectrum of a window centred on the frame. Pre-emphasis flattens the natural tilt of a
    // voice so the upper bands can be compared with the lower ones.
    const centre = Math.floor((from + to) / 2);
    const start = centre - (size >> 1);
    for (let i = 0; i < size; i++) {
      const at = start + i;
      const cur = at >= 0 && at < samples.length ? samples[at] : 0;
      const prev = at - 1 >= 0 && at - 1 < samples.length ? samples[at - 1] : 0;
      re[i] = (cur - 0.95 * prev) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let low = 0;
    let mid = 0;
    let bright = 0;
    let hiss = 0;
    for (let k = 1; k < size / 2; k++) {
      const hz = k * binHz;
      if (hz < 80) continue;
      const power = re[k] * re[k] + im[k] * im[k];
      if (hz < 600) low += power;
      else if (hz < 1400) mid += power;
      else if (hz < 3500) bright += power;
      else hiss += power;
    }
    const total = low + mid + bright + hiss || 1;
    out.push({ rms, low: low / total, mid: mid / total, bright: bright / total, hiss: hiss / total, zcHz });
  }
  return out;
}

/**
 * Picks a mouth shape for every animation frame of a piece of audio and returns the frames where
 * the shape changes (a step track that always starts at frame 0).
 *
 * There is no speech recognition here. Shapes come from how loud each frame is and where its
 * energy sits: silence closes the mouth, a sudden start presses the lips first, hiss gives the
 * teeth-on-lip shape, and voiced sound opens the mouth wider, brighter or rounder depending on
 * its loudness and tone. The result is meant as a good first pass to adjust by hand.
 */
export function analyzeVisemes(samples: Float32Array, sampleRate: number, fps: number, opts: LipSyncOptions = {}): VisemeChange[] {
  if (!(sampleRate > 0) || !(fps > 0)) throw new Error('Lip-sync needs a positive sample rate and frame rate.');
  const sensitivity = Math.min(4, Math.max(0.25, opts.sensitivity ?? 1));
  const minHold = Math.max(1, Math.round(opts.minHold ?? 2));
  if (!samples.length) return [{ frame: 0, viseme: 'rest' }];

  const feats = measure(samples, sampleRate, fps);
  const n = feats.length;
  const levels = Float32Array.from(feats, (f) => f.rms).sort();
  // Loudness is judged against the loud parts of this clip, so quiet and hot recordings behave alike.
  const loud = percentile(levels, 0.95);
  if (loud < 1e-4) return [{ frame: 0, viseme: 'rest' }];
  const floor = percentile(levels, 0.1);
  const silence = Math.min(loud * 0.5, Math.max(floor * 1.8, (loud * 0.12) / sensitivity));

  // Blend each frame's tone with its neighbours, weighted by energy. The first and last frames
  // of a sound are mostly spectral splatter; this lets the body of the sound decide the vowel.
  const tone = feats.map((_, i) => {
    let low = 0;
    let mid = 0;
    let bright = 0;
    let weight = 0;
    for (let d = -1; d <= 1; d++) {
      const f = feats[i + d];
      if (!f) continue;
      const w = f.rms * f.rms * (d === 0 ? 2 : 1);
      low += f.low * w;
      mid += f.mid * w;
      bright += f.bright * w;
      weight += w;
    }
    weight ||= 1;
    return { low: low / weight, mid: mid / weight, bright: bright / weight };
  });

  const raw: Viseme[] = feats.map((f, i) => {
    if (f.rms < silence) return 'rest';
    // Noise with no pitch: s, f, sh, th.
    if (f.hiss > 0.5 && f.zcHz > 2500) return 'FV';
    const level = Math.min(1.5, (f.rms / loud) * sensitivity);
    if (level < 0.3) return 'etc';
    const t = tone[i];
    // A strong upper resonance means a spread mouth (ee, eh); a strong middle one an open jaw (ah).
    if (t.bright > 0.4 * (t.mid + t.bright) && t.bright > 0.04) return 'E';
    if (t.mid > 0.5) return level > 0.45 ? 'AI' : 'O';
    return level > 0.6 ? 'O' : 'U';
  });

  // A sharp start after silence: press the lips together just before the mouth opens.
  for (let i = 1; i < n; i++) {
    if (raw[i] === 'rest' || raw[i] === 'FV' || raw[i - 1] !== 'rest') continue;
    if (feats[i].rms < feats[i - 1].rms * 3 || feats[i].rms < loud * 0.35) continue;
    for (let k = 1; k <= minHold && i - k >= 0 && raw[i - k] === 'rest'; k++) raw[i - k] = 'MBP';
  }

  // Hold every shape for at least `minHold` frames so the mouth never flickers.
  const changes: VisemeChange[] = [{ frame: 0, viseme: raw[0] }];
  let last = 0;
  for (let i = 1; i < n; i++) {
    const current = changes[changes.length - 1].viseme;
    if (raw[i] === current || i - last < minHold) continue;
    changes.push({ frame: i, viseme: raw[i] });
    last = i;
  }
  return changes;
}
