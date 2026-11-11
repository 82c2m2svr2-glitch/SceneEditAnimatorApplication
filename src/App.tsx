import { useEffect, useRef, useState } from 'react';
import { getEval } from './core/anim';
import { renderFrame } from './render/draw';
import { saveToLibrary } from './state/persistence';
import { doc } from './state/store';
import { useUI } from './state/ui';
import { LeftPanel } from './ui/LeftPanel';
import { MenuBar } from './ui/MenuBar';
import { ActionsPanel, AssetsPanel, HistoryPanel } from './ui/Panels';
import { Properties } from './ui/Properties';
import { handleKey, SHORTCUT_HELP } from './ui/shortcuts';
import { StartMenu } from './ui/StartMenu';
import { Timeline } from './ui/Timeline';
import { Toolbar } from './ui/Toolbar';
import { ViewBar } from './ui/ViewBar';
import { Viewport } from './ui/Viewport';
import { Dialog } from './ui/widgets';

/** Small JPEG of the first scene for the Recent projects list. */
function thumbnail(): string | undefined {
  const p = doc.project;
  if (!p) return undefined;
  try {
    const w = 192;
    const h = Math.round((w * p.height) / p.width);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    renderFrame(c.getContext('2d')!, p, getEval(p, p.scenes[0], 0), w, h);
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return undefined;
  }
}

function Editor() {
  const rightTab = useUI((s) => s.rightTab);
  const bottomPanel = useUI((s) => s.bottomPanel);
  const set = useUI((s) => s.set);
  const [bottomH, setBottomH] = useState(250);
  const drag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    // Autosave into the local library whenever there are unsaved changes.
    let savedRev = doc.revision;
    const timer = setInterval(() => {
      if (!doc.project || doc.revision === savedRev || doc.inTransaction) return;
      savedRev = doc.revision;
      void saveToLibrary(thumbnail());
    }, 15000);
    const beforeUnload = () => void saveToLibrary();
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('beforeunload', beforeUnload);
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <MenuBar />
      <div className="editor">
        <Toolbar />
        <LeftPanel />
        <div className="center">
          <ViewBar />
          <Viewport />
        </div>
        <div className="panel right">
          <div className="tabs">
            {(['properties', 'actions', 'assets', 'history'] as const).map((t) => (
              <button key={t} className={`tab${rightTab === t ? ' on' : ''}`} onClick={() => set({ rightTab: t })}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div className="panel-body">
            {rightTab === 'properties' && <Properties />}
            {rightTab === 'actions' && <ActionsPanel />}
            {rightTab === 'assets' && <AssetsPanel />}
            {rightTab === 'history' && <HistoryPanel />}
          </div>
        </div>
        <div className="bottom" style={{ height: bottomH }}>
          <div
            className="resizer"
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = { y: e.clientY, h: bottomH };
            }}
            onPointerMove={(e) => drag.current && setBottomH(Math.max(120, Math.min(window.innerHeight - 240, drag.current.h + drag.current.y - e.clientY)))}
            onPointerUp={() => (drag.current = null)}
          />
          {bottomPanel === 'timeline' && <Timeline />}
        </div>
      </div>
    </>
  );
}

function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const screen = useUI((s) => s.screen);
  const dialog = useUI((s) => s.dialog);
  const set = useUI((s) => s.set);
  return (
    <div className="app">
      {screen === 'editor' && doc.project ? <Editor /> : <StartMenu />}
      {dialog === 'shortcuts' && (
        <Dialog title="Keyboard shortcuts" onClose={() => set({ dialog: null })}>
          <div className="kbd-list">
            {SHORTCUT_HELP.map(([k, v]) => (
              <div key={k}>
                <span>{v}</span>
                <kbd>{k}</kbd>
              </div>
            ))}
          </div>
        </Dialog>
      )}
      <Toasts />
    </div>
  );
}
