import { Check, CircleAlert, ImagePlus, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ASSET_KINDS, ASSET_SIZES, ASSET_STYLES, generateAssets, type AssetQuality, type AssetShape } from '../ai/assetBuilder';
import { listOpenAIModels } from '../ai/providers';
import { patchNode, reorder } from '../state/commands';
import { addReliefModel, importImage, placeImage } from '../state/content';
import { useSettings } from '../state/settings';
import { doc } from '../state/store';
import { ui, useUI } from '../state/ui';
import { Dialog } from './widgets';

interface Made {
  id: number;
  url: string;
  kind: string;
  name: string;
  chosen: boolean;
  /** Made to be added as a 3D object. */
  solid: boolean;
}

let nextId = 1;

/** Generates scene art with the user's OpenAI key and adds the chosen pictures to the project. */
export function AssetBuilder() {
  const set = useUI((s) => s.set);
  const settings = useSettings();
  const hasKey = !!settings.openaiKey;
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState(ASSET_KINDS[0].id);
  const [style, setStyle] = useState(ASSET_STYLES[0].id);
  const [shape, setShape] = useState<AssetShape>(ASSET_KINDS[0].shape);
  const [quality, setQuality] = useState<AssetQuality>('high');
  const [transparent, setTransparent] = useState(ASSET_KINDS[0].transparent);
  const [count, setCount] = useState(2);
  const [output, setOutput] = useState<'2d' | '3d'>('2d');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<Made[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const info = ASSET_KINDS.find((k) => k.id === kind)!;
  // A full-frame picture has no shape to give volume to.
  const canBe3D = info.transparent;
  const solid = output === '3d' && canBe3D;

  useEffect(() => {
    if (!hasKey) return;
    let live = true;
    listOpenAIModels(settings.openaiKey).then((list) => live && setModels(list.filter((m) => m.includes('image'))), () => {});
    return () => {
      live = false;
    };
  }, [hasKey, settings.openaiKey]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const pickKind = (id: string) => {
    const k = ASSET_KINDS.find((x) => x.id === id)!;
    setKind(id);
    setShape(k.shape);
    setTransparent(k.transparent);
  };

  const run = async () => {
    setError('');
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    const name = description.trim().replace(/[^\w\s-]/g, '').split(/\s+/).slice(0, 4).join(' ') || info.label;
    try {
      const res = await generateAssets(
        { description, kind, style, shape, quality, transparent: transparent || solid, count, model: settings.imageModel },
        (url) => setMade((list) => [{ id: nextId++, url, kind, name, solid, chosen: list.every((m) => !m.chosen) }, ...list]),
        ac.signal,
      );
      if (res.failed.length) setError(`${res.failed.length} of ${count} could not be made: ${res.failed[0]}`);
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const chosen = made.filter((m) => m.chosen);
  const add = async () => {
    const p = doc.project;
    if (!p || !chosen.length) return;
    try {
      for (const m of chosen) {
        if (m.solid) {
          addReliefModel(m.name, m.url);
          continue;
        }
        const asset = await importImage(`${m.name}.png`, m.url, 'image/png');
        const id = placeImage(asset);
        if (m.kind === 'background' && asset.width && asset.height) {
          // A background fills the stage and goes behind everything else.
          const k = Math.max(p.width / asset.width, p.height / asset.height);
          patchNode(id, { width: asset.width * k, height: asset.height * k, x: p.width / 2, y: p.height / 2, depth: 600 }, 'Place background');
          reorder(id, 'bottom');
        }
      }
      ui().toast(`${chosen.length} asset${chosen.length === 1 ? '' : 's'} added to the scene and the Assets panel`, 'success');
      set({ dialog: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const close = () => {
    abortRef.current?.abort();
    set({ dialog: null });
  };
  const seg = <T extends string | number | boolean>(value: T, options: [T, string][], onPick: (v: T) => void) => (
    <div className="seg" style={{ width: 'fit-content' }}>
      {options.map(([v, label]) => <button key={String(v)} className={value === v ? 'on' : ''} disabled={busy} onClick={() => onPick(v)}>{label}</button>)}
    </div>
  );

  return (
    <Dialog
      wide
      title={<><Sparkles size={17} /> Asset Builder</>}
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>
            Every picture is drawn by OpenAI with your API key: {count} image{count === 1 ? '' : 's'} per run, billed to your OpenAI account.
          </span>
          <button className="btn" onClick={close}>Close</button>
          {busy
            ? <button className="btn" onClick={() => abortRef.current?.abort()}><Loader2 size={14} className="spin" /> Stop</button>
            : <button className={`btn${made.length ? '' : ' primary'}`} disabled={!hasKey || !description.trim()} onClick={() => void run()}><Sparkles size={14} /> {made.length ? 'Generate more' : 'Generate'}</button>}
          <button className="btn primary" disabled={!chosen.length || busy} onClick={() => void add()}><Check size={14} /> Add {chosen.length || ''} to scene</button>
        </>
      }
    >
      <div className="cc-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!hasKey && (
            <div className="note warn">
              Asset Builder needs your OpenAI API key.{' '}
              <button className="btn" style={{ marginTop: 6 }} onClick={() => set({ dialog: 'settings' })}>Open Settings</button>
            </div>
          )}
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Asset type</label>
            <select value={kind} disabled={busy} onChange={(e) => pickKind(e.target.value)}>
              {ASSET_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </div>
          <textarea
            rows={4} value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
            placeholder={`Describe it. For example: ${info.example}`}
          />
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }} title="A 3D object is the generated picture puffed up into a rounded solid that you can turn, tilt and animate in depth. Backgrounds and textures are always flat.">
            <label>Make it</label>
            <div className="seg" style={{ width: 'fit-content' }}>
              <button className={!solid ? 'on' : ''} disabled={busy} onClick={() => setOutput('2d')}>2D picture</button>
              <button className={solid ? 'on' : ''} disabled={busy || !canBe3D} onClick={() => setOutput('3d')}>3D object</button>
            </div>
          </div>
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Art style</label>
            <select value={style} disabled={busy} onChange={(e) => setStyle(e.target.value)}>
              {ASSET_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Shape</label>
            {seg(shape, (Object.keys(ASSET_SIZES) as AssetShape[]).map((s) => [s, ASSET_SIZES[s].label]), setShape)}
          </div>
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Background</label>
            {solid ? <span className="hint">Transparent (needed for a 3D object)</span> : seg(transparent, [[true, 'Transparent'], [false, 'Solid']], setTransparent)}
          </div>
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Quality</label>
            {seg(quality, [['low', 'Draft'], ['medium', 'Standard'], ['high', 'High']], setQuality)}
          </div>
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Variations</label>
            {seg(count, [[1, '1'], [2, '2'], [3, '3'], [4, '4']], setCount)}
          </div>
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Image model</label>
            <div>
              <input type="text" list="asset-models" value={settings.imageModel} disabled={busy} onChange={(e) => settings.update({ imageModel: e.target.value.trim() })} onKeyDown={(e) => e.stopPropagation()} />
              <datalist id="asset-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            </div>
          </div>
          {error && <div className="note err"><CircleAlert size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
        </div>

        <div className="asset-results">
          {made.length === 0 && (
            <div className="empty">{busy ? 'Drawing… each picture takes up to a minute.' : <><ImagePlus size={22} /><br />Your generated assets appear here. Click the ones you want to keep.</>}</div>
          )}
          {busy && made.length > 0 && <div className="hint"><Loader2 size={13} className="spin" style={{ verticalAlign: -2 }} /> Drawing more…</div>}
          <div className="asset-made">
            {made.map((m) => (
              <button key={m.id} className={`asset-pick${m.chosen ? ' on' : ''}`} title={m.chosen ? 'Selected: click to leave it out' : 'Click to select'} onClick={() => setMade((list) => list.map((x) => (x.id === m.id ? { ...x, chosen: !x.chosen } : x)))}>
                <img src={m.url} alt={m.name} draggable={false} />
                {m.chosen && <span className="asset-tick"><Check size={13} /></span>}
                {m.solid && <span className="chip" style={{ position: 'absolute', left: 6, top: 6 }}>3D</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
