import { evaluateScene } from '../core/anim';
import { planSequence } from '../core/sequence';
import type { Project, Scene } from '../core/types';
import { renderFrame, type Ctx2D } from '../render/draw';
import { preloadImages } from '../render/images';
import { preloadModels } from '../render/models';
import type { FrameCanvas, FrameSource } from './types';

export interface FrameSourceOptions {
  /** Scenes to export, in order. */
  scenes: Scene[];
  width: number;
  height: number;
  transparent?: boolean;
  /** Restrict a single-scene export to a frame range (inclusive start, exclusive end). */
  range?: { from: number; to: number };
}

export interface ProjectFrameSource extends FrameSource {
  /** Where each scene's audio belongs on the output timeline. */
  audioRanges: { scene: Scene; from: number; frames: number; at: number }[];
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function makeCanvas(w: number, h: number): { canvas: FrameCanvas; ctx: Ctx2D } {
  const canvas: FrameCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return { canvas, ctx: canvas.getContext('2d') as Ctx2D };
}

/** Builds the frame source every exporter consumes: finished frames, scene transitions included. */
export async function createFrameSource(project: Project, opts: FrameSourceOptions): Promise<ProjectFrameSource> {
  await preloadImages(project);
  await preloadModels(project);
  if (document.fonts?.ready) await document.fonts.ready;
  const { width, height } = opts;
  const transparent = !!opts.transparent;
  const single = opts.scenes.length === 1 && opts.range ? opts.range : null;
  const plan = planSequence(opts.scenes);
  const offset = single ? Math.max(0, Math.round(single.from)) : 0;
  const frameCount = single ? Math.max(1, Math.min(plan.total, Math.round(single.to)) - offset) : plan.total;
  const out = makeCanvas(width, height);
  const a = makeCanvas(width, height);
  const b = makeCanvas(width, height);

  const draw = (target: Ctx2D, sceneIndex: number, frame: number) => {
    const scene = opts.scenes[sceneIndex];
    renderFrame(target, project, evaluateScene(project, scene, frame), width, height, transparent);
  };

  return {
    width, height, fps: project.fps, frameCount, transparent,
    audioRanges: single
      ? [{ scene: opts.scenes[0], from: offset, frames: frameCount, at: 0 }]
      : plan.segments.map((s) => ({ scene: opts.scenes[s.scene], from: 0, frames: s.duration, at: s.start })),
    async render(index) {
      const s = plan.sample(index + offset);
      const g = out.ctx;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.clearRect(0, 0, width, height);
      if (!s.b) {
        draw(g, s.a.scene, s.a.frame);
      } else {
        draw(a.ctx, s.a.scene, s.a.frame);
        draw(b.ctx, s.b.scene, s.b.frame);
        const t = smooth(s.t);
        g.setTransform(1, 0, 0, 1, 0, 0);
        switch (s.type) {
          case 'wipeLeft':
          case 'wipeRight': {
            g.drawImage(a.canvas, 0, 0);
            g.save();
            g.beginPath();
            if (s.type === 'wipeLeft') g.rect(width * (1 - t), 0, width * t, height);
            else g.rect(0, 0, width * t, height);
            g.clip();
            g.clearRect(0, 0, width, height);
            g.drawImage(b.canvas, 0, 0);
            g.restore();
            break;
          }
          case 'slideLeft':
            g.drawImage(a.canvas, -width * t, 0);
            g.drawImage(b.canvas, width * (1 - t), 0);
            break;
          case 'slideRight':
            g.drawImage(a.canvas, width * t, 0);
            g.drawImage(b.canvas, -width * (1 - t), 0);
            break;
          default:
            g.drawImage(a.canvas, 0, 0);
            g.globalAlpha = t;
            g.drawImage(b.canvas, 0, 0);
            g.globalAlpha = 1;
        }
      }
      if (s.black > 0) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        if (transparent) {
          g.globalCompositeOperation = 'destination-out';
          g.fillStyle = `rgba(0,0,0,${s.black})`;
        } else g.fillStyle = `rgba(0,0,0,${s.black})`;
        g.fillRect(0, 0, width, height);
        g.globalCompositeOperation = 'source-over';
      }
      return out.canvas;
    },
  };
}
