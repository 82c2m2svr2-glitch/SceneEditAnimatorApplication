# DreamForge

A 2D animation and scene-editing studio with a 2.5D multiplane camera and a built-in AI assistant.
One TypeScript codebase runs in the browser and as an installable desktop app.

## What it does

- **Four ways to animate**, chosen in the start menu and all available in every project:
  bone rigs (the default), keyframe tweening, frame-by-frame drawing with onion skin, and mesh
  deformation.
- **Rigged characters with a full turnaround**: front, 3/4, side, back 3/4 and back views on one
  skeleton, a mouth with lip-sync shapes, and blinkable eyes.
- **Character Creator**: describe a character, give a reference image, or upload finished artwork.
  ChatGPT draws the turnaround, each view is converted into vector parts with skeleton landmarks,
  and the result is rigged automatically. A parametric builder works offline with no API key.
- **AI assistant** that operates the app through the same commands as the interface: it builds
  scenes, poses and animates characters, moves the camera, and checks its own work by looking at
  the frame. It runs on ChatGPT or Claude, in Auto mode (acts immediately, everything undoable) or
  Ask-first mode (shows the planned changes and waits).
- **Timeline**: keyframes with easing, a graph editor, reusable action clips (walk, run, idle,
  blink, wave, jump, ...) placed as strips that loop and blend, audio tracks with waveforms, and
  markers.
- **Lip-sync**: type a line of dialogue, or select an audio clip and let auto lip-sync key the
  mouth from the sound. Sensitivity and hold time are adjustable, and every mouth shape lands as a
  normal keyframe you can move or change.
- **Rigging**: bone tool, setup and animate modes, drag-to-pose inverse kinematics, IK targets for
  planted feet and hands, and automatic skin weights for bending shapes and image meshes.
- **Drawing**: pen (bezier), shapes, path point editing, pressure-sensitive brush, eraser, text,
  image import, and tracing an image into editable flat-colour vector shapes.
- **Camera and depth**: every layer has a depth; the animatable camera pans, zooms, rolls and
  dollies with real parallax and optional depth-of-field blur.
- **Effects and particles**: blur, glow, drop shadow, colour adjustment, tint; rain, snow, fire,
  smoke, sparks, confetti and more.
- **Multiple scenes** with cuts, fades, dissolves, wipes and slides.
- **Export**: MP4 and WebM video with sound, animated GIF, PNG sequence, sprite sheet, plus
  character files (`.dfrig`) for reuse.

## Running it

```bash
npm install
npm run dev          # browser version at http://localhost:5173
npm run build        # production web build in dist/
npm run desktop      # build, then open the desktop app
npm run dist         # package installers into release/
npm run dist:win     # single portable Windows .exe in release/
npm run check        # typecheck + lint + unit tests
npm run e2e          # browser scenarios (needs `npm run dev` running; see e2e/run.cjs)
```

Video export uses the browser's WebCodecs encoder, which is available in Chromium-based browsers
and in the desktop app.

## API keys

Keys are entered in Settings and never leave your machine except to call the service they belong
to. The desktop app stores them in the operating system's credential store; the browser version
keeps them in that browser's local storage.

- **OpenAI key**: required for Character Creator; optional for the assistant.
- **Anthropic key**: optional, to run the assistant on Claude.

Model names are editable in Settings, and the Test button lists the models your key can use.

## Project layout

`collab/ARCHITECTURE.md` describes the code structure and the rules that keep it coherent.
`collab/TASKS.md` is the task board shared with the second engineering agent.
