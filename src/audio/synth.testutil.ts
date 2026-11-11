/** Test helpers that synthesise simple speech-like sounds. Not used by the app. */

export const SR = 24000;

export function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR));
}

export function tone(hz: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

/** Deterministic white noise, high-passed so it resembles an "s". */
export function hiss(seconds: number, amp = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let seed = 12345;
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const white = seed / 2147483648 - 1;
    out[i] = amp * (white - prev);
    prev = white;
  }
  return out;
}

/** A vowel: a 120 Hz pulse train shaped by two-pole resonators at the given formants. */
export function vowel(formants: [number, number, number], seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * SR);
  let signal = new Float32Array(n);
  const period = Math.round(SR / 120);
  for (let i = 0; i < n; i += period) signal[i] = 1;
  // Glottal tilt: a gentle low-pass.
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.25 * (signal[i] - lp);
    signal[i] = lp;
  }
  const bandwidths = [80, 100, 140];
  let mix = new Float32Array(n);
  formants.forEach((hz, k) => {
    const r = Math.exp((-Math.PI * bandwidths[k]) / SR);
    const a1 = 2 * r * Math.cos((2 * Math.PI * hz) / SR);
    const a2 = -r * r;
    let y1 = 0;
    let y2 = 0;
    const gain = [1, 0.5, 0.25][k];
    for (let i = 0; i < n; i++) {
      const y = signal[i] + a1 * y1 + a2 * y2;
      y2 = y1;
      y1 = y;
      mix[i] += gain * y * (1 - r);
    }
  });
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mix[i]));
  for (let i = 0; i < n; i++) mix[i] = (mix[i] / (peak || 1)) * amp;
  signal = mix;
  mix = signal;
  return mix;
}

export const VOWELS = {
  a: [800, 1200, 2500],
  e: [500, 1900, 2600],
  i: [300, 2300, 3000],
  o: [500, 900, 2500],
  u: [320, 800, 2300],
} satisfies Record<string, [number, number, number]>;

export function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
