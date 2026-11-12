import { describe, expect, it } from 'vitest';
import {
  angleFromName, buildRequest, CEL_90S, composeNegative, composePrompt, DEFAULT_LOCAL_SETTINGS, describeRecord, isLoopbackHost, layerOverPlate,
  makeRecord, normalizeServerUrl, parseInfo, plateLayout, recordName, regionInSource, regionPixels, settingsFromRecord, snap8, type LocalGenSettings,
} from './localGen';
import type { Camera } from './types';

const base: LocalGenSettings = { ...DEFAULT_LOCAL_SETTINGS, prompt: 'nighttime waterfront promenade, metal railing, skyline' };
const cam: Camera = { x: 960, y: 540, z: 0, zoom: 1, rotation: 0, focal: 1000, dofEnabled: false, focusDepth: 0, aperture: 0 };

describe('local generation request', () => {
  it('adds the style to the shot, and the style negatives first', () => {
    expect(composePrompt(base)).toBe(`nighttime waterfront promenade, metal railing, skyline, ${CEL_90S.positive}`);
    expect(composeNegative({ negativePrompt: 'rain', style: CEL_90S })).toBe(`${CEL_90S.negative}, rain`);
    expect(composePrompt({ prompt: '  a cat, ', style: null })).toBe('a cat');
  });

  it('builds a 512x288 text-to-image request with a random seed', () => {
    const r = buildRequest(base);
    expect(r.path).toBe('/sdapi/v1/txt2img');
    expect(r.body).toMatchObject({ width: 512, height: 288, seed: -1, steps: 20, cfg_scale: 7, batch_size: 1, send_images: true, save_images: false });
    expect(r.body).not.toHaveProperty('init_images');
  });

  it('builds image-to-image and region requests', () => {
    expect(() => buildRequest({ ...base, mode: 'img2img' })).toThrow(/image to start/);
    const v = buildRequest({ ...base, mode: 'img2img', denoisingStrength: 0.25, seed: 42 }, { source: 'SRC' });
    expect(v.path).toBe('/sdapi/v1/img2img');
    expect(v.body).toMatchObject({ init_images: ['SRC'], denoising_strength: 0.25, seed: 42 });
    expect(v.body).not.toHaveProperty('mask');
    const r = buildRequest({ ...base, mode: 'region', denoisingStrength: 0.7 }, { source: 'SRC', mask: 'MASK' });
    expect(r.body).toMatchObject({ mask: 'MASK', mask_blur: 4, denoising_strength: 0.7 });
    expect(buildRequest({ ...base, mode: 'img2img', denoisingStrength: 4 }, { source: 'S' }).body.denoising_strength).toBe(1);
  });

  it('keeps sizes on multiples of 8', () => {
    expect(snap8(515)).toBe(512);
    expect(snap8(10)).toBe(64);
    expect(buildRequest({ ...base, width: 517, height: 290 }).body).toMatchObject({ width: 512, height: 288 });
  });
});

