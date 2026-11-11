// Multiplane camera, depth of field, image mesh deformation, audio and project round trip.
const assert = require('node:assert');

module.exports = async (page, ctx) => {
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(500);
  const info = await page.evaluate(async () => {
    const { commands, content, useUI, doc } = window.df;
    const p = doc.project;
    const shape = (name, d, fill, depth, behind) => {
      const id = 'n_' + name;
      const pts = d.map(([x, y]) => ({ x, y, ix: 0, iy: 0, ox: 0, oy: 0 }));
      commands.addNode({ id, name, type: 'shape', parent: null, children: [], visible: true, locked: false, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, depth, zOrder: 0, blend: 'normal', effects: [], path: { contours: [{ closed: true, pts }] }, fill, stroke: null, strokeWidth: 0, lineCap: 'round', lineJoin: 'round', fillRule: 'nonzero' }, null, behind ? 0 : undefined);
      return id;
    };
    commands.patchScene({ background: '#87ceeb' });
    shape('FarHills', [[-800, 700], [200, 420], [900, 640], [1700, 400], [2800, 700], [2800, 1300], [-800, 1300]], '#6a994e', 900, true);
    shape('NearHills', [[-400, 820], [500, 640], [1300, 800], [2300, 660], [2400, 1300], [-400, 1300]], '#386641', 300, false);
    commands.reorder(commands.scene().roots.find((id) => commands.scene().nodes[id].name === 'Hero'), 'top');
    shape('Bush', [[1100, 1080], [1150, 820], [1400, 760], [1650, 840], [1700, 1080]], '#1b4332', -350, false);
    // An image built in the page, turned into a mesh and bent by two bones.
    const c = document.createElement('canvas'); c.width = 400; c.height = 80; const g = c.getContext('2d');
    for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? '#f72585' : '#ffd166'; g.fillRect(i * 40, 0, 40, 80); }
    const asset = await content.importImage('stripes.png', c.toDataURL('image/png'));
    const img = content.placeImage(asset, { x: 500, y: 250 });
    const b1 = { id: 'b1', name: 'B1', type: 'bone', parent: null, children: [], visible: true, locked: false, x: 300, y: 250, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, depth: 0, zOrder: 0, blend: 'normal', effects: [], length: 200, pose: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } };
    commands.addNode(b1);
    commands.addNode({ ...b1, id: 'b2', name: 'B2', x: 200, y: 0 }, 'b1');
    content.makeMesh(img, 16, 3);
    const bound = content.bindSkin([img], ['b1', 'b2']);
    commands.setProps('b2', { rotation: 70 }, { key: false });
    // Camera: push in toward the hero with depth of field.
    commands.patchScene({ camera: { ...commands.scene().camera, dofEnabled: true, focusDepth: 0, aperture: 10 } });
    commands.setCamera({ zoom: 1, x: 960, y: 540, z: 0 }, { frame: 0, key: true });
    commands.setCamera({ zoom: 1.5, x: 1000, y: 640, z: 250 }, { frame: 60, key: true });
    // Audio: one second of tone, placed on the timeline.
    const sr = 8000; const n = sr; const buf = new ArrayBuffer(44 + n * 2); const dv = new DataView(buf);
    const w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.sin(i / sr * 2 * Math.PI * 440) * 12000 * Math.sin(Math.PI * i / n), true);
    const audioMod = await import('/src/audio/engine.ts');
    const clip = await audioMod.importAudio(new File([buf], 'tone.wav', { type: 'audio/wav' }));
    // Round trip through the file format.
    const persist = await import('/src/state/persistence.ts');
    const json = JSON.stringify(doc.project);
    const back = persist.validateProject(JSON.parse(json));
    useUI.setState({ frame: 45, viewMode: 'camera', showBones: false, selection: [], showChat: false });
    return { bound, clip: !!clip, audio: commands.scene().audio.length, bytes: json.length, sameNodes: Object.keys(back.scenes[0].nodes).length === Object.keys(commands.scene().nodes).length };
  });
  assert.deepStrictEqual({ bound: info.bound, clip: info.clip, audio: info.audio, sameNodes: info.sameNodes }, { bound: 1, clip: true, audio: 1, sameNodes: true });
  await page.waitForTimeout(600);
};
