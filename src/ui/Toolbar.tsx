import {
  Bone, Brush, Circle, Eraser, Hand, Hexagon, Minus, MousePointer2, PenTool, Spline, Square, Star, Target, Type, Video, ZoomIn,
} from 'lucide-react';
import { useUI, type ToolId } from '../state/ui';
import { ColorField, NumberField } from './widgets';

export const TOOL_DEFS: { id: ToolId; label: string; key: string; icon: React.ReactNode; sepBefore?: boolean }[] = [
  { id: 'select', label: 'Select / move / rotate / scale', key: 'V', icon: <MousePointer2 size={17} /> },
  { id: 'node', label: 'Edit path points', key: 'A', icon: <Spline size={17} /> },
  { id: 'hand', label: 'Pan view', key: 'H', icon: <Hand size={17} /> },
  { id: 'zoom', label: 'Zoom view (Alt to zoom out)', key: 'Z', icon: <ZoomIn size={17} /> },
  { id: 'bone', label: 'Bone: drag to add bones', key: 'B', icon: <Bone size={17} />, sepBefore: true },
  { id: 'ik', label: 'IK pose: drag a hand or foot', key: 'I', icon: <Target size={17} /> },
  { id: 'pen', label: 'Pen (bezier path)', key: 'P', icon: <PenTool size={17} />, sepBefore: true },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: <Square size={17} /> },
  { id: 'ellipse', label: 'Ellipse', key: 'E', icon: <Circle size={17} /> },
  { id: 'polygon', label: 'Polygon', key: 'G', icon: <Hexagon size={17} /> },
  { id: 'star', label: 'Star', key: 'S', icon: <Star size={17} /> },
  { id: 'line', label: 'Line', key: 'L', icon: <Minus size={17} /> },
  { id: 'brush', label: 'Brush (frame-by-frame drawing)', key: 'D', icon: <Brush size={17} />, sepBefore: true },
  { id: 'eraser', label: 'Eraser (removes strokes)', key: 'X', icon: <Eraser size={17} /> },
  { id: 'text', label: 'Text', key: 'T', icon: <Type size={17} /> },
  { id: 'camera', label: 'Move the scene camera', key: 'C', icon: <Video size={17} />, sepBefore: true },
];

export function Toolbar() {
  const tool = useUI((s) => s.tool);
  const set = useUI((s) => s.set);
  const fill = useUI((s) => s.fill);
  const stroke = useUI((s) => s.stroke);
  const brushColor = useUI((s) => s.brushColor);
  const drawing = tool === 'brush' || tool === 'eraser';
  return (
    <div className="toolbar">
      {TOOL_DEFS.map((t) => (
        <div key={t.id} style={{ display: 'contents' }}>
          {t.sepBefore && <div className="sep" />}
          <button className={`icon-btn${tool === t.id ? ' on' : ''}`} title={`${t.label} (${t.key})`} onClick={() => set({ tool: t.id })}>
            {t.icon}
          </button>
        </div>
      ))}
      <div className="sep" />
      {drawing ? (
        <ColorField value={brushColor} onChange={(v) => set({ brushColor: v ?? '#000000' })} title="Brush colour" />
      ) : (
        <>
          <ColorField value={fill} onChange={(v) => set({ fill: v })} title="Fill for new shapes" />
          <div style={{ height: 4 }} />
          <ColorField value={stroke} onChange={(v) => set({ stroke: v })} title="Stroke for new shapes" />
        </>
      )}
    </div>
  );
}

/** Options for the active tool, shown in the bar above the viewport. */
export function ToolOptions() {
  const tool = useUI((s) => s.tool);
  const set = useUI((s) => s.set);
  const u = useUI();
  if (tool === 'brush' || tool === 'eraser') {
    return (
      <>
        <div style={{ width: 92 }}>
          <NumberField label="Size" value={u.brushSize} min={1} max={300} precision={0} onChange={(v) => set({ brushSize: v })} />
        </div>
        {tool === 'brush' && (
          <div style={{ width: 120 }} title="How much pen pressure changes the line width">
            <NumberField label="Pressure" value={u.brushThinning} min={0} max={1} step={0.05} onChange={(v) => set({ brushThinning: v })} />
          </div>
        )}
      </>
    );
  }
  if (['rect', 'ellipse', 'polygon', 'star', 'line', 'pen'].includes(tool)) {
    return (
      <>
        <div style={{ width: 100 }}>
          <NumberField label="Stroke" value={u.strokeWidth} min={0} max={200} precision={1} onChange={(v) => set({ strokeWidth: v })} />
        </div>
        {tool === 'polygon' && (
          <div style={{ width: 90 }}>
            <NumberField label="Sides" value={u.polygonSides} min={3} max={24} precision={0} onChange={(v) => set({ polygonSides: Math.round(v) })} />
          </div>
        )}
      </>
    );
  }
  return null;
}