describe('generation record', () => {
  const info = JSON.stringify({ seed: 1234567, all_seeds: [1234567], width: 512, height: 288, steps: 20, cfg_scale: 7, sampler_name: 'Euler a', sd_model_hash: 'abc123', denoising_strength: 0.25 });

  it('reads the server info, tolerating junk', () => {
    expect(parseInfo(info)).toMatchObject({ seed: 1234567, width: 512, sampler: 'Euler a', modelHash: 'abc123' });
    expect(parseInfo('not json')).toEqual({});
    expect(parseInfo(JSON.stringify({ all_seeds: [9] })).seed).toBe(9);
  });

  it('records what was used, with the real seed, and reproduces it', () => {
    const s: LocalGenSettings = { ...base, mode: 'img2img', denoisingStrength: 0.25 };
    const r = makeRecord(s, { info, checkpoint: 'anything-v3-fp16-pruned [abc123]', source: { assetId: 'img1', name: 'Babylon.png' } }, 1000);
    expect(r).toMatchObject({
      engine: 'sdnext', mode: 'img2img', seed: 1234567, width: 512, height: 288, steps: 20, cfgScale: 7, sampler: 'Euler a',
      checkpoint: 'anything-v3-fp16-pruned [abc123]', checkpointHash: 'abc123', denoisingStrength: 0.25, source: { assetId: 'img1', name: 'Babylon.png' }, createdAt: 1000,
    });
    expect(r.fullPrompt).toContain(CEL_90S.positive);
    expect(r.style?.name).toBe(CEL_90S.name);
    const again = settingsFromRecord(r);
    expect(again).toMatchObject({ mode: 'img2img', seed: 1234567, denoisingStrength: 0.25, prompt: base.prompt });
    expect(buildRequest(again, { source: 'S' }).body.seed).toBe(1234567);
    expect(describeRecord(r)).toMatch(/Variation of Babylon\.png: 512×288, seed 1234567.*denoise 0\.25/);
    expect(recordName(r)).toBe('Babylon variation 1234567');
    expect(recordName({ ...r, mode: 'txt2img', prompt: 'wide establishing shot of a nighttime waterfront promenade' })).toBe('nighttime waterfront promenade');
  });

  it('leaves out image-only fields for text to image', () => {
    const r = makeRecord(base, { info: '{}', checkpoint: 'm', source: { assetId: 'x', name: 'y' } });
    expect(r).not.toHaveProperty('denoisingStrength');
    expect(r).not.toHaveProperty('source');
    expect(r.seed).toBe(-1);
  });
});

describe('server address', () => {
  it('accepts only this computer', () => {
    expect(normalizeServerUrl('')).toBe('http://127.0.0.1:7860');
    expect(normalizeServerUrl('localhost:7860/')).toBe('http://localhost:7860');
    expect(normalizeServerUrl('http://[::1]:7860')).toBe('http://[::1]:7860');
    expect(() => normalizeServerUrl('http://192.168.1.20:7860')).toThrow(/this computer/);
    expect(() => normalizeServerUrl('https://example.com')).toThrow(/this computer/);
    expect(() => normalizeServerUrl('http://user:pw@127.0.0.1:7860')).toThrow(/Password/);
    expect(isLoopbackHost('127.4.5.6')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
  });
});

describe('plates and regions', () => {
  it('sizes a plate so it fills the frame from far back', () => {
    const box = plateLayout({ width: 1920, height: 1080 }, { width: 1672, height: 941 }, cam, 600);
    // Cover scale times the perspective undo (1600 / 1000).
    expect(box.width).toBeCloseTo(1672 * Math.max(1920 / 1672, 1080 / 941) * 1.6, 3);
    expect(box.width * (1000 / 1600)).toBeGreaterThanOrEqual(1920 - 1e-6);
    expect(box.height * (1000 / 1600)).toBeGreaterThanOrEqual(1080 - 1e-6);
    expect(box).toMatchObject({ x: 960, y: 540, depth: 600 });
  });

  it('maps a region of the preview back onto the plate', () => {
    expect(regionPixels({ x: 0, y: 0.5, w: 1, h: 0.5 }, 512, 288)).toEqual({ x: 0, y: 144, w: 512, h: 144 });
    // Same shape: unchanged.
    const same = regionInSource({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { width: 1920, height: 1080 }, { width: 512, height: 288 });
    expect(same.x).toBeCloseTo(0.5);
    expect(same.w).toBeCloseTo(0.5);
    // A 4:3 source is cropped top and bottom for a 16:9 preview.
    const tall = regionInSource({ x: 0, y: 0, w: 1, h: 1 }, { width: 1600, height: 1200 }, { width: 512, height: 288 });
    expect(tall.x).toBeCloseTo(0);
    expect(tall.h).toBeCloseTo(0.75);
    expect(tall.y).toBeCloseTo(0.125);
    const over = layerOverPlate({ x: 960, y: 540, width: 1000, height: 500 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(over).toEqual({ x: 1210, y: 665, width: 500, height: 250 });
  });

  it('suggests the camera angle from the file name', () => {
    expect(angleFromName('Babylon City Scene 1 Shot 1 Background.png')).toBe('Babylon City Scene 1 Shot 1');
    expect(angleFromName('pier_bg.jpg')).toBe('pier');
    expect(angleFromName('Background.png')).toBe('Background.png');
  });
});
