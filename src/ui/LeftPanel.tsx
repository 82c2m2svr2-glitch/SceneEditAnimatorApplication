import {
  Bone, Box, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Film, Folder, Image, Lock, PenLine, Plus, Shapes, Sparkles,
  ToggleLeft, Trash2, Type, Unlock, User,
} from 'lucide-react';
import { useState } from 'react';
import type { ID, NodeType, Scene } from '../core/types';
import { addScene, deleteScene, duplicateScene, moveNodes, patchNode, patchSceneById } from '../state/commands';
import { useDoc, useDocRevision } from '../state/store';
import { useUI } from '../state/ui';
import { TextField } from './widgets';

const ICONS: Record<NodeType, React.ReactNode> = {
  model3d: <Box size={13} />,
  group: <Folder size={13} />, shape: <Shapes size={13} />, image: <Image size={13} />, text: <Type size={13} />,
  bone: <Bone size={13} />, character: <User size={13} />, switch: <ToggleLeft size={13} />, drawing: <PenLine size={13} />,
  particles: <Sparkles size={13} />,
};

type DropPos = 'before' | 'in' | 'after';
const CONTAINERS: NodeType[] = ['group', 'bone', 'character', 'switch'];

function TreeRow(props: {
  scene: Scene; id: ID; depth: number; open: Set<ID>; toggle: (id: ID) => void;
  drop: { id: ID; pos: DropPos } | null; setDrop: (d: { id: ID; pos: DropPos } | null) => void;
}) {
  const { scene, id, depth, open } = props;
  const n = scene.nodes[id];
  const selection = useUI((s) => s.selection);
  const select = useUI((s) => s.select);
  const [renaming, setRenaming] = useState(false);
  if (!n) return null;
  const selected = selection.includes(id);
  const isOpen = open.has(id);
  const drop = props.drop?.id === id ? props.drop.pos : null;
  // Front-most first, like a layers panel.
  const kids = [...n.children].reverse();
  return (
    <>
      <div
        className={`tree-row${selected ? ' sel' : ''}${drop ? ` drop-${drop}` : ''}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        draggable={!renaming}
        onDragStart={(e) => {
          if (!selected) select([id]);
          e.dataTransfer.setData('text/plain', id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const t = (e.clientY - r.top) / r.height;
          const canIn = CONTAINERS.includes(n.type);
          props.setDrop({ id, pos: t < 0.28 ? 'before' : t > 0.72 ? 'after' : canIn ? 'in' : t < 0.5 ? 'before' : 'after' });
        }}
        onDragLeave={() => props.setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          const d = props.drop;
          props.setDrop(null);
          if (!d) return;
          const ids = useUI.getState().selection;
          if (ids.includes(id)) return;
          if (d.pos === 'in') return moveNodes(ids, id);
          const list = n.parent ? scene.nodes[n.parent].children : scene.roots;
          const i = list.indexOf(id);
          // The list is displayed reversed: "before" on screen means later in paint order.
          moveNodes(ids, n.parent, d.pos === 'before' ? i + 1 : i);
        }}
        onClick={(e) => select([id], e.shiftKey || e.ctrlKey || e.metaKey)}
        onDoubleClick={() => setRenaming(true)}
      >
        <span className="twist" onClick={(e) => { e.stopPropagation(); props.toggle(id); }}>
          {kids.length > 0 ? isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
        </span>
        <span className="ico" style={n.type === 'bone' && n.color ? { color: n.color } : undefined}>{ICONS[n.type] ?? <Box size={13} />}</span>
        {renaming ? (
          <RenameInput value={n.name} onDone={(v) => { setRenaming(false); if (v && v !== n.name) patchNode(id, { name: v }, 'Rename'); }} />
        ) : (
          <span className={`label${n.visible ? '' : ' off'}`}>
            {n.name}
            {n.view && <span className="chip" style={{ marginLeft: 6 }}>{n.view}</span>}
          </span>
        )}
        <span className={`acts${!n.visible || n.locked ? ' show' : ''}`}>
          <button className="icon-btn sm" title={n.locked ? 'Unlock' : 'Lock'} onClick={(e) => { e.stopPropagation(); patchNode(id, { locked: !n.locked }, n.locked ? 'Unlock' : 'Lock'); }}>
            {n.locked ? <Lock size={11} /> : <Unlock size={11} />}
          </button>
          <button className="icon-btn sm" title={n.visible ? 'Hide' : 'Show'} onClick={(e) => { e.stopPropagation(); patchNode(id, { visible: !n.visible }, n.visible ? 'Hide' : 'Show'); }}>
            {n.visible ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
        </span>
      </div>
      {isOpen && kids.map((c) => <TreeRow key={c} {...props} id={c} depth={depth + 1} />)}
    </>
  );
}

function RenameInput(props: { value: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(props.value);
  return (
    <input
      type="text"
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => props.onDone(v.trim())}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') props.onDone(v.trim());
        if (e.key === 'Escape') props.onDone(props.value);
      }}
    />
  );
}

export function LeftPanel() {
  useDocRevision();
  const project = useDoc((p) => p);
  const sceneId = useUI((s) => s.sceneId);
  const set = useUI((s) => s.set);
  const [open, setOpen] = useState<Set<ID>>(new Set());
  const [drop, setDrop] = useState<{ id: ID; pos: DropPos } | null>(null);
  if (!project) return null;
  const scene = project.scenes.find((s) => s.id === sceneId) ?? project.scenes[0];
  const toggle = (id: ID) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  return (
    <div className="panel left">
      <div className="panel-head">
        <Film size={12} /> <span style={{ flex: 1 }}>Scenes</span>
        <button className="icon-btn sm" title="Add scene" onClick={() => addScene()}><Plus size={13} /></button>
        <button className="icon-btn sm" title="Duplicate scene" onClick={() => duplicateScene(scene.id)}><Copy size={12} /></button>
        <button className="icon-btn sm" title="Delete scene" disabled={project.scenes.length <= 1} onClick={() => deleteScene(scene.id)}><Trash2 size={12} /></button>
      </div>
      <div style={{ maxHeight: 132, overflow: 'auto', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        {project.scenes.map((s, i) => (
          <div key={s.id} className={`scene-item${s.id === scene.id ? ' on' : ''}`} onClick={() => set({ sceneId: s.id, selection: [], selectedKeys: [], frame: 0 })}>
            <span className="idx">{i + 1}</span>
            {s.id === scene.id ? (
              <TextField value={s.name} onChange={(v) => patchSceneById(s.id, { name: v || s.name }, 'Rename scene')} />
            ) : (
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            )}
            <span className="chip">{(s.duration / project.fps).toFixed(1)}s</span>
          </div>
        ))}
      </div>
      <div className="panel-head">Layers</div>
      <div
        className="panel-body"
        onClick={(e) => e.target === e.currentTarget && useUI.getState().select([])}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if (e.target !== e.currentTarget) return;
          moveNodes(useUI.getState().selection, null, 0);
        }}
      >
        {scene.roots.length === 0 && (
          <div className="empty">
            Nothing in this scene yet. Draw with the tools on the left, use the Insert menu, or ask the assistant.
          </div>
        )}
        {[...scene.roots].reverse().map((id) => (
          <TreeRow key={id} scene={scene} id={id} depth={0} open={open} toggle={toggle} drop={drop} setDrop={setDrop} />
        ))}
      </div>
    </div>
  );
}
