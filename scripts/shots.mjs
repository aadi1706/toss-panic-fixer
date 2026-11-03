// Walks the whole flow in headless Chromium and saves screenshots.
// Usage: node scripts/shots.mjs [url] [outDir]   (default: dist/index.html, docs/shots)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const url = process.argv[2] || pathToFileURL(resolve('dist/index.html')).href;
const dir = process.argv[3] || 'docs/shots';
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch();
for (const [name, width, height] of [['mobile', 390, 844], ['desktop', 1280, 900]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await page.screenshot({ path: `${dir}/${name}-1-pre.png`, fullPage: true });
  await page.click('[data-act=toss]:visible');
  await page.waitForTimeout(2800); // let the toss reveal finish
  await page.screenshot({ path: `${dir}/${name}-2-toss.png`, fullPage: true });
  await page.click('[data-act=fixall]:visible');
  await page.screenshot({ path: `${dir}/${name}-3-fixed.png`, fullPage: true });
  await page.click('[data-act=play]:visible');
  await page.screenshot({ path: `${dir}/${name}-4-result.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(name, 'horizontal overflow px:', overflow, 'errors:', errors);
  await page.close();
}
await browser.close();
