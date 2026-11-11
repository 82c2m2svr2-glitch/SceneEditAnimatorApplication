import { boneTip } from '../core/anim';
import { apply, invert } from '../core/math';
import { CAMERA_ID, type ID } from '../core/types';
import type { ToolEnv } from '../tools/env';
import { viewMatrix } from './view';

type G = CanvasRenderingContext2D;

/** Dims everything outside the stage and outlines it. */
export function drawStageFrame(g: G, env: ToolEnv, width: number, height: number, letterbox: boolean): void {
  const a = env.stageToScreen({ x: 0, y: 0 });
  const b = env.stageToScreen({ x: env.project.width, y: env.project.height });
  g.save();
  g.fillStyle = letterbox ? 'rgba(10,11,14,0.92)' : 'rgba(10,11,14,0.45)';
  g.beginPath();
  g.rect(0, 0, width, height);
  g.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  g.fill('evenodd');
  g.strokeStyle = letterbox ? '#f72585' : 'rgba(255,255,255,0.35)';
  g.lineWidth = 1;
  g.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
  g.restore();
}

export function drawGrid(g: G, env: ToolEnv): void {
  const { width, height } = env.project;
  let step = 100;
  while (step * env.zoom < 24) step *= 2;
  while (step * env.zoom > 96) step /= 2;
  g.save();
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= width + 0.01; x += step) {
    const a = env.stageToScreen({ x, y: 0 });
    const b = env.stageToScreen({ x, y: height });
    g.moveTo(Math.round(a.x) + 0.5, a.y);
    g.lineTo(Math.round(b.x) + 0.5, b.y);
  }
  for (let y = 0; y <= height + 0.01; y += step) {
    const a = env.stageToScreen({ x: 0, y });
    const b = env.stageToScreen({ x: width, y });
    g.moveTo(a.x, Math.round(a.y) + 0.5);
    g.lineTo(b.x, Math.round(b.y) + 0.5);
  }
  g.stroke();
  g.restore();
}

export function drawSafeArea(g: G, env: ToolEnv): void {
  const { width, height } = env.project;
  g.save();
  g.setLineDash([6, 4]);
  g.lineWidth = 1;
  for (const [m, color] of [[0.05, 'rgba(255,209,102,0.6)'], [0.1, 'rgba(76,201,240,0.6)']] as const) {
    const a = env.stageToScreen({ x: width * m, y: height * m });
    const b = env.stageToScreen({ x: width * (1 - m), y: height * (1 - m) });
    g.strokeStyle = color;
    g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
  g.restore();
}

/** In stage view: the rectangle the animated scene camera sees at depth 0. */
export function drawCameraFrame(g: G, env: ToolEnv, always: boolean): void {
  const cam = env.es.camera;
  const { width, height } = env.project;
  const animatedCam = !!env.scene.anim[CAMERA_ID];
  const moved = cam.x !== width / 2 || cam.y !== height / 2 || cam.zoom !== 1 || cam.rotation !== 0 || cam.z !== 0;
  if (!always && !animatedCam && !moved) return;
  const view = viewMatrix(cam, width, height, 0);
  if (!view) return;
  const inv = invert(view);
  const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => env.worldToScreen(apply(inv, x, y), 0));
  g.save();
  g.strokeStyle = '#f72585';
  g.lineWidth = 1.5;
  g.beginPath();
  corners.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
  g.closePath();
  g.stroke();
  g.fillStyle = '#f72585';
  g.font = '11px Inter, system-ui, sans-serif';
  g.fillText('CAMERA', corners[0].x + 6, corners[0].y + 14);
  g.restore();
}

export function drawBones(g: G, env: ToolEnv, selection: Set<ID>): void {
  g.save();
  for (const en of env.es.nodes.values()) {
    if (en.node.type !== 'bone' || !en.visible) continue;
    const a = env.worldToScreen({ x: en.world[4], y: en.world[5] }, en.worldDepth);
    const sel = selection.has(en.node.id);
    const color = en.node.color ?? '#ffd166';
    if (en.length < 1) {
      g.beginPath();
      g.arc(a.x, a.y, sel ? 7 : 5, 0, Math.PI * 2);
      g.fillStyle = sel ? '#ffffff' : color;
      g.globalAlpha = sel ? 0.95 : 0.7;
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = '#14151a';
      g.lineWidth = 1;
      g.stroke();
      continue;
    }
    const b = env.worldToScreen(boneTip(en), en.worldDepth);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const w = Math.min(7, Math.max(2.5, len * 0.12));
    const sx = a.x + dx * 0.16;
    const sy = a.y + dy * 0.16;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(sx + nx * w, sy + ny * w);
    g.lineTo(b.x, b.y);
    g.lineTo(sx - nx * w, sy - ny * w);
    g.closePath();
    g.fillStyle = sel ? '#ffffff' : color;
    g.globalAlpha = sel ? 0.9 : 0.55;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = sel ? color : 'rgba(20,21,26,0.9)';
    g.lineWidth = sel ? 2 : 1;
    g.stroke();
    g.beginPath();
    g.arc(a.x, a.y, 2.5, 0, Math.PI * 2);
    g.fillStyle = '#14151a';
    g.fill();
  }
  // IK targets.
  for (const c of env.scene.constraints) {
    const t = env.es.nodes.get(c.targetId);
    if (!t) continue;
    const s = env.worldToScreen({ x: t.world[4], y: t.world[5] }, t.worldDepth);
    g.strokeStyle = c.enabled ? '#06d6a0' : 'rgba(6,214,160,0.4)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(s.x, s.y, 8, 0, Math.PI * 2);
    g.moveTo(s.x - 12, s.y);
    g.lineTo(s.x + 12, s.y);
    g.moveTo(s.x, s.y - 12);
    g.lineTo(s.x, s.y + 12);
    g.stroke();
  }
  g.restore();
}
