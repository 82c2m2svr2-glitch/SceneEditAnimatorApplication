import { encodeCanvasPng } from './pngSequence';
import { throwIfAborted, type ExportOptions, type FrameSource } from './types';

const MAX_SHEET_SIZE = 16384;

interface SpriteGridOptions {
  columns?: number;
  padding?: number;
}

type SpriteSource = Pick<FrameSource, 'width' | 'height' | 'fps' | 'frameCount'>;

export function spriteSheetLayout(
  { width, height, fps, frameCount }: SpriteSource,
  { columns, padding = 0 }: SpriteGridOptions = {},
) {
  if (![width, height, frameCount].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Sprite sheets require positive integer frame dimensions and frame count.');
  }
  if (!Number.isSafeInteger(padding) || padding < 0) {
    throw new Error('Sprite sheet padding must be a non-negative integer.');
  }
  if (columns !== undefined && (!Number.isSafeInteger(columns) || columns < 1)) {
    throw new Error('Sprite sheet columns must be a positive integer.');
  }

  const strideX = width + padding;
  const strideY = height + padding;
  const maxColumns = Math.floor((MAX_SHEET_SIZE - width) / strideX) + 1;
  const maxRows = Math.floor((MAX_SHEET_SIZE - height) / strideY) + 1;
  if (maxColumns < 1 || maxRows < 1 || frameCount > maxColumns * maxRows) {
    throw new Error(`Sprite sheet would exceed ${MAX_SHEET_SIZE} pixels on a side.`);
  }
  const minColumns = Math.ceil(frameCount / maxRows);
  const squareColumns = Math.round(Math.sqrt(frameCount * strideY / strideX));
  const gridColumns = columns === undefined
    ? Math.max(minColumns, Math.min(frameCount, maxColumns, squareColumns))
    : Math.min(frameCount, columns);
  const rows = Math.ceil(frameCount / gridColumns);
  if (gridColumns > maxColumns || rows > maxRows) {
    throw new Error(`Sprite sheet would exceed ${MAX_SHEET_SIZE} pixels on a side.`);
  }

  return {
    width: width + (gridColumns - 1) * strideX,
    height: height + (rows - 1) * strideY,
    fps,
    frameCount,
    frames: Array.from({ length: frameCount }, (_, index) => ({
      x: (index % gridColumns) * strideX,
      y: Math.floor(index / gridColumns) * strideY,
      w: width,
      h: height,
    })),
  };
}

export async function exportSpriteSheet(
  source: FrameSource,
  opts: ExportOptions & SpriteGridOptions,
): Promise<{ png: Blob; json: string }> {
  throwIfAborted(opts.signal);
  const layout = spriteSheetLayout(source, opts);
  const canvas = typeof OffscreenCanvas === 'undefined'
    ? document.createElement('canvas')
    : new OffscreenCanvas(layout.width, layout.height);
  if (canvas.width !== layout.width) canvas.width = layout.width;
  if (canvas.height !== layout.height) canvas.height = layout.height;
  const context = canvas.getContext('2d');
  if (!context || !('drawImage' in context)) {
    throw new Error('Could not create the sprite sheet canvas.');
  }

  for (const [index, frame] of layout.frames.entries()) {
    throwIfAborted(opts.signal);
    const image = await source.render(index);
    throwIfAborted(opts.signal);
    context.drawImage(image, frame.x, frame.y, frame.w, frame.h);
    opts.onProgress?.({ progress: (index + 1) / layout.frameCount, stage: 'Drawing sprite sheet' });
  }
  throwIfAborted(opts.signal);
  const png = await encodeCanvasPng(canvas);
  throwIfAborted(opts.signal);
  return { png, json: JSON.stringify(layout) };
}
