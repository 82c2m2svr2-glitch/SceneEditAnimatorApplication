import type { Viseme } from '../core/character/spec';
import type { Ease, ID } from '../core/types';
import { deleteKeys, scene, setKeys } from '../state/commands';
import { doc } from '../state/store';
import { getSamples } from './engine';

// The audio analyser is a separate module (src/audio/lipsync.ts); the feature is offered once it exists.
const optional = import.meta.glob('./lipsync.ts') as Record<string, () => Promise<any>>;

export const lipSyncAvailable = './lipsync.ts' in optional;

/**
 * Analyses an audio clip and keys the character's mouth to it. The result is ordinary step
 * keyframes on the character's "mouth" track, so every shape can be moved, changed or deleted on
 * the timeline afterwards.
 */
export async function applyLipSync(clipId: ID, characterId: ID, sensitivity = 1): Promise<number> {
  const p = doc.project!;
  const s = scene(p);
  const clip = s.audio.find((a) => a.id === clipId);
  if (!clip) throw new Error('That audio clip no longer exists.');
  const audio = await getSamples(clip.assetId);
  if (!audio) throw new Error('The audio could not be decoded.');
  const { analyzeVisemes } = await optional['./lipsync.ts']();
  const from = Math.floor(clip.offset * audio.sampleRate);
  const to = Math.min(audio.samples.length, Math.floor((clip.offset + clip.length) * audio.sampleRate));
  const shapes: { frame: number; viseme: Viseme }[] = analyzeVisemes(audio.samples.subarray(from, to), audio.sampleRate, p.fps, { sensitivity });
  const start = Math.round(clip.start);
  const end = Math.round(clip.start + clip.length * p.fps);
  doc.transact('Lip-sync to audio', () => {
    const old = (s.anim[characterId]?.mouth?.keys ?? []).filter((k) => k.f >= start && k.f <= end).map((k) => ({ target: characterId, prop: 'mouth', f: k.f }));
    if (old.length) deleteKeys(old);
    setKeys([
      ...shapes.map((v) => ({ target: characterId, prop: 'mouth', f: start + v.frame, v: v.viseme, e: 'step' as Ease })),
      { target: characterId, prop: 'mouth', f: end, v: 'rest', e: 'step' as Ease },
    ], 'Lip-sync to audio');
  });
  return shapes.length;
}
