/**
 * Character Creator pipeline:
 *   1. generate (or accept) a front-view character image,
 *   2. generate the remaining turnaround views from it so the design stays consistent,
 *   3. convert every view into vector parts with skeleton landmarks (a CharacterSpec),
 *   4. hand the spec to buildCharacter, which rigs it.
 * Steps 1-3 call the OpenAI API with the user's own key.
 */
import { BONE_NAMES, JOINT_NAMES, type BoneName, type CharacterSpec, type JointName, type PartPath, type ViewSpec } from '../core/character/spec';
import { parseSvgPath } from '../core/path';
import { VIEW_NAMES, type ViewName } from '../core/types';
import { settings } from '../state/settings';
import { AssistantError, openaiError } from './providers';

export type CreatorSource =
  | { kind: 'text'; description: string }
  | { kind: 'reference'; description: string; image: string }
  | { kind: 'convert'; image: string; view: ViewName; generateOtherViews: boolean; description: string };

export interface CreatorProgress {
  step: string;
  state: 'run' | 'done' | 'fail';
  detail?: string;
}

export interface CreatorResult {
  spec: CharacterSpec;
  images: Partial<Record<ViewName, string>>;
  /** Views that could not be produced, with the reason. */
  failed: Partial<Record<ViewName, string>>;
}

const VIEW_PROMPT: Record<ViewName, string> = {
  front: 'front view, facing the camera directly',
  threeQuarter: "three-quarter front view, body and head turned about 45 degrees toward the viewer's right",
  side: "side profile view, facing the viewer's right",
  backThreeQuarter: "three-quarter back view, seen from behind and turned about 45 degrees so the character faces away toward the viewer's right",
  back: 'back view, facing directly away from the camera',
};

const STYLE =
  'Full-body character turnaround drawing for 2D cutout animation. The whole body is visible from the top of the head to the soles of the feet, centred, with empty margin on every side. ' +
  'Neutral standing A-pose: arms straight and held clearly away from the torso, hands open, legs straight and slightly apart, so no body part overlaps another. ' +
  'Clean flat cartoon style: bold even outlines, solid flat colours, no gradients, no texture, no shading, no cast shadow. Pure white background. No text, no labels, no props, no ground line, a single figure only.';

function dataUrlToBlob(url: string): Blob {
  const m = url.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new AssistantError('That image could not be read.');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

async function post(path: string, body: BodyInit, json: boolean, signal?: AbortSignal): Promise<any> {
  const key = settings().openaiKey;
  if (!key) throw new AssistantError('Add your OpenAI API key in Settings to use Character Creator.');
  let res: Response;
  try {
    res = await fetch(`https://api.openai.com/v1/${path}`, {
      method: 'POST', signal, body,
      headers: json ? { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } : { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new AssistantError('Could not reach the OpenAI API. Check your internet connection.');
  }
  if (!res.ok) throw await openaiError(res);
  return res.json();
}

function imageFrom(data: any): string {
  const item = data?.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  throw new AssistantError('OpenAI returned no image.');
}

async function generateImage(prompt: string, signal?: AbortSignal): Promise<string> {
  return imageFrom(await post('images/generations', JSON.stringify({ model: settings().imageModel, prompt, size: '1024x1536', n: 1 }), true, signal));
}

async function editImage(image: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append('model', settings().imageModel);
  form.append('prompt', prompt);
  form.append('size', '1024x1536');
  form.append('image', dataUrlToBlob(image), 'reference.png');
  return imageFrom(await post('images/edits', form, false, signal));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new AssistantError('That image could not be decoded.'));
    img.src = url;
  });
}

/** Re-encodes any image as a PNG no larger than `max` pixels on its long side. */
export async function normalizeImage(url: string, max = 1536): Promise<{ url: string; width: number; height: number }> {
  const img = await loadImage(url);
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  return { url: c.toDataURL('image/png'), width: w, height: h };
}

// --- vectorisation ---------------------------------------------------------------------------

const POINT = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false };
const PATH = {
  type: 'object',
  properties: {
    d: { type: 'string', description: 'SVG path data in image pixel coordinates. Closed shapes end with Z.' },
    fill: { type: 'string', description: 'Hex colour such as #3d7dd8, or "none".' },
    stroke: { type: 'string', description: 'Hex colour, or "none".' },
    strokeWidth: { type: 'number' },
  },
  required: ['d', 'fill', 'stroke', 'strokeWidth'],
  additionalProperties: false,
};

const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    joints: { type: 'object', properties: Object.fromEntries(JOINT_NAMES.map((j) => [j, POINT])), required: [...JOINT_NAMES], additionalProperties: false },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bone: { type: 'string', enum: [...BONE_NAMES] },
          z: { type: 'number', description: 'Paint order. Higher is in front.' },
          paths: { type: 'array', items: PATH },
        },
        required: ['name', 'bone', 'z', 'paths'],
        additionalProperties: false,
      },
    },
    eyes: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, paths: { type: 'array', items: PATH } }, required: ['name', 'paths'], additionalProperties: false } },
    mouth: {
      type: 'object',
      properties: { visible: { type: 'boolean' }, cx: { type: 'number' }, cy: { type: 'number' }, width: { type: 'number' } },
      required: ['visible', 'cx', 'cy', 'width'],
      additionalProperties: false,
    },
    outlineColor: { type: 'string' },
  },
  required: ['joints', 'parts', 'eyes', 'mouth', 'outlineColor'],
  additionalProperties: false,
};

