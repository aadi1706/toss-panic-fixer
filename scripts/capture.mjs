// Captures viewport screenshots of the whole flow at desktop and phone sizes.
// Usage: node scripts/capture.mjs <outDir> [url]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const out = process.argv[2] || 'docs/shots';
const url = process.argv[3] || pathToFileURL(resolve('dist/index.html')).href;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [name, width, height, phone] of [['desktop', 1280, 900, false], ['desktop1440', 1440, 900, false], ['phone', 390, 844, true], ['phone375', 375, 667, true]]) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: phone, isMobile: phone });
  const press = (s) => (phone ? p.tap(s) : p.click(s));
  const shot = (n) => p.screenshot({ path: `${out}/${name}-${n}.png` });
  await p.goto(url); await p.waitForSelector('.team, .trow'); await p.waitForTimeout(500);
  await shot('1-pre');
  await press('[data-act=toss]:visible'); await p.waitForTimeout(900); await shot('2-toss-coin');
  await p.waitForSelector('#coin', { state: 'detached', timeout: 8000 }); await p.waitForTimeout(700);
  await shot('3-after-toss');
  if (phone) {
    await press('[data-tab=xi]'); await p.waitForTimeout(300); await shot('4-xi'); await press('[data-tab=teams]');
    await press('.trow.broken .open >> nth=0'); await p.waitForTimeout(450); await shot('5-repair');
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  } else {
    await p.evaluate(() => window.scrollTo(0, 500)); await p.waitForTimeout(250); await shot('4-scrolled'); await p.evaluate(() => window.scrollTo(0, 0));
  }
  await press('[data-act=fixall]:visible'); await p.waitForTimeout(500); await shot('6-fixed');
  await press('[data-act=play]:visible'); await p.waitForTimeout(500); await shot('7-result');
  await p.close();
}
await browser.close();
console.log('saved to', out);
