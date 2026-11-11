import type { Viseme } from './spec';

/**
 * Rough mouth shapes from written text, for dialogue without recorded audio.
 * Returns one entry per change of mouth shape, starting at `startFrame`.
 */
export function textToVisemes(text: string, fps: number, startFrame = 0, charsPerSecond = 14): { frame: number; viseme: Viseme }[] {
  const out: { frame: number; viseme: Viseme }[] = [];
  const perChar = fps / charsPerSecond;
  let t = startFrame;
  const push = (v: Viseme) => {
    const frame = Math.round(t);
    const last = out[out.length - 1];
    if (last && last.viseme === v) return;
    if (last && last.frame === frame) last.viseme = v;
    else out.push({ frame, viseme: v });
  };
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i];
    const next = lower[i + 1] ?? '';
    if (/[.!?]/.test(c)) {
      push('rest');
      t += perChar * 5;
    } else if (/[,;:—-]/.test(c)) {
      push('rest');
      t += perChar * 2.5;
    } else if (/\s/.test(c)) {
      t += perChar * 0.6;
    } else if (!/[a-z]/.test(c)) {
      continue;
    } else {
      let v: Viseme;
      if (c === 'o' && next === 'o') v = 'U';
      else if ('ai'.includes(c)) v = 'AI';
      else if (c === 'e' || c === 'y') v = 'E';
      else if (c === 'o') v = 'O';
      else if (c === 'u') v = 'U';
      else if (c === 'w' || c === 'q') v = 'WQ';
      else if ('mbp'.includes(c)) v = 'MBP';
      else if ('fv'.includes(c)) v = 'FV';
      else if (c === 'l') v = 'L';
      else v = 'etc';
      push(v);
      t += perChar;
    }
  }
  t += perChar;
  push('rest');
  return out;
}
