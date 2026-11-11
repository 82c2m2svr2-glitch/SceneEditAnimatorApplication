import type { ID } from './types';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short random id, e.g. "n_k3f9x2ab". Collision odds are negligible at document scale. */
export function newId(prefix = 'n'): ID {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[(Math.random() * 36) | 0];
  return `${prefix}_${s}`;
}
