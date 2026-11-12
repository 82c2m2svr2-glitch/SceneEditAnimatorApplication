# DreamForge

A 2D animation and scene-editing studio with a 2.5D multiplane camera and a built-in AI assistant.
One TypeScript codebase runs in the browser and as an installable desktop app.

## What it does

- **Four ways to animate**, chosen in the start menu and all available in every project:
  bone rigs (the default), keyframe tweening, frame-by-frame drawing with onion skin, and mesh
  deformation.
- **Rigged characters with a full turnaround**: front, 3/4, side, back 3/4 and back views on one
  27-bone skeleton (spine with a separate chest, collarbones, fingers, thumbs, toes and a hair
  bone), a mouth with lip-sync shapes, and blinkable eyes. Every bone can be posed, keyed, driven
  by IK and bound to artwork.
- **2D or 3D characters from the same drawing**: any character can be added as a flat vector
  puppet or as a 3D model built from its turnaround. The 3D body is drawn cel-shaded with an ink
  outline so it still looks 2D, turns freely, and is driven by the same skeleton, so posing,
  actions and lip-sync work on both. Every joint can also be turned in depth.
- **3D models in the scene**: import `.glb`, `.gltf` or `.obj` files (with their animation clips
  and bones), add built-in solids, or puff any picture up into a rounded 3D object. All of them
  are drawn cel-shaded as ordinary layers with depth, effects and keyable Turn, Tilt and Roll.
- **Character Creator**: describe a character, give a reference image, or upload finished artwork.
  ChatGPT draws the turnaround, each view is converted into vector parts with skeleton landmarks,
  and the result is rigged automatically. A parametric builder works offline with no API key.
  Everything you make is kept under **Created characters** for reuse in any project.
- **Asset Builder**: backgrounds, scenery, props, effects, textures and signs drawn by OpenAI's
  image model with your key, with selectors for type, art style, shape, quality, image model and
  number of variations, and the option to make the result a 3D object. Add up to four **reference
  images** (upload, drag in, paste, or pick one already in the project) and choose whether the
  result should match their subject, their style or both; any result can be fed back as a
  reference to refine it. The AI director can pass project images as references too.
