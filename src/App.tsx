import { useEffect, useRef, useState } from 'react';
import { getEval } from './core/anim';
import { renderFrame } from './render/draw';
import { importAudio } from './audio/engine';
import { importImage, importModel, importRig, isModelFile, placeImage, placeModel, readAsDataUrl } from './state/content';
import { openProjectFile, saveToLibrary } from './state/persistence';
import { keyNodes, scene as currentScene, setFrame } from './state/commands';
import { togglePlay } from './state/playback';
import { doc, useDocRevision } from './state/store';
import { toggleFullscreen, ui, useUI } from './state/ui';
import { loadNativeSecrets } from './state/settings';
import { CharacterCreator } from './ui/CharacterCreator';
import { ChatPanel } from './ui/ChatPanel';
import { ExportDialog } from './ui/ExportDialog';
import { TraceDialog } from './ui/TraceDialog';
import { AssetBuilder } from './ui/AssetBuilder';
import { MemoryDialog } from './ui/MemoryDialog';
import { UpdateDialog } from './ui/UpdateDialog';
import { dailyUpdateCheck } from './state/updates';
import { GraphEditor } from './ui/GraphEditor';
import { LeftPanel } from './ui/LeftPanel';
import { MenuBar } from './ui/MenuBar';
import { ActionsPanel, AssetsPanel, HistoryPanel } from './ui/Panels';
import { Properties } from './ui/Properties';
import { handleKey, SHORTCUT_HELP } from './ui/shortcuts';
import { SettingsDialog } from './ui/SettingsDialog';
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

/** Files dropped onto the window: images and audio are imported, projects and characters opened. */
async function handleDrop(files: File[]): Promise<void> {
  for (const f of files) {
    const name = f.name.toLowerCase();
    try {
      if (name.endsWith('.dreamforge')) await openProjectFile(f);
      else if (name.endsWith('.dfrig')) importRig(JSON.parse(await f.text()));
      else if (f.type.startsWith('image/')) placeImage(await importImage(f.name, await readAsDataUrl(f), f.type));
      else if (f.type.startsWith('audio/')) await importAudio(f);
      else if (isModelFile(f.name)) placeModel(await importModel(f));
      else ui().toast(`"${f.name}" is not a file DreamForge can import.`, 'error');
    } catch (err) {
      ui().toast(err instanceof Error ? err.message : `Could not import "${f.name}".`, 'error');
    }
  }
}

function Editor() {
  const rightTab = useUI((s) => s.rightTab);
  const bottomPanel = useUI((s) => s.bottomPanel);
  const set = useUI((s) => s.set);
  const showChat = useUI((s) => s.showChat);
  const full = useUI((s) => s.fullscreen);
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
      {!full && <MenuBar />}
      <div
        className={`editor${full ? ' full' : ''}`}
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          void handleDrop([...e.dataTransfer.files]);
        }}
      >
        <Toolbar />
        {!full && <LeftPanel />}
        <div className="center">
          <ViewBar />
          <Viewport />
          {full && <FullscreenBar />}
        </div>
        <div className="panel right" style={full ? { display: 'none' } : undefined}>
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
        <div className="bottom" style={full ? { display: 'none' } : { height: bottomH }}>
          <div
            className="resizer"
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = { y: e.clientY, h: bottomH };
            }}
            onPointerMove={(e) => drag.current && setBottomH(Math.max(120, Math.min(window.innerHeight - 240, drag.current.h + drag.current.y - e.clientY)))}
            onPointerUp={() => (drag.current = null)}
          />
          <div className="tabs" style={{ flex: 'none' }}>
            <button className={`tab${bottomPanel === 'timeline' ? ' on' : ''}`} style={{ flex: 'none', padding: '0 14px', height: 24 }} onClick={() => set({ bottomPanel: 'timeline' })}>Timeline</button>
            <button className={`tab${bottomPanel === 'graph' ? ' on' : ''}`} style={{ flex: 'none', padding: '0 14px', height: 24 }} onClick={() => set({ bottomPanel: 'graph' })}>Graph editor</button>
          </div>
          {bottomPanel === 'timeline' ? <Timeline /> : <GraphEditor />}
        </div>
        {showChat && !full && <ChatPanel />}
      </div>
    </>
  );
}

/** The few controls full-screen editing needs: scrub, play, key and a way back. */
function FullscreenBar() {
  const frame = useUI((s) => s.frame);
  const playing = useUI((s) => s.playing);
  const selection = useUI((s) => s.selection);
  useDocRevision();
  const duration = currentScene().duration;
  return (
    <div className="full-bar">
      <button className="btn" title="Play / pause (Space)" onClick={() => togglePlay()}>{playing ? 'Pause' : 'Play'}</button>
      <input type="range" min={0} max={Math.max(1, duration - 1)} value={Math.round(frame)} onChange={(e) => setFrame(Number(e.target.value))} title="Scrub the timeline (arrow keys step one frame)" />
      <span className="chip" style={{ minWidth: 76, textAlign: 'center' }}>{Math.round(frame)} / {duration - 1}</span>
      <button className="btn" disabled={!selection.length} title="Insert a keyframe for the selection (K)" onClick={() => keyNodes(selection)}>Key</button>
      <button className="btn" title="Undo (Ctrl+Z)" disabled={!doc.canUndo} onClick={() => doc.undo()}>Undo</button>
      <button className="btn primary" title="Leave full screen (Shift+F, F11 or Esc)" onClick={() => toggleFullscreen(false)}>Exit full screen</button>
    </div>
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
  useEffect(() => {
    void loadNativeSecrets();
    // Once a day, quietly: mention a newer release without interrupting work.
    void dailyUpdateCheck().then((info) => info && ui().toast(`DreamForge ${info.latest} is available. Open File > Check for updates to download it.`, 'info'));
  }, []);
  return (
    <div className="app">
      {screen === 'editor' && doc.project ? <Editor /> : <StartMenu />}
      {dialog === 'characterCreator' && doc.project && <CharacterCreator />}
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'export' && doc.project && <ExportDialog />}
      {dialog === 'trace' && doc.project && <TraceDialog />}
      {dialog === 'update' && <UpdateDialog />}
      {dialog === 'memory' && <MemoryDialog />}
      {dialog === 'assetBuilder' && doc.project && <AssetBuilder />}
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
