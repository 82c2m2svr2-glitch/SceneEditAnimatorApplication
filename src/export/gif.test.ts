import { describe, expect, it } from 'vitest';
import { exportGif } from './gif';
import type { FrameSource } from './types';

function onePixelSource(): FrameSource {
  return {
    width: 1,
    height: 1,
    fps: 24,
    frameCount: 3,
    transparent: true,
    async render(index) {
      return {
        getContext: () => ({
          getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, index ? 0 : 255]) }),
        }),
      } as unknown as OffscreenCanvas;
    },
  };
}

describe('GIF export', () => {
  it('writes a transparent non-looping GIF with cumulative frame delays', async () => {
    const gif = await exportGif(onePixelSource(), { loop: false, maxColors: 2 });
    const bytes = new Uint8Array(await gif.arrayBuffer());
    expect(gif.type).toBe('image/gif');
    const encoded = new TextDecoder().decode(bytes);
    expect(encoded.startsWith('GIF89a')).toBe(true);
    expect(encoded).not.toContain('NETSCAPE2.0');
    expect(bytes.at(-1)).toBe(0x3b);

    const delays: number[] = [];
    for (let index = 0; index < bytes.length - 7; index++) {
      if (bytes[index] !== 0x21 || bytes[index + 1] !== 0xf9 || bytes[index + 2] !== 4) continue;
      expect(bytes[index + 3] & 0b11101).toBe(0b1001);
      expect(bytes[index + 6]).toBe(0);
      delays.push(bytes[index + 4] + 256 * bytes[index + 5]);
    }
    expect(delays).toEqual([4, 4, 5]);
  });

  it('stops before requesting a second frame when progress triggers cancellation', async () => {
    const abort = new AbortController();
    const source = onePixelSource();
    const render = source.render;
    const requested: number[] = [];
    source.render = (index) => {
      requested.push(index);
      return render(index);
    };

    await expect(exportGif(source, {
      signal: abort.signal,
      onProgress: () => abort.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requested).toEqual([0]);
  });
});
