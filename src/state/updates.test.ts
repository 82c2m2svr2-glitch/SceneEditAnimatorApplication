import { describe, expect, it } from 'vitest';
import { assetPrompt } from '../ai/assetBuilder';
import { compareVersions, readRelease } from './updates';

describe('update check', () => {
  it('orders version numbers', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('v0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', 'v0.2.0-beta')).toBe(-1);
  });

  it('reads a GitHub release', () => {
    const release = {
      tag_name: 'v0.3.0', html_url: 'https://example.test/release', body: 'Notes',
      assets: [{ name: 'notes.txt', browser_download_url: 'https://example.test/notes.txt' }, { name: 'DreamForge-0.3.0-windows.exe', browser_download_url: 'https://example.test/app.exe' }],
    };
    expect(readRelease(release, '0.2.0')).toEqual({ current: '0.2.0', latest: '0.3.0', newer: true, page: 'https://example.test/release', download: 'https://example.test/app.exe', notes: 'Notes' });
    expect(readRelease(release, '0.3.0').newer).toBe(false);
    expect(readRelease({ tag_name: 'v9.0.0' }, '0.1.0').download).toBeNull();
    expect(() => readRelease({ message: 'Not Found' })).toThrow(/release/);
  });
});

describe('assetPrompt', () => {
  it('combines the description, the asset type and the style', () => {
    const prompt = assetPrompt({ description: 'a red bicycle', kind: 'prop', style: 'flat', transparent: true });
    expect(prompt).toContain('a red bicycle');
    expect(prompt).toMatch(/single object/i);
    expect(prompt).toMatch(/flat cartoon/i);
    expect(prompt).toMatch(/transparent/i);
    expect(assetPrompt({ description: 'a park', kind: 'background', style: 'none', transparent: false })).not.toMatch(/transparent/i);
  });

  it('refuses an empty description', () => {
    expect(() => assetPrompt({ description: '  ', kind: 'prop', style: 'flat', transparent: true })).toThrow(/Describe/);
  });
});
