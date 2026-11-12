import { Check, CircleAlert, ImageUp, Loader2, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createCharacter, type CreatorProgress, type CreatorResult, type CreatorSource } from '../ai/characterCreator';
import { DEFAULT_HUMANOID, humanoidSpec, type HumanoidParams } from '../core/character/humanoid';
import type { CharacterSpec } from '../core/character/spec';
import { VIEW_NAMES, type ViewName } from '../core/types';
import { renderSpecPreview } from '../render/preview';
import type { LoadedModel } from '../render/three/engine';
import { deleteCharacter, listCharacters, saveCharacter, type SavedCharacter } from '../state/characterLibrary';
import { addCharacter3DFromSpec, addCharacterFromSpec, readAsDataUrl } from '../state/content';
import { pickFile } from '../state/persistence';
import { useSettings } from '../state/settings';
import { doc } from '../state/store';
import { ui, useUI } from '../state/ui';
import { VIEW_LABEL } from './Properties';
import { ColorField, Dialog } from './widgets';

type Tab = 'text' | 'reference' | 'convert' | 'parametric' | 'library';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'text', label: 'Describe', hint: 'Type what the character looks like. ChatGPT draws it, then it is rebuilt as vector parts and rigged.' },
  { id: 'reference', label: 'Reference image', hint: 'Upload a sketch or picture to guide the design. ChatGPT redraws it as a clean turnaround.' },
  { id: 'convert', label: 'Convert my image', hint: 'Upload finished artwork. It is converted straight into vector parts and rigged, without redrawing.' },
  { id: 'parametric', label: 'Quick builder', hint: 'Build a rigged character from sliders and colours. Works offline, no API key needed.' },
  { id: 'library', label: 'Created characters', hint: 'Every character you have made is kept here on this computer. Pick one to add it to this project, as a 2D puppet or a 3D model.' },
];

