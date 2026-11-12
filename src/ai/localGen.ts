/**
 * Talks to the local image generator (SD.Next, `/sdapi/v1` API) on this computer. No API key, no
 * paid service and nothing leaves the machine: the desktop app sends requests from its own process
 * to 127.0.0.1, and the browser version calls the same address directly.
 */
import {
  buildRequest, makeRecord, normalizeServerUrl, regionPixels, type GenerationRecord, type LocalGenSettings, type Rect01,
} from '../core/localGen';
import { settings } from '../state/settings';

/** An error whose message can be shown to the user as-is. */
export class LocalGenError extends Error {}

interface RawResponse {
  ok: boolean;
  status: number;
  text?: string;
  error?: string;
}

const STATUS_TIMEOUT = 10_000;
/** The first image after starting, or after a change of model or size, waits for OpenVINO to compile. */
const GENERATE_TIMEOUT = 20 * 60_000;

function errorText(raw: RawResponse, path: string): string {
  if (raw.status === 0) return raw.error ?? 'Could not reach the local generator.';
  let detail = '';
  try {
    const j = JSON.parse(raw.text ?? '');
    const d = j?.detail ?? j?.error ?? j?.errors ?? j?.message;
    detail = typeof d === 'string' ? d : d ? JSON.stringify(d).slice(0, 300) : '';
  } catch {
    detail = (raw.text ?? '').slice(0, 200);
  }
  if (raw.status === 401) return 'The generator asks for a password. Enter it as user:password in Local generation settings (the one SD.Next was started with --auth).';
  if (raw.status === 404) return `The server answered but has no ${path}. Make sure it is SD.Next and that its API is on.`;
  return `The generator answered with an error (${raw.status}). ${detail}`.trim();
}

