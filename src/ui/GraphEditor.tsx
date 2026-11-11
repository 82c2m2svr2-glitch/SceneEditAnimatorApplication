import { useEffect, useMemo, useRef, useState } from 'react';
import { easeToBezier } from '../core/easing';
import { sampleTrack } from '../core/anim';
import { CAMERA_ID, type Ease, type ID, type Keyframe, type Scene } from '../core/types';
import { moveKeys, setFrame, setKeysEase, setKeyValue } from '../state/commands';
import { doc, useDocRevision } from '../state/store';
import { ui, useUI, type KeyRef } from '../state/ui';

/**
 * Curve editor: value-over-time curves for the numeric tracks of the selection.
 * Drag keys to change time and value; drag the handles of a selected key to shape its easing.
 */

const COLORS = ['#ff6b6b', '#51cf66', '#4dabf7', '#ffd43b', '#da77f2', '#ff922b', '#22d3ee', '#f783ac'];
const PAD = { l: 46, r: 12, t: 10, b: 20 };

interface Curve {
  target: ID;
  prop: string;
  keys: Keyframe[];
  color: string;
  label: string;
}

function curvesFor(scene: Scene, selection: ID[]): Curve[] {
  const targets = selection.length ? selection : [CAMERA_ID, ...Object.keys(scene.anim).filter((t) => t !== CAMERA_ID)].slice(0, 6);
  const out: Curve[] = [];
  for (const target of targets) {
    const tracks = scene.anim[target];
    if (!tracks) continue;
    const name = target === CAMERA_ID ? 'Camera' : scene.nodes[target]?.name ?? target;
    for (const prop of Object.keys(tracks).sort()) {
      const keys = tracks[prop].keys;
      if (keys.length === 0 || keys.some((k) => typeof k.v !== 'number')) continue;
      out.push({ target, prop, keys, color: COLORS[out.length % COLORS.length], label: `${name} · ${prop}` });
    }
  }
  return out;
}

type Drag =
  | { kind: 'key'; curve: Curve; f: number; startX: number; startY: number; v0: number; applied: number; began: boolean }
  | { kind: 'handle'; curve: Curve; index: number; which: 1 | 2 }
  | { kind: 'scrub' };

