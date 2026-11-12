import { useSettings } from '../state/settings';
import { post } from './characterCreator';
import { AssistantError } from './providers';

/**
 * Asset Builder: scene art (backgrounds, props, scenery, textures, effects) drawn by OpenAI's
 * image model with the user's own API key. Every picture it produces comes from that API.
 */

export type AssetShape = 'square' | 'wide' | 'tall';
export type AssetQuality = 'low' | 'medium' | 'high';

export interface AssetKind {
  id: string;
  label: string;
  /** Whether this kind of asset is normally cut out on a transparent background. */
  transparent: boolean;
  shape: AssetShape;
  guide: string;
  example: string;
}

export const ASSET_KINDS: AssetKind[] = [
  { id: 'background', label: 'Background', transparent: false, shape: 'wide', example: 'a sunny city park with a pond, trees and a path, skyline far behind', guide: 'A complete scene background for an animated cartoon: an environment only, with no characters and no animals. Composed edge to edge with no border or frame, with open space in the lower middle where characters will stand.' },
  { id: 'scenery', label: 'Scenery piece', transparent: true, shape: 'square', example: 'a big leafy oak tree', guide: 'One single piece of scenery (such as a tree, building, rock, cloud or fence) to be layered at its own depth in a multiplane scene. The whole piece is visible with a small margin around it, seen from the front at eye level, and nothing else is in the picture: no ground, no sky, no shadow on the floor.' },
  { id: 'prop', label: 'Prop / object', transparent: true, shape: 'square', example: 'a red bicycle with a wicker basket', guide: 'One single object, centred, whole object visible with a small margin around it, seen from a clear three-quarter or side angle. Nothing else in the picture: no surface under it, no cast shadow, no hands holding it.' },
  { id: 'character', label: 'Character art (still)', transparent: true, shape: 'tall', example: 'an old sea captain with a white beard and a blue coat', guide: 'One single character, full body from head to feet, in a relaxed standing pose, centred with a small margin. Nothing else in the picture. (This makes a still picture; use Character Creator for a rigged, animatable character.)' },
  { id: 'effect', label: 'Effect element', transparent: true, shape: 'square', example: 'a puff of cartoon smoke', guide: 'One single visual effect element (such as smoke, fire, a splash, an explosion, sparkles or a magic glow), centred and complete with a margin around it, with nothing else in the picture.' },
  { id: 'texture', label: 'Texture / pattern', transparent: false, shape: 'square', example: 'old red brick wall', guide: 'A seamless, tileable texture that fills the whole image evenly: viewed flat-on with no perspective, no horizon, no objects, no lighting hotspot and no border, so copies placed side by side join invisibly.' },
  { id: 'title', label: 'Title / sign', transparent: true, shape: 'wide', example: 'a wooden signpost that says "Welcome"', guide: 'One single title card element or sign, centred and complete with a margin around it. Any lettering must be spelled exactly as given in the description and be large and legible.' },
];

export const ASSET_STYLES: { id: string; label: string; text: string }[] = [
  { id: 'flat', label: 'Flat cartoon', text: 'Clean flat cartoon style: bold even dark outlines, solid flat colours, at most one simple shadow tone, no gradients and no texture.' },
  { id: 'cel', label: 'Cel-shaded anime', text: 'Cel-shaded anime background-art style: crisp line work, flat colour with one or two hard-edged shadow tones, clear bright palette.' },
  { id: 'storybook', label: 'Storybook watercolour', text: "Children's storybook illustration in soft watercolour with loose pencil lines, gentle washes and visible paper grain." },
  { id: 'painterly', label: 'Painted and detailed', text: 'Richly painted animation-film background-art style: confident brushwork, atmospheric light, depth and carefully designed shapes.' },
  { id: 'paper', label: 'Paper cut-out', text: 'Layered paper cut-out style: flat coloured paper shapes with subtle paper texture and soft drop shadows between the layers.' },
  { id: 'retro', label: 'Retro vector poster', text: 'Mid-century retro poster style: simplified geometric shapes, a limited palette of four or five colours, flat fills with a little grain.' },
  { id: 'pixel', label: 'Pixel art', text: 'Crisp pixel art with a limited palette, clean clusters and no anti-aliasing or blur.' },
  { id: 'lineart', label: 'Ink line art', text: 'Black ink line art on white with confident varied line weight, no colour and no grey shading.' },
  { id: 'none', label: 'No preset (my description decides)', text: '' },
];

