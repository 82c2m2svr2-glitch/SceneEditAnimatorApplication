import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev/test hook: lets end-to-end scripts drive the app without going through the UI.
if (import.meta.env.DEV) {
  void Promise.all([import('./state/store'), import('./state/ui'), import('./state/commands'), import('./state/content'), import('./state/settings'), import('./core/character/humanoid')]).then(([store, uiMod, commands, content, settingsMod, humanoid]) => {
    (window as unknown as Record<string, unknown>).df = { doc: store.doc, useUI: uiMod.useUI, commands, content, useSettings: settingsMod.useSettings, humanoidSpec: humanoid.humanoidSpec };
  });
}
