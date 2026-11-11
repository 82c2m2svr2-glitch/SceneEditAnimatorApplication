import {
  AudioBufferSource, BufferTarget, CanvasSource, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec, Mp4OutputFormat, Output,
  QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_VERY_HIGH, WebMOutputFormat,
} from 'mediabunny';
import { throwIfAborted, type ExportOptions, type FrameSource } from './types';

export interface VideoExportOptions extends ExportOptions {
  format: 'mp4' | 'webm';
  quality: 'medium' | 'high' | 'best';
  /** Finished soundtrack, or null for a silent video. */
  audio?: AudioBuffer | null;
}

export interface VideoExportResult {
  blob: Blob;
  /** Things the user should know, e.g. that this browser could not encode the soundtrack. */
  warnings: string[];
}

/** True when this browser can encode video at all (WebCodecs). */
export function videoExportSupported(): boolean {
  return typeof VideoEncoder !== 'undefined';
}

/** Encodes frames (and an optional soundtrack) into an MP4 or WebM file. */
export async function exportVideo(source: FrameSource, opts: VideoExportOptions): Promise<VideoExportResult> {
  if (!videoExportSupported()) throw new Error('This browser cannot encode video. Use the desktop app or a Chromium-based browser, or export a PNG sequence instead.');
  if (source.width % 2 || source.height % 2) throw new Error('Video width and height must be even numbers.');
  const warnings: string[] = [];
  const format = opts.format === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat();
  const quality = opts.quality === 'best' ? QUALITY_VERY_HIGH : opts.quality === 'high' ? QUALITY_HIGH : QUALITY_MEDIUM;
  const codec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), { width: source.width, height: source.height });
  if (!codec) throw new Error(`This device has no ${opts.format.toUpperCase()} video encoder for ${source.width} x ${source.height}. Try the other format or a smaller size.`);

  const target = new BufferTarget();
  const output = new Output({ format, target });
  const canvas = new OffscreenCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const video = new CanvasSource(canvas, { codec, bitrate: quality, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: source.fps });

  let audio: AudioBufferSource | null = null;
  if (opts.audio) {
    const audioCodec = await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), { numberOfChannels: opts.audio.numberOfChannels, sampleRate: opts.audio.sampleRate });
    if (audioCodec) {
      audio = new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_HIGH });
      output.addAudioTrack(audio);
    } else warnings.push(`This device cannot encode audio for ${opts.format.toUpperCase()}, so the video was exported without sound. WebM usually works where MP4 audio does not.`);
  }

  try {
    await output.start();
    for (let i = 0; i < source.frameCount; i++) {
      throwIfAborted(opts.signal);
      const frame = await source.render(i);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, source.width, source.height);
      ctx.drawImage(frame, 0, 0);
      await video.add(i / source.fps, 1 / source.fps);
      opts.onProgress?.({ progress: ((i + 1) / source.frameCount) * 0.95, stage: `Encoding frame ${i + 1} of ${source.frameCount}` });
      // Let the UI repaint and the cancel button work.
      if (i % 4 === 0) await new Promise((r) => setTimeout(r));
    }
    if (audio && opts.audio) {
      opts.onProgress?.({ progress: 0.96, stage: 'Encoding audio' });
      await audio.add(opts.audio);
    }
    opts.onProgress?.({ progress: 0.98, stage: 'Finishing file' });
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
  if (!target.buffer) throw new Error('The encoder produced no data.');
  return { blob: new Blob([target.buffer], { type: opts.format === 'mp4' ? 'video/mp4' : 'video/webm' }), warnings };
}
