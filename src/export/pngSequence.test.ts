import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { exportPngSequence, pngFrameName } from './pngSequence';
import type { FrameSource } from './types';

describe('PNG sequence frame names', () => {
  it('uses one-based filenames padded to at least four digits', () => {
    expect(pngFrameName('shot', 1, 99)).toBe('shot_0001.png');
    expect(pngFrameName('shot', 99, 99)).toBe('shot_0099.png');
  });

  it('keeps names sortable when a sequence has more than four digits', () => {
    expect(pngFrameName('shot', 9999, 10000)).toBe('shot_09999.png');
    expect(pngFrameName('shot', 10000, 10000)).toBe('shot_10000.png');
  });

  it('keeps the name within the root of the archive', () => {
    expect(pngFrameName('../shots/intro', 1, 1)).toBe('.._shots_intro_0001.png');
    expect(pngFrameName('  ', 1, 1)).toBe('frame_0001.png');
  });
});

it('archives each frame before the renderer reuses its canvas', async () => {
  const requested: number[] = [];
  let pixel = 0;
  const canvas = {
    convertToBlob: async () => new Blob([Uint8Array.of(pixel)], { type: 'image/png' }),
  } as unknown as OffscreenCanvas;
  const source: FrameSource = {
    width: 1,
    height: 1,
    fps: 24,
    frameCount: 2,
    transparent: true,
    async render(index) {
      requested.push(index);
      pixel = index + 1;
      return canvas;
    },
  };
  const progress: number[] = [];

  const zip = await exportPngSequence(source, {
    baseName: 'shot',
    onProgress: (event) => progress.push(event.progress),
  });

  expect(zip.type).toBe('application/zip');
  expect(unzipSync(new Uint8Array(await zip.arrayBuffer()))).toEqual({
    'shot_0001.png': Uint8Array.of(1),
    'shot_0002.png': Uint8Array.of(2),
  });
  expect(requested).toEqual([0, 1]);
  expect(progress).toEqual([0.5, 1]);
});
