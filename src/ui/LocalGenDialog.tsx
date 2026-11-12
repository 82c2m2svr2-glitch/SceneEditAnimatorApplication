import { Check, CircleAlert, Dices, ImagePlus, Layers, Loader2, Lock, PlugZap, RotateCcw, Save, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  angleFromName, BUILT_IN_STYLES, CEL_90S, DEFAULT_LOCAL_SETTINGS, denoiseHint, describeRecord, LOCAL_SIZES, REGION_PRESETS, regionInSource,
  recordName, settingsFromRecord, type GenerationRecord, type LocalGenMode, type LocalGenSettings, type StylePreset,
} from '../core/localGen';
import { newId } from '../core/ids';
import type { Asset, ID } from '../core/types';
import {
  applyRecommendedOpenVino, checkLocalGenerator, cropRegion, generateLocal, selectCheckpoint, type LocalGenStatus, type LocalProgress,
} from '../ai/localGen';
import { placePlate, removeStylePreset, saveStylePreset, scene, setAssetPlate } from '../state/commands';
import { importGeneratedImage, importImage, placeFullFrame, placeOverPlate, plateNodeFor, readAsDataUrl } from '../state/content';
import { pickFile } from '../state/persistence';
import { useSettings } from '../state/settings';
import { doc, useDocRevision } from '../state/store';
import { ui, useUI } from '../state/ui';
import { Dialog } from './widgets';

interface Prefill {
  settings?: LocalGenSettings;
  sourceId?: ID;
  checkpoint?: string;
}

let pending: Prefill | null = null;
/** Remembered between openings, like the other generators' choices. */
let lastSettings: LocalGenSettings = DEFAULT_LOCAL_SETTINGS;
let lastStatus: LocalGenStatus | null = null;

/** Opens Local Image Generation, optionally filled in from an earlier result. */
export function openLocalGen(prefill?: Prefill): void {
  pending = prefill ?? null;
  ui().set({ dialog: 'localGen' });
}

interface Made {
  id: number;
  dataUrl: string;
  record: GenerationRecord;
  /** Set once it is saved as a project asset. */
  assetId?: ID;
}

let nextId = 1;
const MODES: [LocalGenMode, string, string][] = [
  ['txt2img', 'New shot', 'Text to image: a new shot concept from a description.'],
  ['img2img', 'Variation', 'Image to image: a variation of a project image. Denoising strength sets how much of it changes.'],
  ['region', 'Region of a plate', 'Changes only part of a background, for characters and foreground. The rest of the plate stays untouched.'],
];

