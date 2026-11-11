/**
 * Reduces audio samples to `buckets` [min, max] pairs for drawing a waveform.
 * Every sample lands in exactly one bucket; an empty input gives all zeros.
 */
export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const count = Math.max(0, Math.floor(buckets));
  const out = new Float32Array(count * 2);
  if (!count || !samples.length) return out;
  const per = samples.length / count;
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((b + 1) * per)));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i < to; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo > hi) lo = hi = 0;
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}
