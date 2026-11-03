// Accessibility audit: axe-core in every app state (desktop and phone) plus keyboard and focus checks.
// Usage: node scripts/a11y.mjs [url]   (default: dist/index.html)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const url = process.argv[2] || pathToFileURL(resolve('dist/index.html')).href;
const axeSource = readFileSync(resolve('node_modules/axe-core/axe.min.js'), 'utf8');
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };

async function axe(page, label) {
  await page.evaluate(axeSource);
  const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
  const v = r.violations;
  ok(v.length === 0, `axe: ${label} (${r.passes.length} rules passed)`);
  for (const x of v) console.log(`      ${x.impact} ${x.id}: ${x.help}\n        ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

const browser = await chromium.launch();
for (const [name, width, height, phone] of [['desktop', 1280, 900, false], ['phone', 390, 844, true]]) {
  console.log(`\n--- ${name} ---`);
  const p = await browser.newPage({ viewport: { width, height }, hasTouch: phone, isMobile: phone });
  const press = (s) => (phone ? p.tap(s) : p.click(s));
  await p.goto(url); await p.waitForSelector('.team.pre');
  await axe(p, 'pre-toss');
  await press('[data-act=toss]:visible');
  // toss dialog: focus lands in it, page behind is inert, Escape closes it and returns focus to the content
  await p.waitForSelector('#coin');
  ok(await p.evaluate(() => document.activeElement?.id === 'coin'), 'toss dialog receives focus');
  ok(await p.evaluate(() => document.querySelector('.page').hasAttribute('inert')), 'page behind the toss dialog is inert');
  await p.keyboard.press('Escape'); await p.waitForSelector('#coin', { state: 'detached' });
  ok(await p.evaluate(() => document.activeElement?.id === 'teams-main'), 'focus moves to the team list after the toss dialog');
  ok(await p.evaluate(() => !document.querySelector('.page').hasAttribute('inert')), 'page is interactive again');
  await axe(p, 'after toss');
  if (phone) { await press('[data-tab=xi]'); await axe(p, 'Playing XIs tab'); await press('[data-tab=ask]'); await axe(p, 'Ask tab'); await press('[data-tab=teams]'); }
  // keyboard focus survives a re-render
  await p.focus('[data-lang=hinglish]:visible'); await p.keyboard.press('Enter');
  ok(await p.evaluate(() => document.activeElement?.dataset?.lang === 'hinglish'), 'focus stays on the language toggle after it re-renders the page');
  await p.keyboard.press('Enter');
  if (phone) {
    // sheet: opens with focus inside, traps Tab, Escape closes and returns focus to the row
    await p.focus('.mrows .trow.broken .open >> nth=0'); await p.keyboard.press('Enter');
    await p.waitForSelector('.sheet');
    ok(await p.evaluate(() => document.activeElement?.classList.contains('sheet')), 'sheet receives focus when opened');
    ok(await p.evaluate(() => document.querySelector('.page').hasAttribute('inert')), 'page behind the sheet is inert');
    for (let i = 0; i < 40; i++) await p.keyboard.press('Tab');
    ok(await p.evaluate(() => !!document.activeElement?.closest('.sheet')), 'Tab never leaves the sheet (40 presses)');
    await axe(p, 'repair sheet');
    await p.keyboard.press('Escape'); await p.waitForSelector('.sheet', { state: 'detached' });
    ok(await p.evaluate(() => document.activeElement?.dataset?.open === 't1'), 'focus returns to the row that opened the sheet');
    await p.focus('.mrows .trow.broken .qa >> nth=0'); await p.keyboard.press('Enter');
    ok(await p.evaluate(() => !!document.activeElement && document.activeElement !== document.body), 'focus is not dropped after a one-tap fix');
  } else {
    await p.focus('.dcards [data-apply="t1"]'); await p.keyboard.press('Enter');
    ok(await p.evaluate(() => document.activeElement?.dataset?.undo === 't1'), 'focus moves from Apply fix to Undo on the same team');
    await p.keyboard.press('Enter');
  }
  await press('[data-act=fixall]:visible'); await axe(p, 'after Fix all');
  await press('[data-act=play]:visible'); await p.waitForSelector('.fulltime'); await axe(p, 'full time result');
  if (phone) { await press('.mrows .trow.result .open >> nth=0'); await p.waitForSelector('.sheet'); await axe(p, 'result sheet'); }
  await p.close();
}
await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL ACCESSIBILITY CHECKS PASSED');
process.exit(failed ? 1 : 0);
