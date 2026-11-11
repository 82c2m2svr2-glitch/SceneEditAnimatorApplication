import { createProject } from '../core/factory';
import type { AnimMode, Project } from '../core/types';
import { pause } from './playback';
import { doc } from './store';
import { useUI, type ToolId } from './ui';

/** Workspace defaults for each start-menu animation mode. */
const MODE_DEFAULTS: Record<AnimMode, { tool: ToolId; showBones: boolean; onion: boolean }> = {
  rig: { tool: 'select', showBones: true, onion: false },
  tween: { tool: 'select', showBones: false, onion: false },
  frame: { tool: 'brush', showBones: false, onion: true },
  mesh: { tool: 'select', showBones: true, onion: false },
};

/** Opens a project in the editor and resets per-project UI state. */
export function openProject(p: Project): void {
  pause();
  doc.load(p);
  const m = MODE_DEFAULTS[p.mode] ?? MODE_DEFAULTS.rig;
  const u = useUI.getState();
  useUI.setState({
    screen: 'editor', sceneId: p.scenes[0].id, frame: 0, playing: false, selection: [], selectedKeys: [],
    selectedStrip: null, selectedAudio: null, zoom: 0, tool: m.tool, showBones: m.showBones,
    onion: { ...u.onion, enabled: m.onion }, setupMode: false, viewMode: 'stage', dialog: null,
  });
}

export function newProject(opts: { name: string; width: number; height: number; fps: number; mode: AnimMode }): Project {
  const p = createProject(opts);
  openProject(p);
  return p;
}

export function closeProject(): void {
  pause();
  doc.load(null);
  useUI.setState({ screen: 'start', selection: [], selectedKeys: [], dialog: null });
}
