import { CAMERA_ANIM_PROPS } from '../core/anim';
import { BONE_NAMES, VISEMES } from '../core/character/spec';
import { textToVisemes } from '../core/character/speech';
import { createGroup, createShape, createText } from '../core/factory';
import { ellipsePath, linePath, parseSvgPath, pathBounds, polygonPath, polylinePath, rectPath, starPath, transformPath } from '../core/path';
import { PARTICLE_PRESETS } from '../core/particles';
import { findByName, subtreeIds } from '../core/tree';
import {
  CAMERA_ID, VIEW_NAMES, type Camera, type Ease, type Effect, type ID, type KeyValue, type PathData, type Scene, type SceneNode,
  type Transition,
} from '../core/types';
import {
  addNode, addScene, clearTrack, currentValue, deleteKeys, deleteNodes, duplicateNodes, isAnimatable, moveNodes, patchNode,
  patchScene, removeStrip, reorder, scene, setCamera, setFrame, setKeys, setProps,
} from '../state/commands';
import { addHumanoid, addIKForBone, addParticlePreset, applyAction, bindSkin, builtins } from '../state/content';
import { doc, project } from '../state/store';
import { ui, useUI } from '../state/ui';
import { captureFrame } from './capture';
import { registerTool, type JsonSchema } from './registry';

const EASE: JsonSchema = { type: 'string', enum: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'step'], description: 'Interpolation from this key to the next. Default easeInOut.' };
const NODE_REF: JsonSchema = { type: 'string', description: 'Layer id or name. Use "Parent/Child" to address something inside a group or character, e.g. "Hero/upperArm.R".' };
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Resolves a layer reference (id, name, or Parent/Child path). Throws a message the model can act on. */
export function resolveNode(ref: string, s: Scene = scene()): SceneNode {
  if (s.nodes[ref]) return s.nodes[ref];
  const parts = ref.split('/').map((x) => x.trim()).filter(Boolean);
  let cur = null as SceneNode | null;
  for (const part of parts) {
    cur = s.nodes[part] ?? findByName(s, part, cur?.id);
    if (!cur) break;
  }
  if (cur) return cur;
  const names = s.roots.map((id) => s.nodes[id].name).slice(0, 30).join(', ');
  throw new Error(`No layer matches "${ref}". Top-level layers: ${names || '(none)'}. Call get_scene to see everything.`);
}

function resolveCharacter(ref: string): Extract<SceneNode, { type: 'character' }> {
  const s = scene();
  let n: SceneNode | undefined = resolveNode(ref, s);
  while (n && n.type !== 'character') n = n.parent ? s.nodes[n.parent] : undefined;
  if (!n || n.type !== 'character') throw new Error(`"${ref}" is not a character. Characters in this scene: ${Object.values(s.nodes).filter((x) => x.type === 'character').map((x) => x.name).join(', ') || '(none)'}`);
  return n;
}

function describeTree(s: Scene, id: ID, depth: number): unknown {
  const n = s.nodes[id];
  const base: Record<string, unknown> = { id: n.id, name: n.name, type: n.type, x: r1(n.x), y: r1(n.y) };
  if (n.rotation) base.rotation = r1(n.rotation);
  if (n.scaleX !== 1 || n.scaleY !== 1) base.scale = [n.scaleX, n.scaleY];
  if (n.depth) base.depth = n.depth;
  if (!n.visible) base.visible = false;
  if (s.anim[id]) base.animated = Object.keys(s.anim[id]);
  if (n.type === 'character') {
    base.views = n.views;
    base.currentView = n.currentView;
    base.facing = n.scaleX < 0 ? 'left' : 'right';
    base.bones = subtreeIds(s, id).map((b) => s.nodes[b]).filter((b) => b.type === 'bone').map((b) => b.name);
    base.actions = s.strips.filter((st) => st.targetId === id).map((st) => ({ action: project().actions[st.actionId]?.name, start: st.start, duration: st.duration }));
    return base;
  }
  if (n.type === 'text') base.text = n.text;
  if (n.type === 'shape') base.fill = typeof n.fill === 'string' ? n.fill : n.fill ? 'gradient' : null;
  if (n.children.length) base.children = depth > 0 ? n.children.map((c) => describeTree(s, c, depth - 1)) : `${n.children.length} children (use get_node)`;
  return base;
}

function coerce(value: unknown): KeyValue {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) return value as number[];
  throw new Error(`Unsupported value ${JSON.stringify(value)}; use a number, string, or true/false.`);
}

