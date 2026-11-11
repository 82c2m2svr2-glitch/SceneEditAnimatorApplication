import { describe, expect, it } from 'vitest';
import { spriteSheetLayout } from './spriteSheet';

describe('sprite sheet layout', () => {
  it('produces row-major frame rectangles and JSON metadata with gutter padding', () => {
    const layout = spriteSheetLayout(
      { width: 32, height: 16, fps: 24, frameCount: 3 },
      { columns: 2, padding: 4 },
    );

    expect(JSON.parse(JSON.stringify(layout))).toEqual({
      width: 68,
      height: 36,
      fps: 24,
      frameCount: 3,
      frames: [
        { x: 0, y: 0, w: 32, h: 16 },
        { x: 36, y: 0, w: 32, h: 16 },
        { x: 0, y: 20, w: 32, h: 16 },
      ],
    });
  });

  it('chooses a grid that fits when the frames are very tall', () => {
    const layout = spriteSheetLayout({ width: 100, height: 12000, fps: 24, frameCount: 3 });
    expect(layout).toMatchObject({ width: 300, height: 12000 });
  });

  it('allows 16384 pixels and rejects larger sheets before rendering', () => {
    const source = { width: 8192, height: 8, fps: 24, frameCount: 2 };
    expect(spriteSheetLayout(source, { columns: 2 }).width).toBe(16384);
    expect(() => spriteSheetLayout(source, { columns: 2, padding: 1 })).toThrow(/16384/);
    expect(() => spriteSheetLayout({ ...source, height: 16385 })).toThrow(/16384/);
  });
});
