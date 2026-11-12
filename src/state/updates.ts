import { create } from 'zustand';

/**
 * Update check. DreamForge is published as releases of its GitHub repository; this asks GitHub for
 * the newest release and compares it with the running version. Nothing about the user or their
 * projects is sent: it is a plain, anonymous request for a public page.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

const RELEASES = 'https://api.github.com/repos/82c2m2svr2-glitch/SceneEditAnimatorApplication/releases/latest';
const LAST_CHECK = 'dreamforge.updateCheck';

export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  /** Release page on GitHub. */
  page: string;
  /** Direct download of the Windows program, when the release has one. */
  download: string | null;
  /** Size in bytes and SHA-256 of that program, when GitHub reports them, to check the download. */
  downloadSize: number | null;
  sha256: string | null;
  notes: string;
}

/** The newer release found by the startup check, for the Update button in the menu bar. */
export const useUpdate = create<{ available: UpdateInfo | null }>(() => ({ available: null }));

/** Compares dotted version numbers; a leading "v" and anything after the numbers is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.trim().replace(/^v/i, '').match(/^\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export function readRelease(data: unknown, current = APP_VERSION): UpdateInfo {
  const r = (data ?? {}) as { tag_name?: unknown; html_url?: unknown; body?: unknown; assets?: unknown };
  if (typeof r.tag_name !== 'string') throw new Error('GitHub did not return a release.');
  const assets = Array.isArray(r.assets) ? (r.assets as { name?: unknown; browser_download_url?: unknown }[]) : [];
  const exe = (assets as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[])
    .find((a) => typeof a.name === 'string' && /\.exe$/i.test(a.name) && typeof a.browser_download_url === 'string');
  const digest = typeof exe?.digest === 'string' ? exe.digest.match(/^sha256:([0-9a-f]{64})$/i)?.[1].toLowerCase() ?? null : null;
  const latest = r.tag_name.replace(/^v/i, '');
  return {
    current,
    latest,
    newer: compareVersions(latest, current) > 0,
    page: typeof r.html_url === 'string' ? r.html_url : 'https://github.com/82c2m2svr2-glitch/SceneEditAnimatorApplication/releases',
    download: exe ? (exe.browser_download_url as string) : null,
    downloadSize: typeof exe?.size === 'number' && exe.size > 0 ? exe.size : null,
    sha256: digest,
    notes: typeof r.body === 'string' ? r.body : '',
  };
}

export async function checkForUpdates(signal?: AbortSignal): Promise<UpdateInfo> {
  let res: Response;
  try {
    res = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' }, signal });
  } catch {
    throw new Error('Could not reach GitHub. Check your internet connection.');
  }
  if (res.status === 404) throw new Error('No release has been published yet.');
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests from this network right now. Try again in a while.');
  if (!res.ok) throw new Error(`GitHub answered with an error (${res.status}).`);
  try {
    localStorage.setItem(LAST_CHECK, String(Date.now()));
  } catch {}
  return readRelease(await res.json());
}

const NOTIFIED = 'dreamforge.updateNotified';

/**
 * Quietly, at startup: looks for a newer release and, if there is one, shows the Update button.
 * Resolves with the update only the first time a given version is found, so the reminder pops up
 * once per new version and the button stays until it is installed.
 */
export async function startupUpdateCheck(): Promise<UpdateInfo | null> {
  try {
    const info = await checkForUpdates();
    useUpdate.setState({ available: info.newer ? info : null });
    if (!info.newer) return null;
    let seen = '';
    try {
      seen = localStorage.getItem(NOTIFIED) ?? '';
      localStorage.setItem(NOTIFIED, info.latest);
    } catch {}
    return seen === info.latest ? null : info;
  } catch {
    return null;
  }
}

