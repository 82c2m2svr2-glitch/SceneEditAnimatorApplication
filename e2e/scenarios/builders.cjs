// Character Creator's 2D/3D choice and library, Asset Builder (mocked OpenAI), the update check,
// full-screen editing and the everyday shortcuts.
const assert = require('node:assert');

module.exports = async (page) => {
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(400);
  const count = (type) => page.evaluate((t) => Object.values(window.df.commands.scene().nodes).filter((n) => n.type === t).length, type);
  await page.evaluate(() => window.df.commands.deleteNodes(Object.keys(window.df.commands.scene().nodes)));

  // --- Character Creator: build as a 3D model, find it again under Created characters ----------
  await page.keyboard.press('Alt+c');
  const dialog = page.locator('.dialog');
  await dialog.getByRole('button', { name: 'Quick builder' }).click();
  await dialog.locator('input[type=text]').first().fill('Robin');
  await dialog.getByRole('button', { name: '3D model', exact: true }).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('[data-testid=preview-3d]');
    if (!c || c.width < 50) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
    return n > 2000;
  }, null, { timeout: 20000 });
  await dialog.getByRole('button', { name: /Add to scene/ }).click();
  await page.getByText(/Robin added to the scene as a 3D model/).waitFor();
  assert.strictEqual(await count('model3d'), 1);
  assert.strictEqual(await count('character'), 1);

  await page.keyboard.press('Alt+c');
  await dialog.getByRole('button', { name: 'Created characters' }).click();
  const saved = dialog.locator('.cc-saved');
  await saved.first().waitFor();
  assert.strictEqual(await saved.count(), 1);
  assert.match(await saved.first().innerText(), /Robin/);
  await saved.first().click();
  await dialog.getByRole('button', { name: '2D puppet', exact: true }).click();
  await dialog.getByRole('button', { name: /Add to scene/ }).click();
  await page.getByText(/Robin added to the scene as a 2D puppet/).waitFor();
  assert.strictEqual(await count('character'), 2);
  assert.strictEqual(await count('model3d'), 1);

  // --- Asset Builder -------------------------------------------------------------------------------
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 96; c.height = 96; const g = c.getContext('2d');
    g.fillStyle = '#2a9d8f'; g.beginPath(); g.arc(48, 48, 40, 0, Math.PI * 2); g.fill();
    return c.toDataURL('image/png').split(',')[1];
  });
  const requests = [];
  await page.route('https://api.openai.com/v1/images/generations', (r) => {
    requests.push(JSON.parse(r.request().postData()));
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png }] }) });
  });
  await page.route('https://api.openai.com/v1/models', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'gpt-image-test' }, { id: 'gpt-text' }] }) }));
  await page.evaluate(() => window.df.useSettings.getState().update({ openaiKey: 'sk-test', imageModel: 'gpt-image-test' }));
  await page.keyboard.press('Alt+a');
  await dialog.getByText('Asset Builder').waitFor();
  await dialog.locator('select').first().selectOption('prop');
  await dialog.locator('textarea').fill('a green rubber ball');
  await dialog.getByRole('button', { name: '3D object', exact: true }).click();
  await dialog.getByRole('button', { name: '3', exact: true }).click();
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.asset-pick').length === 3, null, { timeout: 15000 });
  assert.strictEqual(requests.length, 3);
  assert.strictEqual(requests[0].model, 'gpt-image-test');
  assert.strictEqual(requests[0].background, 'transparent');
  assert.strictEqual(requests[0].quality, 'high');
  assert.match(requests[0].prompt, /a green rubber ball/);
  // The first result is selected for you; pick a second one too.
  await page.locator('.asset-pick').nth(1).click();
  await dialog.getByRole('button', { name: /Add 2 to scene/ }).click();
  await page.getByText(/2 assets added/).waitFor();
  assert.strictEqual(await count('model3d'), 3);

  // A flat background fills the stage and goes to the back.
  await page.keyboard.press('Alt+a');
  await dialog.locator('select').first().selectOption('background');
  await dialog.locator('textarea').fill('a city park');
  await dialog.getByRole('button', { name: '1', exact: true }).click();
  assert.ok(await dialog.getByRole('button', { name: '3D object', exact: true }).isDisabled());
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.asset-pick').length === 1, null, { timeout: 15000 });
  assert.strictEqual(requests[3].background, 'opaque');
  assert.strictEqual(requests[3].size, '1536x1024');
  await dialog.getByRole('button', { name: /Add 1 to scene/ }).click();
  await page.getByText(/1 asset added/).waitFor();
  const bg = await page.evaluate(() => {
    const s = window.df.commands.scene();
    const n = Object.values(s.nodes).find((x) => x.type === 'image');
    const p = window.df.doc.project;
    return { covers: n.width >= p.width - 1 && n.height >= p.height - 1, atBack: s.roots[0] === n.id };
  });
  assert.deepStrictEqual(bg, { covers: true, atBack: true });

  // --- update check ----------------------------------------------------------------------------------
  await page.unroute('https://api.github.com/**');
  await page.route('https://api.github.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/example/releases/tag/v99.0.0', body: 'Shiny new things', assets: [{ name: 'DreamForge-99.0.0-windows.exe', browser_download_url: 'https://github.com/example/DreamForge-99.0.0-windows.exe' }] }) }));
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByText(/Check for updates/).click();
  await dialog.getByText('Version 99.0.0 is available.').waitFor();
  assert.strictEqual(await dialog.getByRole('link', { name: /Download 99\.0\.0/ }).getAttribute('href'), 'https://github.com/example/DreamForge-99.0.0-windows.exe');
  await dialog.locator('.dialog-foot').getByRole('button', { name: 'Close', exact: true }).click();

  // --- full-screen editing and shortcuts ---------------------------------------------------------------
  await page.keyboard.press('Shift+F');
  await page.locator('.full-bar').waitFor();
  assert.strictEqual(await page.locator('.menubar').count(), 0);
  assert.ok(!(await page.locator('.panel.right').isVisible()));
  assert.ok(await page.locator('.toolbar').isVisible());
  // Editing still works there: select a character, turn it with the keyboard, key its pose.
  const hero = await page.evaluate(() => {
    const s = window.df.commands.scene();
    const id = Object.values(s.nodes).find((n) => n.type === 'character').id;
    window.df.useUI.setState({ selection: [id], frame: 10 });
    return id;
  });
  const view = () => page.evaluate((id) => {
    const s = window.df.commands.scene();
    return s.anim[id]?.currentView?.keys.at(-1)?.v ?? s.nodes[id].currentView;
  }, hero);
  await page.keyboard.press('Alt+ArrowRight');
  assert.strictEqual(await view(), 'threeQuarter');
  await page.keyboard.press('Alt+ArrowLeft');
  assert.strictEqual(await view(), 'front');
  await page.keyboard.press('Shift+K');
  await page.getByText(/Keyed the whole pose/).first().waitFor();
  const keyed = await page.evaluate((id) => {
    const s = window.df.commands.scene();
    const bones = Object.values(s.nodes).filter((n) => n.type === 'bone' && s.anim[n.id]?.rotation);
    return bones.length;
  }, hero);
  assert.ok(keyed >= 27, `keyed ${keyed} bones`);
  await page.keyboard.press('Shift+H');
  assert.strictEqual(await page.evaluate((id) => window.df.commands.scene().nodes[id].visible, hero), false);
  await page.keyboard.press('Shift+H');
  await page.getByRole('button', { name: 'Exit full screen' }).click();
  await page.locator('.menubar').waitFor();
  await page.evaluate(() => window.df.useUI.setState({ selection: [], frame: 0 }));
};
