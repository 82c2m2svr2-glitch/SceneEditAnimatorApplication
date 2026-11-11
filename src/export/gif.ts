// @ts-expect-error gifenc 1.0.3 does not ship TypeScript declarations.
import * as gifencModule from 'gifenc';
import { throwIfAborted, type ExportOptions, type FrameSource } from './types';

type Palette = number[][];

interface GifLibrary {
  quantize(rgba: Uint8ClampedArray, maxColors: number): Palette;
  applyPalette(rgba: Uint8ClampedArray, palette: Palette): Uint8Array;
  GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, options: {
      palette: Palette;
      transparent: boolean;
      transparentIndex: number;
      dispose: number;
      delay: number;
      repeat: number;
    }): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
  };
}

const gifenc = gifencModule as Partial<GifLibrary> & { default?: GifLibrary };
const { GIFEncoder, quantize, applyPalette } = (
  gifenc.GIFEncoder ? gifenc : gifenc.default
) as GifLibrary;

function indexFrame(rgba: Uint8ClampedArray, maxColors: number, transparent: boolean) {
  if (!transparent) {
    const palette = quantize(rgba, maxColors);
    return { palette, pixels: applyPalette(rgba, palette) };
  }

  // Quantize only visible colors so transparent pixels never use up an opaque palette entry.
  const opaque = new Uint8ClampedArray(rgba.length);
  let length = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3] < 128) continue;
    opaque[length++] = rgba[offset];
    opaque[length++] = rgba[offset + 1];
    opaque[length++] = rgba[offset + 2];
    opaque[length++] = 255;
  }

  const pixels = new Uint8Array(rgba.length / 4);
  if (length === 0) return { palette: [[0, 0, 0], [0, 0, 0]], pixels };

  const visible = opaque.subarray(0, length);
  const colors = quantize(visible, maxColors - 1);
  const indices = applyPalette(visible, colors);
  let index = 0;
  for (let pixel = 0; pixel < pixels.length; pixel++) {
    if (rgba[pixel * 4 + 3] >= 128) pixels[pixel] = indices[index++] + 1;
  }
  return { palette: [[0, 0, 0], ...colors], pixels };
}

export async function exportGif(
  source: FrameSource,
  opts: ExportOptions & { loop?: boolean; maxColors?: number },
): Promise<Blob> {
  throwIfAborted(opts.signal);
  const { width, height, fps, frameCount, transparent } = source;
  const maxColors = opts.maxColors ?? 256;
  if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 256) {
    throw new Error('GIF maxColors must be an integer from 2 to 256.');
  }
  if (![width, height].every((size) => Number.isInteger(size) && size > 0 && size <= 65535)) {
    throw new Error('GIF frame dimensions must be integers from 1 to 65535.');
  }
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(frameCount) || frameCount < 1) {
    throw new Error('GIF export requires at least one frame and a positive frame rate.');
  }

  const gif = GIFEncoder();
  for (let index = 0; index < frameCount; index++) {
    throwIfAborted(opts.signal);
    const canvas = await source.render(index);
    throwIfAborted(opts.signal);
    const context = canvas.getContext('2d');
    if (!context || !('getImageData' in context)) {
      throw new Error('Could not read the GIF frame canvas.');
    }
    const { data } = context.getImageData(0, 0, width, height);
    const { palette, pixels } = indexFrame(data, maxColors, transparent);
    // GIF stores centiseconds. Round cumulative time to avoid drifting at rates like 24 fps.
    const start = Math.round(index * 100 / fps);
    const end = Math.round((index + 1) * 100 / fps);
    gif.writeFrame(pixels, width, height, {
      palette,
      transparent,
      transparentIndex: 0,
      dispose: transparent ? 2 : 1,
      delay: Math.min(65535, Math.max(1, end - start)) * 10,
      repeat: opts.loop === false ? -1 : 0,
    });
    opts.onProgress?.({ progress: (index + 1) / frameCount, stage: 'Encoding GIF' });
  }
  throwIfAborted(opts.signal);
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}
