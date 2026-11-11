// Runs Character Creator end to end against a mocked OpenAI API.
const assert = require('node:assert');

module.exports = async (page, ctx) => {
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(500);
  // Canned "model output": the procedural character expressed in the conversion schema.
  const canned = await page.evaluate(() => {
    const spec = window.df.humanoidSpec({ name: 'Mock', shirt: '#e4572e', hair: '#d9a441', hairStyle: 'spiky' });
    const out = {};
    for (const [view, v] of Object.entries(spec.views)) {
      out[view] = {
        joints: Object.fromEntries(Object.entries(v.joints).map(([k, p]) => [k, { x: p[0], y: p[1] }])),
        parts: v.parts.map((p) => ({ name: p.name, bone: p.bone, z: p.z, paths: p.paths.map((q) => ({ d: q.d, fill: q.fill ?? 'none', stroke: q.stroke ?? 'none', strokeWidth: q.strokeWidth ?? 0 })) })),
        eyes: (v.face?.eyes ?? []).map((e) => ({ name: e.name, paths: e.paths.map((q) => ({ d: q.d, fill: q.fill ?? 'none', stroke: q.stroke ?? 'none', strokeWidth: q.strokeWidth ?? 0 })) })),
        mouth: v.face?.mouth ? { visible: true, cx: v.face.mouth.cx, cy: v.face.mouth.cy, width: v.face.mouth.width } : { visible: false, cx: 0, cy: 0, width: 0 },
        outlineColor: '#2a1f1f',
      };
    }
    const c = document.createElement('canvas'); c.width = 64; c.height = 96; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 96); g.fillStyle = '#e4572e'; g.fillRect(20, 20, 24, 60);
    return { views: out, png: c.toDataURL('image/png').split(',')[1] };
  });
  const calls = { gen: 0, edit: 0, vec: [] };
  await page.route('https://api.openai.com/v1/images/generations', (r) => { calls.gen++; r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: canned.png }] }) }); });
  await page.route('https://api.openai.com/v1/images/edits', (r) => { calls.edit++; r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: canned.png }] }) }); });
  await page.route('https://api.openai.com/v1/chat/completions', (r) => {
    const body = JSON.parse(r.request().postData());
    const sys = body.messages[0].content;
    const view = sys.includes('three-quarter back') ? 'backThreeQuarter' : sys.includes('three-quarter front') ? 'threeQuarter' : sys.includes('side profile') ? 'side' : sys.includes('back view, facing') ? 'back' : 'front';
    calls.vec.push(view + ':' + (body.response_format?.json_schema?.strict ? 'strict' : 'loose') + ':' + (Array.isArray(body.messages[1].content) && body.messages[1].content[1].type));
    // The back view always comes back malformed, to exercise the retry and partial-failure path.
    if (view === 'back') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"joints":{}}' } }] }) });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(canned.views[view]) } }] }) });
  });
  await page.evaluate(() => window.df.useSettings.getState().update({ openaiKey: 'sk-test' }));
  await page.getByRole('button', { name: /Character Creator/ }).click();
  await page.locator('.dialog textarea').fill('a cheerful inventor with spiky blond hair and an orange shirt');
  await page.locator('.dialog input[type=text]').first().fill('Inventor');
  await page.getByRole('button', { name: /^Generate$/ }).click();
  await page.waitForFunction(() => !document.querySelector('.dialog-foot .spin'), null, { timeout: 30000 });
  await page.waitForTimeout(300);
  assert.strictEqual(calls.gen, 1);
  assert.strictEqual(calls.edit, 4);
  assert.strictEqual(calls.vec.filter((v) => v.startsWith('back:')).length, 2, 'a malformed conversion is retried once');
  assert.ok(calls.vec.every((v) => v.endsWith(':strict:image_url')));
  assert.match((await page.locator('.dialog .note').allTextContents()).join(' '), /Back: .*landmark/);
  await page.screenshot({ path: ctx.out + '/character-creator-dialog.png' });
  await page.getByRole('button', { name: /Add to scene/ }).click();
  await page.waitForTimeout(300);
  const added = await page.evaluate(() => { const s = window.df.commands.scene(); const n = s.nodes[s.roots[s.roots.length - 1]]; return [n.name, n.type, n.views]; });
  assert.deepStrictEqual(added, ['Inventor', 'character', ['front', 'threeQuarter', 'side', 'backThreeQuarter']]);
};