export const ASSET_SIZES: Record<AssetShape, { size: string; label: string }> = {
  square: { size: '1024x1024', label: 'Square' },
  wide: { size: '1536x1024', label: 'Wide' },
  tall: { size: '1024x1536', label: 'Tall' },
};

export interface AssetRequest {
  description: string;
  kind: string;
  style: string;
  shape: AssetShape;
  quality: AssetQuality;
  transparent: boolean;
  count: number;
  model: string;
}

/** The full instruction sent to the image model for one asset. */
export function assetPrompt(r: Pick<AssetRequest, 'description' | 'kind' | 'style' | 'transparent'>): string {
  const kind = ASSET_KINDS.find((k) => k.id === r.kind) ?? ASSET_KINDS[0];
  const style = ASSET_STYLES.find((s) => s.id === r.style)?.text ?? '';
  const description = r.description.trim();
  if (!description) throw new AssistantError('Describe what you want first.');
  return [
    `Artwork for a 2D animation: ${description}.`,
    kind.guide,
    style,
    r.transparent ? 'The background must be fully transparent, with clean edges around the subject.' : '',
    'High quality, production-ready artwork. No watermark, no signature, no caption and no text unless the description asks for lettering.',
  ].filter(Boolean).join('\n\n');
}

async function one(r: AssetRequest, prompt: string, signal?: AbortSignal): Promise<string> {
  const size = ASSET_SIZES[r.shape].size;
  const full = { model: r.model, prompt, size, n: 1, quality: r.quality, background: r.transparent ? 'transparent' : 'opaque', output_format: 'png' };
  let data;
  try {
    data = await post('images/generations', JSON.stringify(full), true, signal);
  } catch (err) {
    // Image models differ in the options they accept. If this one rejects the request, try once
    // more with only the options every model takes; a real problem will fail again and be shown.
    if (!(err instanceof AssistantError) || !/error 400/i.test(err.message)) throw err;
    data = await post('images/generations', JSON.stringify({ model: r.model, prompt, size, n: 1 }), true, signal);
  }
  const item = data?.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (typeof item?.url === 'string') {
    const blob = await (await fetch(item.url, { signal })).blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new AssistantError('The generated image could not be downloaded.'));
      reader.readAsDataURL(blob);
    });
  }
  throw new AssistantError('OpenAI returned no image.');
}

/**
 * Generates `count` variations. Each finished picture is reported through `onImage` as it arrives;
 * the call only fails if every variation failed.
 */
export async function generateAssets(r: AssetRequest, onImage: (dataUrl: string) => void, signal?: AbortSignal): Promise<{ made: number; failed: string[] }> {
  if (!useSettings.getState().openaiKey) throw new AssistantError('Add your OpenAI API key in Settings first.');
  if (!r.model.trim()) throw new AssistantError('Choose an image model first.');
  const prompt = assetPrompt(r);
  const count = Math.min(4, Math.max(1, Math.round(r.count)));
  const results = await Promise.allSettled(
    Array.from({ length: count }, () => one(r, prompt, signal).then((url) => {
      onImage(url);
      return url;
    })),
  );
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  const failed = results.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map((x) => (x.reason instanceof Error ? x.reason.message : String(x.reason)));
  if (failed.length === count) throw new AssistantError(failed[0]);
  return { made: count - failed.length, failed };
}