/** Turntable preview of the 3D model a turnaround produces. */
function Preview3D({ spec, onError }: { spec: CharacterSpec; onError: (message: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [yaw, setYaw] = useState(30);
  const [model, setModel] = useState<LoadedModel | null>(null);
  const key = JSON.stringify(spec);
  useEffect(() => {
    let live = true;
    let made: LoadedModel | null = null;
    // Wait for edits to settle: building the solids is the slow part.
    const timer = setTimeout(() => {
      import('../render/three/engine')
        .then((m) => m.loadModel({ id: 'preview', name: 'preview', kind: 'character3d', mime: '', dataUrl: '', spec: JSON.parse(key) }))
        .then((m) => {
          made = m;
          if (live) setModel(m);
          else m.dispose();
        })
        .catch((err) => live && onError(err instanceof Error ? err.message : String(err)));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
      made?.dispose();
      setModel(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !model) return;
    const size = Math.round(Math.min(c.clientWidth, c.clientHeight) * (window.devicePixelRatio || 1)) || 512;
    const out = model.render({ rotX: 8, rotY: yaw, rotZ: 0, shadeSteps: 2, shade: 0.28, outline: 0.45, outlineColor: '#1b1b22', lightAngle: 35, clip: null, time: 0 }, size, size);
    c.width = c.height = size;
    c.getContext('2d')!.drawImage(out.canvas, out.sx, out.sy, out.w, out.h, 0, 0, size, size);
  }, [model, yaw]);
  return (
    <>
      <div className="cc-preview">
        <canvas ref={ref} data-testid="preview-3d" style={{ objectFit: 'contain' }} />
        {!model && <div className="empty">Building the 3D model…</div>}
      </div>
      <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        Turn <input type="range" min={-180} max={180} value={yaw} onChange={(e) => setYaw(Number(e.target.value))} style={{ flex: 1 }} />
      </label>
    </>
  );
}

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
  const [style, setStyle] = useState<'2d' | '3d'>('2d');
  const [saved, setSaved] = useState<SavedCharacter[]>([]);
  const [picked, setPicked] = useState<SavedCharacter | null>(null);
  /** The generated result already stored in the library, so adding it does not store it twice. */
  const storedRef = useRef<CreatorResult | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const spec: CharacterSpec | null = tab === 'library' ? picked?.spec ?? null : tab === 'parametric' ? humanoidSpec({ ...params, name, views }) : result?.spec ?? null;
  const refresh = () => listCharacters().then(setSaved, () => setSaved([]));
  useEffect(() => void refresh(), []);
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
  }, [tab, result, shown, style, picked, JSON.stringify(tab === 'parametric' ? { params, views } : null)]);

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
      // A generated character costs API credit: keep it even if this window is closed without adding it.
      storedRef.current = res;
      void saveCharacter({ ...res.spec, name: name.trim() || 'Character' }, TABS.find((t) => t.id === tab)!.label).then(refresh, () => {});
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
    const label = tab === 'library' ? picked!.name : name.trim() || 'Character';
    const sized = { ...spec, name: label, height: Math.round(p.height * 0.55) };
    try {
      if (style === '3d') addCharacter3DFromSpec(sized);
      else addCharacterFromSpec(sized);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (tab === 'parametric' || (tab !== 'library' && storedRef.current !== result)) void saveCharacter({ ...spec, name: label }, TABS.find((t) => t.id === tab)!.label).catch(() => {});
    ui().toast(`${label} added to the scene as a ${style === '3d' ? '3D model' : '2D puppet'}, rigged and ready to animate`, 'success');
    set({ dialog: null, rightTab: 'actions' });
  };

  const P = (patch: Partial<HumanoidParams>) => setParams({ ...params, ...patch });
  const info = TABS.find((t) => t.id === tab)!;
  const needsKey = tab !== 'parametric' && tab !== 'library' && !hasKey;
  const imageCount = tab === 'convert' ? (otherViews ? views.filter((v) => v !== convertView).length : 0) : views.length;

  return (
    <Dialog
      wide
      title={<><Wand2 size={17} /> Character Creator</>}
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>
            {tab === 'library' ? `${saved.length} saved character${saved.length === 1 ? '' : 's'}, stored on this computer.` : tab === 'parametric' ? 'Built on your computer. Nothing is sent anywhere.' : `Uses your OpenAI key: ${imageCount} image generation${imageCount === 1 ? '' : 's'} and ${tab === 'convert' && !otherViews ? 1 : views.length} conversion${views.length === 1 ? '' : 's'}.`}
          </span>
          <button className="btn" onClick={close}>Cancel</button>
          {tab !== 'parametric' && tab !== 'library' && (
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
        {tab === 'library' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
            <div className="hint">{info.hint}</div>
            {saved.length === 0 && <div className="empty">Nothing here yet. Characters appear as soon as you generate one or add one from the Quick builder.</div>}
            <div className="cc-library">
              {saved.map((c) => (
                <div key={c.id} className={`cc-saved${picked?.id === c.id ? ' on' : ''}`} onClick={() => { setPicked(c); setError(null); }} title={`${c.name}\n${c.source}, ${new Date(c.createdAt).toLocaleDateString()}`}>
                  {c.thumb ? <img src={c.thumb} alt="" draggable={false} /> : <div className="cc-nothumb" />}
                  <small>{c.name}</small>
                  <button className="icon-btn sm del" title="Delete from the library" onClick={(e) => { e.stopPropagation(); void deleteCharacter(c.id).then(() => { if (picked?.id === c.id) setPicked(null); return refresh(); }); }}><Trash2 size={11} /></button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: tab === 'library' ? 'none' : 'flex', flexDirection: 'column', gap: 12 }}>
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
          <div className="seg" style={{ alignSelf: 'center' }} title="A 2D puppet is flat vector art with five drawn views. A 3D model is built from the same drawings, turns freely and is drawn cel-shaded so it still looks 2D. Both use the same skeleton and animations.">
            <button className={style === '2d' ? 'on' : ''} onClick={() => setStyle('2d')}>2D puppet</button>
            <button className={style === '3d' ? 'on' : ''} onClick={() => setStyle('3d')}>3D model</button>
          </div>
          {spec && style === '3d' ? <Preview3D spec={spec} onError={setError} /> : (
            <div className="cc-preview">
              {spec ? <canvas ref={canvasRef} /> : <div className="empty">{busy ? 'Working… this usually takes a minute or two.' : tab === 'library' ? 'Pick a character on the left.' : 'The rigged character appears here.'}</div>}
            </div>
          )}
          {style === '2d' && available.length > 1 && (
            <div className="seg" style={{ alignSelf: 'center' }}>
              {available.map((v) => <button key={v} className={shown === v ? 'on' : ''} onClick={() => setPreviewView(v)}>{VIEW_LABEL[v]}</button>)}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