function shapePath(a: any): { path: PathData; cx: number; cy: number } {
  const w = a.width ?? 200;
  const h = a.height ?? a.width ?? 200;
  switch (a.kind) {
    case 'rect': return { path: rectPath(-w / 2, -h / 2, w, h, a.radius ?? 0), cx: a.x, cy: a.y };
    case 'ellipse': return { path: ellipsePath(0, 0, w / 2, h / 2), cx: a.x, cy: a.y };
    case 'polygon': {
      const p = polygonPath(0, 0, 0.5, Math.max(3, a.sides ?? 6));
      for (const q of p.contours[0].pts) { q.x *= w; q.y *= h; }
      return { path: p, cx: a.x, cy: a.y };
    }
    case 'star': {
      const p = starPath(0, 0, 0.5, 0.21, Math.max(3, a.sides ?? 5));
      for (const q of p.contours[0].pts) { q.x *= w; q.y *= h; }
      return { path: p, cx: a.x, cy: a.y };
    }
    case 'line': {
      if (!Array.isArray(a.points) || a.points.length < 2) throw new Error('kind "line" needs points: [[x1,y1],[x2,y2],...] in stage coordinates.');
      const pts = a.points.map((q: number[]) => ({ x: q[0], y: q[1] }));
      const xs = pts.map((q: { x: number }) => q.x);
      const ys = pts.map((q: { y: number }) => q.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const path = pts.length === 2 ? linePath(pts[0].x - cx, pts[0].y - cy, pts[1].x - cx, pts[1].y - cy) : polylinePath(pts.map((q: { x: number; y: number }) => ({ x: q.x - cx, y: q.y - cy })), false);
      return { path, cx, cy };
    }
    case 'path': {
      if (typeof a.path !== 'string') throw new Error('kind "path" needs path: an SVG path data string in stage coordinates.');
      const parsed = parseSvgPath(a.path);
      const b = pathBounds(parsed);
      if (!b) throw new Error('The SVG path is empty or invalid.');
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      return { path: transformPath(parsed, [1, 0, 0, 1, -cx, -cy]), cx: a.x ?? cx, cy: a.y ?? cy };
    }
    default: throw new Error(`Unknown shape kind "${a.kind}".`);
  }
}

let registered = false;

export function registerAllTools(): void {
  if (registered) return;
  registered = true;

  registerTool({
    name: 'get_scene',
    description: 'Describes the open project and the current scene: stage size, frame rate, playhead, camera, every layer with its id, type and position, each character with its bones and views, and the action library. Call this first.',
    parameters: { type: 'object', properties: {} },
    mutates: false,
    run: () => {
      const p = project();
      const s = scene();
      const u = ui();
      return {
        project: { name: p.name, width: p.width, height: p.height, fps: p.fps },
        scenes: p.scenes.map((x) => ({ name: x.name, frames: x.duration, current: x.id === s.id })),
        scene: { name: s.name, durationFrames: s.duration, background: s.background, playheadFrame: u.frame, camera: s.camera, cameraAnimated: Object.keys(s.anim[CAMERA_ID] ?? {}) },
        selection: u.selection.map((id) => s.nodes[id]?.name),
        layers: s.roots.map((id) => describeTree(s, id, 2)),
        note: 'Layers are listed back to front. Stage origin is the top-left corner, y grows downward.',
        actionLibrary: [...Object.values(p.actions).filter((a) => !a.id.startsWith('builtin_')), ...builtins()].map((a) => ({ name: a.name, frames: Math.round(a.duration * (p.fps / a.fps)), loops: a.loop, views: a.views.length ? a.views : 'any' })),
      };
    },
  });

  registerTool({
    name: 'get_node',
    description: 'Full details of one layer: properties, current animated values, keyframes per property, and children.',
    parameters: { type: 'object', properties: { node: NODE_REF }, required: ['node'] },
    mutates: false,
    run: ({ node }) => {
      const s = scene();
      const n = resolveNode(node, s);
      const tracks: Record<string, unknown> = {};
      for (const prop in s.anim[n.id] ?? {}) tracks[prop] = s.anim[n.id][prop].keys.slice(0, 60).map((k) => [k.f, k.v, k.e]);
      const { children, effects, ...rest } = n as SceneNode & Record<string, unknown>;
      const slim: Record<string, unknown> = { ...rest };
      for (const heavy of ['path', 'skin', 'mesh', 'frames', 'viewRest']) if (heavy in slim) slim[heavy] = '(omitted)';
      return {
        ...slim, effects,
        now: Object.fromEntries(['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity'].map((k) => [k, currentValue(n.id, k)])),
        keyframes: tracks,
        children: children.map((c) => ({ id: c, name: s.nodes[c].name, type: s.nodes[c].type, view: s.nodes[c].view })),
        note: n.type === 'bone' ? 'Bone x/y/rotation are the rest pose. Keyframes and "now" are pose offsets from rest.' : undefined,
      };
    },
  });

  registerTool({
    name: 'look',
    description: 'Returns a picture of the scene at a frame, as the camera sees it. Use it to check your work: composition, poses, overlaps.',
    parameters: { type: 'object', properties: { frame: { type: 'number', description: 'Frame to look at. Default: the playhead.' } } },
    mutates: false,
    run: ({ frame }) => ({ result: { frame: frame ?? ui().frame, note: 'Image attached.' }, image: captureFrame(896, frame ?? ui().frame) }),
  });

  registerTool({
    name: 'set_frame',
    description: 'Moves the playhead. Property edits without an explicit frame apply at the playhead.',
    parameters: { type: 'object', properties: { frame: { type: 'number' } }, required: ['frame'] },
    mutates: false,
    run: ({ frame }) => {
      setFrame(Math.round(frame));
      return { playheadFrame: ui().frame };
    },
  });

  registerTool({
    name: 'select',
    description: 'Selects layers in the editor so the user can see what you are working on.',
    parameters: { type: 'object', properties: { nodes: { type: 'array', items: NODE_REF } }, required: ['nodes'] },
    mutates: false,
    run: ({ nodes }) => {
      const ids = (nodes as string[]).map((r) => resolveNode(r).id);
      ui().select(ids);
      return { selected: ids.length };
    },
  });

  registerTool({
    name: 'create_shape',
    description: 'Adds a vector shape. x/y is the centre in stage pixels. For kind "path", give SVG path data in stage coordinates (use it for custom props, scenery, clouds, hills). For kind "line", give points.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'star', 'line', 'path'] },
        name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
        radius: { type: 'number', description: 'Corner radius for rect.' },
        sides: { type: 'integer', description: 'Polygon sides or star points.' },
        points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'For line: [[x,y],...]' },
        path: { type: 'string', description: 'For path: SVG path data, e.g. "M100 500 Q400 300 700 500 Z".' },
        fill: { type: 'string', description: 'CSS colour, or "none".' }, stroke: { type: 'string' }, strokeWidth: { type: 'number' },
        opacity: { type: 'number' }, rotation: { type: 'number' },
        depth: { type: 'number', description: 'Multiplane depth. Positive = further from camera (parallax background), negative = foreground.' },
        parent: NODE_REF,
        behind: { type: 'boolean', description: 'Place behind everything else in its parent instead of in front.' },
      },
      required: ['kind'],
    },
    mutates: true,
    summarize: (a) => `Add ${a.kind}${a.name ? ` "${a.name}"` : ''}`,
    run: (a) => {
      const p = project();
      const args = { x: p.width / 2, y: p.height / 2, ...a };
      const { path, cx, cy } = shapePath(args);
      const open = a.kind === 'line' || (a.kind === 'path' && path.contours.every((c) => !c.closed));
      const fill = a.fill === 'none' ? null : a.fill ?? (open ? null : '#7c5cff');
      const stroke = a.stroke === 'none' ? null : a.stroke ?? (open ? '#ffffff' : null);
      const n = createShape(a.name ?? a.kind[0].toUpperCase() + a.kind.slice(1), path, { fill, stroke, strokeWidth: a.strokeWidth ?? (stroke ? 4 : 0) });
      Object.assign(n, { x: cx, y: cy, opacity: a.opacity ?? 1, rotation: a.rotation ?? 0, depth: a.depth ?? 0 });
      const parent = a.parent ? resolveNode(a.parent).id : null;
      addNode(n, parent, a.behind ? 0 : undefined);
      return { id: n.id, name: scene().nodes[n.id].name };
    },
  });

  registerTool({
    name: 'create_text',
    description: 'Adds a text layer centred at x/y. Use \\n for line breaks.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, size: { type: 'number' }, fill: { type: 'string' },
        stroke: { type: 'string' }, strokeWidth: { type: 'number' }, weight: { type: 'integer' }, align: { type: 'string', enum: ['left', 'center', 'right'] },
        font: { type: 'string' }, name: { type: 'string' }, parent: NODE_REF, depth: { type: 'number' },
      },
      required: ['text'],
    },
    mutates: true,
    summarize: (a) => `Add text "${String(a.text).slice(0, 30)}"`,
    run: (a) => {
      const p = project();
      const n = createText(a.text, {
        x: a.x ?? p.width / 2, y: a.y ?? p.height / 2, size: a.size ?? 72, fill: a.fill ?? '#ffffff', stroke: a.stroke ?? null,
        strokeWidth: a.strokeWidth ?? 0, weight: a.weight ?? 700, align: a.align ?? 'center', depth: a.depth ?? 0,
      });
      if (a.font) n.font = a.font;
      if (a.name) n.name = a.name;
      addNode(n, a.parent ? resolveNode(a.parent).id : null);
      return { id: n.id, name: scene().nodes[n.id].name };
    },
  });

  registerTool({
    name: 'create_group',
    description: 'Creates a group, optionally moving existing layers into it (they keep their place on screen). Animate the group to move everything together.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, children: { type: 'array', items: NODE_REF }, parent: NODE_REF, depth: { type: 'number' } }, required: ['name'] },
    mutates: true,
    summarize: (a) => `Create group "${a.name}"`,
    run: (a) => {
      const g = createGroup(a.name, { x: a.x ?? 0, y: a.y ?? 0, depth: a.depth ?? 0 });
      addNode(g, a.parent ? resolveNode(a.parent).id : null);
      if (a.children?.length) moveNodes((a.children as string[]).map((r) => resolveNode(r).id), g.id);
      return { id: g.id, name: scene().nodes[g.id].name };
    },
  });

  registerTool({
    name: 'add_character',
    description: `Adds a fully rigged vector character with five views (${VIEW_NAMES.join(', ')}), a mouth with lip-sync shapes and blinkable eyes. x/y is where the feet stand. Bones: ${BONE_NAMES.join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number', description: 'Ground position of the feet.' }, height: { type: 'number', description: 'Height in pixels.' },
        skin: { type: 'string' }, hair: { type: 'string' }, shirt: { type: 'string' }, pants: { type: 'string' }, shoes: { type: 'string' }, eyes: { type: 'string' },
        hairStyle: { type: 'string', enum: ['short', 'long', 'spiky', 'bald'] }, sleeves: { type: 'string', enum: ['short', 'long'] },
        build: { type: 'number', description: '0.8 slim to 1.3 stocky.' }, headScale: { type: 'number', description: '1 realistic to 1.5 big cartoon head.' },
        view: { type: 'string', enum: [...VIEW_NAMES] }, facing: { type: 'string', enum: ['right', 'left'], description: 'Side views face right by default.' },
      },
      required: ['name'],
    },
    mutates: true,
    summarize: (a) => `Add character "${a.name}"`,
    run: (a) => {
      const p = project();
      const { x, y, view, facing, ...params } = a;
      const id = addHumanoid({ height: Math.round(p.height * 0.55), ...params }, { x: x ?? p.width / 2, y: y ?? Math.round(p.height * 0.86) });
      const patch: Record<string, unknown> = {};
      if (view) patch.currentView = view;
      if (facing === 'left') patch.scaleX = -1;
      if (Object.keys(patch).length) patchNode(id, patch, 'Set up character');
      return { id, name: scene().nodes[id].name, bones: BONE_NAMES };
    },
  });

  registerTool({
    name: 'add_particles',
    description: `Adds a particle effect. Presets: ${Object.keys(PARTICLE_PRESETS).join(', ')}.`,
    parameters: { type: 'object', properties: { preset: { type: 'string', enum: Object.keys(PARTICLE_PRESETS) }, x: { type: 'number' }, y: { type: 'number' }, depth: { type: 'number' } }, required: ['preset'] },
    mutates: true,
    summarize: (a) => `Add ${a.preset} particles`,
    run: (a) => {
      const id = addParticlePreset(a.preset);
      const patch: Record<string, unknown> = {};
      for (const k of ['x', 'y', 'depth']) if (typeof a[k] === 'number') patch[k] = a[k];
      if (Object.keys(patch).length) patchNode(id, patch, 'Place particles');
      return { id, name: scene().nodes[id].name };
    },
  });

  registerTool({
    name: 'set_properties',
    description: 'Sets properties on a layer. Animatable: x, y, rotation, scaleX, scaleY, opacity (0..1), depth, zOrder, visible, and for shapes/text fill, stroke, strokeWidth, size, text. With key=true a keyframe is written at the frame; with key=false the base value changes for the whole scene. Default: keys only if that property is already animated. Other properties (name, blend, locked, font, align) are set directly.',
    parameters: {
      type: 'object',
      properties: {
        node: NODE_REF,
        properties: { type: 'object', description: 'Property name -> value, e.g. {"x": 400, "opacity": 0.5, "fill": "#ff0000"}.' },
        frame: { type: 'number', description: 'Frame for the keyframe. Default: the playhead.' },
        key: { type: 'boolean' }, ease: EASE,
      },
      required: ['node', 'properties'],
    },
    mutates: true,
    summarize: (a) => `Set ${Object.keys(a.properties ?? {}).join(', ')} on ${a.node}`,
    run: (a) => {
      const n = resolveNode(a.node);
      const anim: Record<string, KeyValue> = {};
      const direct: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.properties as Record<string, unknown>)) {
        if (isAnimatable(n, k)) anim[k] = v === 'none' ? (null as unknown as KeyValue) : coerce(v);
        else if (k in n || ['name', 'blend', 'locked', 'font', 'align', 'weight', 'italic', 'tag'].includes(k)) direct[k] = v;
        else throw new Error(`"${k}" is not a property of a ${n.type} layer.`);
      }
      doc.transact('Set properties', () => {
        const nulls = Object.keys(anim).filter((k) => anim[k] === null);
        for (const k of nulls) {
          direct[k] = null;
          delete anim[k];
        }
        if (Object.keys(anim).length) setProps(n.id, anim, { frame: a.frame, key: a.key === undefined ? 'auto' : a.key, ease: a.ease as Ease | undefined });
        if (Object.keys(direct).length) patchNode(n.id, direct, 'Set properties');
      });
      return { ok: true, keyed: a.key === true };
    },
  });

  registerTool({
    name: 'set_keyframes',
    description: 'Writes many keyframes in one step. This is the main way to animate: give every key for the motion you want. For bones, values are pose OFFSETS from the rest pose (rotation in degrees, clockwise positive).',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: {
            type: 'object',
            properties: { node: NODE_REF, property: { type: 'string' }, frame: { type: 'number' }, value: { description: 'Number, colour string, or true/false.' }, ease: EASE },
            required: ['node', 'property', 'frame', 'value'],
          },
        },
      },
      required: ['keys'],
    },
    mutates: true,
    summarize: (a) => `Set ${a.keys?.length ?? 0} keyframes`,
    run: (a) => {
      const keys = (a.keys as any[]).map((k) => {
        const n = resolveNode(k.node);
        if (!isAnimatable(n, k.property)) throw new Error(`"${k.property}" cannot be animated on ${n.name} (${n.type}).`);
        return { target: n.id, prop: k.property as string, f: Math.max(0, k.frame as number), v: coerce(k.value), e: k.ease as Ease | undefined };
      });
      setKeys(keys);
      const last = Math.max(...keys.map((k) => k.f));
      if (last >= scene().duration) patchScene({ duration: Math.ceil(last) + 1 }, 'Extend scene');
      return { keyframes: keys.length };
    },
  });

  registerTool({
    name: 'pose',
    description: 'Poses a character at a frame by keying bone offsets from the rest pose. Rotation is in degrees, clockwise positive on screen. In views facing right, a NEGATIVE rotation swings a hanging arm or leg forward. Bones not listed keep their animation.',
    parameters: {
      type: 'object',
      properties: {
        character: NODE_REF, frame: { type: 'number' },
        bones: { type: 'object', description: 'Bone name -> { rotation?, x?, y?, scaleX?, scaleY? }, e.g. {"upperArm.R": {"rotation": 120}, "head": {"rotation": -8}}.' },
        ease: EASE,
      },
      required: ['character', 'bones'],
    },
    mutates: true,
    summarize: (a) => `Pose ${a.character} (${Object.keys(a.bones ?? {}).length} bones)`,
    run: (a) => {
      const ch = resolveCharacter(a.character);
      const s = scene();
      const frame = Math.max(0, a.frame ?? ui().frame);
      const keys: { target: ID; prop: string; f: number; v: KeyValue; e?: Ease }[] = [];
      for (const [bone, vals] of Object.entries(a.bones as Record<string, Record<string, number>>)) {
        const b = findByName(s, bone, ch.id);
        if (!b || b.type !== 'bone') throw new Error(`${ch.name} has no bone "${bone}". Bones: ${BONE_NAMES.join(', ')}`);
        for (const [prop, v] of Object.entries(vals)) {
          if (!['rotation', 'x', 'y', 'scaleX', 'scaleY'].includes(prop)) throw new Error(`Bone channel "${prop}" does not exist.`);
          keys.push({ target: b.id, prop, f: frame, v, e: a.ease });
        }
      }
      setKeys(keys, 'Pose character');
      return { keyframes: keys.length, frame };
    },
  });

  registerTool({
    name: 'set_character',
    description: 'Sets a character\'s view (turn), facing, mouth shape or eyes, optionally as keyframes at a frame.',
    parameters: {
      type: 'object',
      properties: {
        character: NODE_REF, frame: { type: 'number' }, key: { type: 'boolean', description: 'Write keyframes at the frame instead of changing the whole scene.' },
        view: { type: 'string', enum: [...VIEW_NAMES] }, facing: { type: 'string', enum: ['right', 'left'] },
        mouth: { type: 'string', enum: [...VISEMES] }, eyes: { type: 'string', enum: ['open', 'closed', 'happy'] },
      },
      required: ['character'],
    },
    mutates: true,
    summarize: (a) => `Update ${a.character}`,
    run: (a) => {
      const ch = resolveCharacter(a.character);
      if (a.view && !ch.views.includes(a.view)) throw new Error(`${ch.name} has no "${a.view}" view. Available: ${ch.views.join(', ')}`);
      const values: Record<string, KeyValue> = {};
      if (a.view) values.currentView = a.view;
      if (a.mouth) values.mouth = a.mouth;
      if (a.eyes) values.eyes = a.eyes;
      doc.transact('Update character', () => {
        if (Object.keys(values).length) setProps(ch.id, values, { frame: a.frame, key: a.key === true ? true : 'auto', ease: 'step' });
        if (a.facing) setProps(ch.id, { scaleX: Math.abs(ch.scaleX) * (a.facing === 'left' ? -1 : 1) }, { frame: a.frame, key: a.key === true ? true : 'auto', ease: 'step' });
      });
      return { ok: true };
    },
  });

  registerTool({
    name: 'speak',
    description: 'Lip-syncs a character to a line of dialogue by keying mouth shapes from the text (no audio needed). Returns the frame where the line ends.',
    parameters: { type: 'object', properties: { character: NODE_REF, text: { type: 'string' }, startFrame: { type: 'number' }, speed: { type: 'number', description: 'Characters per second. Default 14.' } }, required: ['character', 'text'] },
    mutates: true,
    summarize: (a) => `Lip-sync "${String(a.text).slice(0, 28)}"`,
    run: (a) => {
      const ch = resolveCharacter(a.character);
      const start = Math.max(0, Math.round(a.startFrame ?? ui().frame));
      const vis = textToVisemes(a.text, project().fps, start, a.speed ?? 14);
      setKeys(vis.map((v) => ({ target: ch.id, prop: 'mouth', f: v.frame, v: v.viseme, e: 'step' as Ease })), 'Lip-sync');
      const end = vis[vis.length - 1].frame;
      if (end >= scene().duration) patchScene({ duration: end + 12 }, 'Extend scene');
      return { startFrame: start, endFrame: end };
    },
  });

  registerTool({
    name: 'apply_action',
    description: 'Places a reusable action clip (walk, run, idle, blink, wave, jump, ...) on a character\'s timeline. Looping actions repeat for the whole duration. Walk/run animate the legs in place: also key the character\'s x to travel. See get_scene for the action library and which views each action suits.',
    parameters: {
      type: 'object',
      properties: {
        character: NODE_REF, action: { type: 'string', description: 'Action name, e.g. "Walk".' }, startFrame: { type: 'number' },
        durationFrames: { type: 'number', description: 'How long the strip lasts. Default: one cycle.' }, speed: { type: 'number' }, blendFrames: { type: 'number' },
      },
      required: ['character', 'action'],
    },
    mutates: true,
    summarize: (a) => `Apply "${a.action}" to ${a.character}`,
    run: (a) => {
      const ch = resolveCharacter(a.character);
      const id = applyAction(ch.id, a.action, { start: a.startFrame, duration: a.durationFrames, speed: a.speed, blend: a.blendFrames });
      if (!id) throw new Error(`No action named "${a.action}". Available: ${builtins().map((x) => x.name).join(', ')}`);
      const st = scene().strips.find((x) => x.id === id)!;
      if (st.start + st.duration > scene().duration) patchScene({ duration: st.start + st.duration }, 'Extend scene');
      return { strip: id, start: st.start, duration: st.duration };
    },
  });

  registerTool({
    name: 'remove_actions',
    description: 'Removes action strips from a character (all of them, or only a named action).',
    parameters: { type: 'object', properties: { character: NODE_REF, action: { type: 'string' } }, required: ['character'] },
    mutates: true,
    summarize: (a) => `Remove actions from ${a.character}`,
    run: (a) => {
      const ch = resolveCharacter(a.character);
      const p = project();
      const strips = scene().strips.filter((s) => s.targetId === ch.id && (!a.action || p.actions[s.actionId]?.name.toLowerCase().includes(String(a.action).toLowerCase())));
      doc.transact('Remove actions', () => strips.forEach((s) => removeStrip(s.id)));
      return { removed: strips.length };
    },
  });

  registerTool({
    name: 'remove_animation',
    description: 'Deletes keyframes from a layer: a whole property, everything, or only keys inside a frame range.',
    parameters: { type: 'object', properties: { node: NODE_REF, property: { type: 'string' }, fromFrame: { type: 'number' }, toFrame: { type: 'number' } }, required: ['node'] },
    mutates: true,
    summarize: (a) => `Remove animation from ${a.node}`,
    run: (a) => {
      const target = a.node === 'camera' ? CAMERA_ID : resolveNode(a.node).id;
      if (a.fromFrame === undefined && a.toFrame === undefined) {
        clearTrack(target, a.property);
        return { ok: true };
      }
      const tracks = scene().anim[target] ?? {};
      const refs = Object.keys(tracks).filter((p) => !a.property || p === a.property).flatMap((p) => tracks[p].keys.filter((k) => k.f >= (a.fromFrame ?? 0) && k.f <= (a.toFrame ?? Infinity)).map((k) => ({ target, prop: p, f: k.f })));
      deleteKeys(refs);
      return { removed: refs.length };
    },
  });

  registerTool({
    name: 'delete_nodes',
    description: 'Deletes layers (and everything inside them).',
    parameters: { type: 'object', properties: { nodes: { type: 'array', items: NODE_REF } }, required: ['nodes'] },
    mutates: true,
    summarize: (a) => `Delete ${(a.nodes ?? []).join(', ')}`,
    run: (a) => {
      const ids = (a.nodes as string[]).map((r) => resolveNode(r).id);
      deleteNodes(ids);
      return { deleted: ids.length };
    },
  });

  registerTool({
    name: 'duplicate_node',
    description: 'Duplicates a layer with its children and animation. Optionally renames and repositions the copy.',
    parameters: { type: 'object', properties: { node: NODE_REF, name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['node'] },
    mutates: true,
    summarize: (a) => `Duplicate ${a.node}`,
    run: (a) => doc.transact('Duplicate', () => {
      const [id] = duplicateNodes([resolveNode(a.node).id], 0);
      const patch: Record<string, unknown> = {};
      if (a.name) patch.name = a.name;
      if (typeof a.x === 'number') patch.x = a.x;
      if (typeof a.y === 'number') patch.y = a.y;
      if (Object.keys(patch).length) patchNode(id, patch, 'Duplicate');
      return { id, name: scene().nodes[id].name };
    }),
  });

  registerTool({
    name: 'arrange',
    description: 'Changes stacking order or parent. Layers later in a parent are drawn in front.',
    parameters: { type: 'object', properties: { node: NODE_REF, order: { type: 'string', enum: ['front', 'back', 'forward', 'backward'] }, parent: { type: 'string', description: 'New parent layer, or "root".' } }, required: ['node'] },
    mutates: true,
    summarize: (a) => `Arrange ${a.node}`,
    run: (a) => doc.transact('Arrange', () => {
      const id = resolveNode(a.node).id;
      if (a.parent) moveNodes([id], a.parent === 'root' ? null : resolveNode(a.parent).id);
      if (a.order) reorder(id, ({ front: 'top', back: 'bottom', forward: 'up', backward: 'down' } as const)[a.order as 'front']);
      return { ok: true };
    }),
  });

  registerTool({
    name: 'set_camera',
    description: 'Sets the scene camera, optionally as keyframes for camera moves. x/y is the point the camera centres on. zoom 1 = whole stage, 2 = twice as close. z dollies into the scene (layers with different depth then slide at different speeds: parallax). rotation rolls the camera.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' }, zoom: { type: 'number' }, rotation: { type: 'number' }, z: { type: 'number' }, focal: { type: 'number' },
        dofEnabled: { type: 'boolean' }, focusDepth: { type: 'number' }, aperture: { type: 'number' },
        frame: { type: 'number' }, key: { type: 'boolean', description: 'Write keyframes at the frame. Use for camera animation.' }, ease: EASE,
      },
    },
    mutates: true,
    summarize: (a) => `Camera${a.key ? ` key at ${a.frame ?? 'playhead'}` : ''}`,
    run: (a) => {
      const values: Partial<Camera> = {};
      for (const k of CAMERA_ANIM_PROPS) if (typeof a[k] === 'number') (values as Record<string, number>)[k] = a[k];
      doc.transact('Set camera', () => {
        if (Object.keys(values).length) setCamera(values, { frame: a.frame, key: a.key === true ? true : a.key === false ? false : 'auto', ease: a.ease });
        if (typeof a.dofEnabled === 'boolean') patchScene({ camera: { ...scene().camera, dofEnabled: a.dofEnabled } }, 'Depth of field');
      });
      return { ok: true };
    },
  });

  registerTool({
    name: 'set_scene',
    description: 'Changes the current scene: name, length in frames, background colour, and the transition into the next scene.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, durationFrames: { type: 'number' }, background: { type: 'string' },
        transition: { type: 'string', enum: ['cut', 'fade', 'dissolve', 'wipeLeft', 'wipeRight', 'slideLeft', 'slideRight'] }, transitionFrames: { type: 'number' },
      },
    },
    mutates: true,
    summarize: () => 'Update scene settings',
    run: (a) => {
      const s = scene();
      const patch: Partial<Scene> = {};
      if (a.name) patch.name = a.name;
      if (typeof a.durationFrames === 'number') patch.duration = Math.max(1, Math.round(a.durationFrames));
      if (a.background) patch.background = a.background;
      if (a.transition || a.transitionFrames) patch.transition = { type: (a.transition ?? s.transition.type) as Transition['type'], duration: Math.round(a.transitionFrames ?? s.transition.duration) };
      patchScene(patch, 'Update scene');
      return { ok: true };
    },
  });

  registerTool({
    name: 'add_scene',
    description: 'Adds a new empty scene after the others and switches to it.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, durationFrames: { type: 'number' }, background: { type: 'string' } } },
    mutates: true,
    summarize: (a) => `Add scene${a.name ? ` "${a.name}"` : ''}`,
    run: (a) => doc.transact('Add scene', () => {
      const id = addScene(a.name);
      const patch: Partial<Scene> = {};
      if (typeof a.durationFrames === 'number') patch.duration = Math.max(1, Math.round(a.durationFrames));
      if (a.background) patch.background = a.background;
      if (Object.keys(patch).length) patchScene(patch, 'Add scene');
      return { id, name: scene().name };
    }),
  });

  registerTool({
    name: 'switch_scene',
    description: 'Switches the editor to another scene by name or number (1-based).',
    parameters: { type: 'object', properties: { scene: { type: 'string' } }, required: ['scene'] },
    mutates: false,
    run: (a) => {
      const p = project();
      const idx = /^\d+$/.test(String(a.scene)) ? Number(a.scene) - 1 : p.scenes.findIndex((s) => s.name.toLowerCase() === String(a.scene).toLowerCase());
      const target = p.scenes[idx];
      if (!target) throw new Error(`No scene "${a.scene}". Scenes: ${p.scenes.map((s) => s.name).join(', ')}`);
      useUI.setState({ sceneId: target.id, selection: [], selectedKeys: [], frame: 0 });
      return { scene: target.name };
    },
  });

  registerTool({
    name: 'add_effect',
    description: 'Adds a visual effect to a layer (and everything inside it). Types: blur {radius}, glow {radius,color,strength 1-4}, shadow {dx,dy,radius,color}, color {brightness,contrast,saturation,hue}, tint {color,amount 0-1}. replace=true clears existing effects first.',
    parameters: {
      type: 'object',
      properties: {
        node: NODE_REF, type: { type: 'string', enum: ['blur', 'glow', 'shadow', 'color', 'tint'] }, radius: { type: 'number' }, color: { type: 'string' },
        strength: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' }, brightness: { type: 'number' }, contrast: { type: 'number' },
        saturation: { type: 'number' }, hue: { type: 'number' }, amount: { type: 'number' }, replace: { type: 'boolean' },
      },
      required: ['node', 'type'],
    },
    mutates: true,
    summarize: (a) => `Add ${a.type} to ${a.node}`,
    run: (a) => {
      const n = resolveNode(a.node);
      let fx: Effect;
      switch (a.type) {
        case 'blur': fx = { type: 'blur', enabled: true, radius: a.radius ?? 6 }; break;
        case 'glow': fx = { type: 'glow', enabled: true, radius: a.radius ?? 14, color: a.color ?? '#ffffff', strength: a.strength ?? 2 }; break;
        case 'shadow': fx = { type: 'shadow', enabled: true, dx: a.dx ?? 0, dy: a.dy ?? 12, radius: a.radius ?? 16, color: a.color ?? 'rgba(0,0,0,0.55)' }; break;
        case 'color': fx = { type: 'color', enabled: true, brightness: a.brightness ?? 1, contrast: a.contrast ?? 1, saturation: a.saturation ?? 1, hue: a.hue ?? 0 }; break;
        default: fx = { type: 'tint', enabled: true, color: a.color ?? '#22d3ee', amount: a.amount ?? 0.35 };
      }
      patchNode(n.id, { effects: a.replace ? [fx] : [...n.effects, fx] }, 'Add effect');
      return { effects: (a.replace ? 1 : n.effects.length + 1) };
    },
  });

  registerTool({
    name: 'add_ik',
    description: 'Adds an inverse-kinematics target to a limb bone (e.g. "Hero/foot.L" or "Hero/hand.R"): the limb then reaches for the target layer, which you can move or key to plant feet or grab things.',
    parameters: { type: 'object', properties: { bone: NODE_REF }, required: ['bone'] },
    mutates: true,
    summarize: (a) => `Add IK to ${a.bone}`,
    run: (a) => {
      const id = addIKForBone(resolveNode(a.bone).id);
      if (!id) throw new Error(`"${a.bone}" is not a bone.`);
      return { target: id, name: scene().nodes[id].name };
    },
  });

  registerTool({
    name: 'bind_to_bones',
    description: 'Binds shapes or image meshes to bones so they bend smoothly with the skeleton (mesh deformation).',
    parameters: { type: 'object', properties: { nodes: { type: 'array', items: NODE_REF } }, required: ['nodes'] },
    mutates: true,
    summarize: () => 'Bind to bones',
    run: (a) => ({ bound: bindSkin((a.nodes as string[]).map((r) => resolveNode(r).id)) }),
  });

  registerTool({
    name: 'undo',
    description: 'Undoes the most recent changes.',
    parameters: { type: 'object', properties: { steps: { type: 'integer' } } },
    mutates: true,
    summarize: (a) => `Undo ${a.steps ?? 1} step(s)`,
    run: (a) => {
      let n = 0;
      for (let i = 0; i < Math.max(1, a.steps ?? 1); i++) if (doc.undo()) n++;
      return { undone: n };
    },
  });
}
