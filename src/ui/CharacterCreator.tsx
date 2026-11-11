import { Check, CircleAlert, ImageUp, Loader2, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createCharacter, type CreatorProgress, type CreatorResult, type CreatorSource } from '../ai/characterCreator';
import { DEFAULT_HUMANOID, humanoidSpec, type HumanoidParams } from '../core/character/humanoid';
import type { CharacterSpec } from '../core/character/spec';
import { VIEW_NAMES, type ViewName } from '../core/types';
import { renderSpecPreview } from '../render/preview';
import { addCharacterFromSpec, readAsDataUrl } from '../state/content';
import { pickFile } from '../state/persistence';
import { useSettings } from '../state/settings';
import { doc } from '../state/store';
import { ui, useUI } from '../state/ui';
import { VIEW_LABEL } from './Properties';
import { ColorField, Dialog } from './widgets';

type Tab = 'text' | 'reference' | 'convert' | 'parametric';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'text', label: 'Describe', hint: 'Type what the character looks like. ChatGPT draws it, then it is rebuilt as vector parts and rigged.' },
  { id: 'reference', label: 'Reference image', hint: 'Upload a sketch or picture to guide the design. ChatGPT redraws it as a clean turnaround.' },
  { id: 'convert', label: 'Convert my image', hint: 'Upload finished artwork. It is converted straight into vector parts and rigged, without redrawing.' },
  { id: 'parametric', label: 'Quick builder', hint: 'Build a rigged character from sliders and colours. Works offline, no API key needed.' },
];

