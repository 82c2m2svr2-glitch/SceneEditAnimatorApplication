import { newId } from '../core/ids';
import type { Asset, AudioClip, ID, Project, Scene } from '../core/types';
import { addAsset, addAudioClip, scene as currentScene } from '../state/commands';
import { readAsDataUrl } from '../state/content';
import { onPlaybackStart, onPlaybackStop } from '../state/playback';
import { doc } from '../state/store';
import { requestRepaint, ui } from '../state/ui';

let ctx: AudioContext | null = null;

function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

const buffers = new Map<ID, { src: string; buffer: AudioBuffer | null; pending: Promise<AudioBuffer | null> }>();
const peaksCache = new Map<ID, Float32Array>();

async function dataUrlToArrayBuffer(dataUrl: string): Promise<ArrayBuffer> {
  return (await fetch(dataUrl)).arrayBuffer();
}

/** Decoded audio for an asset (cached). */
export function decodeAsset(asset: Asset): Promise<AudioBuffer | null> {
  let e = buffers.get(asset.id);
  if (!e || e.src !== asset.dataUrl) {
    const fresh = { src: asset.dataUrl, buffer: null as AudioBuffer | null, pending: Promise.resolve<AudioBuffer | null>(null) };
    fresh.pending = dataUrlToArrayBuffer(asset.dataUrl)
      .then((ab) => audioContext().decodeAudioData(ab))
      .then((buf) => {
        fresh.buffer = buf;
        peaksCache.delete(asset.id);
        requestRepaint();
        return buf;
      })
      .catch(() => null);
    buffers.set(asset.id, fresh);
    e = fresh;
  }
  return e.pending;
}

function monoOf(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

/** [min, max] pairs for drawing a waveform; null until the audio has decoded. */
export function getPeaks(assetId: ID, buckets = 2000): Float32Array | null {
  const hit = peaksCache.get(assetId);
  if (hit) return hit;
  const asset = doc.project?.assets[assetId];
  if (!asset || asset.kind !== 'audio') return null;
  const buf = buffers.get(assetId)?.buffer;
  if (!buf) {
    void decodeAsset(asset);
    return null;
  }
  const mono = monoOf(buf);
  const out = new Float32Array(buckets * 2);
  const per = mono.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(mono.length, Math.floor((b + 1) * per));
    for (let i = Math.floor(b * per); i < end; i++) {
      const v = mono[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  peaksCache.set(assetId, out);
  return out;
}

/** Mono samples of an asset, for analysis such as lip-sync. */
export async function getSamples(assetId: ID): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  const asset = doc.project?.assets[assetId];
  if (!asset) return null;
  const buf = await decodeAsset(asset);
  return buf ? { samples: monoOf(buf), sampleRate: buf.sampleRate } : null;
}

/** Imports an audio file as an asset and places it on the timeline at the playhead. */
export async function importAudio(file: File): Promise<ID | null> {
  const dataUrl = await readAsDataUrl(file);
  const asset: Asset = { id: newId('aud'), name: file.name, kind: 'audio', mime: file.type || 'audio/mpeg', dataUrl };
  const buf = await decodeAsset(asset);
  if (!buf) {
    buffers.delete(asset.id);
    ui().toast(`Could not decode "${file.name}" as audio.`, 'error');
    return null;
  }
  asset.duration = buf.duration;
  return doc.transact('Import audio', () => {
    addAsset(asset);
    return placeAudio(asset);
  });
}

export function placeAudio(asset: Asset, start = ui().frame): ID {
  const s = currentScene();
  const fps = doc.project!.fps;
  const lenF = (asset.duration ?? 1) * fps;
  let track = 0;
  while (s.audio.some((a) => a.track === track && a.start < start + lenF && a.start + a.length * fps > start)) track++;
  return addAudioClip({ assetId: asset.id, name: asset.name.replace(/\.[a-z0-9]+$/i, ''), start, offset: 0, length: asset.duration ?? 1, volume: 1, muted: false, track });
}

// --- playback --------------------------------------------------------------------------------

let playing: AudioBufferSourceNode[] = [];

function stopAll(): void {
  for (const n of playing) {
    try {
      n.stop();
    } catch {}
  }
  playing = [];
}

function schedule(ac: BaseAudioContext, p: Project, scene: Scene, fromFrame: number, at: number, out: AudioNode, track?: AudioBufferSourceNode[]): void {
  for (const clip of scene.audio) {
    if (clip.muted || clip.volume <= 0) continue;
    const buf = buffers.get(clip.assetId)?.buffer;
    if (!buf) continue;
    const clipStart = clip.start / p.fps;
    const from = fromFrame / p.fps;
    const skip = Math.max(0, from - clipStart);
    const remaining = clip.length - skip;
    if (remaining <= 0) continue;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const gain = ac.createGain();
    gain.gain.value = clip.volume;
    src.connect(gain).connect(out);
    src.start(at + Math.max(0, clipStart - from), clip.offset + skip, remaining);
    track?.push(src);
  }
}

onPlaybackStart((frame) => {
  const p = doc.project;
  if (!p) return;
  const s = currentScene(p);
  if (s.audio.length === 0) return;
  const ac = audioContext();
  void ac.resume();
  stopAll();
  schedule(ac, p, s, frame, ac.currentTime + 0.02, ac.destination, playing);
});
onPlaybackStop(stopAll);

/** Makes sure every audio asset used by the given scenes is decoded. */
export async function preloadAudio(p: Project, scenes: Scene[]): Promise<void> {
  const ids = new Set(scenes.flatMap((s) => s.audio.map((a) => a.assetId)));
  await Promise.all([...ids].map((id) => (p.assets[id] ? decodeAsset(p.assets[id]) : null)));
}

/**
 * Renders the soundtrack for a set of scene ranges into one buffer. Each range plays `frames`
 * frames of its scene starting at scene frame `from`, placed at output frame `at`. Ranges may
 * overlap (scene transitions), in which case their audio mixes.
 */
export async function mixdown(p: Project, ranges: { scene: Scene; from: number; frames: number; at: number }[], sampleRate = 48000): Promise<AudioBuffer | null> {
  if (!ranges.some((r) => r.scene.audio.some((a) => !a.muted))) return null;
  await preloadAudio(p, ranges.map((r) => r.scene));
  const total = Math.max(...ranges.map((r) => r.at + r.frames)) / p.fps;
  const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * sampleRate)), sampleRate);
  for (const r of ranges) {
    const t = r.at / p.fps;
    const end = t + r.frames / p.fps;
    // A gate per range so audio from one scene cannot spill past its end.
    const gate = oc.createGain();
    gate.gain.setValueAtTime(0, 0);
    gate.gain.setValueAtTime(1, t);
    gate.gain.setValueAtTime(0, end);
    gate.connect(oc.destination);
    schedule(oc, p, r.scene, r.from, t, gate);
  }
  return oc.startRendering();
}

export function audioClipEndFrame(clip: AudioClip, fps: number): number {
  return clip.start + clip.length * fps;
}
