import type { Asset, Project } from '../core/types';
import { requestRepaint } from '../state/ui';

type Loaded = HTMLImageElement | ImageBitmap;

const cache = new Map<string, { src: string; img: Loaded | null; pending: Promise<Loaded | null> }>();

function load(asset: Asset): Promise<Loaded | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = asset.dataUrl;
  });
}

function entry(asset: Asset) {
  let e = cache.get(asset.id);
  if (!e || e.src !== asset.dataUrl) {
    const fresh = { src: asset.dataUrl, img: null as Loaded | null, pending: Promise.resolve<Loaded | null>(null) };
    fresh.pending = load(asset).then((img) => {
      fresh.img = img;
      requestRepaint();
      return img;
    });
    cache.set(asset.id, fresh);
    e = fresh;
  }
  return e;
}

/** Decoded image for an asset, or null while it is still decoding (a repaint follows when ready). */
export function getImage(asset: Asset | undefined): Loaded | null {
  if (!asset || asset.kind !== 'image') return null;
  return entry(asset).img;
}

/** Resolves once every image in the project is decoded. Export waits on this. */
export async function preloadImages(project: Project): Promise<void> {
  await Promise.all(Object.values(project.assets).filter((a) => a.kind === 'image').map((a) => entry(a).pending));
}

/** Reads an image file's pixel size. */
export function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = dataUrl;
  });
}
