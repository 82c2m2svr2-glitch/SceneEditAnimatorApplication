/**
 * The 3D side of DreamForge. Everything that touches three.js lives in this file, which is loaded
 * on demand the first time a project shows a 3D model.
 *
 * Models are drawn with an orthographic camera, flat cel shading and an ink outline into a
 * transparent WebGL canvas; the 2D renderer then composites that picture like any other layer.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { buildCharacter3D, poseTo3D, type Character3D, type EyeState, type Part3D, type TexLayer } from '../../core/character/model3d';
import { BONE_DEFS, BONE_NAMES, type BoneName, type CharacterSpec, type PartPath, type Viseme } from '../../core/character/spec';
import type { Asset } from '../../core/types';

export interface BonePose {
  /** Pose rotation in degrees, clockwise on screen. */
  rot: number;
  dx: number;
  dy: number;
  /** Stretch along the bone. */
  sx: number;
  /** Rest direction of the parent bone on screen, in degrees. */
  parentAngle: number;
}

export interface CharacterPose {
  /** How far the current 2D view is turned from the front, in degrees. */
  yaw: number;
  mouth: string;
  eyes: string;
  bones: Record<string, BonePose>;
}

export interface ModelState {
  rotX: number;
  rotY: number;
  rotZ: number;
  shadeSteps: number;
  shade: number;
  outline: number;
  outlineColor: string;
  lightAngle: number;
  clip: string | null;
  /** Clip time in seconds. */
  time: number;
  pose?: CharacterPose;
  /** Extra rotation per joint name, in degrees about X, Y and Z. */
  joints?: Record<string, [number, number, number]>;
}

export interface RenderedModel {
  canvas: HTMLCanvasElement;
  /** Region of `canvas` that holds the picture. */
  sx: number;
  sy: number;
  w: number;
  h: number;
}

export interface LoadedModel {
  clips: { name: string; duration: number }[];
  /** Names of every joint that can be posed. */
  joints: string[];
  render(state: ModelState, width: number, height: number): RenderedModel;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Shared renderer
// ---------------------------------------------------------------------------------------------

let renderer: THREE.WebGLRenderer | null = null;

function getRenderer(): THREE.WebGLRenderer {
  if (!renderer) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    renderer.setScissorTest(true);
  }
  return renderer;
}