function vectorPrompt(view: ViewName, width: number, height: number): string {
  return `You convert a character drawing into a rigged vector puppet for cutout animation. The image is ${width} x ${height} pixels and shows the character in ${VIEW_PROMPT[view]}. All coordinates you output are image pixels (origin top-left, y down). "L" and "R" always mean the CHARACTER'S own left and right, not the viewer's.

Return:

1. joints: the pivot point of every skeleton landmark, at the centre of rotation of that joint on the drawing:
   hips (centre of the pelvis), waist, neck (base of the neck), head (where the skull meets the neck), headTop,
   shoulder/elbow/wrist/handTip for L and R, hip/knee/ankle/toe for L and R.
   Landmarks hidden behind the body in this view still need a plausible position.

2. parts: the artwork redrawn as separate vector parts, each attached to one bone. Bones: ${BONE_NAMES.filter((b) => b !== 'root').join(', ')}.
   - Make at least one part per bone that is visible: pelvis on hips, torso on torso, neck on neck, head on head, and upper arm, lower arm, hand, upper leg, lower leg and foot (shoe) on their bones. Hair, ears, hats and anything worn on the head attach to head. Clothing follows the body part it covers.
   - Draw every part COMPLETE, as if its neighbours were removed: extend each limb segment past the joint with a rounded end so that neighbouring parts overlap generously. When a limb rotates, no gap may open.
   - Follow the drawing's silhouette, proportions and colours closely. Use smooth cubic curves (C commands). Keep each path under about 24 segments.
   - A part can have several paths (base colour first, then details on top). Use the drawing's outline colour and width as stroke where it has outlines.
   - Do NOT include the eyes or the mouth in the head part; they are returned separately.
   - z (paint order): far-side limbs lowest (around -20), legs around -10, pelvis 0, torso 5, neck 3, near-side or front arms 20, head 30, hair in front of the face 36, hair behind the head -30.

3. eyes: one entry per visible eye, named "eye.L" / "eye.R", each with its paths (white, iris/pupil, highlight). Empty list if no eye is visible.

4. mouth: centre and width of the mouth, with visible=false when the mouth cannot be seen (back views).

5. outlineColor: the drawing's line colour as hex.`;
}

const validColor = (c: string): string | null => (/^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : c.trim().toLowerCase() === 'none' || !c.trim() ? null : c.trim());

function toPaths(raw: any[]): PartPath[] {
  const out: PartPath[] = [];
  for (const p of raw ?? []) {
    if (typeof p?.d !== 'string') continue;
    // Drop paths the model wrote incorrectly rather than letting one bad path break the rig.
    if (parseSvgPath(p.d).contours.every((c) => c.pts.length < 2)) continue;
    out.push({ d: p.d, fill: validColor(String(p.fill ?? 'none')), stroke: validColor(String(p.stroke ?? 'none')), strokeWidth: Number(p.strokeWidth) || 0 });
  }
  return out;
}

/** Turns the model's JSON for one view into a ViewSpec, validating everything the rig depends on. */
export function viewFromResponse(raw: any, view: ViewName): ViewSpec {
  const joints = {} as Record<JointName, [number, number]>;
  for (const j of JOINT_NAMES) {
    const p = raw?.joints?.[j];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new AssistantError(`The conversion for the ${view} view is missing the "${j}" landmark.`);
    joints[j] = [p.x, p.y];
  }
  const parts = (raw.parts ?? [])
    .map((p: any) => ({ name: String(p.name || p.bone), bone: (BONE_NAMES.includes(p.bone) ? p.bone : 'torso') as BoneName, z: Number(p.z) || 0, paths: toPaths(p.paths) }))
    .filter((p: { paths: PartPath[] }) => p.paths.length > 0);
  if (parts.length < 4) throw new AssistantError(`The conversion for the ${view} view produced too few parts to rig.`);
  const eyes = (raw.eyes ?? []).map((e: any, i: number) => ({ name: String(e.name || `eye.${i}`), z: 32, paths: toPaths(e.paths) })).filter((e: { paths: PartPath[] }) => e.paths.length > 0);
  const m = raw.mouth;
  const mouth = m?.visible && Number.isFinite(m.cx) && Number.isFinite(m.cy) && m.width > 0 ? { cx: m.cx, cy: m.cy, width: m.width, z: 33 } : null;
  const face = eyes.length || mouth ? { eyes, mouth, lineColor: validColor(String(raw.outlineColor ?? '')) ?? '#2a1f1f', mouthScale: view === 'side' ? 0.6 : view === 'threeQuarter' ? 0.85 : 1 } : undefined;
  return { joints, parts, face };
}

