import { useEffect } from 'react';
import { buildCharacter } from './core/character/build';
import { humanoidSpec } from './core/character/humanoid';
import { VIEW_NAMES } from './core/types';
import { addNodes } from './state/commands';
import { newProject } from './state/session';
import { doc } from './state/store';
import { useUI } from './state/ui';
import { Viewport } from './ui/Viewport';

export function App() {
  const screen = useUI((s) => s.screen);
  useEffect(() => {
    if (doc.project) return;
    newProject({ name: 'Test', width: 1920, height: 1080, fps: 24, mode: 'rig' });
    VIEW_NAMES.forEach((v, i) => {
      const built = buildCharacter(humanoidSpec({ name: v, hairStyle: i % 2 ? 'long' : 'short' }));
      const root = built.nodes.find((n) => n.id === built.rootId)!;
      Object.assign(root, { x: 240 + i * 360, y: 900, currentView: v });
      addNodes(built.nodes, [built.rootId]);
    });
  }, []);
  return <div className="app">{screen === 'editor' && <Viewport />}</div>;
}
