// Local Image Generation against a mocked SD.Next (no GPU needed): connection check, recommended
// OpenVINO settings, a background plate, a widescreen text-to-image preview, a low-denoise
// variation of the plate and a region edit placed over it, each saved with its settings.
const assert = require('node:assert');

module.exports = async (page) => {
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.df.commands.deleteNodes(Object.keys(window.df.commands.scene().nodes)));

  const png = (w, h, color) => page.evaluate(([w, h, color]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, w, h); g.fillStyle = '#ffd166'; g.fillRect(w * 0.6, h * 0.2, w * 0.05, h * 0.2);
    return c.toDataURL('image/png').split(',')[1];
  }, [w, h, color]);
  const result = await png(512, 288, '#1d2540');
  const requests = [];
  let options = { sd_model_checkpoint: 'anything-v3-fp16-pruned [6569e224]', openvino_devices: [], openvino_disable_model_caching: true };
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
  await page.route('http://127.0.0.1:7860/**', async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': '*' } });
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    requests.push({ path, body });
    if (path === '/sdapi/v1/version') return json(r, { branch: 'master', commit: 'abc1234', updated: '2026-10-29' });
    if (path === '/sdapi/v1/options') {
      if (body) options = { ...options, ...body };
      return json(r, options);
    }
    if (path === '/sdapi/v1/sd-models') return json(r, [{ title: options.sd_model_checkpoint, model_name: 'anything-v3-fp16-pruned' }]);
    if (path === '/sdapi/v1/samplers') return json(r, [{ name: 'Euler a' }]);
    if (path === '/sdapi/v1/progress') return json(r, { progress: 0.5, eta_relative: 2, state: { sampling_step: 10, sampling_steps: 20 } });
    if (path === '/sdapi/v1/reload-checkpoint') return r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (path === '/sdapi/v1/txt2img' || path === '/sdapi/v1/img2img') {
      const seed = body.seed >= 0 ? body.seed : 1000 + requests.length;
      return json(r, { images: [result], parameters: {}, info: JSON.stringify({ seed, width: body.width, height: body.height, steps: body.steps, cfg_scale: body.cfg_scale, sampler_name: 'Euler a', sd_model_hash: '6569e224', denoising_strength: body.denoising_strength ?? 0 }) });
    }
    return json(r, { detail: 'Not Found' }, 404);
  });

  const dialog = page.locator('.dialog');
  await page.keyboard.press('Alt+g');
  await dialog.getByText(/Connected: SD\.Next master abc1234/).waitFor();
  await dialog.getByRole('button', { name: /Use recommended settings/ }).click();
  await dialog.getByText(/OpenVINO: GPU, cache on/).waitFor();

  // A 16:9 plate, marked and placed behind everything.
  const plateData = await png(1600, 900, '#202a48');
  await page.evaluate((d) => window.df.content.importImage('Pier Scene 2 Shot 3 Background.png', `data:image/png;base64,${d}`, 'image/png'), plateData);
  await dialog.getByRole('button', { name: /Background plates/ }).click();
  await dialog.locator('select').filter({ has: page.locator('option', { hasText: 'Choose an image' }) }).selectOption({ label: 'Pier Scene 2 Shot 3 Background.png' });
  assert.strictEqual(await dialog.locator('input[placeholder="Camera angle name"]').inputValue(), 'Pier Scene 2 Shot 3');
  await dialog.getByRole('button', { name: /Mark as plate/ }).click();
  await dialog.getByRole('button', { name: 'Add to this scene' }).click();
  await dialog.getByRole('button', { name: /In this scene/ }).waitFor();

  // Widescreen text-to-image preview.
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await dialog.locator('textarea').first().fill('nighttime waterfront promenade, railing, skyline');
  await dialog.getByRole('button', { name: /Generate preview/ }).click();
  await dialog.locator('.lg-result').first().waitFor();
  await dialog.locator('.lg-result').first().getByRole('button', { name: /Save to project/ }).click();

  // Low-denoise variation of the plate.
  await dialog.getByRole('button', { name: 'Variation', exact: true }).click();
  await dialog.locator('select').filter({ has: page.locator('option', { hasText: 'Choose a project image' }) }).selectOption({ label: 'Plate: Pier Scene 2 Shot 3' });
  await dialog.locator('input[type=range]').fill('0.25');
  await dialog.getByRole('button', { name: /Generate preview/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.lg-result').length === 2);
  await dialog.locator('.lg-result').first().getByRole('button', { name: /Save to project/ }).click();

  // A region over the plate, added as its own layer.
  await dialog.getByRole('button', { name: 'Region of a plate', exact: true }).click();
  await dialog.getByRole('button', { name: 'Lower right', exact: true }).click();
  await dialog.locator('textarea').first().fill('a woman leaning on the railing');
  await dialog.getByRole('button', { name: /Generate preview/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.lg-result').length === 3);
  await dialog.locator('.lg-result').first().getByRole('button', { name: /Add to scene/ }).click();
  await page.getByText(/lined up with the region it came from/).waitFor();
  await dialog.locator('.dialog-foot').getByRole('button', { name: 'Close', exact: true }).click();

  const gens = requests.filter((q) => /2img$/.test(q.path));
  assert.deepStrictEqual(gens.map((q) => [q.path, q.body.width, q.body.height]), [['/sdapi/v1/txt2img', 512, 288], ['/sdapi/v1/img2img', 512, 288], ['/sdapi/v1/img2img', 512, 288]]);
  assert.strictEqual(gens[1].body.denoising_strength, 0.25);
  assert.match(gens[0].body.prompt, /dark ink outlines/);
  assert.ok(gens[2].body.mask && !gens[1].body.mask);

  const state = await page.evaluate(() => {
    const p = window.df.doc.project;
    const s = window.df.commands.scene();
    const plate = Object.values(p.assets).find((a) => a.plate);
    return {
      records: Object.values(p.assets).filter((a) => a.generation).map((a) => ({ mode: a.generation.mode, seed: a.generation.seed, w: a.width, h: a.height, denoise: a.generation.denoisingStrength, source: a.generation.source?.assetId === plate.id })),
      plateNode: Object.values(s.nodes).find((n) => n.tag === 'plate'),
      overPlate: Object.values(s.nodes).filter((n) => n.type === 'image' && n.tag !== 'plate').length,
    };
  });
  assert.deepStrictEqual(state.records.map((r) => r.mode).sort(), ['img2img', 'region', 'txt2img']);
  const variation = state.records.find((r) => r.mode === 'img2img');
  assert.deepStrictEqual([variation.w, variation.h, variation.denoise, variation.source], [512, 288, 0.25, true]);
  assert.ok(state.records.every((r) => r.seed >= 1000));
  assert.ok(state.plateNode.locked && state.plateNode.depth === 600);
  assert.strictEqual(state.overPlate, 1);
};