- **Local Image Generation** (Alt+G): free, on-device Stable Diffusion through SD.Next on your own
  computer, with no API key and nothing sent anywhere. Text to image for new shot concepts, image to
  image for variations of a project image with a denoising-strength slider, and region edits that
  change only part of a background. Every result is saved with its prompt, style, checkpoint,
  seed, size and settings, so it can be reproduced or used as the start of another shot. Reusable
  style presets (default: a hand-drawn 1990s cel-anime look) travel with the project, and
  **background plates** put one finished background behind every shot from the same camera angle,
  locked and unchanged. See [Local image generation](#local-image-generation).
- **AI director and assistant** that operates the app through the same commands as the interface
  and has a tool for every part of it: it stages scenes, poses and animates 2D and 3D
  characters, turns joints in depth, moves the camera, lip-syncs, generates and traces art, and
  checks its own work by looking at frames. It runs on Claude or ChatGPT, in Auto mode (acts
  immediately, everything undoable) or Ask-first mode (shows the planned changes and waits).
- **Feedback and memory**: rate each result Good, Meh or Bad, or press Polish it. A poor rating
  sends the assistant back to review its own animation, fix it and save a lesson; saved lessons
  and your ratings are given to it at the start of every later conversation. The memory is
  stored on your computer and can be read, edited or erased from the chat panel.
- **Timeline**: keyframes with easing, a graph editor, reusable action clips (walk, run, idle,
  blink, wave, jump, ...) placed as strips that loop and blend, audio tracks with waveforms, and
  markers. Every built-in clip has a version for each of the five views, so it plays correctly
  whichever way the character faces.
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
- **Full-screen editing** (Shift+F or F11) with only the stage, the tools and a playback bar, and
  keyboard shortcuts for everyday actions (press `?` in the app for the list).
- **One-click updates**: new code on GitHub becomes a new release automatically, and DreamForge
  shows an **Update** button in the menu bar when one is out. It downloads the new version,
  checks it, saves your open project and restarts on the new version in place, so shortcuts and
  launchers keep working. View > Check for updates does the same on demand.
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

## Local image generation

DreamForge drives [SD.Next](https://github.com/vladmandic/sdnext) running on the same computer.
On an Intel laptop (Core Ultra with integrated graphics) it runs through OpenVINO on the
integrated GPU. The default checkpoint is a lightweight SD 1.5 anime model, Anything V3 fp16
(about 2.1 GB).

### One-time setup on Windows

1. Install [Git for Windows](https://git-scm.com/download/win) and [Python 3.12](https://www.python.org/downloads/windows/)
   (tick "Add python.exe to PATH"). SD.Next supports Python 3.10 to 3.13.
2. Update the Intel graphics driver (Intel Driver & Support Assistant).
3. In `local-generator\windows`, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File install-sdnext.ps1
   ```

   It clones SD.Next into `%USERPROFILE%\sdnext` and downloads the checkpoint into
   `models\Stable-diffusion`. To use another SD 1.5 checkpoint, put its `.safetensors` file there.

### Every time

1. Double-click `local-generator\windows\start-sdnext.bat` and wait for the console to show
   "Startup time" (the first start installs OpenVINO and takes a while).
2. In DreamForge press **Alt+G** (or Insert > Local Image Generation). It checks the connection by
   itself; **Use recommended settings** sets OpenVINO to the integrated GPU and keeps compiled
   models on disk.

The first image after starting, or after changing the model or the size, waits for OpenVINO to
compile the model (several minutes). Later images at the same size are much faster, which is
why previews stay at 512×288.

### Using it

- **New shot**: text to image from a description. The style preset is added to every prompt.
- **Variation**: image to image from any project image. Denoising strength 0.2 to 0.35 keeps the
  composition; 0.6 and up mostly redraws.
- **Region of a plate**: changes only a region (left, middle or right third, lower half, lower
  left, lower right) for characters and foreground. The result is saved cropped to that region and
  placed as its own layer exactly over the plate, which stays untouched.
- **Background plates**: mark an image as the plate for a camera angle, then add it to this scene
  or every scene. It is placed far back (depth 600), scaled to fill the frame from the scene's
  camera, and locked.
- **Reuse settings** on a result, or the circular arrow on a generated image in the Assets panel,
  fills in the exact prompt, style, seed, size, model and source again.

### Privacy

`start-sdnext.bat` starts SD.Next without `--listen`, so it answers only on 127.0.0.1, and in
API-only mode. The desktop app sends requests from its own process and accepts only loopback
addresses and the few API routes it uses, so SD.Next needs no CORS opening. The browser version
(`npm run dev`) calls SD.Next directly, so start it with `start-sdnext.bat --browser`, which allows
exactly `http://localhost:5173`. If DreamForge is ever hosted on a website, keep SD.Next on
127.0.0.1, allow only that site's exact origin with `--cors-origins`, and expect Chrome to ask the
user for permission before a public site may reach localhost. If SD.Next is started with
`--auth user:password`, enter the same `user:password` in the dialog; the desktop app keeps it in
the operating system's credential store. Never add `--listen` or `--share`.

## Releases and updates

Every push to the default branch runs the *Windows build* workflow: it typechecks, lints and tests
the code, builds `DreamForge.exe`, and publishes it as a GitHub release numbered from the major and
minor version in `package.json` plus the build number (for example `0.2.37`). Nothing is published
if a check fails. To start a new major or minor series, change the version in `package.json`.

The Windows app checks for a newer release each time it starts. Update now downloads the new
`.exe` next to the running one, confirms its size and SHA-256 checksum against what GitHub reports,
then closes DreamForge, replaces the file and opens it again. If DreamForge sits in a folder it may
not write to (such as Program Files), it offers the download link instead.

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
