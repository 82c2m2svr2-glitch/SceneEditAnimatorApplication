import { Zip, ZipPassThrough } from 'fflate';
import { throwIfAborted, type ExportOptions, type FrameCanvas, type FrameSource } from './types';

export function pngFrameName(baseName: string, frameNumber: number, frameCount: number): string {
  const safeName = baseName.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').trim() || 'frame';
  const width = Math.max(4, String(frameCount).length);
  return `${safeName}_${String(frameNumber).padStart(width, '0')}.png`;
}

export function encodeCanvasPng(canvas: FrameCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode the canvas as PNG.'));
    }, 'image/png');
  });
}

export async function exportPngSequence(
  source: FrameSource,
  opts: ExportOptions & { baseName?: string },
): Promise<Blob> {
  throwIfAborted(opts.signal);
  const { frameCount } = source;
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 65535) {
    throw new Error('PNG sequence export supports 1 to 65535 frames per ZIP.');
  }

  const chunks: BlobPart[] = [];
  const zip = new Zip((error, data) => {
    if (error) throw error;
    // fflate types allow a shared buffer, which Blob does not accept.
    chunks.push(new Uint8Array(data));
  });
  try {
    for (let index = 0; index < frameCount; index++) {
      throwIfAborted(opts.signal);
      const canvas = await source.render(index);
      throwIfAborted(opts.signal);
      const png = await encodeCanvasPng(canvas);
      throwIfAborted(opts.signal);
      const bytes = await png.arrayBuffer();
      throwIfAborted(opts.signal);
      // PNG already uses lossless compression. Store each file without recompressing it.
      const entry = new ZipPassThrough(pngFrameName(opts.baseName ?? 'frame', index + 1, frameCount));
      zip.add(entry);
      entry.push(new Uint8Array(bytes), true);
      opts.onProgress?.({ progress: (index + 1) / frameCount, stage: 'Encoding PNG sequence' });
    }
    throwIfAborted(opts.signal);
    zip.end();
    return new Blob(chunks, { type: 'application/zip' });
  } catch (error) {
    zip.terminate();
    throw error;
  }
}
