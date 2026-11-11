import { CircleAlert, Download, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { mixdown } from '../audio/engine';
import { createFrameSource } from '../export/frames';
import type { ExportOptions, FrameSource } from '../export/types';
import { exportVideo, videoExportSupported } from '../export/video';
import { scene as currentScene } from '../state/commands';
import { downloadBlob } from '../state/persistence';
import { doc } from '../state/store';
import { useUI } from '../state/ui';
import { Dialog, NumberField } from './widgets';

type Format = 'mp4' | 'webm' | 'gif' | 'png' | 'sprite';

// Image-sequence exporters are separate modules; a format is offered once its module exists.
const optional = import.meta.glob(['../export/gif.ts', '../export/pngSequence.ts', '../export/spriteSheet.ts']) as Record<string, () => Promise<any>>;
const has = (file: string) => `../export/${file}.ts` in optional;
const load = (file: string) => optional[`../export/${file}.ts`]();

const FORMATS: { id: Format; label: string; note: string; available: boolean }[] = [
  { id: 'mp4', label: 'MP4 video', note: 'Plays everywhere. Best for sharing and uploading.', available: true },
  { id: 'webm', label: 'WebM video', note: 'Open format, small files.', available: true },
  { id: 'gif', label: 'Animated GIF', note: 'Loops, no sound, limited colours.', available: has('gif') },
  { id: 'png', label: 'PNG sequence (zip)', note: 'One image per frame, with transparency.', available: has('pngSequence') },
  { id: 'sprite', label: 'Sprite sheet', note: 'All frames in one image plus JSON, for game engines.', available: has('spriteSheet') },
];

export function ExportDialog() {
  const set = useUI((s) => s.set);
  const p = doc.project!;
  const scene = currentScene(p);
  const [format, setFormat] = useState<Format>('mp4');
  const [scope, setScope] = useState<'scene' | 'all'>(p.scenes.length > 1 ? 'all' : 'scene');
  const [scale, setScale] = useState(1);
  const [quality, setQuality] = useState<'medium' | 'high' | 'best'>('high');
  const [sound, setSound] = useState(true);
  const [transparent, setTransparent] = useState(false);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(scene.duration);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ progress: 0, stage: '' });
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const isVideo = format === 'mp4' || format === 'webm';
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const width = even(p.width * scale);
  const height = even(p.height * scale);
  const scenes = scope === 'all' ? p.scenes : [scene];
  const frames = scope === 'all' ? null : Math.max(1, Math.min(scene.duration, to) - Math.max(0, from));
  const hasAudio = scenes.some((s) => s.audio.some((a) => !a.muted));
  const base = p.name.replace(/[^\w\- ]+/g, '').trim() || 'animation';

  const run = async () => {
    setError(null);
    setNotes([]);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    const opts: ExportOptions = { signal: ac.signal, onProgress: setProgress };
    try {
      setProgress({ progress: 0, stage: 'Preparing' });
      const source = await createFrameSource(p, {
        scenes, width, height, transparent: !isVideo && transparent,
        range: scope === 'scene' ? { from: Math.max(0, from), to: Math.min(scene.duration, to) } : undefined,
      });
      if (isVideo) {
        const audio = sound && hasAudio ? await mixdown(p, source.audioRanges) : null;
        const res = await exportVideo(source, { ...opts, format, quality, audio });
        setNotes(res.warnings);
        downloadBlob(res.blob, `${base}.${format}`);
      } else if (format === 'gif') {
        const { exportGif } = await load('gif');
        downloadBlob(await exportGif(source as FrameSource, { ...opts, loop: true }), `${base}.gif`);
      } else if (format === 'png') {
        const { exportPngSequence } = await load('pngSequence');
        downloadBlob(await exportPngSequence(source as FrameSource, { ...opts, baseName: base }), `${base}_frames.zip`);
      } else {
        const { exportSpriteSheet } = await load('spriteSheet');
        const out = await exportSpriteSheet(source as FrameSource, opts);
        downloadBlob(out.png, `${base}_sheet.png`);
        downloadBlob(new Blob([out.json], { type: 'application/json' }), `${base}_sheet.json`);
      }
      setProgress({ progress: 1, stage: 'Done. The file is in your downloads.' });
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      else setProgress({ progress: 0, stage: 'Cancelled' });
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    abortRef.current?.abort();
    set({ dialog: null });
  };
  const fmt = FORMATS.find((f) => f.id === format)!;

  return (
    <Dialog
      title={<><Download size={17} /> Export</>}
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>{width} x {height} · {p.fps} fps{frames ? ` · ${frames} frames (${(frames / p.fps).toFixed(1)}s)` : ` · ${p.scenes.length} scenes`}</span>
          <button className="btn" onClick={close}>{busy ? 'Cancel' : 'Close'}</button>
          <button className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Export</button>
        </>
      }
    >
      <div className="form-row">
        <label>Format</label>
        <div>
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)} disabled={busy}>
            {FORMATS.filter((f) => f.available).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <div className="hint" style={{ marginTop: 4 }}>{fmt.note}</div>
        </div>
      </div>
      <div className="form-row">
        <label>What to export</label>
        <div className="seg" style={{ width: 'fit-content' }}>
          <button className={scope === 'scene' ? 'on' : ''} onClick={() => setScope('scene')}>This scene</button>
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')} disabled={p.scenes.length < 2}>All scenes, with transitions</button>
        </div>
      </div>
      {scope === 'scene' && (
        <div className="form-row">
          <label>Frame range</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <NumberField label="From" value={from} min={0} max={scene.duration - 1} precision={0} onChange={(v) => setFrom(Math.round(v))} />
            <NumberField label="To" value={to} min={1} max={scene.duration} precision={0} onChange={(v) => setTo(Math.round(v))} />
          </div>
        </div>
      )}
      <div className="form-row">
        <label>Size</label>
        <div className="seg" style={{ width: 'fit-content' }}>
          {[0.25, 0.5, 1, 2].map((s) => <button key={s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)}>{s * 100}%</button>)}
        </div>
      </div>
      {isVideo ? (
        <>
          <div className="form-row">
            <label>Quality</label>
            <div className="seg" style={{ width: 'fit-content' }}>
              {(['medium', 'high', 'best'] as const).map((q) => <button key={q} className={quality === q ? 'on' : ''} onClick={() => setQuality(q)}>{q}</button>)}
            </div>
          </div>
          <div className="form-row">
            <label>Sound</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={sound && hasAudio} disabled={!hasAudio} onChange={(e) => setSound(e.target.checked)} />
              {hasAudio ? 'Include the audio tracks' : 'No audio on the timeline'}
            </label>
          </div>
          {!videoExportSupported() && <div className="note warn">This browser cannot encode video. Use the DreamForge desktop app or a Chromium-based browser.</div>}
        </>
      ) : (
        <div className="form-row">
          <label>Background</label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent
          </label>
        </div>
      )}
      {(busy || progress.stage) && (
        <div>
          <div className="progress"><i style={{ width: `${Math.round(progress.progress * 100)}%` }} /></div>
          <div className="hint" style={{ marginTop: 6 }}>{progress.stage}</div>
        </div>
      )}
      {notes.map((n) => <div key={n} className="note warn">{n}</div>)}
      {error && <div className="note err"><CircleAlert size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
    </Dialog>
  );
}
