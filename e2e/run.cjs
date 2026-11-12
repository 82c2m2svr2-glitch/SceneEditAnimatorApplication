// End-to-end scenarios that drive the real app in Chromium.
//
//   npm run dev                       (in another terminal)
//   node e2e/run.cjs                  runs every scenario
//   node e2e/run.cjs assistant        runs one
//
// Requires Playwright (`npm i -D playwright && npx playwright install chromium`); it is not a
// project dependency because it downloads a browser. AI scenarios mock the OpenAI and Anthropic
// APIs, so no key is needed and nothing is billed.
const fs = require('node:fs');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node-tools/node_modules/playwright'));
}

const BASE = process.env.DREAMFORGE_URL || 'http://127.0.0.1:5173/';
const dir = path.join(__dirname, 'scenarios');
const wanted = process.argv.slice(2);
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).map((f) => f.replace(/\.cjs$/, '')).filter((n) => !wanted.length || wanted.includes(n));

(async () => {
  const browser = await chromium.launch();
  let failed = 0;
  fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });
  for (const name of names) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    // The app's daily update check must not leave the machine during tests; scenarios may override this.
    await page.route('https://api.github.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.0.1', assets: [] }) }));
    try {
      await page.goto(BASE);
      await page.waitForSelector('.start');
      await require(path.join(dir, name + '.cjs'))(page, { out: path.join(__dirname, 'output') });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(__dirname, 'output', name + '.png') });
      if (errors.length) throw new Error('Page errors:\n' + errors.join('\n'));
      console.log(`ok    ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
    }
    await page.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
