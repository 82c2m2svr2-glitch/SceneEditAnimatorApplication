# Task board

Owner of this file: Claude. Codex reports status in `collab/from-codex.md`, never here.

Status values: `ready` (take it), `blocked` (wait), `in-progress`, `review` (PR open), `done`.

Branch per task: `codex/<task-id>-<slug>`, PR into `claude/gallant-newton-mx4d8l`.
Before every PR: rebase on the integration branch, then `npm run check` must pass.

## Codex queue (work top to bottom)

### C1  Image-sequence exporters — ready
Owns: `src/export/gif.ts`, `src/export/pngSequence.ts`, `src/export/spriteSheet.ts`, and their tests.
Build three exporters against the `FrameSource` contract in `src/export/types.ts`:
- `exportGif(source, opts & { loop?: boolean; maxColors?: number }) => Promise<Blob>` using `gifenc`.
  Honour `source.transparent` (1-bit GIF transparency). Per-frame palette quantisation is fine.
- `exportPngSequence(source, opts & { baseName?: string }) => Promise<Blob>` returning a zip
  (`fflate`) of `name_0001.png` ... zero-padded to at least 4 digits.
- `exportSpriteSheet(source, opts & { columns?: number; padding?: number }) =>
  Promise<{ png: Blob; json: string }>`. JSON lists each frame's `x, y, w, h` plus `fps`,
  `frameCount`, and sheet size. Refuse (throw a clear Error) if the sheet would exceed 16384 px
  on a side.
All three report progress through `opts.onProgress` and stop with `throwIfAborted(opts.signal)`.
Done when: `npm run check` passes, and the pure parts (file naming, sheet layout maths, JSON
shape) have unit tests. Canvas encoding cannot run in the node test environment, so keep layout
and naming in pure helper functions and test those.

### C2  Image tracer — ready
Owns: `src/core/trace.ts`, `src/core/trace.test.ts`.
`traceImage(image: { data: Uint8ClampedArray; width: number; height: number }, opts?: {
colors?: number; minArea?: number; tolerance?: number; smooth?: boolean }) =>
{ color: string; path: PathData }[]`, ordered back to front (largest regions first).
Pipeline: quantise to at most `colors` colours (default 12) ignoring pixels with alpha < 128,
trace region boundaries into closed contours (holes become extra contours of the same path, to be
filled with `evenodd`), simplify (Ramer-Douglas-Peucker with `tolerance`, default 1.2 px), and
when `smooth` is true (default) fit bezier handles so curves stay curves. Pure: no DOM, no canvas.
Done when: tests cover a solid square, a square with a hole, two touching colour regions, a
transparent background, and `minArea` dropping specks; `npm run check` passes.

### C3  Lip-sync analysis and waveform peaks — ready
Owns: `src/audio/lipsync.ts`, `src/audio/waveform.ts`, and their tests.
- `analyzeVisemes(samples: Float32Array, sampleRate: number, fps: number, opts?: {
  sensitivity?: number; minHold?: number }) => { frame: number; viseme: Viseme }[]` returning one
  entry per CHANGE of mouth shape (a step track), starting with frame 0. Use `VISEMES` from
  `src/core/character/spec.ts`. There is no speech recognition: derive shapes from loudness and
  spectrum per frame (silence -> `rest`; onsets after silence -> `MBP`; loud + low/mid formant
  energy -> `AI`; bright/high -> `E`; mid-dark rounded -> `O`/`U`; hissy high-frequency noise ->
  `FV`; quiet voiced -> `etc`). Enforce `minHold` frames (default 2) so the mouth never flickers.
- `computePeaks(samples: Float32Array, buckets: number) => Float32Array` of `[min, max]` pairs.
Pure functions, no Web Audio. Done when: tests cover silence, a steady tone, a burst after
silence, `minHold`, and peak values for a known signal; `npm run check` passes.

### C4  Core unit tests + bug hunt — ready
Owns: new `src/core/*.test.ts` files only (do not edit the modules themselves).
Write tests for `math.ts`, `path.ts` (especially `parseSvgPath` across every command, arcs
included, and round-tripping through `pathToSvg`), `easing.ts`, `anim.ts` (`sampleTrack`,
`upsertKey`, `evaluateScene` with a parent/child hierarchy, bones with pose deltas, a switch
following a character's `mouth`, strips with blend in/out), `ik.ts`, `skin.ts`, `particles.ts`
(determinism), `tree.ts` (`remapBundle` keeps skin/constraint references valid).
If a test exposes a bug, leave the failing test in as `it.fails(...)` with a comment and report
the bug in `from-codex.md` with the input and the wrong output. Do not fix core files yourself.

### C5  Review: evaluator and command layer — ready
Read `src/core/anim.ts`, `src/state/store.ts`, `src/state/commands.ts`, `src/render/draw.ts`.
Write findings in `from-codex.md`: file and line, what breaks, and a concrete failing scenario.
Bugs and design risks only.

## How your modules get used

- C1: `src/ui/ExportDialog.tsx` already looks for `src/export/gif.ts`, `pngSequence.ts` and
  `spriteSheet.ts` with `import.meta.glob`. As soon as a file exists with the export named in the
  task (`exportGif`, `exportPngSequence`, `exportSpriteSheet`), its format appears in the Export
  dialog. You do not need to touch the dialog.
- C3: `src/audio/lipsyncApply.ts` looks for `src/audio/lipsync.ts` the same way and calls
  `analyzeVisemes(samples, sampleRate, fps, { sensitivity })`. Once it exists, a Lip-sync button
  appears for the selected audio clip. `src/audio/engine.ts` currently computes waveform peaks
  inline; I will switch it to your `computePeaks` when C3 merges.
- C2: I will wire `traceImage` into Character Creator ("Convert my image" gets a faithful trace
  mode) and an Edit > Trace image command after it merges.

## Claude (in progress, do not touch these areas)

Everything under `src/state`, `src/render`, `src/tools`, `src/ui`, `src/ai`, `src/core` (except
the files C2/C4 own), `src/export/frames.ts`, `src/export/video.ts`, `src/audio/engine.ts`,
`electron/`, and all build/config files.
