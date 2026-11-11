import {
  ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Circle, Flag, ListVideo, Pause, Play, Repeat, SkipBack, SkipForward, Trash2,
  Video,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { exposureFrames } from '../core/drawing';
import { allIds } from '../core/tree';
import { CAMERA_ID, type ActionStrip, type AudioClip, type Ease, type ID, type Keyframe, type Project, type Scene } from '../core/types';
import { getPeaks } from '../audio/engine';
import {
  addMarker, clearTrack, currentValue, deleteKeys, jumpKey, moveKeys, patchAudioClip, patchScene, patchStrip, removeMarker,
  removeStrip, scene as currentScene, setDrawingFrame, setFrame, setKey, setKeysEase,
} from '../state/commands';
import { togglePlay } from '../state/playback';
import { doc, useDocRevision } from '../state/store';
import { ui, useUI, type KeyRef } from '../state/ui';
import { KeyDot, NumberField } from './widgets';

const RULER = 24;
const ROW = 22;
const PAD = 10;

type TRow =
  | { kind: 'head'; target: ID; label: string; frames: number[]; open: boolean; hasChildren: boolean }
  | { kind: 'prop'; target: ID; prop: string; keys: Keyframe[] }
  | { kind: 'strips'; target: ID; track: number; strips: ActionStrip[] }
  | { kind: 'drawing'; target: ID; frames: number[] }
  | { kind: 'audio'; track: number; clips: AudioClip[] };

function buildRows(scene: Scene, selection: ID[], expanded: Set<ID>, collapsed: Set<ID>): TRow[] {
  const rows: TRow[] = [];
  const pushTarget = (target: ID, label: string) => {
    const tracks = scene.anim[target] ?? {};
    const props = Object.keys(tracks).sort();
    const strips = scene.strips.filter((s) => s.targetId === target);
    const node = scene.nodes[target];
    const drawing = node?.type === 'drawing' ? exposureFrames(node.frames) : null;
    const frames = [...new Set(props.flatMap((p) => tracks[p].keys.map((k) => k.f)))].sort((a, b) => a - b);
    const hasChildren = props.length > 0;
    const open = hasChildren && !collapsed.has(target) && (expanded.has(target) || selection.includes(target));
    rows.push({ kind: 'head', target, label, frames, open, hasChildren });
    if (drawing) rows.push({ kind: 'drawing', target, frames: drawing });
    const trackCount = strips.length ? Math.max(...strips.map((s) => s.track)) + 1 : 0;
    for (let t = 0; t < trackCount; t++) rows.push({ kind: 'strips', target, track: t, strips: strips.filter((s) => s.track === t) });
    if (open) for (const prop of props) rows.push({ kind: 'prop', target, prop, keys: tracks[prop].keys });
  };
  pushTarget(CAMERA_ID, 'Camera');
  for (const id of allIds(scene)) {
    const n = scene.nodes[id];
    const relevant = !!scene.anim[id] || selection.includes(id) || scene.strips.some((s) => s.targetId === id) || (n.type === 'drawing' && Object.keys(n.frames).length > 0);
    if (relevant) pushTarget(id, n.name);
  }
  const audioTracks = scene.audio.length ? Math.max(...scene.audio.map((a) => a.track)) + 1 : 0;
  for (let t = 0; t < audioTracks; t++) rows.push({ kind: 'audio', track: t, clips: scene.audio.filter((a) => a.track === t) });
  return rows;
}

const EASES: { label: string; value: Ease }[] = [
  { label: 'Ease in-out', value: 'easeInOut' }, { label: 'Linear', value: 'linear' }, { label: 'Ease in', value: 'easeIn' },
  { label: 'Ease out', value: 'easeOut' }, { label: 'Hold (step)', value: 'step' }, { label: 'Overshoot', value: [0.34, 1.56, 0.64, 1] },
  { label: 'Anticipate', value: [0.68, -0.6, 0.32, 1.6] }, { label: 'Snap', value: [0.1, 0.9, 0.2, 1] },
];

type Drag =
  | { kind: 'scrub' }
  | { kind: 'keys'; startX: number; applied: number; began: boolean }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'strip'; id: ID; mode: 'move' | 'resize'; startX: number; start: number; duration: number; began: boolean }
  | { kind: 'audio'; id: ID; startX: number; start: number; began: boolean }
  | { kind: 'exposure'; target: ID; from: number; startX: number; cur: number };

