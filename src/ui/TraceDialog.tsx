import { Loader2, Spline } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { pathToSvg } from '../core/path';
import { traceImage, type TracedShape } from '../core/trace';
import type { ImageNode } from '../core/types';
import { scene } from '../state/commands';
import { addTracedShapes, imagePixels } from '../state/content';
import { doc } from '../state/store';
import { useUI } from '../state/ui';
import { Dialog, NumberField } from './widgets';

const DETAIL = [
  { label: 'Simple', tolerance: 2.2 },
  { label: 'Balanced', tolerance: 1 },
  { label: 'Detailed', tolerance: 0.5 },
];

/** Turns the selected image layer into editable vector shapes, with a live preview of the result. */
export function TraceDialog() {
  const set = useUI((s) => s.set);
  const selection = useUI((s) => s.selection);
  const toast = useUI((s) => s.toast);
  const node = scene().nodes[selection[0]] as ImageNode | undefined;
  const asset = node?.type === 'image' ? doc.project!.assets[node.assetId] : undefined;

  const [colors, setColors] = useState(8);
  const [detail, setDetail] = useState(1);
  const [minArea, setMinArea] = useState(12);
  const [smooth, setSmooth] = useState(true);
  const [pixels, setPixels] = useState<ImageData | null>(null);
  const [result, setResult] = useState<TracedShape[] | null>(null);
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!asset) return;
    let live = true;
    imagePixels(asset).then((px) => live && setPixels(px), () => live && setError('This image could not be read.'));
    return () => {
      live = false;
    };
  }, [asset]);

  // Re-trace shortly after the last change so dragging a number does not queue up work.
  useEffect(() => {
    if (!pixels) return;
    setResult(null);
    const timer = setTimeout(() => {
      try {
        setResult(traceImage(pixels, { colors, minArea, tolerance: DETAIL[detail].tolerance, smooth }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [pixels, colors, detail, minArea, smooth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pixels || !result) return;
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const shape of result) {
      ctx.fillStyle = shape.color;
      ctx.fill(new Path2D(pathToSvg(shape.path)), 'evenodd');
    }
  }, [pixels, result]);

  const close = () => set({ dialog: null });
  const points = result?.reduce((n, s) => n + s.path.contours.reduce((m, c) => m + c.pts.length, 0), 0) ?? 0;

  if (!node || node.type !== 'image' || !asset) {
    return (
      <Dialog title={<><Spline size={17} /> Trace image to vector shapes</>} onClose={close} footer={<button className="btn" onClick={close}>Close</button>}>
        <div className="hint">Select one image layer first, then open this again.</div>
      </Dialog>
    );
  }

  return (
    <Dialog
      wide
      title={<><Spline size={17} /> Trace image to vector shapes</>}
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>
            {error || (result ? `${result.length} shape${result.length === 1 ? '' : 's'}, ${points} points. The original image is kept, hidden.` : 'Tracing…')}
          </span>
          <button className="btn" onClick={close}>Cancel</button>
          <button
            className="btn primary"
            disabled={!result?.length || !pixels}
            onClick={() => {
              const id = addTracedShapes(node.id, result!, pixels!);
              if (id) toast(`Traced "${node.name}" into ${result!.length} vector shapes.`, 'success');
              close();
            }}
          >
            Trace
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <figure className="trace-pane">
          <figcaption>Image</figcaption>
          <img src={asset.dataUrl} alt="" />
        </figure>
        <figure className="trace-pane">
          <figcaption>Vector result</figcaption>
          {result ? <canvas ref={canvasRef} /> : <div className="trace-wait"><Loader2 size={18} className="spin" /></div>}
        </figure>
      </div>
      <div className="form-row">
        <label>Colours</label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="range" min={2} max={32} value={colors} onChange={(e) => setColors(Number(e.target.value))} style={{ flex: 1 }} />
          <span className="chip" style={{ minWidth: 34, textAlign: 'center' }}>{colors}</span>
        </div>
      </div>
      <div className="form-row">
        <label>Outline detail</label>
        <div className="seg" style={{ width: 'fit-content' }}>
          {DETAIL.map((d, i) => <button key={d.label} className={detail === i ? 'on' : ''} onClick={() => setDetail(i)}>{d.label}</button>)}
        </div>
      </div>
      <div className="form-row">
        <label>Ignore specks under</label>
        <div style={{ width: 130 }}><NumberField label="px" value={minArea} min={0} max={2000} precision={0} onChange={(v) => setMinArea(Math.round(v))} /></div>
      </div>
      <div className="form-row">
        <label>Curves</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text)' }}>
          <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} /> Smooth rounded outlines
        </label>
      </div>
      <div className="hint">Works best on flat-coloured art such as cartoons, logos and cut-out characters. Photos need many colours and produce a lot of shapes.</div>
    </Dialog>
  );
}
