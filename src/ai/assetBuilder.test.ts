import { describe, expect, it } from 'vitest';
import { ASSET_STYLES, assetPrompt, takesInputFidelity } from './assetBuilder';

const flat = ASSET_STYLES.find((s) => s.id === 'flat')!.text;
const base = { kind: 'prop', style: 'flat', transparent: true };

describe('asset prompt', () => {
  it('needs a description when there is no reference', () => {
    expect(() => assetPrompt({ ...base, description: '  ' })).toThrow(/Describe/);
    const p = assetPrompt({ ...base, description: 'a red bicycle' });
    expect(p).toContain('a red bicycle');
    expect(p).toContain(flat);
    expect(p).not.toMatch(/reference/i);
  });

  it('draws the reference subject with no description, keeping its own style', () => {
    const p = assetPrompt({ ...base, description: '', references: 1, referenceUse: 'both' });
    expect(p).toMatch(/subject in the reference image/);
    expect(p).toMatch(/Reproduce it faithfully/);
    expect(p).toMatch(/match the reference's art style/);
    // The preset would fight the reference's own look.
    expect(p).not.toContain(flat);
  });

  it('keeps the subject but applies the chosen style', () => {
    const p = assetPrompt({ ...base, description: 'make it blue', references: ['a', 'b'], referenceUse: 'subject' });
    expect(p).toMatch(/the 2 reference images/);
    expect(p).toMatch(/apply only those changes/);
    expect(p).toContain(flat);
  });

  it('uses a reference for style only and still needs a description', () => {
    expect(() => assetPrompt({ ...base, description: '', references: 1, referenceUse: 'style' })).toThrow(/style of the reference/);
    const p = assetPrompt({ ...base, description: 'a lighthouse', references: 1, referenceUse: 'style' });
    expect(p).toMatch(/only for style/);
    expect(p).not.toMatch(/Reproduce it faithfully/);
  });
});

describe('input fidelity support', () => {
  it('is sent only to models that accept it', () => {
    expect(takesInputFidelity('gpt-image-1')).toBe(true);
    expect(takesInputFidelity('gpt-image-1.5')).toBe(true);
    expect(takesInputFidelity('gpt-image-1-mini')).toBe(false);
    expect(takesInputFidelity('gpt-image-2')).toBe(false);
    expect(takesInputFidelity('gpt-image-2.5-sunburst')).toBe(false);
  });
});