/** True when this machine can draw 3D at all. */
export function supported(): boolean {
  try {
    getRenderer();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Cel shading
// ---------------------------------------------------------------------------------------------

/** Where each light band ends, as the cosine of the angle between a surface and the light. */
const BANDS: Record<number, number[]> = { 1: [], 2: [0.2], 3: [0, 0.45], 4: [-0.2, 0.2, 0.55] };

function gradientMap(steps: number, shade: number): THREE.DataTexture {
  const n = Math.min(4, Math.max(1, Math.round(steps)));
  const size = 64;
  const data = new Uint8Array(size * 4);
  // `shade` is how dark the shadow looks on screen; light maths is linear, hence the power.
  const dark = Math.pow(Math.min(1, Math.max(0, 1 - shade)), 2.2);
  for (let i = 0; i < size; i++) {
    // The shader looks the band up at (cosine + 1) / 2.
    const cosine = ((i + 0.5) / size) * 2 - 1;
    const band = BANDS[n].filter((edge) => cosine >= edge).length;
    const v = n === 1 ? 1 : dark + ((1 - dark) * band) / (n - 1);
    data.set([v * 255, v * 255, v * 255, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

interface Outline {
  mesh: THREE.Mesh;
  width: { value: number };
  /** Converts a thickness in model units into this mesh's own units. */
  factor: number;
}

/** A back-facing copy of a mesh, swollen along its normals: the classic cartoon ink line. */
function addOutline(mesh: THREE.Mesh, list: Outline[]): void {
  const width = { value: 0 };
  const material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = width;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float outlineWidth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * outlineWidth;');
  };
  const copy = mesh.clone(false);
  copy.material = material;
  copy.name = '';
  // The shell rides on the mesh itself, so it follows every pose, clip and hand-set turn.
  copy.position.set(0, 0, 0);
  copy.quaternion.identity();
  copy.scale.set(1, 1, 1);
  mesh.add(copy);
  mesh.updateWorldMatrix(true, false);
  const scale = mesh.getWorldScale(new THREE.Vector3());
  list.push({ mesh: copy, width, factor: 1 / (Math.max(1e-6, (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3)) });
}

type AnyMaterial = THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null; vertexColors?: boolean; alphaTest?: number };

function toToon(source: THREE.Material, gradient: THREE.Texture): THREE.MeshToonMaterial {
  const m = source as AnyMaterial;
  return new THREE.MeshToonMaterial({
    color: m.color ? m.color.clone() : new THREE.Color(0xbbbbbb),
    map: m.map ?? null,
    gradientMap: gradient,
    vertexColors: !!m.vertexColors,
    transparent: m.transparent,
    opacity: m.opacity,
    alphaTest: m.alphaTest ?? 0,
    side: m.side,
  });
}

// ---------------------------------------------------------------------------------------------
// Stage: scene, camera and light shared by every kind of model
// ---------------------------------------------------------------------------------------------

class Stage {
  readonly scene = new THREE.Scene();
  readonly pivot = new THREE.Group();
  readonly camera: THREE.OrthographicCamera;
  readonly light = new THREE.DirectionalLight(0xffffff, Math.PI);
  readonly outlines: Outline[] = [];
  readonly toons: THREE.MeshToonMaterial[] = [];
  private gradient = gradientMap(2, 0.3);
  private gradientKey = '';

  /** `half` is half the height of the square region the camera sees, centred on the pivot. */
  constructor(readonly half: number) {
    this.camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, half * 12);
    this.camera.position.set(0, 0, half * 6);
    this.pivot.rotation.order = 'ZXY';
    this.scene.add(this.pivot, this.light);
  }

  /** Converts every mesh under the pivot to cel shading and gives it an outline. */
  stylise(): void {
    const meshes: THREE.Mesh[] = [];
    this.pivot.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    for (const mesh of meshes) {
      if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
      const plain = !!mesh.userData.noOutline;
      const convert = (m: THREE.Material) => {
        const toon = m instanceof THREE.MeshToonMaterial ? m : toToon(m, this.gradient);
        toon.gradientMap = this.gradient;
        this.toons.push(toon);
        return toon;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
      if (!plain) addOutline(mesh, this.outlines);
    }
  }

  apply(state: ModelState, extraYaw = 0): void {
    const rad = Math.PI / 180;
    this.pivot.rotation.set(state.rotX * rad, (state.rotY + extraYaw) * rad, state.rotZ * rad);
    const key = `${state.shadeSteps}|${state.shade}`;
    if (key !== this.gradientKey) {
      this.gradientKey = key;
      this.gradient.dispose();
      this.gradient = gradientMap(state.shadeSteps, state.shade);
      for (const t of this.toons) {
        t.gradientMap = this.gradient;
        t.needsUpdate = true;
      }
    }
    const a = state.lightAngle * rad;
    // From the viewer's side and above: faces stay lit, shadow falls under chins and on far sides.
    this.light.position.set(Math.sin(a), Math.cos(a), 1.2).multiplyScalar(this.half * 4);
    const thickness = (Math.max(0, state.outline) / 100) * this.half * 2;
    const ink = new THREE.Color(state.outlineColor);
    for (const o of this.outlines) {
      o.mesh.visible = thickness > 0;
      o.width.value = thickness * o.factor;
      (o.mesh.material as THREE.MeshBasicMaterial).color.copy(ink);
    }
  }

  render(width: number, height: number): RenderedModel {
    const r = getRenderer();
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const canvas = r.domElement;
    // The canvas only ever grows, so models of different sizes do not keep reallocating it.
    if (canvas.width < w || canvas.height < h) r.setSize(Math.max(canvas.width, w), Math.max(canvas.height, h), false);
    const aspect = w / h;
    this.camera.left = -this.half * aspect;
    this.camera.right = this.half * aspect;
    this.camera.updateProjectionMatrix();
    r.setViewport(0, 0, w, h);
    r.setScissor(0, 0, w, h);
    r.clear();
    r.render(this.scene, this.camera);
    // WebGL counts rows from the bottom; the 2D canvas API counts from the top.
    return { canvas, sx: 0, sy: canvas.height - h, w, h };
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        (m as AnyMaterial).map?.dispose();
        m.dispose();
      }
    });
    this.gradient.dispose();
  }
}

const RAD = Math.PI / 180;
const turn = new THREE.Quaternion();
const euler = new THREE.Euler();

/** Applies a hand-set rotation (degrees about X, Y, Z) on top of whatever pose a joint already has. */
function addTurn(joint: THREE.Object3D, angles: [number, number, number]): void {
  joint.quaternion.multiply(turn.setFromEuler(euler.set(angles[0] * RAD, angles[1] * RAD, angles[2] * RAD, 'XYZ')));
}

// ---------------------------------------------------------------------------------------------
// Imported files and built-in solids
// ---------------------------------------------------------------------------------------------

function bytesOf(dataUrl: string): ArrayBuffer {
  const comma = dataUrl.indexOf(',');
  const body = dataUrl.slice(comma + 1);
  if (!/;base64/i.test(dataUrl.slice(0, comma))) return new TextEncoder().encode(decodeURIComponent(body)).buffer as ArrayBuffer;
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function solid(shape: string, color: string): THREE.Object3D {
  const geometry =
    shape === 'sphere' ? new THREE.SphereGeometry(0.6, 40, 24)
    : shape === 'cylinder' ? new THREE.CylinderGeometry(0.45, 0.45, 1.1, 40)
    : shape === 'cone' ? new THREE.ConeGeometry(0.55, 1.15, 40)
    : shape === 'torus' ? new THREE.TorusGeometry(0.45, 0.19, 20, 48)
    : shape === 'capsule' ? new THREE.CapsuleGeometry(0.34, 0.62, 8, 28)
    : new THREE.BoxGeometry(0.9, 0.9, 0.9);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }));
  mesh.name = shape;
  return mesh;
}

