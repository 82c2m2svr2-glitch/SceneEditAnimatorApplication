import { useEffect, useRef } from 'react';
import { evaluateScene, getEval } from '../core/anim';
import type { ID, Mat } from '../core/types';
import { acquireBuffer, releaseBuffer, renderScene } from '../render/draw';
import { drawBones, drawCameraFrame, drawGrid, drawSafeArea, drawStageFrame } from '../render/overlays';
import { scene as currentScene } from '../state/commands';
import { doc } from '../state/store';
import { ui, useUI } from '../state/ui';
import { getTool } from '../tools';
import { activeCamera, makeEnv, type Pointer, type Tool } from '../tools/env';
import { handTool, zoomAt } from '../tools/nav';

/** Fits the stage into the viewport with a margin. */
export function fitView(el: HTMLElement | null = document.querySelector<HTMLElement>('.viewport')): void {
  const p = doc.project;
  if (!p || !el) return;
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (w < 10 || h < 10) return;
  const zoom = Math.min((w - 80) / p.width, (h - 80) / p.height);
  useUI.setState({ zoom, panX: (w - p.width * zoom) / 2, panY: (h - p.height * zoom) / 2 });
}

export function Viewport() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let dragging: Tool | null = null;
    let lastTool = ui().tool;

    const draw = () => {
      raf = 0;
      const p = doc.project;
      if (!p) return;
      const u = ui();
      const dpr = window.devicePixelRatio || 1;
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      if (cw < 2 || ch < 2) return;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      if (u.zoom === 0) return fitView(wrap);
      if (u.tool !== lastTool) {
        getTool(lastTool).cancel?.();
        dragging = null;
        lastTool = u.tool;
      }
      const s = currentScene(p);
      const es = getEval(p, s, u.frame, u.setupMode);
      const camera = activeCamera(p, es);
      const outer: Mat = [dpr * u.zoom, 0, 0, dpr * u.zoom, dpr * u.panX, dpr * u.panY];
      const cameraView = u.viewMode === 'camera';

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0c0d11';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(outer[0], 0, 0, outer[3], outer[4], outer[5]);
      ctx.fillStyle = s.background;
      ctx.fillRect(0, 0, p.width, p.height);

      // Onion skin: neighbouring frames of drawing layers (or of the selection), tinted.
      if (u.onion.enabled && !u.playing) {
        const drawings = Object.values(s.nodes).filter((n) => n.type === 'drawing').map((n) => n.id);
        const only = new Set<ID>(u.selection.length ? u.selection : drawings);
        if (only.size) {
          const ghost = (frame: number, tint: string, alpha: number) => {
            if (frame < 0 || frame >= s.duration) return;
            const buf = acquireBuffer(canvas.width, canvas.height);
            renderScene(buf.ctx, p, evaluateScene(p, s, frame, { setup: u.setupMode }), { outer, camera, background: false, clip: false, only });
            buf.ctx.globalCompositeOperation = 'source-atop';
            buf.ctx.fillStyle = tint;
            buf.ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = alpha;
            ctx.drawImage(buf.canvas, 0, 0);
            ctx.globalAlpha = 1;
            releaseBuffer(buf);
          };
          for (let k = u.onion.before; k >= 1; k--) ghost(u.frame - k, '#ff4d6d', 0.42 / k);
          for (let k = u.onion.after; k >= 1; k--) ghost(u.frame + k, '#38b000', 0.42 / k);
        }
      }

      renderScene(ctx, p, es, { outer, camera, background: false, clip: cameraView });

      // Overlays, in CSS pixels.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const env = makeEnv();
      if (u.showGrid) drawGrid(ctx, env);
      drawStageFrame(ctx, env, cw, ch, cameraView);
      if (u.showSafeArea) drawSafeArea(ctx, env);
      if (!u.playing) {
        if (!cameraView) drawCameraFrame(ctx, env, u.tool === 'camera');
        if (u.showBones) drawBones(ctx, env, new Set(u.selection));
        getTool(u.tool).overlay?.(ctx, env);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const un1 = doc.subscribe(schedule);
    const un2 = useUI.subscribe(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(wrap);
    schedule();

    const pointer = (e: PointerEvent | MouseEvent): Pointer => {
      const r = canvas.getBoundingClientRect();
      const u = ui();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const pe = e as PointerEvent;
      return {
        screen: { x: sx, y: sy },
        stage: { x: (sx - u.panX) / u.zoom, y: (sy - u.panY) / u.zoom },
        shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, button: e.button,
        pressure: pe.pressure ?? 0.5, pen: pe.pointerType === 'pen',
      };
    };

    const onDown = (e: PointerEvent) => {
      if (!doc.project || e.button === 2) return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      canvas.setPointerCapture(e.pointerId);
      const tool = e.button === 1 ? handTool : getTool(ui().tool);
      dragging = tool;
      tool.down?.(pointer(e), makeEnv());
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!doc.project) return;
      const tool = dragging ?? getTool(ui().tool);
      tool.move?.(pointer(e), makeEnv(), dragging !== null);
    };
    const onUp = (e: PointerEvent) => {
      const tool = dragging;
      dragging = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (tool && doc.project) tool.up?.(pointer(e), makeEnv());
      schedule();
    };
    const onDbl = (e: MouseEvent) => {
      if (doc.project) getTool(ui().tool).dblclick?.(pointer(e), makeEnv());
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const u = ui();
      if (e.shiftKey) return useUI.setState({ panX: u.panX - (e.deltaY || e.deltaX) });
      if (e.altKey) return useUI.setState({ panY: u.panY - e.deltaY });
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      un1();
      un2();
      ro.disconnect();
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  const tool = useUI((s) => s.tool);
  return (
    <div className="viewport" ref={wrapRef}>
      <canvas ref={canvasRef} style={{ cursor: getTool(tool).cursor }} onContextMenu={(e) => e.preventDefault()} />
    </div>
  );
}
