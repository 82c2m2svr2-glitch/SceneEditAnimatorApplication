import { lerpColor } from './color';
import { DEG, lerp } from './math';
import type { ParticleConfig } from './types';

export interface Particle {
  x: number;
  y: number;
  size: number;
  rotation: number;
  color: string;
  alpha: number;
  /** Velocity direction, for streak shapes. */
  vx: number;
  vy: number;
}

function hash(seed: number, k: number, salt: number): number {
  let h = (seed * 374761393 + k * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Stateless, deterministic particle simulation: the particle set at time `t` (seconds) is a pure
 * function of the config, so scrubbing and export always match playback.
 */
export function simulateParticles(c: ParticleConfig, t: number): Particle[] {
  const out: Particle[] = [];
  if (c.rate <= 0 || c.life <= 0) return out;
  const maxLife = c.life * (1 + c.lifeJitter);
  const first = Math.max(Math.ceil((t - maxLife) * c.rate), Math.floor(-c.prewarm * c.rate));
  const last = Math.floor(t * c.rate);
  const start = Math.max(first, last - c.maxParticles + 1);
  for (let k = start; k <= last; k++) {
    const born = k / c.rate;
    const age = t - born;
    const life = c.life * (1 + (hash(c.seed, k, 1) * 2 - 1) * c.lifeJitter);
    if (age < 0 || age > life) continue;
    const u = age / life;
    const ang = (c.angle + (hash(c.seed, k, 2) * 2 - 1) * c.spread) * DEG;
    const speed = c.speed * (1 + (hash(c.seed, k, 3) * 2 - 1) * c.speedJitter);
    const vx0 = Math.cos(ang) * speed;
    const vy0 = Math.sin(ang) * speed;
    const x0 = (hash(c.seed, k, 4) - 0.5) * c.width;
    const y0 = (hash(c.seed, k, 5) - 0.5) * c.height;
    let x: number;
    let y: number;
    let vx: number;
    let vy: number;
    if (c.drag > 1e-4) {
      const e = Math.exp(-c.drag * age);
      const f = (1 - e) / c.drag;
      x = x0 + (vx0 - c.gravityX / c.drag) * f + (c.gravityX * age) / c.drag;
      y = y0 + (vy0 - c.gravityY / c.drag) * f + (c.gravityY * age) / c.drag;
      vx = (vx0 - c.gravityX / c.drag) * e + c.gravityX / c.drag;
      vy = (vy0 - c.gravityY / c.drag) * e + c.gravityY / c.drag;
    } else {
      x = x0 + vx0 * age + 0.5 * c.gravityX * age * age;
      y = y0 + vy0 * age + 0.5 * c.gravityY * age * age;
      vx = vx0 + c.gravityX * age;
      vy = vy0 + c.gravityY * age;
    }
    const sizeMul = 1 + (hash(c.seed, k, 6) * 2 - 1) * c.sizeJitter;
    out.push({
      x, y, vx, vy,
      size: Math.max(0, lerp(c.sizeStart, c.sizeEnd, u) * sizeMul),
      rotation: hash(c.seed, k, 7) * 360 + c.spin * age,
      color: lerpColor(c.colorStart, c.colorEnd, u),
      alpha: Math.max(0, Math.min(1, lerp(c.alphaStart, c.alphaEnd, u))),
    });
  }
  return out;
}

export const PARTICLE_PRESETS: Record<string, Partial<ParticleConfig>> = {
  sparks: {},
  rain: {
    rate: 220, life: 1.1, lifeJitter: 0.2, width: 2400, height: 0, speed: 1500, speedJitter: 0.15, angle: 100, spread: 2,
    gravityY: 0, drag: 0, sizeStart: 3, sizeEnd: 3, sizeJitter: 0.3, colorStart: '#bcd7ff', colorEnd: '#bcd7ff',
    alphaStart: 0.6, alphaEnd: 0.4, shape: 'streak', prewarm: 2, maxParticles: 1200,
  },
  snow: {
    rate: 60, life: 7, lifeJitter: 0.3, width: 2400, height: 0, speed: 130, speedJitter: 0.5, angle: 90, spread: 25,
    gravityY: 0, drag: 0, sizeStart: 9, sizeEnd: 7, sizeJitter: 0.6, spin: 40, colorStart: '#ffffff', colorEnd: '#ffffff',
    alphaStart: 0.95, alphaEnd: 0.7, shape: 'flake', prewarm: 7, maxParticles: 900,
  },
  smoke: {
    rate: 18, life: 3.5, lifeJitter: 0.3, width: 30, height: 0, speed: 90, speedJitter: 0.4, angle: -90, spread: 18,
    gravityY: -30, drag: 0.4, sizeStart: 30, sizeEnd: 140, sizeJitter: 0.3, colorStart: '#9aa0a8', colorEnd: '#4a4f57',
    alphaStart: 0.45, alphaEnd: 0, shape: 'circle', prewarm: 3,
  },
  fire: {
    rate: 70, life: 1.0, lifeJitter: 0.4, width: 70, height: 0, speed: 220, speedJitter: 0.4, angle: -90, spread: 16,
    gravityY: -200, drag: 0.6, sizeStart: 46, sizeEnd: 4, sizeJitter: 0.4, colorStart: '#ffe066', colorEnd: '#e63946',
    alphaStart: 0.9, alphaEnd: 0, shape: 'circle', prewarm: 1,
  },
  confetti: {
    rate: 90, life: 3.2, lifeJitter: 0.2, width: 1600, height: 0, speed: 260, speedJitter: 0.6, angle: 90, spread: 40,
    gravityY: 220, drag: 0.8, sizeStart: 16, sizeEnd: 16, sizeJitter: 0.5, spin: 360, colorStart: '#ff5d8f', colorEnd: '#4cc9f0',
    alphaStart: 1, alphaEnd: 1, shape: 'square', prewarm: 3,
  },
  stars: {
    rate: 14, life: 2.2, lifeJitter: 0.5, width: 1920, height: 700, speed: 0, speedJitter: 0, angle: 0, spread: 0,
    gravityY: 0, drag: 0, sizeStart: 2, sizeEnd: 16, sizeJitter: 0.6, colorStart: '#fff6c9', colorEnd: '#ffffff',
    alphaStart: 1, alphaEnd: 0, shape: 'star', prewarm: 2,
  },
  dust: {
    rate: 26, life: 5, lifeJitter: 0.4, width: 1920, height: 1080, speed: 26, speedJitter: 0.8, angle: -60, spread: 180,
    gravityY: -6, drag: 0.1, sizeStart: 5, sizeEnd: 5, sizeJitter: 0.7, colorStart: '#fff3d6', colorEnd: '#fff3d6',
    alphaStart: 0.5, alphaEnd: 0, shape: 'circle', prewarm: 5,
  },
  bubbles: {
    rate: 10, life: 5, lifeJitter: 0.3, width: 900, height: 0, speed: 130, speedJitter: 0.4, angle: -90, spread: 12,
    gravityY: -20, drag: 0.1, sizeStart: 18, sizeEnd: 34, sizeJitter: 0.6, colorStart: '#c8f1ff', colorEnd: '#ffffff',
    alphaStart: 0.55, alphaEnd: 0, shape: 'circle', prewarm: 4,
  },
};
