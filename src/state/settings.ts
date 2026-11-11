import { create } from 'zustand';

export type ProviderId = 'openai' | 'anthropic';

export interface Settings {
  openaiKey: string;
  anthropicKey: string;
  /** Which service powers the assistant chat. Character Creator always uses OpenAI. */
  assistantProvider: ProviderId;
  openaiModel: string;
  anthropicModel: string;
  /** OpenAI image model used by Character Creator. */
  imageModel: string;
  /** OpenAI vision model that converts images into vector parts. */
  visionModel: string;
  /** 'auto' acts immediately (undoable); 'ask' shows the planned changes and waits for approval. */
  aiMode: 'auto' | 'ask';
}

const DEFAULTS: Settings = {
  openaiKey: '', anthropicKey: '', assistantProvider: 'openai', openaiModel: 'gpt-6-astra',
  anthropicModel: 'claude-opus-5-5', imageModel: 'gpt-image-2.5-sunburst', visionModel: 'gpt-6-astra', aiMode: 'auto',
};

const STORAGE = 'dreamforge.settings';
const SECRET_FIELDS = ['openaiKey', 'anthropicKey'] as const;

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const useSettings = create<Settings & { update: (patch: Partial<Settings>) => void }>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch);
    const { update: _u, ...all } = get();
    const native = window.dreamforge;
    const stored: Record<string, unknown> = { ...all };
    if (native) {
      // On desktop, keys go to the operating system's credential store, not to plain storage.
      for (const f of SECRET_FIELDS) {
        if (f in patch) void native.setSecret(f, all[f]);
        delete stored[f];
      }
    }
    try {
      localStorage.setItem(STORAGE, JSON.stringify(stored));
    } catch {}
  },
}));

export const settings = (): Settings => useSettings.getState();

/** Loads keys from the desktop credential store, when running as the desktop app. */
export async function loadNativeSecrets(): Promise<void> {
  const native = window.dreamforge;
  if (!native) return;
  const patch: Partial<Settings> = {};
  for (const f of SECRET_FIELDS) {
    const v = await native.getSecret(f);
    if (v) patch[f] = v;
  }
  if (Object.keys(patch).length) useSettings.setState(patch);
}
