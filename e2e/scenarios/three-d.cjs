// 3D in the 2D scene: generated 3D characters driven by the 2D rig, solids, imported models,
// pictures turned into 3D objects, and posing every joint.
const assert = require('node:assert');

module.exports = async (page) => {
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(400);

  const r = await page.evaluate(async () => {
    const { commands, content, humanoidSpec, doc, useUI } = window.df;
    const models = await import('/src/render/models.ts');
    const anim = await import('/src/core/anim.ts');
    commands.deleteNodes(Object.keys(commands.scene().nodes));
    const out = {};
    /** Number of painted pixels in a model layer's picture, and a cheap fingerprint of it. */
    const picture = (id) => {
      const s = commands.scene();
      const es = anim.evaluateScene(doc.project, s, useUI.getState().frame);
      const c = models.modelPicture(doc.project, es, es.nodes.get(id), 256);
      if (!c) return { painted: 0, sum: 0 };
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let painted = 0; let sum = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 20) { painted++; sum = (sum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + i) % 1000003; }
      return { painted, sum };
    };

    // --- a 3D character keeps the 2D skeleton, which drives the 3D body -------------------------
    const hero = content.addCharacter3DFromSpec(humanoidSpec({ name: 'Solid', height: 500 }), { x: 500, y: 900 });
    const s0 = commands.scene();
    const kids = s0.nodes[hero].children.map((c) => s0.nodes[c]);
    const body = kids.find((n) => n.type === 'model3d');
    const bones = Object.values(s0.nodes).filter((n) => n.type === 'bone');
    await models.preloadModels(doc.project);
    out.character = { type: s0.nodes[hero].type, bones: bones.length, body: !!body, error: models.modelError(doc.project.assets[body.assetId]), joints: models.modelJoints(doc.project.assets[body.assetId]).length };
    const rest = picture(body.id);
    out.restPainted = rest.painted;
    // Posing a 2D bone changes the 3D picture.
    const arm = bones.find((b) => b.name === 'upperArm.R');
    commands.setProps(arm.id, { rotation: 120 }, { key: false });
    out.posed = picture(body.id).sum !== rest.sum;
    commands.setProps(arm.id, { rotation: 0 }, { key: false });
    // Changing the character's view turns the body; mouth shapes repaint the face.
    commands.patchNode(hero, { currentView: 'side' });
    const side = picture(body.id);
    out.turned = side.sum !== rest.sum;
    commands.patchNode(hero, { currentView: 'front', mouth: 'AI' });
    out.speaks = picture(body.id).sum !== rest.sum;
    commands.patchNode(hero, { mouth: 'rest' });
    // Every joint can also be turned in depth and keyed.
    useUI.setState({ frame: 12, autoKey: true });
    commands.setProps(body.id, { 'j:head:y': 45 });
    const track = commands.scene().anim[body.id]?.['j:head:y']?.keys ?? [];
    out.jointKeys = track.map((k) => [k.f, k.v]);
    out.jointTurned = picture(body.id).sum !== rest.sum;
    useUI.setState({ frame: 0 });
    out.jointAtZero = picture(body.id).sum === rest.sum;
    // The action library works on it unchanged.
    out.strip = !!content.applyAction(hero, 'builtin_walk', { start: 0 });

    // --- built-in solids ------------------------------------------------------------------------
    const box = content.addSolid('box', '#e4572e', { x: 1100, y: 400 });
    await models.preloadModels(doc.project);
    const a = picture(box);
    commands.setProps(box, { rotY: 75 }, { key: false });
    out.solid = { painted: a.painted > 500, turns: picture(box).sum !== a.sum, animatable: commands.isAnimatable(commands.scene().nodes[box], 'rotY') };

    // --- an imported model file with its own bones and animation --------------------------------
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
    const root = new THREE.Group(); root.name = 'Body';
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial({ color: 0x2a9d8f })));
    const limb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.4, 0.4), new THREE.MeshStandardMaterial({ color: 0xe9c46a }));
    limb.name = 'Arm'; limb.position.set(0.9, 0.3, 0); root.add(limb);
    const clip = new THREE.AnimationClip('Swing', 1, [new THREE.QuaternionKeyframeTrack('Arm.quaternion', [0, 0.5, 1], [0, 0, 0, 1, 0, 0, 0.7071, 0.7071, 0, 0, 0, 1])]);
    const glb = await new GLTFExporter().parseAsync(root, { binary: true, animations: [clip] });
    const asset = await content.importModel(new File([glb], 'robot.glb', { type: 'model/gltf-binary' }));
    const robot = content.placeModel(asset, { x: 1500, y: 500 });
    await models.preloadModels(doc.project);
    const stand = picture(robot);
    out.imported = { error: models.modelError(asset), clips: models.modelClips(asset).map((c) => c.name), joints: models.modelJoints(asset), painted: stand.painted > 500 };
    commands.patchNode(robot, { clip: 'Swing', clipSpeed: 0, clipTime: 0.5 });
    out.imported.clipMoves = picture(robot).sum !== stand.sum;
    commands.patchNode(robot, { clip: null });
    commands.setProps(robot, { 'j:Arm:z': 60 }, { key: false });
    out.imported.jointMoves = picture(robot).sum !== stand.sum;
    let bad = '';
    try { await content.importModel(new File(['x'], 'model.fbx')); } catch (e) { bad = e.message; }
    out.rejects = bad;

    // --- a picture puffed up into a 3D object ----------------------------------------------------
    const c = document.createElement('canvas'); c.width = 200; c.height = 200; const g = c.getContext('2d');
    g.fillStyle = '#f4a261'; g.beginPath(); g.arc(100, 100, 80, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#264653'; g.fillRect(70, 70, 20, 20);
    const ball = content.addReliefModel('Ball', c.toDataURL('image/png'), {}, { x: 300, y: 300 });
    await models.preloadModels(doc.project);
    commands.setProps(ball, { rotY: 0 }, { key: false });
    const flat = picture(ball);
    commands.setProps(ball, { rotY: 60 }, { key: false });
    const angled = picture(ball);
    out.relief = { painted: flat.painted > 2000, narrowerWhenTurned: angled.painted < flat.painted * 0.95, stillVisible: angled.painted > flat.painted * 0.3 };

    // --- the project still saves and reopens -----------------------------------------------------
    const persist = await import('/src/state/persistence.ts');
    const back = persist.validateProject(JSON.parse(JSON.stringify(doc.project)));
    out.roundTrip = Object.values(back.scenes[0].nodes).filter((n) => n.type === 'model3d').length;
    useUI.setState({ selection: [], frame: 8 });
    return out;
  });

  assert.deepStrictEqual(r.character, { type: 'character', bones: 27, body: true, error: null, joints: 27 });
  assert.ok(r.restPainted > 1500, `3D character painted ${r.restPainted} pixels`);
  assert.deepStrictEqual({ posed: r.posed, turned: r.turned, speaks: r.speaks, jointTurned: r.jointTurned, jointAtZero: r.jointAtZero, strip: r.strip }, { posed: true, turned: true, speaks: true, jointTurned: true, jointAtZero: true, strip: true });
  assert.deepStrictEqual(r.jointKeys, [[0, 0], [12, 45]]);
  assert.deepStrictEqual(r.solid, { painted: true, turns: true, animatable: true });
  assert.ok(r.imported.joints.includes('Body') && r.imported.joints.includes('Arm'), `joints: ${r.imported.joints}`);
  assert.deepStrictEqual({ ...r.imported, joints: 0 }, { error: null, clips: ['Swing'], joints: 0, painted: true, clipMoves: true, jointMoves: true });
  assert.match(r.rejects, /not a 3D model/);
  assert.deepStrictEqual(r.relief, { painted: true, narrowerWhenTurned: true, stillVisible: true });
  assert.strictEqual(r.roundTrip, 4);

  // The property panel shows the 3D controls for a model layer, and joint controls for a bone.
  await page.evaluate(() => {
    const s = window.df.commands.scene();
    window.df.useUI.setState({ selection: [Object.values(s.nodes).find((n) => n.name === 'Box').id], rightTab: 'properties' });
  });
  await page.getByText('2D look').waitFor();
  await page.getByRole('button', { name: '3 tones' }).click();
  assert.strictEqual(await page.evaluate(() => Object.values(window.df.commands.scene().nodes).find((n) => n.name === 'Box').shadeSteps), 3);
  await page.evaluate(() => {
    const s = window.df.commands.scene();
    window.df.useUI.setState({ selection: [Object.values(s.nodes).find((n) => n.name === 'head').id] });
  });
  await page.getByText('3D turn').waitFor();
  await page.waitForTimeout(400);
};