export function LocalGenDialog() {
  useDocRevision();
  const set = useUI((s) => s.set);
  const settings = useSettings();
  const p = doc.project!;
  const [init] = useState(() => {
    const pre = pending;
    pending = null;
    return pre;
  });
  const [tab, setTab] = useState<'generate' | 'plates'>('generate');
  const [s, setS] = useState<LocalGenSettings>(init?.settings ?? lastSettings);
  const [sourceId, setSourceId] = useState<ID>(init?.sourceId ?? '');
  const [regionId, setRegionId] = useState(REGION_PRESETS.find((r) => s.region && r.rect.x === s.region.x && r.rect.w === s.region.w && r.rect.y === s.region.y)?.id ?? 'lower');
  const [status, setStatus] = useState<LocalGenStatus | null>(lastStatus);
  const [checking, setChecking] = useState(false);
  const [checkpoint, setCheckpoint] = useState(init?.checkpoint ?? lastStatus?.checkpoint ?? '');
  const [busy, setBusy] = useState<'' | 'generate' | 'model' | 'openvino'>('');
  const [progress, setProgress] = useState<LocalProgress | null>(null);
  const [error, setError] = useState('');
  const [made, setMade] = useState<Made[]>([]);
  const [editStyle, setEditStyle] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const images = Object.values(p.assets).filter((a) => a.kind === 'image' && a.dataUrl);
  const plates = images.filter((a) => a.plate);
  const source = images.find((a) => a.id === sourceId) ?? null;
  const styles: StylePreset[] = [...BUILT_IN_STYLES, ...(p.styles ?? [])];
  const P = (patch: Partial<LocalGenSettings>) => setS((prev) => ({ ...prev, ...patch }));
  const sizeId = LOCAL_SIZES.find((z) => z.width === s.width && z.height === s.height)?.id ?? 'wide';

  useEffect(() => {
    lastSettings = s;
  }, [s]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const check = async () => {
    setChecking(true);
    setError('');
    try {
      const st = await checkLocalGenerator();
      lastStatus = st;
      setStatus(st);
      setCheckpoint((c) => (c && st.checkpoints.some((m) => m.title === c) ? c : st.checkpoint));
    } catch (err) {
      lastStatus = null;
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (!lastStatus) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    setError('');
    if (s.mode !== 'txt2img' && !source) return setError('Choose the project image to start from.');
    if (s.mode === 'txt2img' && !s.prompt.trim()) return setError('Describe the shot first.');
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy('generate');
    setProgress(null);
    try {
      const region = REGION_PRESETS.find((r) => r.id === regionId)!.rect;
      const res = await generateLocal(s.mode === 'region' ? { ...s, region } : s, {
        checkpoint: checkpoint || undefined,
        source: source ? { assetId: source.id, name: source.name, dataUrl: source.dataUrl } : undefined,
        onProgress: setProgress,
        signal: ac.signal,
      });
      setMade((list) => [{ id: nextId++, ...res }, ...list]);
      if (checkpoint && status) setStatus({ ...status, checkpoint });
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
      setProgress(null);
    }
  };

  /** Saves a result as a project asset (once) and returns it. */
  const save = async (m: Made): Promise<Asset> => {
    const existing = m.assetId ? p.assets[m.assetId] : undefined;
    if (existing) return existing;
    let url = m.dataUrl;
    if (m.record.mode === 'region' && m.record.region) {
      // Keep only the changed part: it becomes its own layer over the untouched plate.
      url = await cropRegion(m.dataUrl, m.record.region);
    }
    const asset = await importGeneratedImage(`${recordName(m.record)}.png`, url, m.record);
    setMade((list) => list.map((x) => (x.id === m.id ? { ...x, assetId: asset.id } : x)));
    return asset;
  };

  const act = async (m: Made, what: 'save' | 'scene' | 'source' | 'plate') => {
    setError('');
    try {
      const asset = await save(m);
      if (what === 'save') ui().toast(`Saved "${asset.name}" to the project with its settings`, 'success');
      if (what === 'scene') {
        const r = m.record;
        const src = r.source ? p.assets[r.source.assetId] : undefined;
        const plateNode = r.mode === 'region' && src ? plateNodeFor(src.id) : null;
        if (plateNode && r.region && src?.width && src.height) {
          placeOverPlate(asset, plateNode.id, regionInSource(r.region, { width: src.width, height: src.height }, { width: r.width, height: r.height }));
          ui().toast('Added over the plate, lined up with the region it came from', 'success');
        } else {
          placeFullFrame(asset);
          ui().toast(`Added "${asset.name}" to the scene`, 'success');
        }
      }
      if (what === 'source') {
        setSourceId(asset.id);
        P({ mode: 'img2img', seed: -1 });
      }
      if (what === 'plate') {
        setAssetPlate(asset.id, { angle: angleFromName(asset.name) });
        setTab('plates');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const switchModel = async (title: string) => {
    setCheckpoint(title);
    if (!status || title === status.checkpoint) return;
    setBusy('model');
    setError('');
    try {
      await selectCheckpoint(title);
      setStatus({ ...status, checkpoint: title });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const recommend = async () => {
    setBusy('openvino');
    setError('');
    try {
      await applyRecommendedOpenVino();
      await check();
      ui().toast('OpenVINO now uses the Intel graphics and keeps compiled models between runs', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  /** Fills the form from a record: same seed, source, region and model, so it can be repeated or changed. */
  const reuse = (r: GenerationRecord) => {
    setS(settingsFromRecord(r));
    if (r.source && p.assets[r.source.assetId]) setSourceId(r.source.assetId);
    const preset = r.region && REGION_PRESETS.find((x) => x.rect.x === r.region!.x && x.rect.y === r.region!.y && x.rect.w === r.region!.w && x.rect.h === r.region!.h);
    if (preset) setRegionId(preset.id);
    if (r.checkpoint && status?.checkpoints.some((c) => c.title === r.checkpoint)) setCheckpoint(r.checkpoint);
  };

  const close = () => {
    abortRef.current?.abort();
    set({ dialog: null });
  };
  const seg = <T extends string>(value: T, options: [T, string][], onPick: (v: T) => void, disabled = false) => (
    <div className="seg" style={{ width: 'fit-content', flexWrap: 'wrap' }}>
      {options.map(([v, label]) => <button key={v} className={value === v ? 'on' : ''} disabled={disabled || !!busy} onClick={() => onPick(v)}>{label}</button>)}
    </div>
  );
  const row = (label: string, child: React.ReactNode, title?: string) => (
    <div className="form-row" style={{ gridTemplateColumns: '96px 1fr' }} title={title}><label>{label}</label>{child}</div>
  );
  const style = s.style ? styles.find((x) => x.id === s.style!.id) : undefined;
  const styleChanged = !!s.style && (!style || style.positive !== s.style.positive || style.negative !== s.style.negative);
  const recommended = !!status && !(status.openvinoDevices.length === 1 && status.openvinoDevices[0] === 'GPU' && status.openvinoCaching);
  const pct = progress ? Math.round(progress.progress * 100) : 0;

  return (
    <Dialog
      wide
      title={<><Wand2 size={17} /> Local Image Generation</>}
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>Runs on this computer with SD.Next: no API key, no paid service, nothing leaves the machine.</span>
          <button className="btn" onClick={close}>Close</button>
          {tab === 'generate' && (busy === 'generate'
            ? <button className="btn" onClick={() => abortRef.current?.abort()}><Loader2 size={14} className="spin" /> Stop</button>
            : <button className="btn primary" disabled={!!busy || !status} onClick={() => void run()}><Sparkles size={14} /> Generate preview</button>)}
        </>
      }
    >
      <div className="lg-conn">
        <PlugZap size={15} />
        <input type="text" value={settings.localGenUrl} disabled={!!busy} onChange={(e) => settings.update({ localGenUrl: e.target.value })} onKeyDown={(e) => e.stopPropagation()} title="Address of SD.Next on this computer" style={{ width: 190 }} />
        <input type="password" value={settings.localGenAuth} disabled={!!busy} placeholder="user:password (optional)" onChange={(e) => settings.update({ localGenAuth: e.target.value })} onKeyDown={(e) => e.stopPropagation()} title="Only if SD.Next was started with --auth" style={{ width: 170 }} />
        <button className="btn" disabled={checking || !!busy} onClick={() => void check()}>{checking ? <Loader2 size={14} className="spin" /> : <PlugZap size={14} />} Check connection</button>
        {status
          ? <span className="chip lg-ok" title={status.url}><Check size={11} /> Connected: {status.version} ({status.ms} ms)</span>
          : !checking && <span className="chip lg-off">Not connected</span>}
      </div>
      {status && (
        <div className="lg-conn" style={{ marginTop: -4 }}>
          <span className="hint">Model</span>
          <select value={checkpoint} disabled={!!busy} onChange={(e) => void switchModel(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
            {!status.checkpoints.some((m) => m.title === checkpoint) && <option value={checkpoint}>{checkpoint || 'None loaded'}</option>}
            {status.checkpoints.map((m) => <option key={m.title} value={m.title}>{m.name}</option>)}
          </select>
          {busy === 'model' && <span className="hint"><Loader2 size={12} className="spin" /> Loading model…</span>}
          <span className="hint">OpenVINO: {status.openvinoDevices.join('+') || 'AUTO'}{status.openvinoCaching ? ', cache on' : ''}</span>
          {recommended && <button className="btn" disabled={!!busy} title="Run on the Intel graphics (GPU) and keep compiled models between runs" onClick={() => void recommend()}>{busy === 'openvino' ? <Loader2 size={14} className="spin" /> : null} Use recommended settings</button>}
        </div>
      )}

      <div className="tabs" style={{ borderBottom: '1px solid var(--line)' }}>
        <button className={`tab${tab === 'generate' ? ' on' : ''}`} onClick={() => setTab('generate')}>Generate</button>
        <button className={`tab${tab === 'plates' ? ' on' : ''}`} onClick={() => setTab('plates')}>Background plates ({plates.length})</button>
      </div>

      {tab === 'generate' && (
        <div className="cc-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {seg(s.mode, MODES.map(([m, l]) => [m, l]), (m) => P({ mode: m }))}
            <span className="hint">{MODES.find(([m]) => m === s.mode)![2]}</span>
            {s.mode !== 'txt2img' && (
              <>
                {row('Start from', (
                  <select value={sourceId} disabled={!!busy} onChange={(e) => setSourceId(e.target.value)}>
                    <option value="">Choose a project image…</option>
                    {(s.mode === 'region' ? [...plates, ...images.filter((a) => !a.plate)] : images).map((a) => <option key={a.id} value={a.id}>{a.plate ? `Plate: ${a.plate.angle}` : a.name}</option>)}
                  </select>
                ))}
                {source && (
                  <div className="lg-source">
                    <img src={source.dataUrl} alt="" />
                    {s.mode === 'region' && (() => {
                      const r = REGION_PRESETS.find((x) => x.id === regionId)!.rect;
                      return <i className="lg-region" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />;
                    })()}
                  </div>
                )}
                {s.mode === 'region' && row('Region', seg(regionId, REGION_PRESETS.map((r) => [r.id, r.label]), setRegionId))}
                {row('Denoising', (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input type="range" min={0.05} max={1} step={0.05} value={s.denoisingStrength} disabled={!!busy} onChange={(e) => P({ denoisingStrength: Number(e.target.value) })} style={{ flex: 1 }} />
                      <b style={{ width: 34, textAlign: 'right' }}>{s.denoisingStrength.toFixed(2)}</b>
                    </div>
                    <span className="hint">{denoiseHint(s.denoisingStrength)}</span>
                  </div>
                ), 'How much of the starting image may change: low keeps the composition, high makes a new picture')}
              </>
            )}
            <textarea
              rows={3} value={s.prompt} disabled={!!busy} onChange={(e) => P({ prompt: e.target.value })} onKeyDown={(e) => e.stopPropagation()}
              placeholder={s.mode === 'txt2img' ? 'The shot: for example, wide shot of a nighttime waterfront promenade, metal railing, city skyline across the water, lit windows' : s.mode === 'region' ? 'What goes in the region: for example, a young woman in a trench coat leaning on the railing, seen from behind' : 'What to change, or leave as the original description'}
            />
            <input type="text" value={s.negativePrompt} disabled={!!busy} placeholder="Also avoid (optional)" onChange={(e) => P({ negativePrompt: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
            {row('Style', (
              <div style={{ display: 'flex', gap: 6 }}>
                <select value={s.style?.id ?? 'none'} disabled={!!busy} style={{ flex: 1, minWidth: 0 }} onChange={(e) => P({ style: styles.find((x) => x.id === e.target.value) ?? null })}>
                  {styles.map((x) => <option key={x.id} value={x.id}>{x.name}{x.builtIn ? '' : ' (this project)'}</option>)}
                  {s.style && !styles.some((x) => x.id === s.style!.id) && <option value={s.style.id}>{s.style.name} (from a saved result)</option>}
                </select>
                <button className={`btn${editStyle ? ' on' : ''}`} disabled={!!busy || !s.style} onClick={() => setEditStyle(!editStyle)}>Edit</button>
              </div>
            ), 'A style describes the look and is added to every prompt, so the same look carries across locations')}
            {editStyle && s.style && (
              <div className="lg-style">
                <input type="text" value={s.style.name} onChange={(e) => P({ style: { ...s.style!, name: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} />
                <textarea rows={3} value={s.style.positive} onChange={(e) => P({ style: { ...s.style!, positive: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} placeholder="Look: added after every shot description" />
                <textarea rows={2} value={s.style.negative} onChange={(e) => P({ style: { ...s.style!, negative: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} placeholder="Always avoid" />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn" disabled={!styleChanged && !!style && !style.builtIn} onClick={() => {
                    const keep = style && !style.builtIn ? s.style!.id : newId('style');
                    const name = style?.builtIn && s.style!.name === style.name ? `${style.name} (custom)` : s.style!.name;
                    saveStylePreset({ ...s.style!, id: keep, name });
                    P({ style: { ...s.style!, id: keep, name } });
                    ui().toast(`Saved the style "${name}" with the project`, 'success');
                  }}><Save size={13} /> {style && !style.builtIn ? 'Save changes' : 'Save as project style'}</button>
                  {style && !style.builtIn && <button className="btn" onClick={() => { removeStylePreset(style.id); P({ style: CEL_90S }); }}><Trash2 size={13} /> Delete style</button>}
                  <button className="btn" onClick={() => P({ style: style ?? CEL_90S })}><RotateCcw size={13} /> Revert</button>
                </div>
              </div>
            )}
            {row('Size', (
              <select value={sizeId} disabled={!!busy} onChange={(e) => { const z = LOCAL_SIZES.find((x) => x.id === e.target.value)!; P({ width: z.width, height: z.height }); }}>
                {LOCAL_SIZES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
              </select>
            ), 'OpenVINO compiles the model for one size: changing it costs a few minutes the first time')}
            {row('Seed', (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="number" value={s.seed} disabled={!!busy || s.seed < 0} onChange={(e) => P({ seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} onKeyDown={(e) => e.stopPropagation()} style={{ width: 120 }} />
                <button className="btn" disabled={!!busy} title={s.seed < 0 ? 'Random each time: click to fix the seed' : 'Fixed: click for a random seed each time'} onClick={() => P({ seed: s.seed < 0 ? (made[0]?.record.seed ?? Math.floor(Math.random() * 2 ** 31)) : -1 })}>
                  {s.seed < 0 ? <><Dices size={13} /> Random</> : <><Lock size={13} /> Fixed</>}
                </button>
              </div>
            ))}
            <details>
              <summary className="hint">Steps, guidance and sampler</summary>
              {row('Steps', <input type="number" min={1} max={150} value={s.steps} disabled={!!busy} onChange={(e) => P({ steps: Number(e.target.value) || 20 })} onKeyDown={(e) => e.stopPropagation()} />)}
              {row('CFG scale', <input type="number" min={1} max={30} step={0.5} value={s.cfgScale} disabled={!!busy} onChange={(e) => P({ cfgScale: Number(e.target.value) || 7 })} onKeyDown={(e) => e.stopPropagation()} />)}
              {row('Sampler', (
                <select value={s.sampler} disabled={!!busy} onChange={(e) => P({ sampler: e.target.value })}>
                  {[...new Set(['Default', s.sampler, ...(status?.samplers ?? [])])].map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              ))}
            </details>
            {error && <div className="note err"><CircleAlert size={13} style={{ verticalAlign: -2 }} /> {error}</div>}
            {!status && !checking && (
              <div className="note warn">
                Start SD.Next on this computer (see "Local image generation" in the README), then press Check connection.
              </div>
            )}
          </div>

          <div className="asset-results">
            {busy === 'generate' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="progress"><i style={{ width: `${pct}%` }} /></div>
                <span className="hint">
                  {progress && progress.steps ? `Step ${progress.step} of ${progress.steps}${progress.etaSeconds ? `, about ${Math.ceil(progress.etaSeconds)} s left` : ''}` : 'Starting… the first image after a model or size change waits for OpenVINO to compile, which can take several minutes.'}
                </span>
              </div>
            )}
            {made.length === 0 && busy !== 'generate' && <div className="empty"><ImagePlus size={22} /><br />Previews appear here with the settings that made them.</div>}
            {made.map((m) => (
              <div key={m.id} className="lg-result">
                <div className="lg-shot">
                  <img src={m.dataUrl} alt="" />
                  {m.record.mode === 'region' && m.record.region && (
                    <i className="lg-region" style={{ left: `${m.record.region.x * 100}%`, top: `${m.record.region.y * 100}%`, width: `${m.record.region.w * 100}%`, height: `${m.record.region.h * 100}%` }} />
                  )}
                </div>
                <div className="hint lg-meta" title={`${m.record.fullPrompt}\n\nNegative: ${m.record.fullNegativePrompt}`}>{describeRecord(m.record)}</div>
                <div className="lg-actions">
                  <button className="btn" disabled={!!m.assetId} onClick={() => void act(m, 'save')}>{m.assetId ? <><Check size={13} /> Saved</> : <><Save size={13} /> Save to project</>}</button>
                  <button className="btn" onClick={() => void act(m, 'scene')}><ImagePlus size={13} /> Add to scene</button>
                  <button className="btn" disabled={!!busy} title="Make a variation of this picture" onClick={() => void act(m, 'source')}><Wand2 size={13} /> Vary this</button>
                  <button className="btn" disabled={!!busy} title="Fill in the form with exactly these settings (same seed)" onClick={() => reuse(m.record)}><RotateCcw size={13} /> Reuse settings</button>
                  {m.record.mode !== 'region' && <button className="btn" title="Use as the fixed background for this camera angle" onClick={() => void act(m, 'plate')}><Layers size={13} /> Use as plate</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'plates' && <PlatesTab images={images} onGenerateOn={(id) => { setSourceId(id); P({ mode: 'region' }); setTab('generate'); }} />}
    </Dialog>
  );
}

/** Background plates: one image per camera angle, placed unchanged and locked behind every shot from that angle. */
function PlatesTab({ images, onGenerateOn }: { images: Asset[]; onGenerateOn: (assetId: ID) => void }) {
  const p = doc.project!;
  const [pick, setPick] = useState('');
  const [angle, setAngle] = useState('');
  const plates = images.filter((a) => a.plate);
  const sceneId = scene().id;
  const inScene = (assetId: ID, sceneNodes = scene().nodes) => Object.values(sceneNodes).some((n) => n.type === 'image' && n.assetId === assetId && n.tag === 'plate');

  const mark = (a: Asset, name: string) => {
    setAssetPlate(a.id, { angle: name || angleFromName(a.name) });
    setPick('');
    setAngle('');
  };
  const importPlate = async () => {
    const [f] = await pickFile('image/png,image/jpeg,image/webp');
    if (!f) return;
    try {
      const a = await importImage(f.name, await readAsDataUrl(f), f.type);
      mark(a, angleFromName(f.name));
    } catch {
      ui().toast(`Could not import "${f.name}".`, 'error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 360 }}>
      <span className="hint">
        A plate is the finished background for one camera angle. It is placed unchanged and locked behind every shot from that angle, so the railing, skyline and lights never shift between frames. Work on characters and foreground in their own layers on top, or generate them with "Region of a plate".
      </span>
      <div className="lg-conn">
        <button className="btn" onClick={() => void importPlate()}><ImagePlus size={14} /> Import plate image…</button>
        <span className="hint">or mark a project image:</span>
        <select value={pick} onChange={(e) => { setPick(e.target.value); const a = images.find((x) => x.id === e.target.value); setAngle(a ? angleFromName(a.name) : ''); }} style={{ minWidth: 0, flex: 1 }}>
          <option value="">Choose an image…</option>
          {images.filter((a) => !a.plate).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input type="text" value={angle} placeholder="Camera angle name" onChange={(e) => setAngle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} style={{ width: 200 }} />
        <button className="btn primary" disabled={!pick} onClick={() => { const a = images.find((x) => x.id === pick); if (a) mark(a, angle); }}><Layers size={14} /> Mark as plate</button>
      </div>
      {plates.length === 0 && <div className="empty">No plates yet.</div>}
      <div className="lg-plates">
        {plates.map((a) => {
          const here = inScene(a.id);
          const scenesWith = p.scenes.filter((sc) => inScene(a.id, sc.nodes)).length;
          return (
            <div key={a.id} className="lg-plate">
              <img src={a.dataUrl} alt="" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
                <input type="text" defaultValue={a.plate!.angle} title="Camera angle" onBlur={(e) => e.target.value !== a.plate!.angle && setAssetPlate(a.id, { angle: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                <span className="hint">{a.name} · {a.width}×{a.height} · in {scenesWith} of {p.scenes.length} scene{p.scenes.length === 1 ? '' : 's'}</span>
                <div className="lg-actions">
                  <button className="btn" disabled={here} onClick={() => { if (placePlate(a.id, [sceneId])) ui().toast('Plate placed behind everything in this scene, locked', 'success'); }}>{here ? <><Check size={13} /> In this scene</> : 'Add to this scene'}</button>
                  <button className="btn" disabled={scenesWith === p.scenes.length} onClick={() => { const n = placePlate(a.id, p.scenes.map((sc) => sc.id)); ui().toast(`Plate added to ${n} more scene${n === 1 ? '' : 's'}`, 'success'); }}>Add to all scenes</button>
                  <button className="btn" title="Make variations or region edits from this plate" onClick={() => onGenerateOn(a.id)}><Wand2 size={13} /> Generate on it</button>
                  <button className="btn" title="No longer a plate (layers already placed stay)" onClick={() => setAssetPlate(a.id, null)}><X size={13} /> Unmark</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