export function GraphEditor() {
  useDocRevision();
  const frame = useUI((s) => s.frame);
  const selection = useUI((s) => s.selection);
  const selectedKeys = useUI((s) => s.selectedKeys);
  const sceneId = useUI((s) => s.sceneId);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [size, setSize] = useState({ w: 600, h: 180 });
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const p = doc.project!;
  const scene = p.scenes.find((s) => s.id === sceneId) ?? p.scenes[0];
  const all = useMemo(() => curvesFor(scene, selection), [scene, selection]);
  const curves = all.filter((c) => !hidden.has(`${c.target}/${c.prop}`));

  // View range: the whole scene horizontally, the visible curves' value range vertically.
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of curves) for (const k of c.keys) {
    lo = Math.min(lo, k.v as number);
    hi = Math.max(hi, k.v as number);
  }
  if (lo === Infinity) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const margin = (hi - lo) * 0.18;
  lo -= margin;
  hi += margin;
  const W = size.w - PAD.l - PAD.r;
  const H = size.h - PAD.t - PAD.b;
  const X = (f: number) => PAD.l + (f / Math.max(1, scene.duration - 1)) * W;
  const Y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * H;
  const FX = (x: number) => ((x - PAD.l) / W) * Math.max(1, scene.duration - 1);
  const VY = (y: number) => lo + (1 - (y - PAD.t) / H) * (hi - lo);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const isSel = (c: Curve, f: number) => selectedKeys.some((k) => k.target === c.target && k.prop === c.prop && Math.abs(k.f - f) < 1e-6);

  /** Screen positions of the two easing handles of the segment starting at key `i`. */
  const handles = (c: Curve, i: number) => {
    const a = c.keys[i];
    const b = c.keys[i + 1];
    if (!b || a.e === 'step') return null;
    const bz = easeToBezier(a.e);
    const x0 = X(a.f), x1 = X(b.f), y0 = Y(a.v as number), y1 = Y(b.v as number);
    return [
      { x: x0 + (x1 - x0) * bz[0], y: y0 + (y1 - y0) * bz[1] },
      { x: x0 + (x1 - x0) * bz[2], y: y0 + (y1 - y0) * bz[3] },
    ];
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    if (size.w < 2 || size.h < 2) return;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#14151a';
    g.fillRect(0, 0, size.w, size.h);
    g.font = '10px Inter, system-ui, sans-serif';
    // Grid
    const span = hi - lo;
    const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
    const vstep = [1, 2, 5, 10].map((m) => m * step).find((s) => span / s <= 6) ?? step * 10;
    g.textBaseline = 'middle';
    for (let v = Math.ceil(lo / vstep) * vstep; v <= hi; v += vstep) {
      g.strokeStyle = Math.abs(v) < 1e-9 ? '#3a3e4b' : '#22242c';
      g.beginPath();
      g.moveTo(PAD.l, Math.round(Y(v)) + 0.5);
      g.lineTo(size.w - PAD.r, Math.round(Y(v)) + 0.5);
      g.stroke();
      g.fillStyle = '#6b7080';
      g.fillText(String(Math.round(v * 1000) / 1000), 4, Y(v));
    }
    let fstep = 1;
    for (const s of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
      fstep = s;
      if ((s / Math.max(1, scene.duration - 1)) * W >= 50) break;
    }
    g.textBaseline = 'top';
    for (let f = 0; f < scene.duration; f += fstep) {
      g.strokeStyle = '#22242c';
      g.beginPath();
      g.moveTo(Math.round(X(f)) + 0.5, PAD.t);
      g.lineTo(Math.round(X(f)) + 0.5, size.h - PAD.b);
      g.stroke();
      g.fillStyle = '#6b7080';
      g.fillText(String(f), X(f) + 2, size.h - PAD.b + 4);
    }
    // Curves
    for (const c of curves) {
      g.strokeStyle = c.color;
      g.lineWidth = 1.5;
      g.beginPath();
      const first = c.keys[0].f;
      const last = c.keys[c.keys.length - 1].f;
      g.moveTo(X(0), Y(c.keys[0].v as number));
      for (let px = X(first); px <= X(last); px += 2) g.lineTo(px, Y(sampleTrack({ keys: c.keys }, FX(px)) as number));
      g.lineTo(X(last), Y(c.keys[c.keys.length - 1].v as number));
      g.lineTo(X(scene.duration - 1), Y(c.keys[c.keys.length - 1].v as number));
      g.stroke();
      c.keys.forEach((k, i) => {
        const sel = isSel(c, k.f);
        if (sel) {
          const hs = handles(c, i);
          if (hs) {
            const ends = [{ x: X(k.f), y: Y(k.v as number) }, { x: X(c.keys[i + 1].f), y: Y(c.keys[i + 1].v as number) }];
            hs.forEach((hp, n) => {
              g.strokeStyle = 'rgba(255,255,255,0.45)';
              g.lineWidth = 1;
              g.beginPath();
              g.moveTo(ends[n].x, ends[n].y);
              g.lineTo(hp.x, hp.y);
              g.stroke();
              g.fillStyle = '#ffffff';
              g.beginPath();
              g.arc(hp.x, hp.y, 4, 0, Math.PI * 2);
              g.fill();
            });
          }
        }
        g.fillStyle = sel ? '#ffffff' : c.color;
        g.strokeStyle = '#14151a';
        g.lineWidth = 1.5;
        g.beginPath();
        g.rect(X(k.f) - (sel ? 5 : 4), Y(k.v as number) - (sel ? 5 : 4), sel ? 10 : 8, sel ? 10 : 8);
        g.fill();
        g.stroke();
      });
    }
    // Playhead
    g.strokeStyle = '#ff4d6d';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(X(frame)) + 0.5, 0);
    g.lineTo(Math.round(X(frame)) + 0.5, size.h);
    g.stroke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curves, size, frame, selectedKeys, lo, hi]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = local(e);
    // Easing handles of selected keys take priority.
    for (const c of curves) {
      for (let i = 0; i < c.keys.length; i++) {
        if (!isSel(c, c.keys[i].f)) continue;
        const hs = handles(c, i);
        if (!hs) continue;
        for (const which of [1, 2] as const) {
          const hp = hs[which - 1];
          if (Math.hypot(hp.x - x, hp.y - y) <= 7) {
            dragRef.current = { kind: 'handle', curve: c, index: i, which };
            doc.begin('Edit easing');
            return;
          }
        }
      }
    }
    for (const c of curves) {
      for (const k of c.keys) {
        if (Math.hypot(X(k.f) - x, Y(k.v as number) - y) <= 7) {
          const ref: KeyRef = { target: c.target, prop: c.prop, f: k.f };
          useUI.setState({ selectedKeys: e.shiftKey ? [...ui().selectedKeys, ref] : [ref] });
          dragRef.current = { kind: 'key', curve: c, f: k.f, startX: x, startY: y, v0: k.v as number, applied: 0, began: false };
          return;
        }
      }
    }
    useUI.setState({ selectedKeys: [] });
    dragRef.current = { kind: 'scrub' };
    setFrame(Math.round(FX(x)));
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const { x, y } = local(e);
    if (d.kind === 'scrub') return setFrame(Math.round(FX(x)));
    if (d.kind === 'key') {
      if (!d.began) {
        if (Math.hypot(x - d.startX, y - d.startY) < 3) return;
        doc.begin('Edit keyframe');
        d.began = true;
      }
      const df = Math.round(FX(x) - FX(d.startX));
      if (df !== d.applied && !e.altKey) {
        moveKeys([{ target: d.curve.target, prop: d.curve.prop, f: d.f + d.applied }], df - d.applied);
        d.applied = df;
      }
      if (!e.shiftKey) setKeyValue({ target: d.curve.target, prop: d.curve.prop, f: Math.max(0, d.f + d.applied) }, d.v0 + (VY(y) - VY(d.startY)));
      return;
    }
    // Handle drag: express the pointer as a cubic-bezier control point of this segment.
    const s = doc.project!.scenes.find((sc) => sc.id === ui().sceneId)!;
    const keys = s.anim[d.curve.target]?.[d.curve.prop]?.keys;
    const a = keys?.[d.index];
    const b = keys?.[d.index + 1];
    if (!a || !b) return;
    const x0 = X(a.f), x1 = X(b.f), y0 = Y(a.v as number), y1 = Y(b.v as number);
    const bz = [...easeToBezier(a.e)] as [number, number, number, number];
    const tx = Math.max(0, Math.min(1, (x - x0) / (x1 - x0 || 1)));
    const ty = Math.abs(y1 - y0) < 1e-6 ? (d.which === 1 ? 0 : 1) : Math.max(-2, Math.min(3, (y - y0) / (y1 - y0)));
    if (d.which === 1) {
      bz[0] = tx;
      bz[1] = ty;
    } else {
      bz[2] = tx;
      bz[3] = ty;
    }
    setKeysEase([{ target: d.curve.target, prop: d.curve.prop, f: a.f }], bz.map((n) => Math.round(n * 1000) / 1000) as unknown as Ease);
  };

  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'handle' || (d.kind === 'key' && d.began)) doc.commit();
  };

  return (
    <div className="tl">
      <div className="tl-labels" style={{ overflowY: 'auto' }}>
        {all.length === 0 && <div className="empty">Select an animated layer to see its curves here.</div>}
        {all.map((c) => {
          const id = `${c.target}/${c.prop}`;
          const off = hidden.has(id);
          return (
            <div
              key={id} className="row" style={{ padding: '0 8px', height: 22, cursor: 'pointer', opacity: off ? 0.4 : 1 }}
              onClick={() => {
                const next = new Set(hidden);
                if (off) next.delete(id);
                else next.add(id);
                setHidden(next);
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: 2, background: c.color, flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
            </div>
          );
        })}
        {all.length > 0 && <div className="hint" style={{ padding: 8 }}>Drag a key to change time and value (Shift: time only, Alt: value only). Select a key and drag its two handles to shape the easing into the next key.</div>}
      </div>
      <div className="tl-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      </div>
    </div>
  );
}
