const assert = require('node:assert');
const fs = require('node:fs');

module.exports = async (page, ctx) => {
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const { commands, content, useUI } = window.df;
    const s = commands.scene();
    const hero = s.roots[0];
    commands.patchNode(hero, { currentView: 'side' });
    content.applyAction(hero, 'Walk', { start: 0, duration: 48 });
    commands.setKeys([{ target: hero, prop: 'x', f: 0, v: 300 }, { target: hero, prop: 'x', f: 47, v: 1500, e: 'linear' }]);
    commands.patchScene({ duration: 48 });
    useUI.setState({ frame: 18, bottomPanel: 'graph', selection: [hero] });
  });
  await page.waitForTimeout(300);
  for (const fmt of ['webm', 'mp4']) {
    await page.evaluate(() => window.df.useUI.setState({ dialog: 'export' }));
    await page.locator('.dialog select').first().selectOption(fmt);
    await page.locator('.dialog .seg button', { hasText: '50%' }).click();
    const dl = page.waitForEvent('download', { timeout: 60000 }).catch((e) => null);
    await page.locator('.dialog-foot .btn.primary').click();
    const d = await dl;
    assert.ok(d, `${fmt}: no file was produced. Dialog says: ${(await page.locator('.dialog .note, .dialog .hint').allTextContents()).join(' ')}`);
    const file = `${ctx.out}/export.${fmt}`;
    await d.saveAs(file);
    assert.ok(fs.statSync(file).size > 10000, `${fmt} file is too small`);
    await page.evaluate(() => window.df.useUI.setState({ dialog: null }));
  }
};