export function CharacterCreator() {
  const set = useUI((s) => s.set);
  const hasKey = useSettings((s) => !!s.openaiKey);
  const [tab, setTab] = useState<Tab>(hasKey ? 'text' : 'parametric');
  const [name, setName] = useState('Hero');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [convertView, setConvertView] = useState<ViewName>('front');
  const [otherViews, setOtherViews] = useState(false);
  const [views, setViews] = useState<ViewName[]>([...VIEW_NAMES]);
  const [params, setParams] = useState<HumanoidParams>({ ...DEFAULT_HUMANOID });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CreatorProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatorResult | null>(null);
  const [previewView, setPreviewView] = useState<ViewName>('front');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const spec: CharacterSpec | null = tab === 'parametric' ? humanoidSpec({ ...params, name, views }) : result?.spec ?? null;
  const available = spec ? VIEW_NAMES.filter((v) => spec.views[v]) : [];
  const shown = available.includes(previewView) ? previewView : available[0];

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !spec || !shown) return;
    try {
      renderSpecPreview(c, spec, shown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, result, shown, JSON.stringify(tab === 'parametric' ? { params, views } : null)]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const close = () => {
    abortRef.current?.abort();
    set({ dialog: null });
  };

  const upload = async () => {
    const [f] = await pickFile('image/png,image/jpeg,image/webp');
    if (f) setImage(await readAsDataUrl(f));
  };

  const run = async () => {
    setError(null);
    setResult(null);
    setProgress([]);
    let source: CreatorSource;
    if (tab === 'text') {
      if (!description.trim()) return setError('Describe the character first.');
      source = { kind: 'text', description };
    } else if (tab === 'reference') {
      if (!image) return setError('Choose a reference image first.');
      source = { kind: 'reference', description, image };
    } else {
      if (!image) return setError('Choose the artwork to convert first.');
      source = { kind: 'convert', image, view: convertView, generateOtherViews: otherViews, description };
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    try {
      const res = await createCharacter(source, name, views, (p) => setProgress((prev) => [...prev.filter((x) => x.step !== p.step), p]), ac.signal);
      setResult(res);
      setPreviewView(VIEW_NAMES.find((v) => res.spec.views[v]) ?? 'front');
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    if (!spec || !doc.project) return;
    const p = doc.project;
    addCharacterFromSpec({ ...spec, name: name.trim() || 'Character', height: Math.round(p.height * 0.55) });
    ui().toast(`${name || 'Character'} added to the scene, rigged and ready to animate`, 'success');
    set({ dialog: null, rightTab: 'actions' });
  };

  const P = (patch: Partial<HumanoidParams>) => setParams({ ...params, ...patch });
  const info = TABS.find((t) => t.id === tab)!;
  const needsKey = tab !== 'parametric' && !hasKey;
  const imageCount = tab === 'convert' ? (otherViews ? views.filter((v) => v !== convertView).length : 0) : views.length;

  return (
    <Dialog
      wide
      title={<><Wand2 size={17} /> Character Creator</>}
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>
            {tab === 'parametric' ? 'Built on your computer. Nothing is sent anywhere.' : `Uses your OpenAI key: ${imageCount} image generation${imageCount === 1 ? '' : 's'} and ${tab === 'convert' && !otherViews ? 1 : views.length} conversion${views.length === 1 ? '' : 's'}.`}
          </span>
          <button className="btn" onClick={close}>Cancel</button>
          {tab !== 'parametric' && (
            busy
              ? <button className="btn" onClick={() => abortRef.current?.abort()}><Loader2 size={14} className="spin" /> Stop</button>
              : <button className="btn" disabled={needsKey} onClick={() => void run()}><Wand2 size={14} /> {result ? 'Generate again' : 'Generate'}</button>
          )}
          <button className="btn primary" disabled={!spec || busy} onClick={add}><Check size={14} /> Add to scene</button>
        </>
      }
    >
      <div className="tabs" style={{ borderBottom: '1px solid var(--line)', margin: '-6px 0 0' }}>
        {TABS.map((t) => <button key={t.id} className={`tab${tab === t.id ? ' on' : ''}`} disabled={busy} onClick={() => { setTab(t.id); setError(null); }}>{t.label}</button>)}
      </div>
      <div className="cc-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="hint">{info.hint}</div>
          {needsKey && (
            <div className="note warn">
              Character Creator needs your OpenAI API key.{' '}
              <button className="btn" style={{ marginTop: 6 }} onClick={() => set({ dialog: 'settings' })}>Open Settings</button>
            </div>
          )}
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>

          {(tab === 'reference' || tab === 'convert') && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn" onClick={() => void upload()}><ImageUp size={14} /> {image ? 'Change image' : 'Choose image'}</button>
              {image && <img src={image} alt="" style={{ height: 64, borderRadius: 6, background: '#fff' }} />}
            </div>
          )}
          {tab === 'convert' && (
            <>
              <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
                <label>It shows the</label>
                <select value={convertView} onChange={(e) => setConvertView(e.target.value as ViewName)}>
                  {VIEW_NAMES.map((v) => <option key={v} value={v}>{VIEW_LABEL[v]} view</option>)}
                </select>
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={otherViews} onChange={(e) => setOtherViews(e.target.checked)} />
                Also draw the other turnaround views with ChatGPT
              </label>
            </>
          )}
          {tab !== 'parametric' && (
            <textarea
              rows={tab === 'text' ? 6 : 3}
              placeholder={tab === 'text' ? 'For example: a cheerful teenage inventor with messy orange hair, round glasses, a green hoodie, grey cargo trousers and red sneakers' : 'Optional notes: what to keep, change or emphasise'}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          )}

          {tab === 'parametric' && (
            <>
              <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
                <label>Colours</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['skin', 'hair', 'shirt', 'pants', 'shoes', 'eyes'] as const).map((k) => <ColorField key={k} value={params[k]} title={k} onChange={(c) => P({ [k]: c ?? '#000000' })} />)}
                </div>
              </div>
              <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
                <label>Hair</label>
                <div className="seg">{(['short', 'long', 'spiky', 'bald'] as const).map((h) => <button key={h} className={params.hairStyle === h ? 'on' : ''} onClick={() => P({ hairStyle: h })}>{h}</button>)}</div>
              </div>
              <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
                <label>Sleeves</label>
                <div className="seg">{(['short', 'long'] as const).map((h) => <button key={h} className={params.sleeves === h ? 'on' : ''} onClick={() => P({ sleeves: h })}>{h}</button>)}</div>
              </div>
              <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
                <label>Build</label>
                <input type="range" min={0.75} max={1.4} step={0.01} value={params.build} onChange={(e) => P({ build: Number(e.target.value) })} />
              </div>
              <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
                <label>Head size</label>
                <input type="range" min={0.9} max={1.7} step={0.01} value={params.headScale} onChange={(e) => P({ headScale: Number(e.target.value) })} />
              </div>
              <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
                <label>Outline</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={params.outline !== null} onChange={(e) => P({ outline: e.target.checked ? '#2a1f1f' : null })} />
                  {params.outline && <ColorField value={params.outline} onChange={(c) => P({ outline: c })} />}
                </div>
              </div>
            </>
          )}

          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Views</label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {VIEW_NAMES.map((v) => (
                <label key={v} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="checkbox" disabled={busy || (tab === 'convert' && !otherViews)} checked={tab === 'convert' && !otherViews ? v === convertView : views.includes(v)}
                    onChange={(e) => setViews(e.target.checked ? VIEW_NAMES.filter((x) => x === v || views.includes(x)) : views.length > 1 ? views.filter((x) => x !== v) : views)}
                  />
                  {VIEW_LABEL[v]}
                </label>
              ))}
            </div>
          </div>

          {progress.length > 0 && (
            <div className="cc-steps">
              {progress.map((p) => (
                <div key={p.step} className={`cc-step ${p.state}`}>
                  {p.state === 'run' ? <Loader2 size={13} className="spin" /> : p.state === 'done' ? <Check size={13} /> : <CircleAlert size={13} />}
                  <span>{p.step}{p.detail ? ` (${p.detail})` : ''}</span>
                </div>
              ))}
            </div>
          )}
          {result && Object.keys(result.failed).length > 0 && (
            <div className="note warn">
              Some views could not be built: {Object.entries(result.failed).map(([v, why]) => `${VIEW_LABEL[v]}: ${why}`).join(' ')}
            </div>
          )}
          {error && <div className="note err"><CircleAlert size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
          {result && (
            <div className="cc-thumbs" title="The drawings the vector parts were built from">
              {VIEW_NAMES.filter((v) => result.images[v]).map((v) => <img key={v} src={result.images[v]} alt={VIEW_LABEL[v]} />)}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="cc-preview">
            {spec ? <canvas ref={canvasRef} /> : <div className="empty">{busy ? 'Working… this usually takes a minute or two.' : 'The rigged vector character appears here.'}</div>}
          </div>
          {available.length > 1 && (
            <div className="seg" style={{ alignSelf: 'center' }}>
              {available.map((v) => <button key={v} className={shown === v ? 'on' : ''} onClick={() => setPreviewView(v)}>{VIEW_LABEL[v]}</button>)}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

