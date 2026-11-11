// Tracing an image into vector shapes through the dialog, and lip-syncing a character to audio.
const assert = require('node:assert');

module.exports = async (page) => {
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(400);

  // --- trace -------------------------------------------------------------------------------
  const imageId = await page.evaluate(async () => {
    const { content } = window.df;
    const c = document.createElement('canvas'); c.width = 240; c.height = 160; const g = c.getContext('2d');
    g.fillStyle = '#e63946'; g.beginPath(); g.arc(80, 80, 60, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1d3557'; g.fillRect(150, 30, 70, 100);
    const asset = await content.importImage('art.png', c.toDataURL('image/png'));
    return content.placeImage(asset, { x: 400, y: 300 });
  });
  await page.getByRole('button', { name: 'Trace to vector shapes…' }).click();
  const dialog = page.locator('.dialog');
  await dialog.getByText(/2 shapes, \d+ points/).waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Trace', exact: true }).click();
  const traced = await page.evaluate((id) => {
    const s = window.df.commands.scene();
    const group = Object.values(s.nodes).find((n) => n.name === 'art (vector)');
    const parts = group.children.map((c) => s.nodes[c]);
    return {
      imageHidden: s.nodes[id].visible === false,
      samePlace: group.x === s.nodes[id].x && group.y === s.nodes[id].y,
      fills: parts.map((p) => p.fill).sort(),
      evenodd: parts.every((p) => p.type === 'shape' && p.fillRule === 'evenodd'),
      curved: parts.some((p) => p.path.contours[0].pts.some((q) => q.ox || q.oy)),
      selected: window.df.useUI.getState().selection[0] === group.id,
    };
  }, imageId);
  assert.deepStrictEqual(traced, { imageHidden: true, samePlace: true, fills: ['#1d3557', '#e63946'], evenodd: true, curved: true, selected: true });
  // One undo removes the shapes and shows the image again.
  const undone = await page.evaluate((id) => {
    window.df.doc.undo();
    const s = window.df.commands.scene();
    return { image: s.nodes[id].visible, group: Object.values(s.nodes).some((n) => n.name === 'art (vector)') };
  }, imageId);
  assert.deepStrictEqual(undone, { image: true, group: false });

  // --- lip-sync ----------------------------------------------------------------------------
  const setup = await page.evaluate(async () => {
    const { commands, useUI } = window.df;
    // Speech-like test audio: silence, a loud buzz, silence, a shorter buzz, silence.
    const sr = 16000; const parts = [[0.25, 0], [0.5, 1], [0.5, 0], [0.25, 1], [0.25, 0]];
    const n = Math.round(parts.reduce((t, p) => t + p[0], 0) * sr);
    const buf = new ArrayBuffer(44 + n * 2); const dv = new DataView(buf);
    const w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    let i = 0;
    for (const [seconds, on] of parts) {
      for (const end = i + Math.round(seconds * sr); i < end && i < n; i++) {
        const t = i / sr;
        dv.setInt16(44 + i * 2, on ? (Math.sin(t * 2 * Math.PI * 140) + 0.6 * Math.sin(t * 2 * Math.PI * 820) + 0.3 * Math.sin(t * 2 * Math.PI * 1150)) * 9000 : 0, true);
      }
    }
    const audio = await import('/src/audio/engine.ts');
    await audio.importAudio(new File([buf], 'line.wav', { type: 'audio/wav' }));
    const s = commands.scene();
    const hero = Object.values(s.nodes).find((x) => x.type === 'character');
    useUI.setState({ selection: [hero.id], selectedAudio: s.audio[0].id, bottomPanel: 'timeline' });
    return { hero: hero.id, fps: window.df.doc.project.fps, start: s.audio[0].start };
  });
  const mouthKeys = () => page.evaluate((id) => (window.df.commands.scene().anim[id]?.mouth?.keys ?? []).map((k) => ({ f: k.f, v: k.v, e: k.e })), setup.hero);
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await apply.click();
  await page.getByText(/Lip-synced/).first().waitFor({ timeout: 10000 });
  const first = await mouthKeys();
  const frame = (seconds) => setup.start + Math.round(seconds * setup.fps);
  const shapeAt = (keys, f) => keys.filter((k) => k.f <= f).at(-1)?.v;
  assert.ok(first.every((k) => k.e === 'step'), 'mouth keys are step keys');
  assert.strictEqual(shapeAt(first, frame(0.1)), 'rest');
  assert.notStrictEqual(shapeAt(first, frame(0.5)), 'rest');
  assert.strictEqual(shapeAt(first, frame(1.0)), 'rest');
  assert.notStrictEqual(shapeAt(first, frame(1.37)), 'rest');
  assert.strictEqual(first.at(-1).v, 'rest');
  assert.ok(first.some((k) => k.v === 'MBP'), 'lips press before a burst');

  // Fine-tuning: a long hold gives fewer, calmer shapes and replaces the earlier keys.
  const hold = page.getByRole('spinbutton', { name: 'Hold' }).or(page.locator('.field', { hasText: 'Hold' }).locator('input')).first();
  await hold.fill('8');
  await hold.press('Enter');
  await apply.click();
  await page.waitForFunction((count) => {
    const s = window.df.commands.scene();
    const hero = Object.values(s.nodes).find((x) => x.type === 'character');
    return (s.anim[hero.id]?.mouth?.keys ?? []).length !== count;
  }, first.length, { timeout: 10000 });
  const second = await mouthKeys();
  assert.ok(second.length < first.length, `expected fewer keys with a longer hold (${second.length} vs ${first.length})`);
  for (let k = 1; k < second.length - 1; k++) assert.ok(second[k].f - second[k - 1].f >= 8, 'each shape is held at least 8 frames');
  await page.evaluate(() => window.df.doc.undo());
  assert.deepStrictEqual(await mouthKeys(), first);
};