/**
 * Puffs a cut-out picture up into a rounded solid, like a balloon in the picture's shape: thick in
 * the middle of wide areas, thinning to nothing at the edges, with the picture on both faces. From
 * the front it is the picture exactly; turned, it has real volume.
 */
async function relief(asset: Asset): Promise<THREE.Object3D> {
  const img = new Image();
  img.src = asset.dataUrl;
  try {
    await img.decode();
  } catch {
    throw new Error('The picture for this 3D object could not be read.');
  }
  const aspect = img.naturalWidth / img.naturalHeight;
  const cols = Math.max(8, Math.round(aspect >= 1 ? 112 : 112 * aspect));
  const rows = Math.max(8, Math.round(aspect >= 1 ? 112 / aspect : 112));
  const probe = document.createElement('canvas');
  probe.width = cols + 1;
  probe.height = rows + 1;
  const pctx = probe.getContext('2d', { willReadFrequently: true })!;
  pctx.drawImage(img, 0, 0, cols + 1, rows + 1);
  const alpha = pctx.getImageData(0, 0, cols + 1, rows + 1).data;
  const W = cols + 1;
  const H = rows + 1;
  const inside = new Uint8Array(W * H);
  let any = false;
  let all = true;
  for (let i = 0; i < W * H; i++) {
    inside[i] = alpha[i * 4 + 3] > 40 ? 1 : 0;
    any ||= !!inside[i];
    all &&= !!inside[i];
  }
  // A picture with no transparency is treated as one solid rectangle.
  if (!any || all) inside.fill(1);
  // Distance from every grid point to the nearest edge of the shape (two-pass chamfer).
  const dist = new Float32Array(W * H);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : inside[y * W + x] ? dist[y * W + x] : 0);
  for (let i = 0; i < W * H; i++) dist[i] = inside[i] ? 1e6 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside[y * W + x]) dist[y * W + x] = Math.min(dist[y * W + x], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) if (inside[y * W + x]) dist[y * W + x] = Math.min(dist[y * W + x], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
  let deepest = 1;
  for (let i = 0; i < W * H; i++) deepest = Math.max(deepest, dist[i]);

  const w = aspect >= 1 ? 1 : aspect;
  const h = aspect >= 1 ? 1 / aspect : 1;
  const thickness = Math.min(1, Math.max(0.05, asset.depth ?? 0.5)) * 0.5 * (deepest / Math.max(cols, rows)) * 2;
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  // Front and back share the picture; the back is a mirror image of the front surface.
  for (const side of [1, -1]) {
    const base = positions.length / 3;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.max(0, dist[y * W + x] - 1);
        const t = Math.min(1, d / Math.max(1, deepest - 1));
        // A circular profile: steep at the rim, flat across the middle.
        positions.push((x / cols - 0.5) * w, (0.5 - y / rows) * h, side * thickness * Math.sqrt(t * (2 - t)));
        uvs.push(x / cols, 1 - y / rows);
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const a = y * W + x;
        // Keep any cell the shape touches; the picture's own transparency trims the exact edge.
        if (!(inside[a] || inside[a + 1] || inside[a + W] || inside[a + W + 1])) continue;
        const q = [base + a, base + a + 1, base + a + W + 1, base + a + W];
        if (side > 0) index.push(q[0], q[3], q[1], q[1], q[3], q[2]);
        else index.push(q[0], q[1], q[3], q[1], q[2], q[3]);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const map = new THREE.Texture(img);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  map.needsUpdate = true;
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map, alphaTest: any && !all ? 0.5 : 0, side: THREE.DoubleSide }));
  mesh.name = 'object';
  // Generated art carries its own drawn outline; an ink shell would only add a jagged second one.
  mesh.userData.noOutline = true;
  return mesh;
}