export function Timeline() {
  useDocRevision();
  const frame = useUI((s) => s.frame);
  const playing = useUI((s) => s.playing);
  const selection = useUI((s) => s.selection);
  const selectedKeys = useUI((s) => s.selectedKeys);
  const selectedStrip = useUI((s) => s.selectedStrip);
  const selectedAudio = useUI((s) => s.selectedAudio);
  const zoom = useUI((s) => s.tlZoom);
  const sceneId = useUI((s) => s.sceneId);
  const loop = useUI((s) => s.loop);
  const playAll = useUI((s) => s.playAll);
  const autoKey = useUI((s) => s.autoKey);
  const set = useUI((s) => s.set);
  const repaint = useUI((s) => s.repaint);
  const [expanded, setExpanded] = useState<Set<ID>>(new Set([CAMERA_ID]));
  const [collapsed, setCollapsed] = useState<Set<ID>>(new Set());
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 600, h: 180 });
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);

  const p = doc.project as Project;
  const scene = p.scenes.find((s) => s.id === sceneId) ?? p.scenes[0];
  const rows = useMemo(() => buildRows(scene, selection, expanded, collapsed), [scene, selection, expanded, collapsed]);

  const fx = (f: number) => f * zoom - scroll.x + PAD;
  const xf = (x: number) => (x - PAD + scroll.x) / zoom;
  const rowY = (i: number) => RULER + i * ROW - scroll.y;

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Keep the playhead in view while playing.
  useEffect(() => {
    if (!playing) return;
    const x = frame * zoom - scroll.x + PAD;
    if (x > size.w - 30 || x < PAD) setScroll((s) => ({ ...s, x: Math.max(0, frame * zoom - 40) }));
  }, [frame, playing, zoom, scroll.x, size.w]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size;
    if (w < 2 || h < 2) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#14151a';
    g.fillRect(0, 0, w, h);
    const X = (f: number) => f * zoom - scroll.x + PAD;
    const isSel = (target: ID, prop: string, f: number) => selectedKeys.some((k) => k.target === target && k.prop === prop && Math.abs(k.f - f) < 1e-6);
    const diamond = (x: number, y: number, r: number, fill: string, stroke?: string) => {
      g.beginPath();
      g.moveTo(x, y - r);
      g.lineTo(x + r, y);
      g.lineTo(x, y + r);
      g.lineTo(x - r, y);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = 1.5;
        g.stroke();
      }
    };

    // Rows
    rows.forEach((row, i) => {
      const y = RULER + i * ROW - scroll.y;
      if (y + ROW < RULER || y > h) return;
      g.fillStyle = row.kind === 'head' ? '#1b1d24' : i % 2 ? '#15161b' : '#17181e';
      g.fillRect(0, y, w, ROW);
      const cy = y + ROW / 2;
      if (row.kind === 'head') {
        for (const f of row.frames) diamond(X(f), cy, 3.5, '#8a8fa0');
      } else if (row.kind === 'prop') {
        if (row.keys.length > 1) {
          g.strokeStyle = 'rgba(255,209,102,0.28)';
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(X(row.keys[0].f), cy);
          g.lineTo(X(row.keys[row.keys.length - 1].f), cy);
          g.stroke();
        }
        for (const k of row.keys) {
          const sel = isSel(row.target, row.prop, k.f);
          if (k.e === 'step') {
            g.fillStyle = sel ? '#ffffff' : '#ffd166';
            g.fillRect(X(k.f) - 4, cy - 4, 8, 8);
          } else diamond(X(k.f), cy, sel ? 5.5 : 4.5, sel ? '#ffffff' : '#ffd166', sel ? '#7c5cff' : undefined);
        }
      } else if (row.kind === 'strips') {
        for (const s of row.strips) {
          const x0 = X(s.start);
          const x1 = X(s.start + s.duration);
          const sel = s.id === selectedStrip;
          g.fillStyle = s.muted ? 'rgba(124,92,255,0.18)' : sel ? 'rgba(124,92,255,0.75)' : 'rgba(124,92,255,0.45)';
          g.beginPath();
          g.roundRect(x0, y + 2, Math.max(4, x1 - x0), ROW - 4, 4);
          g.fill();
          if (sel) {
            g.strokeStyle = '#c9bdff';
            g.lineWidth = 1;
            g.stroke();
          }
          // Blend ramps.
          g.fillStyle = 'rgba(255,255,255,0.16)';
          if (s.blendIn > 0) {
            g.beginPath();
            g.moveTo(x0, y + ROW - 2);
            g.lineTo(X(s.start + s.blendIn), y + 2);
            g.lineTo(x0, y + 2);
            g.fill();
          }
          const clip = p.actions[s.actionId];
          // Loop boundaries.
          if (clip?.loop) {
            const one = (clip.duration * (p.fps / clip.fps)) / s.speed;
            g.strokeStyle = 'rgba(255,255,255,0.25)';
            g.lineWidth = 1;
            for (let t = one; t < s.duration - 0.01; t += one) {
              g.beginPath();
              g.moveTo(X(s.start + t), y + 4);
              g.lineTo(X(s.start + t), y + ROW - 4);
              g.stroke();
            }
          }
          g.save();
          g.beginPath();
          g.rect(x0, y, x1 - x0 - 2, ROW);
          g.clip();
          g.fillStyle = '#fff';
          g.font = '11px Inter, system-ui, sans-serif';
          g.textBaseline = 'middle';
          g.fillText(clip?.name ?? 'Missing action', x0 + 6, cy);
          g.restore();
        }
      } else if (row.kind === 'drawing') {
        row.frames.forEach((f, k) => {
          const end = row.frames[k + 1] ?? scene.duration;
          g.fillStyle = 'rgba(34,211,238,0.22)';
          g.fillRect(X(f), y + 4, Math.max(2, (end - f) * zoom - 1), ROW - 8);
          g.fillStyle = '#22d3ee';
          g.fillRect(X(f), y + 4, Math.max(2, Math.min(zoom - 1, 8)), ROW - 8);
        });
      } else {
        for (const c of row.clips) {
          const x0 = X(c.start);
          const lenF = c.length * p.fps;
          const wpx = Math.max(4, lenF * zoom);
          const sel = c.id === selectedAudio;
          g.fillStyle = c.muted ? 'rgba(6,214,160,0.12)' : sel ? 'rgba(6,214,160,0.5)' : 'rgba(6,214,160,0.28)';
          g.beginPath();
          g.roundRect(x0, y + 2, wpx, ROW - 4, 4);
          g.fill();
          const peaks = getPeaks(c.assetId);
          const asset = p.assets[c.assetId];
          if (peaks && asset?.duration) {
            g.strokeStyle = 'rgba(190,255,235,0.85)';
            g.lineWidth = 1;
            g.beginPath();
            const n = peaks.length / 2;
            for (let px = Math.max(0, -x0); px < Math.min(wpx, w - x0); px++) {
              const t = c.offset + (px / wpx) * c.length;
              const bi = Math.min(n - 1, Math.max(0, Math.floor((t / asset.duration) * n)));
              const amp = Math.max(Math.abs(peaks[bi * 2]), Math.abs(peaks[bi * 2 + 1])) * c.volume;
              const hgt = Math.min(1, amp) * (ROW / 2 - 3);
              g.moveTo(x0 + px + 0.5, cy - hgt);
              g.lineTo(x0 + px + 0.5, cy + hgt + 0.5);
            }
            g.stroke();
          }
          g.save();
          g.beginPath();
          g.rect(x0, y, wpx - 2, ROW);
          g.clip();
          g.fillStyle = '#eafff8';
          g.font = '10px Inter, system-ui, sans-serif';
          g.textBaseline = 'top';
          g.fillText(c.name, x0 + 5, y + 3);
          g.restore();
        }
      }
    });

    // Beyond the end of the scene.
    const xEnd = X(scene.duration);
    if (xEnd < w) {
      g.fillStyle = 'rgba(0,0,0,0.42)';
      g.fillRect(Math.max(0, xEnd), RULER, w, h);
    }

    // Ruler
    g.fillStyle = '#1b1d24';
    g.fillRect(0, 0, w, RULER);
    g.strokeStyle = '#2a2d37';
    g.beginPath();
    g.moveTo(0, RULER + 0.5);
    g.lineTo(w, RULER + 0.5);
    g.stroke();
    let step = 1;
    for (const s of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) {
      step = s;
      if (s * zoom >= 46) break;
    }
    const minor = step >= 10 ? step / 5 : step >= 2 ? 1 : 0;
    const f0 = Math.max(0, Math.floor((scroll.x - PAD) / zoom / step) * step);
    g.font = '10px Inter, system-ui, sans-serif';
    g.textBaseline = 'top';
    for (let f = f0; X(f) < w; f += step) {
      const x = Math.round(X(f)) + 0.5;
      g.strokeStyle = '#4a4f5e';
      g.beginPath();
      g.moveTo(x, RULER - 9);
      g.lineTo(x, RULER);
      g.stroke();
      g.fillStyle = f % p.fps === 0 ? '#d8dae3' : '#8a8fa0';
      g.fillText(f % p.fps === 0 && f > 0 ? `${f}  ${f / p.fps}s` : String(f), x + 3, 3);
      if (minor) {
        g.strokeStyle = '#353945';
        for (let m = f + minor; m < f + step; m += minor) {
          const mx = Math.round(X(m)) + 0.5;
          g.beginPath();
          g.moveTo(mx, RULER - 4);
          g.lineTo(mx, RULER);
          g.stroke();
        }
      }
    }
    for (const m of scene.markers) {
      const x = X(m.frame);
      g.fillStyle = m.color ?? '#22d3ee';
      g.beginPath();
      g.moveTo(x, RULER);
      g.lineTo(x - 5, RULER - 8);
      g.lineTo(x + 5, RULER - 8);
      g.fill();
      g.fillText(m.name, x + 7, RULER - 12);
      g.globalAlpha = 0.25;
      g.fillRect(x, RULER, 1, h);
      g.globalAlpha = 1;
    }

    // Playhead
    const px = Math.round(X(frame)) + 0.5;
    g.strokeStyle = '#ff4d6d';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, h);
    g.stroke();
    g.fillStyle = '#ff4d6d';
    g.beginPath();
    g.roundRect(px - 6, 0, 12, 12, 3);
    g.fill();

    if (box) {
      g.fillStyle = 'rgba(76,201,240,0.12)';
      g.strokeStyle = '#4cc9f0';
      g.beginPath();
      g.rect(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      g.fill();
      g.stroke();
    }
  }, [rows, size, scroll, zoom, frame, selectedKeys, selectedStrip, selectedAudio, scene, p, box, repaint]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const rowAt = (y: number): { row: TRow; index: number } | null => {
    const i = Math.floor((y - RULER + scroll.y) / ROW);
    return y >= RULER && rows[i] ? { row: rows[i], index: i } : null;
  };
  const keysAt = (row: TRow, x: number): KeyRef[] => {
    const near = (f: number) => Math.abs(fx(f) - x) <= 6;
    if (row.kind === 'prop') return row.keys.filter((k) => near(k.f)).slice(0, 1).map((k) => ({ target: row.target, prop: row.prop, f: k.f }));
    if (row.kind === 'head') {
      const f = row.frames.find(near);
      if (f === undefined) return [];
      const tracks = currentScene().anim[row.target] ?? {};
      return Object.keys(tracks).filter((prop) => tracks[prop].keys.some((k) => Math.abs(k.f - f) < 1e-6)).map((prop) => ({ target: row.target, prop, f }));
    }
    return [];
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = local(e);
    const hit = rowAt(y);
    if (!hit) {
      dragRef.current = { kind: 'scrub' };
      setFrame(Math.round(xf(x)));
      return;
    }
    const row = hit.row;
    if (row.kind === 'strips') {
      const s = row.strips.find((st) => x >= fx(st.start) && x <= fx(st.start + st.duration));
      if (s) {
        set({ selectedStrip: s.id, selectedAudio: null, selectedKeys: [] });
        const edge = fx(s.start + s.duration) - x < 7;
        dragRef.current = { kind: 'strip', id: s.id, mode: edge ? 'resize' : 'move', startX: x, start: s.start, duration: s.duration, began: false };
        return;
      }
    } else if (row.kind === 'audio') {
      const c = row.clips.find((a) => x >= fx(a.start) && x <= fx(a.start + a.length * p.fps));
      if (c) {
        set({ selectedAudio: c.id, selectedStrip: null, selectedKeys: [] });
        dragRef.current = { kind: 'audio', id: c.id, startX: x, start: c.start, began: false };
        return;
      }
    } else if (row.kind === 'drawing') {
      const f = [...row.frames].reverse().find((ff) => fx(ff) <= x + 3);
      if (f !== undefined && x - fx(f) < Math.max(10, zoom)) {
        dragRef.current = { kind: 'exposure', target: row.target, from: f, startX: x, cur: f };
        setFrame(f);
        return;
      }
    } else {
      const hits = keysAt(row, x);
      if (hits.length) {
        const already = hits.every((h) => selectedKeys.some((k) => k.target === h.target && k.prop === h.prop && Math.abs(k.f - h.f) < 1e-6));
        if (e.shiftKey) {
          set({ selectedKeys: already ? selectedKeys.filter((k) => !hits.some((h) => h.target === k.target && h.prop === k.prop && Math.abs(h.f - k.f) < 1e-6)) : [...selectedKeys, ...hits] });
        } else if (!already) set({ selectedKeys: hits, selectedStrip: null, selectedAudio: null });
        setFrame(hits[0].f);
        dragRef.current = { kind: 'keys', startX: x, applied: 0, began: false };
        return;
      }
    }
    setFrame(Math.round(xf(x)));
    if (!e.shiftKey) set({ selectedKeys: [], selectedStrip: null, selectedAudio: null });
    dragRef.current = { kind: 'box', x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) {
      const { x, y } = local(e);
      const hit = rowAt(y);
      let cursor = 'default';
      if (hit?.row.kind === 'strips') {
        const s = hit.row.strips.find((st) => x >= fx(st.start) && x <= fx(st.start + st.duration));
        if (s) cursor = fx(s.start + s.duration) - x < 7 ? 'ew-resize' : 'grab';
      }
      canvasRef.current!.style.cursor = cursor;
      return;
    }
    const { x, y } = local(e);
    if (d.kind === 'scrub') setFrame(Math.round(xf(x)));
    else if (d.kind === 'keys') {
      const delta = Math.round((x - d.startX) / zoom);
      if (delta !== d.applied) {
        if (!d.began) {
          doc.begin('Move keyframes');
          d.began = true;
        }
        moveKeys(ui().selectedKeys, delta - d.applied);
        d.applied = delta;
      }
    } else if (d.kind === 'box') {
      d.x1 = x;
      d.y1 = y;
      setBox({ x0: d.x0, y0: d.y0, x1: x, y1: y });
    } else if (d.kind === 'strip') {
      const delta = Math.round((x - d.startX) / zoom);
      if (!d.began && delta !== 0) {
        doc.begin('Edit action strip');
        d.began = true;
      }
      if (d.began) patchStrip(d.id, d.mode === 'move' ? { start: Math.max(0, d.start + delta) } : { duration: Math.max(1, d.duration + delta) });
    } else if (d.kind === 'audio') {
      const delta = Math.round((x - d.startX) / zoom);
      if (!d.began && delta !== 0) {
        doc.begin('Move audio');
        d.began = true;
      }
      if (d.began) patchAudioClip(d.id, { start: Math.max(0, d.start + delta) });
    } else if (d.kind === 'exposure') {
      d.cur = Math.max(0, d.from + Math.round((x - d.startX) / zoom));
    }
  };

  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if ((d.kind === 'keys' || d.kind === 'strip' || d.kind === 'audio') && d.began) doc.commit();
    if (d.kind === 'exposure' && d.cur !== d.from) {
      const n = currentScene().nodes[d.target];
      if (n?.type === 'drawing' && !n.frames[String(d.cur)]) {
        const strokes = n.frames[String(d.from)];
        doc.transact('Move drawing', () => {
          setDrawingFrame(d.target, d.from, null);
          setDrawingFrame(d.target, d.cur, strokes);
        });
        setFrame(d.cur);
      }
    }
    if (d.kind === 'box') {
      setBox(null);
      if (Math.abs(d.x1 - d.x0) < 4 && Math.abs(d.y1 - d.y0) < 4) return;
      const fa = xf(Math.min(d.x0, d.x1));
      const fb = xf(Math.max(d.x0, d.x1));
      const ya = Math.min(d.y0, d.y1);
      const yb = Math.max(d.y0, d.y1);
      const hits: KeyRef[] = [];
      rows.forEach((row, i) => {
        const y = rowY(i) + ROW / 2;
        if (row.kind !== 'prop' || y < ya || y > yb) return;
        for (const k of row.keys) if (k.f >= fa && k.f <= fb) hits.push({ target: row.target, prop: row.prop, f: k.f });
      });
      set({ selectedKeys: d.additive ? [...ui().selectedKeys, ...hits] : hits });
    }
  };

  const onDbl = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    const hit = rowAt(y);
    if (hit?.row.kind !== 'prop') return;
    const f = Math.max(0, Math.round(xf(x)));
    setFrame(f);
    const v = hit.row.target === CAMERA_ID ? undefined : currentValue(hit.row.target, hit.row.prop);
    if (v !== undefined) setKey(hit.row.target, hit.row.prop, f, v);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const { x } = local(e);
      const f = xf(x);
      const next = Math.max(1, Math.min(60, zoom * Math.exp(-e.deltaY * 0.002)));
      set({ tlZoom: next });
      setScroll((s) => ({ ...s, x: Math.max(0, f * next - (x - PAD)) }));
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      setScroll((s) => ({ ...s, x: Math.max(0, s.x + (e.deltaX || e.deltaY)) }));
    } else {
      const maxY = Math.max(0, rows.length * ROW - (size.h - RULER) + 8);
      setScroll((s) => ({ ...s, y: Math.max(0, Math.min(maxY, s.y + e.deltaY)) }));
    }
  };

  const toggleRow = (target: ID, open: boolean) => {
    const ex = new Set(expanded);
    const co = new Set(collapsed);
    if (open) {
      ex.delete(target);
      co.add(target);
    } else {
      ex.add(target);
      co.delete(target);
    }
    setExpanded(ex);
    setCollapsed(co);
  };

  const strip = scene.strips.find((s) => s.id === selectedStrip);
  const audio = scene.audio.find((a) => a.id === selectedAudio);
  const selEase = selectedKeys.length ? scene.anim[selectedKeys[0].target]?.[selectedKeys[0].prop]?.keys.find((k) => Math.abs(k.f - selectedKeys[0].f) < 1e-6)?.e : undefined;

  return (
    <>
      <div className="transport">
        <button className="icon-btn" title="First frame (Home)" onClick={() => setFrame(0)}><SkipBack size={15} /></button>
        <button className="icon-btn" title="Previous keyframe (,)" onClick={() => jumpKey(-1)}><ChevronsLeft size={15} /></button>
        <button className="icon-btn on" title="Play / pause (Space)" onClick={togglePlay}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
        <button className="icon-btn" title="Next keyframe (.)" onClick={() => jumpKey(1)}><ChevronsRight size={15} /></button>
        <button className="icon-btn" title="Last frame (End)" onClick={() => setFrame(scene.duration - 1)}><SkipForward size={15} /></button>
        <div className="frame-box"><NumberField value={frame} min={0} max={scene.duration - 1} precision={0} onChange={(v) => setFrame(Math.round(v))} title="Current frame" /></div>
        <span style={{ color: 'var(--faint)' }}>/</span>
        <div className="frame-box"><NumberField value={scene.duration} min={1} max={100000} precision={0} onChange={(v) => patchScene({ duration: Math.max(1, Math.round(v)) }, 'Scene length')} title="Scene length in frames" /></div>
        <span className="chip" title="Time at the playhead">{(frame / p.fps).toFixed(2)}s · {p.fps} fps</span>
        <button className={`icon-btn${loop ? ' on' : ''}`} title="Loop playback" onClick={() => set({ loop: !loop })}><Repeat size={14} /></button>
        <button className={`icon-btn${playAll ? ' on' : ''}`} title="Play all scenes in order" onClick={() => set({ playAll: !playAll })}><ListVideo size={14} /></button>
        <button className={`icon-btn${autoKey ? ' on' : ''}`} title="Auto-key: changes made after frame 0 create keyframes" onClick={() => set({ autoKey: !autoKey })} style={autoKey ? { color: '#ff4d6d', borderColor: 'rgba(255,77,109,0.5)', background: 'rgba(255,77,109,0.14)' } : undefined}>
          <Circle size={13} fill={autoKey ? '#ff4d6d' : 'none'} />
        </button>
        <button className="icon-btn" title="Add marker at the playhead (M)" onClick={() => addMarker(frame, `Marker ${scene.markers.length + 1}`)}><Flag size={14} /></button>
        {scene.markers.some((m) => m.frame === frame) && <button className="icon-btn" title="Remove marker here" onClick={() => scene.markers.filter((m) => m.frame === frame).forEach((m) => removeMarker(m.id))}><Trash2 size={13} /></button>}
        <div className="spacer" />
        {selectedKeys.length > 0 && (
          <>
            <span className="chip">{selectedKeys.length} key{selectedKeys.length > 1 ? 's' : ''}</span>
            <select
              title="Easing from the selected keys to the next key"
              value={EASES.findIndex((x) => JSON.stringify(x.value) === JSON.stringify(selEase ?? 'linear'))}
              onChange={(e) => setKeysEase(selectedKeys, EASES[Number(e.target.value)].value)}
            >
              <option value={-1} disabled>Custom curve</option>
              {EASES.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}
            </select>
            <button className="icon-btn" title="Delete selected keyframes (Delete)" onClick={() => deleteKeys(selectedKeys)}><Trash2 size={14} /></button>
          </>
        )}
        {strip && (
          <>
            <span className="chip">{p.actions[strip.actionId]?.name ?? 'Action'}</span>
            <div style={{ width: 84 }}><NumberField label="Speed" value={strip.speed} min={0.05} max={10} step={0.05} onChange={(v) => patchStrip(strip.id, { speed: v }, 'stripspeed')} /></div>
            <div style={{ width: 84 }}><NumberField label="Blend" value={strip.blendIn} min={0} max={240} precision={0} onChange={(v) => patchStrip(strip.id, { blendIn: v, blendOut: v }, 'stripblend')} /></div>
            <div style={{ width: 88 }}><NumberField label="Weight" value={strip.weight} min={0} max={1} step={0.02} onChange={(v) => patchStrip(strip.id, { weight: v }, 'stripweight')} /></div>
            <button className="icon-btn" title="Remove strip (Delete)" onClick={() => { removeStrip(strip.id); set({ selectedStrip: null }); }}><Trash2 size={14} /></button>
          </>
        )}
        {audio && (
          <>
            <span className="chip">{audio.name}</span>
            <div style={{ width: 96 }}><NumberField label="Volume" value={audio.volume} min={0} max={2} step={0.02} onChange={(v) => patchAudioClip(audio.id, { volume: v }, 'audiovol')} /></div>
            <button className={`btn${audio.muted ? ' primary' : ''}`} onClick={() => patchAudioClip(audio.id, { muted: !audio.muted })}>{audio.muted ? 'Muted' : 'Mute'}</button>
          </>
        )}
        <input type="range" min={1} max={40} step={0.5} value={zoom} onChange={(e) => set({ tlZoom: Number(e.target.value) })} title="Timeline zoom (Ctrl + wheel)" style={{ width: 90 }} />
      </div>
      <div className="tl">
        <div className="tl-labels">
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: RULER, background: 'var(--bg-2)', borderBottom: '1px solid var(--line)', zIndex: 2, display: 'flex', alignItems: 'center', padding: '0 8px', color: 'var(--faint)', fontSize: 11 }}>
            Tracks
          </div>
          {rows.map((row, i) => {
            const top = rowY(i);
            if (top < RULER - ROW || top > size.h) return null;
            const style = { top };
            if (row.kind === 'head') {
              const sel = selection.includes(row.target);
              return (
                <div key={`h${row.target}`} className={`tl-label head${sel ? ' sel' : ''}`} style={style} onClick={() => (row.target === CAMERA_ID ? ui().select([]) : ui().select([row.target]))}>
                  <span style={{ width: 14, display: 'grid', placeItems: 'center' }} onClick={(e) => { e.stopPropagation(); if (row.hasChildren) toggleRow(row.target, row.open); }}>
                    {row.hasChildren ? row.open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
                  </span>
                  {row.target === CAMERA_ID && <Video size={12} />}
                  <span className="t">{row.label}</span>
                  {row.hasChildren && <button className="icon-btn sm" title="Remove all animation from this layer" onClick={(e) => { e.stopPropagation(); clearTrack(row.target); }}><Trash2 size={11} /></button>}
                </div>
              );
            }
            if (row.kind === 'prop') {
              const st = row.keys.some((k) => Math.abs(k.f - frame) < 1e-6) ? 'on' : 'track';
              return (
                <div key={`p${row.target}${row.prop}`} className="tl-label sub" style={style}>
                  <span className="t">{row.prop}</span>
                  <KeyDot state={st} onClick={() => {
                    if (st === 'on') deleteKeys([{ target: row.target, prop: row.prop, f: frame }]);
                    else {
                      const v = row.target === CAMERA_ID ? undefined : currentValue(row.target, row.prop);
                      if (v !== undefined) setKey(row.target, row.prop, frame, v);
                    }
                  }} />
                  <button className="icon-btn sm" title="Remove this animation track" onClick={() => clearTrack(row.target, row.prop)}><Trash2 size={11} /></button>
                </div>
              );
            }
            if (row.kind === 'strips') return <div key={`s${row.target}${row.track}`} className="tl-label sub" style={style}><span className="t">Actions {row.track + 1}</span></div>;
            if (row.kind === 'drawing') return <div key={`d${row.target}`} className="tl-label sub" style={style}><span className="t">Drawings</span></div>;
            return <div key={`a${row.track}`} className="tl-label head" style={style}><span style={{ width: 14 }} /><span className="t">Audio {row.track + 1}</span></div>;
          })}
        </div>
        <div className="tl-canvas-wrap" ref={wrapRef}>
          <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDbl} onWheel={onWheel} />
        </div>
      </div>
    </>
  );
}
