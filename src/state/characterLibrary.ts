import type { CharacterSpec } from '../core/character/spec';
import { newId } from '../core/ids';
import { renderSpecPreview } from '../render/preview';
import { idb } from './persistence';

/**
 * Every character made in Character Creator is kept here, on this computer, so it can be added to
 * any project later. Nothing in the library is uploaded anywhere.
 */
export interface SavedCharacter {
  id: string;
  name: string;
  createdAt: number;
  /** How it was made: "Describe", "Quick builder", ... */
  source: string;
  thumb: string;
  spec: CharacterSpec;
}

const STORE = 'characters';

function thumbnail(spec: CharacterSpec): string {
  try {
    const big = document.createElement('canvas');
    renderSpecPreview(big, spec, spec.views.front ? 'front' : (Object.keys(spec.views)[0] as keyof CharacterSpec['views']), '#1b1d24');
    const small = document.createElement('canvas');
    small.width = 150;
    small.height = 200;
    small.getContext('2d')!.drawImage(big, 0, 0, small.width, small.height);
    return small.toDataURL('image/webp', 0.85);
  } catch {
    return '';
  }
}

export async function saveCharacter(spec: CharacterSpec, source: string): Promise<SavedCharacter> {
  const entry: SavedCharacter = { id: newId('chr'), name: spec.name || 'Character', createdAt: Date.now(), source, thumb: thumbnail(spec), spec };
  await idb(STORE, 'readwrite', (s) => s.put(entry));
  return entry;
}

/** Saved characters, newest first. */
export async function listCharacters(): Promise<SavedCharacter[]> {
  const all = await idb<SavedCharacter[]>(STORE, 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteCharacter(id: string): Promise<void> {
  await idb(STORE, 'readwrite', (s) => s.delete(id));
}
