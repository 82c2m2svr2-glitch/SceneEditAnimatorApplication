const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { unzipSync } = require('fflate');

module.exports = async (page) => {
  await page.getByRole('button', { name: /Create project/ }).click();
  await page.evaluate(() => window.df.commands.patchScene({ duration: 3 }));

  const download = async (format, extensions) => {
    await page.evaluate(() => window.df.useUI.setState({ dialog: 'export' }));
    const dialog = page.locator('.dialog');
    const footer = dialog.locator('.dialog-foot');
    await dialog.locator('select').first().selectOption(format);
    await dialog.getByRole('button', { name: '25%', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Transparent' }).check();
    const files = Promise.all(extensions.map(async (extension) => {
      const file = await page.waitForEvent('download', {
        predicate: (event) => event.suggestedFilename().endsWith(extension),
        timeout: 10000,
      });
      return fs.readFile(await file.path());
    }));
    const [contents] = await Promise.all([
      files,
      footer.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    await footer.getByRole('button', { name: 'Close', exact: true }).click();
    return contents;
  };

  const [gif] = await download('gif', ['.gif']);
  assert.equal(gif.toString('ascii', 0, 6), 'GIF89a');
  assert.equal(gif.at(-1), 0x3b);

  const pngSize = (png) => {
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };
  const [zip] = await download('png', ['.zip']);
  const frames = unzipSync(zip);
  assert.deepEqual(Object.keys(frames).map((name) => name.slice(-9)), [
    '_0001.png', '_0002.png', '_0003.png',
  ]);
  for (const frame of Object.values(frames)) {
    assert.deepEqual(pngSize(Buffer.from(frame)), [gif.readUInt16LE(6), gif.readUInt16LE(8)]);
  }

  const [sheet, json] = await download('sprite', ['.png', '.json']);
  const layout = JSON.parse(json.toString('utf8'));
  assert.equal(layout.frameCount, 3);
  assert.equal(layout.frames.length, 3);
  assert.deepEqual(pngSize(sheet), [layout.width, layout.height]);
};
