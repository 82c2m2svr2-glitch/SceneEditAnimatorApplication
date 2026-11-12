import { Check, CircleAlert, ImagePlus, ImageUp, Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ASSET_KINDS, ASSET_SIZES, ASSET_STYLES, MAX_REFERENCES, REFERENCE_USES, generateAssets, type AssetQuality, type AssetShape, type ReferenceUse } from '../ai/assetBuilder';
import { normalizeImage } from '../ai/characterCreator';
import { listOpenAIModels } from '../ai/providers';
import { patchNode, reorder } from '../state/commands';
import { addReliefModel, importImage, placeImage, readAsDataUrl } from '../state/content';
import { pickFile } from '../state/persistence';
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

interface Reference {
  id: number;
  url: string;
  name: string;
  /** The generated result this reference was taken from, if any. */
  madeId?: number;
}

let nextId = 1;

const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif';
const baseName = (name: string) => name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();

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
  const [refs, setRefs] = useState<Reference[]>([]);
  const [refUse, setRefUse] = useState<ReferenceUse>('both');
  const [dropping, setDropping] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<Made[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const info = ASSET_KINDS.find((k) => k.id === kind)!;
  // A full-frame picture has no shape to give volume to.
  const canBe3D = info.transparent;
  const solid = output === '3d' && canBe3D;
  const projectImages = Object.values(doc.project?.assets ?? {}).filter((a) => a.kind === 'image' && a.dataUrl);
  const styleFromRef = refs.length > 0 && refUse === 'both';
  const needsWords = refs.length === 0 || refUse === 'style';
  const canRun = hasKey && (!!description.trim() || !needsWords);

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

  /** Adds pictures as references, shrunk to what the API needs so the window stays light. */
  const addRefs = async (items: { url: string; name: string; madeId?: number }[]) => {
    if (!items.length) return;
    setError('');
    const room = MAX_REFERENCES - refs.length;
    if (room <= 0) return setError(`Up to ${MAX_REFERENCES} reference images. Remove one to add another.`);
    const added: Reference[] = [];
    for (const item of items.slice(0, room)) {
      try {
        added.push({ id: nextId++, url: (await normalizeImage(item.url)).url, name: baseName(item.name) || 'Reference', madeId: item.madeId });
      } catch {
        setError(`${item.name || 'That picture'} could not be read as an image.`);
      }
    }
    setRefs((list) => [...list, ...added].slice(0, MAX_REFERENCES));
    if (items.length > room) setError(`Only the first ${room} were added: up to ${MAX_REFERENCES} reference images.`);
  };
  const addFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (files.length && !images.length) return setError('Reference images must be pictures (PNG, JPEG or WebP).');
    await addRefs(await Promise.all(images.map(async (f) => ({ url: await readAsDataUrl(f), name: f.name }))));
  };
  const browse = async () => addFiles(await pickFile(IMAGE_TYPES, true));
  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (!files.length || busy) return;
    e.preventDefault();
    void addFiles(files.map((f, i) => (f.name ? f : new File([f], `pasted-${i + 1}.png`, { type: f.type }))));
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    if (!busy) void addFiles([...e.dataTransfer.files]);
  };

  const run = async () => {
    setError('');
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    const fromWords = description.trim().replace(/[^\w\s-]/g, '').split(/\s+/).slice(0, 4).join(' ');
    const name = fromWords || (refUse !== 'style' ? refs[0]?.name : '') || info.label;
    try {
      const res = await generateAssets(
        {
          description, kind, style, shape, quality, transparent: transparent || solid, count, model: settings.imageModel,
          references: refs.map((r) => r.url), referenceUse: refUse,
        },
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
  const toggle = (id: number) => setMade((list) => list.map((x) => (x.id === id ? { ...x, chosen: !x.chosen } : x)));
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
            Every picture is drawn by OpenAI with your API key: {count} image{count === 1 ? '' : 's'} per run
            {refs.length ? `, each guided by ${refs.length} reference image${refs.length === 1 ? '' : 's'}` : ''}, billed to your OpenAI account.
          </span>
          <button className="btn" onClick={close}>Close</button>
          {busy
            ? <button className="btn" onClick={() => abortRef.current?.abort()}><Loader2 size={14} className="spin" /> Stop</button>
            : <button className={`btn${made.length ? '' : ' primary'}`} disabled={!canRun} onClick={() => void run()}><Sparkles size={14} /> {made.length ? 'Generate more' : 'Generate'}</button>}
          <button className="btn primary" disabled={!chosen.length || busy} onClick={() => void add()}><Check size={14} /> Add {chosen.length || ''} to scene</button>
        </>
      }
    >
      <div className="cc-grid" onPaste={onPaste}>
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
            placeholder={
              needsWords
                ? refs.length ? `Describe what to draw in the reference's style. For example: ${info.example}` : `Describe it. For example: ${info.example}`
                : 'Optional: anything to change or add. Leave empty to draw exactly what the reference shows.'
            }
          />

          <div
            className={`asset-refbox${dropping ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDropping(true); }}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 12 }}>Reference images</strong>
              <span className="hint" style={{ flex: 1 }}>{refs.length}/{MAX_REFERENCES}, optional</span>
            </div>
            {refs.length > 0 && (
              <div className="asset-refs">
                {refs.map((r) => (
                  <div key={r.id} className="asset-ref" title={r.name}>
                    <img src={r.url} alt={r.name} draggable={false} />
                    <button className="icon-btn sm asset-ref-x" title="Remove this reference" disabled={busy} onClick={() => setRefs((list) => list.filter((x) => x.id !== r.id))}><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn" disabled={busy || refs.length >= MAX_REFERENCES} onClick={() => void browse()}><ImageUp size={14} /> Add image</button>
              {projectImages.length > 0 && (
                <select
                  value="" disabled={busy || refs.length >= MAX_REFERENCES} style={{ width: 'auto', flex: 1, minWidth: 0 }}
                  onChange={(e) => {
                    const a = projectImages.find((x) => x.id === e.target.value);
                    if (a) void addRefs([{ url: a.dataUrl, name: a.name }]);
                  }}
                >
                  <option value="">From this project…</option>
                  {projectImages.map((a) => <option key={a.id} value={a.id}>{baseName(a.name)}</option>)}
                </select>
              )}
            </div>
            {refs.length === 0
              ? <span className="hint">Give a picture of what you want (a sketch, photo, or earlier art) and the result follows it instead of guessing from words. Drop or paste images here too.</span>
              : (
                <>
                  <div className="form-row" style={{ gridTemplateColumns: '70px 1fr' }}>
                    <label>Use it for</label>
                    {seg(refUse, REFERENCE_USES.map((u) => [u.id, u.label] as [ReferenceUse, string]), setRefUse)}
                  </div>
                  <span className="hint">{REFERENCE_USES.find((u) => u.id === refUse)!.hint}{refs.length > 1 && refUse !== 'style' ? ' Several references are treated as views or details of the same thing.' : ''}</span>
                </>
              )}
          </div>

          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }} title="A 3D object is the generated picture puffed up into a rounded solid that you can turn, tilt and animate in depth. Backgrounds and textures are always flat.">
            <label>Make it</label>
            <div className="seg" style={{ width: 'fit-content' }}>
              <button className={!solid ? 'on' : ''} disabled={busy} onClick={() => setOutput('2d')}>2D picture</button>
              <button className={solid ? 'on' : ''} disabled={busy || !canBe3D} onClick={() => setOutput('3d')}>3D object</button>
            </div>
          </div>
          <div className="form-row" style={{ gridTemplateColumns: '90px 1fr' }}>
            <label>Art style</label>
            {styleFromRef
              ? <span className="hint">Taken from the reference image</span>
              : (
                <select value={style} disabled={busy} onChange={(e) => setStyle(e.target.value)}>
                  {ASSET_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              )}
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
              <div
                key={m.id} role="button" tabIndex={0}
                className={`asset-pick${m.chosen ? ' on' : ''}`}
                title={m.chosen ? 'Selected: click to leave it out' : 'Click to select'}
                onClick={() => toggle(m.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  toggle(m.id);
                }}
              >
                <img src={m.url} alt={m.name} draggable={false} />
                {m.chosen && <span className="asset-tick"><Check size={13} /></span>}
                {m.solid && <span className="chip" style={{ position: 'absolute', left: 6, top: 6 }}>3D</span>}
                <button
                  className="btn asset-use-ref"
                  disabled={busy || refs.length >= MAX_REFERENCES || refs.some((r) => r.madeId === m.id)}
                  title="Use this picture as a reference for the next run, to get closer to what you want"
                  onClick={(e) => {
                    e.stopPropagation();
                    void addRefs([{ url: m.url, name: m.name, madeId: m.id }]);
                  }}
                >
                  <ImageUp size={12} /> Use as reference
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