async function loadFile(asset: Asset): Promise<LoadedModel> {
  let content: THREE.Object3D;
  let animations: THREE.AnimationClip[] = [];
  if (asset.format === 'relief') {
    content = await relief(asset);
  } else if (asset.format === 'solid') {
    content = solid(asset.solid?.shape ?? 'box', asset.solid?.color ?? '#7c5cff');
  } else if (asset.format === 'obj') {
    content = new OBJLoader().parse(new TextDecoder().decode(bytesOf(asset.dataUrl)));
  } else {
    let gltf;
    try {
      gltf = await new GLTFLoader().parseAsync(bytesOf(asset.dataUrl), '');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const message = /draco|meshopt|ktx/i.test(detail)
        ? 'This model uses a compression DreamForge cannot read yet. Re-export it as a plain .glb.'
        : asset.format === 'gltf'
          ? 'This .gltf refers to separate files. Export the model as a single .glb instead.'
          : `The model could not be read: ${detail}`;
      throw new Error(message, { cause: err });
    }
    content = gltf.scene;
    animations = gltf.animations;
  }

  // Centre the model on the pivot and size the camera so no rotation can clip it.
  const box = new THREE.Box3().setFromObject(content);
  if (box.isEmpty()) throw new Error('The model file contains no geometry.');
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const stage = new Stage(sphere.radius * 1.06);
  const holder = new THREE.Group();
  holder.position.copy(sphere.center).multiplyScalar(-1);
  holder.add(content);
  stage.pivot.add(holder);

  // Every named part of the file can be posed: skeleton bones first, then other named nodes.
  const named = new Map<string, THREE.Object3D>();
  for (const bonesOnly of [true, false]) {
    content.traverse((o) => {
      if (o.name && !named.has(o.name) && !!(o as THREE.Bone).isBone === bonesOnly && named.size < 400) named.set(o.name, o);
    });
  }
  stage.stylise();
  /** Joints turned by hand in the last frame, with the pose they had before the turn. */
  const turned = new Map<THREE.Object3D, THREE.Quaternion>();

  const mixer = animations.length ? new THREE.AnimationMixer(content) : null;
  let playing: { name: string; action: THREE.AnimationAction; duration: number } | null = null;
  return {
    clips: animations.map((a, i) => ({ name: a.name || `Clip ${i + 1}`, duration: a.duration })),
    joints: [...named.keys()],
    render(state, width, height) {
      // Undo last frame's hand-set turns first, so they never pile up and the clip sees its own pose.
      for (const [joint, base] of turned) joint.quaternion.copy(base);
      turned.clear();
      if (mixer) {
        const index = animations.findIndex((a, i) => (a.name || `Clip ${i + 1}`) === state.clip);
        if (index < 0 && playing) {
          mixer.stopAllAction();
          playing = null;
        } else if (index >= 0 && playing?.name !== state.clip) {
          mixer.stopAllAction();
          const action = mixer.clipAction(animations[index]);
          action.play();
          playing = { name: state.clip!, action, duration: animations[index].duration };
        }
        if (playing) {
          const d = playing.duration || 1;
          mixer.setTime(((state.time % d) + d) % d);
        }
      }
      for (const name in state.joints) {
        const joint = named.get(name);
        if (!joint) continue;
        turned.set(joint, joint.quaternion.clone());
        addTurn(joint, state.joints[name]);
      }
      stage.apply(state);
      return stage.render(width, height);
    },
    dispose() {
      mixer?.stopAllAction();
      stage.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Characters built from a turnaround
// ---------------------------------------------------------------------------------------------

function paintHalf(ctx: CanvasRenderingContext2D, part: Part3D, layer: TexLayer, x: number, eyes: PartPath[], mouth: PartPath[], withFace: boolean): void {
  const { texW: w, texH: h } = part;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, 0, w, h);
  ctx.clip();
  ctx.fillStyle = part.base;
  ctx.fillRect(x, 0, w, h);
  const m = layer.toUnit;
  ctx.setTransform(w * m[0], h * m[1], w * m[2], h * m[3], x + w * m[4], h * m[5]);
  ctx.lineJoin = ctx.lineCap = 'round';
  // First spread every colour outward a little, so the sides of the solid take the colour of the
  // nearest piece of artwork instead of the flat base colour.
  const bleed = 0.14 / Math.max(1e-6, Math.abs(m[0]));
  for (const item of layer.items) {
    for (const p of item.paths ?? []) {
      if (!p.fill) continue;
      ctx.strokeStyle = p.fill;
      ctx.lineWidth = bleed;
      ctx.stroke(new Path2D(p.d));
    }
  }
  const draw = (p: PartPath, ink: boolean) => {
    const path = new Path2D(p.d);
    if (p.fill) {
      ctx.fillStyle = p.fill;
      ctx.fill(path);
    }
    // Outlines of filled body shapes are left out: the 3D ink line replaces them.
    if (p.stroke && (ink || !p.fill)) {
      ctx.strokeStyle = p.stroke;
      ctx.lineWidth = p.strokeWidth || 1;
      ctx.stroke(path);
    }
  };
  for (const item of layer.items) {
    if (item.slot) {
      if (withFace) for (const p of item.slot === 'eyes' ? eyes : mouth) draw(p, true);
    } else for (const p of item.paths ?? []) draw(p, false);
  }
  ctx.restore();
}

function paintPart(part: Part3D, eyes: EyeState, mouth: Viseme): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = part.texW * 2;
  canvas.height = part.texH;
  const ctx = canvas.getContext('2d')!;
  const e = part.face?.eyes[eyes] ?? [];
  const mo = part.face?.mouth[mouth] ?? [];
  paintHalf(ctx, part, part.front, 0, e, mo, true);
  paintHalf(ctx, part, part.back, part.texW, e, mo, false);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function loadCharacter(asset: Asset): LoadedModel {
  const model: Character3D = buildCharacter3D(asset.spec as CharacterSpec);
  const half = model.height * 0.85;
  const stage = new Stage(half);
  // The camera looks at the middle of the body; the pivot (and so every turn) stays on that point.
  const body = new THREE.Group();
  body.position.set(0, -model.height / 2, 0);
  stage.pivot.add(body);

  const joints = {} as Record<BoneName, THREE.Object3D>;
  const rest = {} as Record<BoneName, THREE.Vector3>;
  for (const name of BONE_NAMES) {
    const joint = new THREE.Group();
    joint.name = name;
    const parent = name === 'root' ? null : BONE_DEFS[name].parent;
    const p = model.joints[name];
    const q = parent ? model.joints[parent] : [0, 0, 0];
    rest[name] = new THREE.Vector3(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    joint.position.copy(rest[name]);
    (parent ? joints[parent] : body).add(joint);
    joints[name] = joint;
  }

  let head: { part: Part3D; material: THREE.MeshToonMaterial; textures: Map<string, THREE.CanvasTexture> } | null = null;
  for (const part of model.parts) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(part.uvs, 2));
    const texture = paintPart(part, 'open', 'rest');
    const material = new THREE.MeshToonMaterial({ map: texture });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = part.bone;
    joints[part.bone].add(mesh);
    if (part.face) head = { part, material, textures: new Map([['open|rest', texture]]) };
  }
  stage.stylise();

  return {
    clips: [],
    joints: [...BONE_NAMES],
    render(state, width, height) {
      const pose = state.pose;
      for (const name of BONE_NAMES) {
        const joint = joints[name];
        const b = pose?.bones[name];
        const extra = state.joints?.[name];
        if (!b) {
          joint.quaternion.identity();
          joint.position.copy(rest[name]);
          joint.scale.setScalar(1);
          if (extra) addTurn(joint, extra);
          continue;
        }
        const t = poseTo3D(pose.yaw, b.rot, b.dx, b.dy, b.parentAngle);
        joint.quaternion.set(...t.quat);
        joint.position.set(rest[name].x + t.offset[0], rest[name].y + t.offset[1], rest[name].z + t.offset[2]);
        // A 2D bone stretches along its length; in 3D that is whichever axis the bone mostly follows.
        const d = model.directions[name];
        const axis = Math.abs(d[1]) >= Math.abs(d[0]) && Math.abs(d[1]) >= Math.abs(d[2]) ? 1 : Math.abs(d[0]) >= Math.abs(d[2]) ? 0 : 2;
        joint.scale.set(axis === 0 ? b.sx : 1, axis === 1 ? b.sx : 1, axis === 2 ? b.sx : 1);
        // Turns set by hand in 3D come on top of the pose from the 2D skeleton.
        if (extra) addTurn(joint, extra);
      }
      if (head) {
        const eyes = (['open', 'closed', 'happy'] as string[]).includes(pose?.eyes ?? '') ? (pose!.eyes as EyeState) : 'open';
        const mouth = pose && pose.mouth in head.part.face!.mouth ? (pose.mouth as Viseme) : 'rest';
        const key = `${eyes}|${mouth}`;
        let tex = head.textures.get(key);
        if (!tex) head.textures.set(key, (tex = paintPart(head.part, eyes, mouth)));
        if (head.material.map !== tex) {
          head.material.map = tex;
          head.material.needsUpdate = true;
        }
      }
      stage.apply(state, pose?.yaw ?? 0);
      return stage.render(width, height);
    },
    dispose() {
      if (head) for (const t of head.textures.values()) t.dispose();
      stage.dispose();
    },
  };
}

export async function loadModel(asset: Asset): Promise<LoadedModel> {
  return asset.kind === 'character3d' ? loadCharacter(asset) : loadFile(asset);
}
