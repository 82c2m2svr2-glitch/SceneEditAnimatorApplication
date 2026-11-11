// Exercises the viewport tools with real pointer events.
const assert = require('node:assert');

module.exports = async (page, ctx) => {
  const log = () => {};
  await page.locator('.card', { hasText: 'Keyframe tween' }).click();
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(500);
  const vp = await page.locator('.viewport canvas').boundingBox();
  const st = () => page.evaluate(() => { const u = window.df.useUI.getState(); return { zoom: u.zoom, panX: u.panX, panY: u.panY }; });
  const v = await st();
  const S = (x, y) => [vp.x + v.panX + x * v.zoom, vp.y + v.panY + y * v.zoom];
  const drag = async (a, b, steps = 8) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b, { steps }); await page.mouse.up(); };
  const scene = () => page.evaluate(() => { const s = window.df.commands.scene(); return { nodes: Object.values(s.nodes).map((n) => ({ name: n.name, type: n.type, x: Math.round(n.x), y: Math.round(n.y), rot: Math.round(n.rotation), sx: +n.scaleX.toFixed(2), skin: !!n.skin, len: n.length && Math.round(n.length), parent: n.parent && s.nodes[n.parent].name })), anim: Object.fromEntries(Object.entries(s.anim).map(([k, t]) => [s.nodes[k]?.name ?? k, Object.fromEntries(Object.entries(t).map(([p, tr]) => [p, tr.keys.map((q) => [q.f, Math.round(q.v)])]))])) }; });

  // 1. Rectangle tool
  await page.keyboard.press('r');
  await drag(S(400, 300), S(700, 500));
  assert.deepStrictEqual((await scene()).nodes.map((n) => [n.name, n.x, n.y]), [['Rectangle', 550, 400]]);
  // 2. Move with the select tool
  await drag(S(550, 400), S(750, 450));
  assert.deepStrictEqual((await scene()).nodes.map((n) => [n.x, n.y]), [[750, 450]]);
  // 3. Auto-key at frame 24
  await page.evaluate(() => window.df.useUI.setState({ frame: 24 }));
  await drag(S(750, 450), S(1200, 600));
  assert.deepStrictEqual((await scene()).anim, { Rectangle: { x: [[0, 750], [24, 1200]], y: [[0, 450], [24, 600]] } }, 'auto-key pins the start value at frame 0');
  // 4. Rotate with the gizmo handle
  const box = await page.evaluate(() => { const s = window.df.commands.scene(); const n = Object.values(s.nodes)[0]; return { x: n.x, y: n.y }; });
  await page.evaluate(() => window.df.useUI.setState({ frame: 0 }));
  await page.waitForTimeout(100);
  // at frame 0 rect is at its keyed start (750,450); rotate handle is 26px above the top edge
  const top = S(750, 350);
  await drag([top[0], top[1] - 26], [top[0] + 80, top[1] + 20]);
  assert.ok(Math.abs((await scene()).nodes[0].rot - 81) <= 2, 'rotate handle');
  void box;
  // 5. Undo twice, redo once
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  assert.deepStrictEqual((await scene()).anim, {}, 'undo removes the rotation and the keyed move');
  await page.keyboard.press('Control+Shift+z');
  // 6. Pen tool: three clicks and Enter
  await page.keyboard.press('p');
  for (const pt of [[200, 800], [400, 700], [600, 850]]) await page.mouse.click(...S(...pt));
  await page.keyboard.press('Enter');
  // 7. Text tool
  await page.keyboard.press('t');
  await page.mouse.click(...S(1400, 200));
  // 8. Brush on frames 0 and 2 with onion skin
  await page.keyboard.press('d');
  await page.evaluate(() => window.df.useUI.setState({ frame: 0, onion: { enabled: true, before: 2, after: 1 }, brushColor: '#ffd166', brushSize: 14, selection: [] }));
  await drag(S(1300, 700), S(1600, 900), 12);
  await page.evaluate(() => window.df.useUI.setState({ frame: 2 }));
  await drag(S(1350, 650), S(1650, 880), 12);
  // 9. Bones: two chained bones, then bind the rectangle and bend it
  await page.evaluate(() => window.df.useUI.setState({ frame: 0, setupMode: true, showBones: true, selection: [], tool: 'bone' }));
  await drag(S(300, 100), S(500, 100));
  await drag(S(500, 100), S(700, 100));
  await page.evaluate(() => {
    const { commands, content, useUI } = window.df;
    const s = commands.scene();
    const bones = Object.values(s.nodes).filter((n) => n.type === 'bone');
    // A long bar across both bones, with enough points to bend.
    const pts = []; for (let i = 0; i <= 10; i++) pts.push({ x: -200 + i * 40, y: -20, ix: 0, iy: 0, ox: 0, oy: 0 }); for (let i = 10; i >= 0; i--) pts.push({ x: -200 + i * 40, y: 20, ix: 0, iy: 0, ox: 0, oy: 0 });
    const id = 'bar1';
    commands.addNode({ id, name: 'Bar', type: 'shape', parent: null, children: [], visible: true, locked: false, x: 500, y: 100, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, depth: 0, zOrder: 0, blend: 'normal', effects: [], path: { contours: [{ closed: true, pts }] }, fill: '#22d3ee', stroke: null, strokeWidth: 0, lineCap: 'round', lineJoin: 'round', fillRule: 'nonzero' });
    content.bindSkin([id], bones.map((b) => b.id));
    useUI.setState({ setupMode: false, selection: [bones[1].id] });
    commands.setProps(bones[1].id, { rotation: 60 }, { key: false });
  });
  const s2 = await scene();
  assert.deepStrictEqual(s2.nodes.filter((n) => n.type === 'bone').map((n) => [n.name, n.x, n.y, n.len, n.parent]), [['Bone 1', 300, 100, 200, null], ['Bone 2', 200, 0, 200, 'Bone 1']]);
  assert.strictEqual(s2.nodes.find((n) => n.name === 'Bar').skin, true);
  assert.deepStrictEqual(s2.nodes.map((n) => n.type).sort(), ['bone', 'bone', 'drawing', 'shape', 'shape', 'shape', 'text']);
  await page.evaluate(() => window.df.useUI.setState({ frame: 2, selection: [] }));
  await page.waitForTimeout(300);
};
