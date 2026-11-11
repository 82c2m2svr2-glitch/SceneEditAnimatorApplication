/**
 * Shared contract between the frame renderer and every exporter (video, GIF, PNG sequence,
 * sprite sheet). An exporter never touches the document: it only pulls finished frames.
 */

export type FrameCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface FrameSource {
  /** Output pixel size. */
  width: number;
  height: number;
  fps: number;
  /** Total frames to export, across every scene in the range. */
  frameCount: number;
  /** True when frames have a transparent background. */
  transparent: boolean;
  /**
   * Renders output frame `index` (0-based) and returns the canvas holding it. The same canvas
   * object is reused for every call, so read or copy its pixels before requesting the next frame.
   */
  render(index: number): Promise<FrameCanvas>;
}

export interface ExportProgress {
  /** 0..1 */
  progress: number;
  stage: string;
}

export interface ExportOptions {
  onProgress?: (p: ExportProgress) => void;
  /** Abort support: exporters check `signal.aborted` between frames and reject with AbortError. */
  signal?: AbortSignal;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}