async function vectorizeOnce(image: { url: string; width: number; height: number }, view: ViewName, signal?: AbortSignal): Promise<ViewSpec> {
  const data = await post(
    'chat/completions',
    JSON.stringify({
      model: settings().visionModel,
      messages: [
        { role: 'system', content: vectorPrompt(view, image.width, image.height) },
        { role: 'user', content: [{ type: 'text', text: 'Convert this drawing.' }, { type: 'image_url', image_url: { url: image.url, detail: 'high' } }] },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'character_view', strict: true, schema: VIEW_SCHEMA } },
    }),
    true,
    signal,
  );
  const choice = data?.choices?.[0];
  if (choice?.message?.refusal) throw new AssistantError(`The model declined to convert the ${view} view: ${choice.message.refusal}`);
  if (choice?.finish_reason === 'length') throw new AssistantError(`The ${view} view was too detailed to convert in one pass. Try a simpler design.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(choice?.message?.content ?? '');
  } catch {
    throw new RetryableError(`The conversion for the ${view} view came back unreadable. Try again.`);
  }
  try {
    return viewFromResponse(parsed, view);
  } catch (err) {
    throw new RetryableError((err as Error).message);
  }
}

/** A malformed model answer: worth one more attempt before reporting the view as failed. */
class RetryableError extends AssistantError {}

async function vectorize(image: string, view: ViewName, signal?: AbortSignal): Promise<ViewSpec> {
  const norm = await normalizeImage(image, 1536);
  try {
    return await vectorizeOnce(norm, view, signal);
  } catch (err) {
    if (!(err instanceof RetryableError)) throw err;
    return vectorizeOnce(norm, view, signal);
  }
}

/**
 * Runs the whole pipeline. Views are produced independently, so one failed view does not lose the
 * others; the result lists what failed. Throws only when no view at all could be built.
 */
export async function createCharacter(
  source: CreatorSource, name: string, views: ViewName[], onProgress: (p: CreatorProgress) => void, signal?: AbortSignal,
): Promise<CreatorResult> {
  const images: Partial<Record<ViewName, string>> = {};
  const failed: Partial<Record<ViewName, string>> = {};
  const wanted = VIEW_NAMES.filter((v) => views.includes(v));
  let base: ViewName = 'front';
  const describe = source.description.trim();

  if (source.kind === 'convert') {
    base = source.view;
    images[base] = (await normalizeImage(source.image)).url;
  } else {
    onProgress({ step: 'Drawing the front view', state: 'run' });
    try {
      const prompt = `${STYLE}\n\nCharacter: ${describe}\n\nView: ${VIEW_PROMPT.front}.`;
      images.front = source.kind === 'reference'
        ? await editImage((await normalizeImage(source.image)).url, `Redraw the character from the reference image as a clean design sheet drawing. Keep its identity, colours and outfit. ${describe ? `Notes: ${describe}. ` : ''}${STYLE}\n\nView: ${VIEW_PROMPT.front}.`, signal)
        : await generateImage(prompt, signal);
      onProgress({ step: 'Drawing the front view', state: 'done' });
    } catch (err) {
      onProgress({ step: 'Drawing the front view', state: 'fail', detail: (err as Error).message });
      throw err;
    }
  }

  const others = source.kind === 'convert' && !source.generateOtherViews ? [] : wanted.filter((v) => v !== base);
  if (others.length) {
    const label = `Drawing ${others.length} more view${others.length > 1 ? 's' : ''}`;
    onProgress({ step: label, state: 'run' });
    const ref = images[base]!;
    await Promise.all(
      others.map(async (v) => {
        try {
          images[v] = await editImage(ref, `Redraw this exact character in a different view. Keep the identical design, proportions, colours, outfit and drawing style. ${describe ? `Character: ${describe}. ` : ''}${STYLE}\n\nView: ${VIEW_PROMPT[v]}.`, signal);
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          failed[v] = (err as Error).message;
        }
      }),
    );
    onProgress({ step: label, state: Object.keys(failed).length === others.length ? 'fail' : 'done', detail: Object.keys(failed).length ? `${Object.keys(failed).length} view(s) failed` : undefined });
  }

  const toConvert = VIEW_NAMES.filter((v) => images[v]);
  const label = `Converting ${toConvert.length} view${toConvert.length > 1 ? 's' : ''} to vector parts and finding the skeleton`;
  onProgress({ step: label, state: 'run' });
  const specViews: CharacterSpec['views'] = {};
  await Promise.all(
    toConvert.map(async (v) => {
      try {
        specViews[v] = await vectorize(images[v]!, v, signal);
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        failed[v] = (err as Error).message;
      }
    }),
  );
  const built = Object.keys(specViews).length;
  if (built === 0) {
    onProgress({ step: label, state: 'fail' });
    throw new AssistantError(Object.values(failed)[0] ?? 'No view could be converted.');
  }
  onProgress({ step: label, state: 'done', detail: built < toConvert.length ? `${toConvert.length - built} view(s) failed` : undefined });
  return { spec: { name: name.trim() || 'Character', views: specViews }, images, failed };
}
