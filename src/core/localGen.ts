/**
 * Local image generation with a Stable Diffusion server on the user's own computer (SD.Next, which
 * speaks the `/sdapi/v1` API). Pure logic only: style presets, the request sent to the server, the
 * record kept with every result so it can be reproduced, and the geometry for regions and plates.
 */
import type { Camera, ID } from './types';

export type LocalGenMode = 'txt2img' | 'img2img' | 'region';

/** A rectangle in 0..1 units of an image's width and height. */
export interface Rect01 {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A reusable look, kept separate from the shot description so it can follow the film everywhere. */
export interface StylePreset {
  id: string;
  name: string;
  /** Added after the shot description. */
  positive: string;
  /** Added to the negative prompt. */
  negative: string;
  builtIn?: boolean;
}

export const CEL_90S: StylePreset = {
  id: 'cel90s',
  name: '1990s cel anime',
  builtIn: true,
  positive:
    '1990s hand-drawn cel anime, retro anime screencap, dark ink outlines, clean confident line art, ' +
    'restrained muted colour palette, simple flat cel shading with one hard-edged shadow tone, ' +
    'detailed hand-painted background art, soft film grain',
  negative:
    '3d render, cgi, photorealistic, photo, glossy, soft gradient shading, airbrushed, oversaturated, ' +
    'neon glow, lens flare, bokeh, blurry, lowres, jpeg artifacts, watermark, signature, text, ' +
    'extra limbs, extra fingers, deformed',
};

export const BUILT_IN_STYLES: StylePreset[] = [
  CEL_90S,
  {
    id: 'cel90s-plate',
    name: '1990s cel anime, empty background plate',
    builtIn: true,
    positive: `${CEL_90S.positive}, background art only, empty scene, no people, no characters`,
    negative: `${CEL_90S.negative}, person, people, character, figure, animal`,
  },
  { id: 'none', name: 'No style (prompt only)', builtIn: true, positive: '', negative: '' },
];

/**
 * Output sizes. SD 1.5 works in multiples of 8 and OpenVINO compiles the model for one size at a
 * time, so every change of size costs a recompile of a few minutes: a fixed preview size keeps
 * generation fast after the first run.
 */
export const LOCAL_SIZES = [
  { id: 'wide', width: 512, height: 288, label: 'Widescreen preview 512×288' },
  { id: 'tall', width: 288, height: 512, label: 'Vertical 288×512' },
  { id: 'square', width: 512, height: 512, label: 'Square 512×512' },
] as const;
export type LocalSizeId = (typeof LOCAL_SIZES)[number]['id'];

export const REGION_PRESETS: { id: string; label: string; rect: Rect01 }[] = [
  { id: 'left', label: 'Left third', rect: { x: 0, y: 0, w: 1 / 3, h: 1 } },
  { id: 'center', label: 'Middle third', rect: { x: 1 / 3, y: 0, w: 1 / 3, h: 1 } },
  { id: 'right', label: 'Right third', rect: { x: 2 / 3, y: 0, w: 1 / 3, h: 1 } },
  { id: 'lower', label: 'Lower half (foreground)', rect: { x: 0, y: 0.5, w: 1, h: 0.5 } },
  { id: 'lowerLeft', label: 'Lower left', rect: { x: 0, y: 0.45, w: 0.5, h: 0.55 } },
  { id: 'lowerRight', label: 'Lower right', rect: { x: 0.5, y: 0.45, w: 0.5, h: 0.55 } },
];

export interface LocalGenSettings {
  mode: LocalGenMode;
  /** The shot itself: subject, action, place, time of day. */
  prompt: string;
  /** Extra things to avoid in this shot, added to the style's negative prompt. */
  negativePrompt: string;
  style: StylePreset | null;
  /** -1 picks a new random seed. */
  seed: number;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  sampler: string;
  /** img2img and region: 0 keeps the source exactly, 1 ignores it. */
  denoisingStrength: number;
  region?: Rect01;
}

export const DEFAULT_LOCAL_SETTINGS: LocalGenSettings = {
  mode: 'txt2img', prompt: '', negativePrompt: '', style: CEL_90S, seed: -1, width: 512, height: 288,
  steps: 20, cfgScale: 7, sampler: 'Default', denoisingStrength: 0.3,
};

/** Saved with every generated image, so it can be reproduced or used as the start of another shot. */
export interface GenerationRecord {
  engine: 'sdnext';
  mode: LocalGenMode;
  prompt: string;
  negativePrompt: string;
  /** A copy of the style as it was, so later edits to the preset do not change the record. */
  style: { id: string; name: string; positive: string; negative: string } | null;
  /** Exactly what was sent to the server. */
  fullPrompt: string;
  fullNegativePrompt: string;
  checkpoint: string;
  checkpointHash?: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  sampler: string;
  denoisingStrength?: number;
  source?: { assetId: ID; name: string };
  region?: Rect01;
  createdAt: number;
  serverVersion?: string;
}

/** A background reused unchanged across every frame shot from the same camera angle. */
export interface PlateInfo {
  angle: string;
}

const join = (...parts: string[]) => parts.map((p) => p.trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');

export function composePrompt(s: Pick<LocalGenSettings, 'prompt' | 'style'>): string {
  return join(s.prompt, s.style?.positive ?? '');
}

export function composeNegative(s: Pick<LocalGenSettings, 'negativePrompt' | 'style'>): string {
  return join(s.style?.negative ?? '', s.negativePrompt);
}

/** Rounds a size down to the multiple of 8 Stable Diffusion needs, never below 64. */
export const snap8 = (n: number): number => Math.max(64, Math.floor(n / 8) * 8);

/** Whole pixels of a 0..1 rectangle inside an image, clamped to the image. */
export function regionPixels(r: Rect01, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.min(width - 1, Math.round(r.x * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round(r.y * height)));
  return { x, y, w: Math.max(1, Math.min(width - x, Math.round(r.w * width))), h: Math.max(1, Math.min(height - y, Math.round(r.h * height))) };
}

export interface SdRequest {
  path: '/sdapi/v1/txt2img' | '/sdapi/v1/img2img';
  body: Record<string, unknown>;
}

/**
 * The request for SD.Next. `source` and `mask` are base64 PNGs (no data: prefix) already at the
 * output size, so the server never resizes them.
 */
export function buildRequest(s: LocalGenSettings, images: { source?: string; mask?: string } = {}): SdRequest {
  const width = snap8(s.width);
  const height = snap8(s.height);
  const body: Record<string, unknown> = {
    prompt: composePrompt(s),
    negative_prompt: composeNegative(s),
    seed: Number.isFinite(s.seed) && s.seed >= 0 ? Math.floor(s.seed) : -1,
    steps: Math.round(Math.min(150, Math.max(1, s.steps))),
    cfg_scale: Math.min(30, Math.max(1, s.cfgScale)),
    sampler_name: s.sampler.trim() || 'Default',
    width,
    height,
    batch_size: 1,
    n_iter: 1,
    send_images: true,
    save_images: false,
  };
  if (s.mode === 'txt2img') return { path: '/sdapi/v1/txt2img', body };
  if (!images.source) throw new Error('Choose the image to start from.');
  body.init_images = [images.source];
  body.denoising_strength = Math.min(1, Math.max(0, s.denoisingStrength));
  body.resize_mode = 0;
  if (s.mode === 'region') {
    if (!images.mask) throw new Error('Choose the region to change.');
    body.mask = images.mask;
    body.mask_blur = 4;
    body.inpaint_full_res = false;
  }
  return { path: '/sdapi/v1/img2img', body };
}

export interface ParsedInfo {
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  sampler?: string;
  modelHash?: string;
  denoisingStrength?: number;
}

/** Reads the `info` JSON string SD.Next returns with every result. Unknown or broken fields are skipped. */
export function parseInfo(info: unknown): ParsedInfo {
  let o: Record<string, unknown> = {};
  try {
    o = typeof info === 'string' ? JSON.parse(info) : info && typeof info === 'object' ? (info as Record<string, unknown>) : {};
  } catch {
    return {};
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const seeds = Array.isArray(o.all_seeds) ? o.all_seeds : [];
  return {
    seed: num(o.seed) ?? num(seeds[0]),
    width: num(o.width),
    height: num(o.height),
    steps: num(o.steps),
    cfgScale: num(o.cfg_scale),
    sampler: typeof o.sampler_name === 'string' ? o.sampler_name : undefined,
    modelHash: typeof o.sd_model_hash === 'string' && o.sd_model_hash ? o.sd_model_hash : undefined,
    denoisingStrength: num(o.denoising_strength),
  };
}

export function makeRecord(
  s: LocalGenSettings,
  result: { info: unknown; checkpoint: string; source?: { assetId: ID; name: string }; serverVersion?: string },
  now = Date.now(),
): GenerationRecord {
  const p = parseInfo(result.info);
  const sent = buildRequest({ ...s, mode: 'txt2img' }).body;
  return {
    engine: 'sdnext',
    mode: s.mode,
    prompt: s.prompt,
    negativePrompt: s.negativePrompt,
    style: s.style ? { id: s.style.id, name: s.style.name, positive: s.style.positive, negative: s.style.negative } : null,
    fullPrompt: String(sent.prompt),
    fullNegativePrompt: String(sent.negative_prompt),
    checkpoint: result.checkpoint,
    ...(p.modelHash ? { checkpointHash: p.modelHash } : {}),
    // The seed the server actually used, so a random run can be repeated exactly.
    seed: p.seed ?? (sent.seed as number),
    width: p.width ?? (sent.width as number),
    height: p.height ?? (sent.height as number),
    steps: p.steps ?? (sent.steps as number),
    cfgScale: p.cfgScale ?? (sent.cfg_scale as number),
    sampler: p.sampler ?? (sent.sampler_name as string),
    ...(s.mode !== 'txt2img' ? { denoisingStrength: p.denoisingStrength ?? s.denoisingStrength } : {}),
    ...(result.source && s.mode !== 'txt2img' ? { source: result.source } : {}),
    ...(s.mode === 'region' && s.region ? { region: s.region } : {}),
    createdAt: now,
    ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
  };
}

/** The settings that reproduce a record (same seed), ready to run again or to change. */
export function settingsFromRecord(r: GenerationRecord): LocalGenSettings {
  return {
    mode: r.mode, prompt: r.prompt, negativePrompt: r.negativePrompt, style: r.style ? { ...r.style } : null,
    seed: r.seed, width: r.width, height: r.height, steps: r.steps, cfgScale: r.cfgScale, sampler: r.sampler,
    denoisingStrength: r.denoisingStrength ?? DEFAULT_LOCAL_SETTINGS.denoisingStrength,
    ...(r.region ? { region: r.region } : {}),
  };
}

const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'with', 'and', 'from', 'for', 'by', 'shot', 'wide', 'close', 'establishing']);

/** A short asset name: a few telling words of the prompt, or the source and what was done to it. */
export function recordName(r: GenerationRecord): string {
  const words = r.prompt.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter((w) => w && !SMALL_WORDS.has(w.toLowerCase())).slice(0, 4).join(' ');
  if (r.mode === 'txt2img') return words || 'Generated shot';
  return `${r.source?.name.replace(/\.[a-z0-9]+$/i, '') ?? 'Image'} ${r.mode === 'region' ? 'region' : 'variation'} ${r.seed}`;
}

/** One line describing a record, for tooltips and the assistant. */
export function describeRecord(r: GenerationRecord): string {
  const what = r.mode === 'txt2img' ? 'Text to image' : r.mode === 'img2img' ? `Variation of ${r.source?.name ?? 'an image'}` : `Region of ${r.source?.name ?? 'an image'}`;
  const denoise = r.denoisingStrength !== undefined && r.mode !== 'txt2img' ? `, denoise ${r.denoisingStrength}` : '';
  return `${what}: ${r.width}×${r.height}, seed ${r.seed}, ${r.steps} steps, CFG ${r.cfgScale}${denoise}, ${r.checkpoint || 'current model'}`;
}

export function denoiseHint(v: number): string {
  if (v <= 0.2) return 'Almost the same picture: small touch-ups only.';
  if (v <= 0.4) return 'Keeps the composition, layout and lights; restyles details.';
  if (v <= 0.6) return 'Keeps the rough layout; shapes and details change.';
  return 'Mostly new picture; only the overall colours and layout guide it.';
}

/**
 * Only servers on this computer are accepted, so the generator never has to be opened to the
 * network and nothing about the project leaves the machine.
 */
export function normalizeServerUrl(raw: string): string {
  const text = raw.trim() || 'http://127.0.0.1:7860';
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new Error(`"${raw}" is not a valid address. Use something like http://127.0.0.1:7860.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The address must start with http:// or https://.');
  if (!isLoopbackHost(url.hostname)) {
    throw new Error('Local generation only connects to a server on this computer (127.0.0.1 or localhost), so the generator stays private.');
  }
  if (url.username || url.password) throw new Error('Put the user name and password in the Password field, not in the address.');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Size and position for a background plate that exactly fills the frame as seen by the scene's
 * camera, even though it sits far back (`depth`) so every other layer draws in front of it.
 */
export function plateLayout(stage: { width: number; height: number }, image: { width: number; height: number }, cam: Camera, depth: number) {
  const cover = Math.max(stage.width / image.width, stage.height / image.height);
  // Planes further away are drawn smaller (see the camera in render/view.ts): undo that here.
  const perspective = (cam.focal + depth - cam.z) / (cam.zoom * cam.focal);
  return { x: cam.x, y: cam.y, width: image.width * cover * perspective, height: image.height * cover * perspective, depth };
}

export const PLATE_DEPTH = 600;
export const PLATE_TAG = 'plate';

/** The angle name suggested for a plate from its file name: "Babylon City Scene 1 Shot 1 Background" -> "Babylon City Scene 1 Shot 1". */
export function angleFromName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[\s_-]*(background|bg|plate)$/i, '').trim() || name;
}

/**
 * Where a region of the generated picture lies on the original source image. The source is
 * centre-cropped to the output shape before generating, so a source of another shape maps back
 * with that crop undone.
 */
export function regionInSource(r: Rect01, source: { width: number; height: number }, output: { width: number; height: number }): Rect01 {
  const k = Math.max(output.width / source.width, output.height / source.height);
  // Fraction of the source that is visible in the output, on each axis.
  const vw = Math.min(1, output.width / (source.width * k));
  const vh = Math.min(1, output.height / (source.height * k));
  return { x: (1 - vw) / 2 + r.x * vw, y: (1 - vh) / 2 + r.y * vh, w: r.w * vw, h: r.h * vh };
}

/** Size and centre of a layer covering `r` (0..1 of the source) on a plate layer drawn at its full size. */
export function layerOverPlate(plate: { x: number; y: number; width: number; height: number }, r: Rect01) {
  return {
    x: plate.x - plate.width / 2 + (r.x + r.w / 2) * plate.width,
    y: plate.y - plate.height / 2 + (r.y + r.h / 2) * plate.height,
    width: r.w * plate.width,
    height: r.h * plate.height,
  };
}