async function send(method: 'GET' | 'POST', path: string, body?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> {
  let base: string;
  try {
    base = normalizeServerUrl(settings().localGenUrl);
  } catch (err) {
    throw new LocalGenError((err as Error).message);
  }
  const auth = settings().localGenAuth.trim();
  const json = body === undefined ? undefined : JSON.stringify(body);
  const timeoutMs = opts.timeoutMs ?? STATUS_TIMEOUT;
  const native = window.dreamforge?.localGen;
  let raw: RawResponse;
  if (native) {
    raw = await native({ base, method, path, body: json, auth: auth || undefined, timeoutMs });
  } else {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const stop = () => ac.abort();
    opts.signal?.addEventListener('abort', stop);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (json) headers['Content-Type'] = 'application/json';
      if (auth.includes(':')) headers.Authorization = `Basic ${btoa(auth)}`;
      const res = await fetch(base + path, { method, headers, body: json, signal: ac.signal, cache: 'no-store' });
      raw = { ok: res.ok, status: res.status, text: await res.text() };
    } catch {
      if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      raw = {
        ok: false, status: 0,
        error: ac.signal.aborted
          ? 'The generator did not answer in time.'
          : `Could not reach the generator at ${base}. Check that SD.Next is running. In the browser version it must also be started with --cors-origins ${location.origin} (the desktop app does not need this).`,
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
    }
  }
  if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  if (!raw.ok) throw new LocalGenError(errorText(raw, path));
  if (!raw.text) return null;
  try {
    return JSON.parse(raw.text);
  } catch {
    return raw.text;
  }
}

export interface Checkpoint {
  title: string;
  name: string;
}

export interface LocalGenStatus {
  url: string;
  version: string;
  /** Title of the loaded checkpoint, as SD.Next names it. */
  checkpoint: string;
  checkpoints: Checkpoint[];
  samplers: string[];
  /** OpenVINO device setting: empty means OpenVINO picks one itself (AUTO). */
  openvinoDevices: string[];
  openvinoCaching: boolean;
  /** Milliseconds the version request took. */
  ms: number;
}

const versionText = (v: any): string =>
  v && typeof v === 'object' ? ['SD.Next', v.branch, v.commit, v.updated ? `(${v.updated})` : ''].filter((x) => x && x !== 'unknown').join(' ') : String(v ?? 'SD.Next');

/** Checks that the generator is reachable and reads what it has loaded. */
export async function checkLocalGenerator(): Promise<LocalGenStatus> {
  const url = normalizeServerUrl(settings().localGenUrl);
  const t0 = performance.now();
  const version = await send('GET', '/sdapi/v1/version');
  const ms = Math.round(performance.now() - t0);
  const [options, models, samplers] = await Promise.all([
    send('GET', '/sdapi/v1/options'),
    send('GET', '/sdapi/v1/sd-models').catch(() => []),
    send('GET', '/sdapi/v1/samplers').catch(() => []),
  ]);
  return {
    url,
    version: versionText(version),
    checkpoint: typeof options?.sd_model_checkpoint === 'string' ? options.sd_model_checkpoint : '',
    checkpoints: (Array.isArray(models) ? models : []).filter((m) => typeof m?.title === 'string').map((m) => ({ title: m.title, name: typeof m.model_name === 'string' ? m.model_name : m.title })),
    samplers: (Array.isArray(samplers) ? samplers : []).map((s) => s?.name).filter((n): n is string => typeof n === 'string'),
    openvinoDevices: Array.isArray(options?.openvino_devices) ? options.openvino_devices : [],
    openvinoCaching: options?.openvino_disable_model_caching === false,
    ms,
  };
}

/** Loads a checkpoint. Takes a while: the model is read from disk and compiled again. */
export async function selectCheckpoint(title: string): Promise<void> {
  await send('POST', '/sdapi/v1/options', { sd_model_checkpoint: title }, { timeoutMs: GENERATE_TIMEOUT });
  // In API-only mode SD.Next only loads the new model when asked to.
  await send('POST', '/sdapi/v1/reload-checkpoint', undefined, { timeoutMs: GENERATE_TIMEOUT });
}

/**
 * Settings for an Intel laptop: run on the integrated graphics (GPU) rather than letting OpenVINO
 * pick, and keep compiled models on disk so the multi-minute compile happens once per size, not
 * after every restart.
 */
export async function applyRecommendedOpenVino(device = 'GPU'): Promise<void> {
  await send('POST', '/sdapi/v1/options', { openvino_devices: [device], openvino_disable_model_caching: false });
  await send('POST', '/sdapi/v1/reload-checkpoint', undefined, { timeoutMs: GENERATE_TIMEOUT });
}

export async function interruptLocal(): Promise<void> {
  await send('POST', '/sdapi/v1/interrupt').catch(() => {});
}

export interface LocalProgress {
  /** 0..1 */
  progress: number;
  step: number;
  steps: number;
  etaSeconds: number;
}

export interface LocalResult {
  dataUrl: string;
  record: GenerationRecord;
}

/**
 * Generates one picture. `source` is the starting image for variations and regions (any data URL;
 * it is fitted to the output size here). Progress is polled from the server while it works.
 */
export async function generateLocal(
  s: LocalGenSettings,
  opts: { checkpoint?: string; source?: { assetId: string; name: string; dataUrl: string }; onProgress?: (p: LocalProgress) => void; signal?: AbortSignal } = {},
): Promise<LocalResult> {
  const options = await send('GET', '/sdapi/v1/options');
  let checkpoint = typeof options?.sd_model_checkpoint === 'string' ? options.sd_model_checkpoint : '';
  if (opts.checkpoint && opts.checkpoint !== checkpoint) {
    await selectCheckpoint(opts.checkpoint);
    checkpoint = opts.checkpoint;
  }
  const images: { source?: string; mask?: string } = {};
  if (s.mode !== 'txt2img') {
    if (!opts.source) throw new LocalGenError('Choose the project image to start from.');
    images.source = stripPrefix(await fitImage(opts.source.dataUrl, s.width, s.height));
    if (s.mode === 'region') {
      if (!s.region) throw new LocalGenError('Choose the region to change.');
      images.mask = stripPrefix(regionMask(s.width, s.height, s.region));
    }
  }
  const req = buildRequest(s, images);
  const version = await send('GET', '/sdapi/v1/version').then(versionText, () => undefined);

  let polling = true;
  const poll = async () => {
    while (polling && opts.onProgress) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!polling) break;
      try {
        const p = await send('GET', '/sdapi/v1/progress?skip_current_image=true');
        const st = p?.state ?? {};
        opts.onProgress({ progress: Number(p?.progress) || 0, step: Number(st.sampling_step) || 0, steps: Number(st.sampling_steps) || s.steps, etaSeconds: Number(p?.eta_relative) || 0 });
      } catch {
        // Progress is only a nicety; the generation itself reports real errors.
      }
    }
  };
  const onAbort = () => void interruptLocal();
  opts.signal?.addEventListener('abort', onAbort);
  void poll();
  let data: any;
  try {
    data = await send('POST', req.path, req.body, { timeoutMs: GENERATE_TIMEOUT, signal: opts.signal });
  } finally {
    polling = false;
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  const b64 = Array.isArray(data?.images) ? data.images[0] : null;
  if (typeof b64 !== 'string' || !b64) throw new LocalGenError('The generator finished but sent back no image.');
  const dataUrl = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64.split(',', 1)[0]}`;
  const record = makeRecord(s, {
    info: data?.info, checkpoint,
    source: opts.source ? { assetId: opts.source.assetId, name: opts.source.name } : undefined,
    serverVersion: version,
  });
  return { dataUrl, record };
}

// --- images ------------------------------------------------------------------------------------

const stripPrefix = (url: string) => url.replace(/^data:[^,]*,/, '');

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new LocalGenError('That image could not be read.'));
    img.src = url;
  });
}

/** Scales and centre-crops a picture to exactly width x height (the plate keeps its framing at 16:9). */
export async function fitImage(url: string, width: number, height: number): Promise<string> {
  const img = await loadImage(url);
  const k = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const w = img.naturalWidth * k;
  const h = img.naturalHeight * k;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, width, height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
  return c.toDataURL('image/png');
}

/** White where the picture may change, black where it must stay. */
export function regionMask(width: number, height: number, r: Rect01): string {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, width, height);
  const px = regionPixels(r, width, height);
  g.fillStyle = '#fff';
  g.fillRect(px.x, px.y, px.w, px.h);
  return c.toDataURL('image/png');
}

/** Cuts the region out of a generated picture, so it can sit as its own layer over the untouched plate. */
export async function cropRegion(url: string, r: Rect01): Promise<string> {
  const img = await loadImage(url);
  const px = regionPixels(r, img.naturalWidth, img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = px.w;
  c.height = px.h;
  c.getContext('2d')!.drawImage(img, px.x, px.y, px.w, px.h, 0, 0, px.w, px.h);
  return c.toDataURL('image/png');
}
