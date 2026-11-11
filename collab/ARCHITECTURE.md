# DreamForge architecture

Owner of this file: Claude (lead). Codex: read all of it before writing code. If something here
conflicts with the onboarding prompt, this file wins.

## Stack

- TypeScript (strict), React 19, Vite. One codebase for the browser and the desktop app (Electron
  shell lives in `electron/`).
- State: `immer` patches for the document (undo/redo), `zustand` for transient UI state.
- Rendering: Canvas 2D. No WebGL in the main renderer. The 2.5D multiplane camera is a per-depth
  affine view matrix (`src/render/view.ts`).
- Libraries already installed and approved for use: `perfect-freehand`, `fflate`, `gifenc`,
  `mediabunny`, `lucide-react`. Do not add dependencies without asking in `from-codex.md`.
- Tests: `vitest` (`src/**/*.test.ts`, node environment, so tests cover pure logic only).
- Commands: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run check` (all three),
  `npm run dev`, `npm run build`.

## Layout

```
src/core/      Pure logic. No DOM, no React, no store imports. Everything here is unit-testable.
  types.ts       The document model. Read this first.
  math.ts path.ts color.ts easing.ts ids.ts
  anim.ts        Track sampling + scene evaluation (the pose at a frame)
  ik.ts skin.ts particles.ts drawing.ts tree.ts factory.ts
  character/     spec.ts (CharacterSpec format), build.ts, humanoid.ts, actions.ts
src/state/     store.ts (document + undo), ui.ts (UI state), commands.ts (every mutation),
               content.ts (higher-level authoring ops), playback.ts, session.ts
src/render/    draw.ts (scene renderer), view.ts (camera), hit.ts, overlays.ts, images.ts
src/tools/     Viewport tools (select, node, pen, shapes, brush, bone, IK, camera, ...)
src/ui/        React components
src/ai/        Tool registry, providers (OpenAI / Anthropic), agent loop, Character Creator
src/export/    types.ts (FrameSource contract), frame source, exporters
src/audio/     Audio engine, waveform, lip-sync
electron/      Desktop shell
collab/        This folder
```

Dependency direction: `core` <- `state` <- `render`/`tools`/`ai`/`export`/`audio` <- `ui`.
`core` must never import from anything else.

## Document model (src/core/types.ts)

- `Project { width, height, fps, mode, scenes[], assets{}, actions{} }`. A project file is this
  object as JSON (`.dreamforge`). Assets are embedded data URLs.
- `Scene { duration, nodes{}, roots[], camera, anim{}, strips[], constraints[], audio[], ... }`.
- Nodes are a flat map with `parent` / `children` links. Types: `group`, `shape`, `image`, `text`,
  `bone`, `character`, `switch`, `drawing`, `particles`.
- Units: pixels, y down, degrees clockwise, time in frames. Depth 0 is the focal plane; positive is
  further away.
- Animation lives in `scene.anim[targetId][property] = { keys: [{ f, v, e }] }`, never on the node.
  `targetId` is a node id or `CAMERA_ID`. `e` is the ease from that key to the next.
- Bones: `x / y / rotation` on a bone node are the REST transform. Keyed bone channels are pose
  DELTAS stored in `bone.pose` and layered on the rest. Turnaround characters store a rest per
  view in `bone.viewRest`.
- Characters: `CharacterNode { views, currentView, mouth, eyes }`. Art parts carry a `view` tag
  and only show in that view. `switch` nodes with `source: 'mouth' | 'eyes'` follow the
  character's keyed `mouth` / `eyes` value, so one key drives every view.
- Actions: `ActionClip.tracks[nodeName][property]`, addressed by node NAME so one clip drives any
  rig with the standard bone names (`src/core/character/spec.ts`). `'@'` addresses the strip's
  target itself. Clips are placed on the timeline as `ActionStrip`s.

## The two rules that keep the app coherent

1. Every change to the document goes through `src/state/commands.ts` (or `content.ts`), which
   calls `doc.apply(label, recipe)`. Nothing else mutates the project. That is what makes every
   action undoable, including the AI's. Multi-step operations use `doc.transact(label, fn)`.
2. Every user-facing feature is also exposed as an AI tool in `src/ai/tools/` (registered with
   `registerTool`). If a person can do it, the assistant can do it.

Rendering never mutates anything: `evaluateScene(project, scene, frame)` returns an `EvalScene`
(evaluated transforms and animated properties), and the renderer draws that.

## Contracts you can build against

- Exporters: `src/export/types.ts` (`FrameSource`, `ExportOptions`). An exporter is
  `(source: FrameSource, opts) => Promise<Blob | ...>` and only pulls frames.
- Visemes: `VISEMES` in `src/core/character/spec.ts`. Lip-sync writes a step track on a
  character's `mouth` property.
- Vector paths: `PathData` in `types.ts`; helpers in `src/core/path.ts` (`parseSvgPath`,
  `pathToSvg`, `smoothPath`, `pathBounds`, ...).

## Conventions

- No default exports. Named exports only.
- Pure functions in `core`; tests next to the file as `name.test.ts`.
- Comments explain why, not what. No commented-out code, no TODO stubs presented as features.
- UI text is plain and literal. Dark theme tokens are CSS variables in `src/styles.css`.
- API keys are entered by the user at runtime and never appear in the repo, tests or logs.
