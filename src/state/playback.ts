import { project } from './store';
import { ui, useUI } from './ui';

type Hook = (frame: number) => void;
const startHooks = new Set<Hook>();
const stopHooks = new Set<Hook>();

/** Lets the audio engine follow transport without the transport knowing about audio. */
export function onPlaybackStart(fn: Hook): () => void {
  startHooks.add(fn);
  return () => startHooks.delete(fn);
}

export function onPlaybackStop(fn: Hook): () => void {
  stopHooks.add(fn);
  return () => stopHooks.delete(fn);
}

let raf = 0;
let t0 = 0;
let f0 = 0;

function sceneNow() {
  const p = project();
  const u = ui();
  return p.scenes.find((s) => s.id === u.sceneId) ?? p.scenes[0];
}

function restart(frame: number): void {
  t0 = performance.now();
  f0 = frame;
  for (const fn of stopHooks) fn(frame);
  for (const fn of startHooks) fn(frame);
}

function tick(): void {
  const u = ui();
  if (!u.playing) return;
  const p = project();
  const s = sceneNow();
  let frame = Math.floor(f0 + ((performance.now() - t0) / 1000) * p.fps);
  if (frame >= s.duration) {
    const i = p.scenes.findIndex((x) => x.id === s.id);
    if (u.playAll && (i < p.scenes.length - 1 || u.loop)) {
      const next = p.scenes[(i + 1) % p.scenes.length];
      useUI.setState({ sceneId: next.id, selection: [], selectedKeys: [] });
      frame = 0;
      restart(0);
    } else if (u.loop && !u.playAll) {
      frame = 0;
      restart(0);
    } else {
      useUI.setState({ frame: s.duration - 1 });
      return pause();
    }
  }
  if (frame !== u.frame) useUI.setState({ frame });
  raf = requestAnimationFrame(tick);
}

export function play(): void {
  const u = ui();
  if (u.playing) return;
  const s = sceneNow();
  const frame = u.frame >= s.duration - 1 ? 0 : u.frame;
  useUI.setState({ playing: true, frame });
  t0 = performance.now();
  f0 = frame;
  for (const fn of startHooks) fn(frame);
  raf = requestAnimationFrame(tick);
}

export function pause(): void {
  cancelAnimationFrame(raf);
  if (!ui().playing) return;
  useUI.setState({ playing: false });
  for (const fn of stopHooks) fn(ui().frame);
}

export function togglePlay(): void {
  if (ui().playing) pause();
  else play();
}
