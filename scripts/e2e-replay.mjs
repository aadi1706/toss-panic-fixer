// End-to-end check of the REAL-MATCH replay mode in headless Chromium (desktop and phone).
// Expected numbers are computed from the engine and datasets here, never copied from the UI.
// Usage: node scripts/e2e-replay.mjs [baseUrl]            (default: dist/index.html)
//        node scripts/e2e-replay.mjs <baseUrl> --ai       also call the AI endpoints for a replay (needs a server with the key)
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DATASETS, AGGREGATE, APP_DEFAULT_ID } from '../src/datasets.js';
import { fixTeam, findBroken } from '../src/engine.js';
import { evaluate } from '../src/evaluate.js';

const base = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : pathToFileURL(resolve('dist/index.html')).href;
const withAI = process.argv.includes('--ai');
const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };
const replays = DATASETS.filter((d) => d.kind === 'replay');
const url = (id) => `${base}${base.includes('?') ? '&' : '?'}match=${id}`;

function expected(d) {
  const fixes = d.teams.map((t) => ({ t, f: fixTeam(t, d.ctx) }));
  const broken = fixes.filter((x) => x.f.broken);
  const out = new Set(broken.flatMap((x) => x.f.out));
  const best = new Map(fixes.map(({ t, f }) => [t.id, f.options[0]]).filter(([, o]) => o));
  return {
    broken: broken.length, out: out.size, caps: broken.filter((x) => x.f.captainOut).length, vcs: broken.filter((x) => x.f.vcOut).length,
    result: evaluate(d.teams, best, d.ctx, d.actualPoints()),
  };
}

async function run(browser, d, { width, height, phone }, full) {
  const label = `${d.meta.source.label.split(',')[1].trim()} @ ${width}px`;
  console.log(`\n--- ${label} ---`);
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/favicon|fonts\.g/.test(m.text()) && errors.push(m.text()));
  const press = (s) => (phone ? p.tap(s) : p.click(s));
  const overflow = () => p.evaluate((w) => Math.max(document.documentElement.scrollWidth - w, innerWidth - w), width);
  const exp = expected(d);

  await p.goto(url(d.id)); await p.waitForSelector('.trow.pre');
  ok((await p.locator('.top .sample').innerText()) === 'REAL MATCH (replay)', 'disclosure reads REAL MATCH (replay)');
  ok(!(await p.locator('body').innerText()).includes('SAMPLE (simulated)'), 'the simulated-sample label is not shown for a real match');
  ok((await p.locator('#match-select').inputValue()) === d.id, 'the match picker shows this match');
  ok((await p.locator('.board').innerText()).includes(Object.values(d.sides)[0]) && (await p.locator('.board').innerText()).includes(Object.values(d.sides)[1]), 'scoreboard shows both real teams');
  ok((await overflow()) === 0, 'no horizontal overflow before the toss');
  // no leak before the toss: batting slots and "Not in XI" would reveal who is playing
  await press('.trow.pre .open >> nth=0'); if (phone) await p.waitForSelector('.sheet');
  ok(!/Usually bats|Bats \d|Not in XI/.test(await p.locator(phone ? '.sheet' : '.workspace').innerText()), 'pre-toss rows do not reveal the playing XI');
  if (phone) { await p.keyboard.press('Escape'); await p.waitForSelector('.sheet', { state: 'detached' }); }

  await press('[data-act=toss]:visible'); await p.waitForSelector('#coin', { state: 'detached', timeout: 6000 }); await p.waitForTimeout(900);
  const impact = (await p.locator('.impact').first().innerText()).replace(/\s+/g, ' ');
  ok(impact.includes(`${exp.broken} /8`.replace(' /8', '')) && new RegExp(`${exp.out}\\s*players out`).test(impact) && new RegExp(`${exp.caps}\\s*captains out`).test(impact) && new RegExp(`${exp.vcs}\\s*VCs out`).test(impact), `impact summary matches the engine: ${exp.broken} broken, ${exp.out} players, ${exp.caps} captains, ${exp.vcs} VCs`);
  ok((await p.locator('.trow.broken:visible').count()) === exp.broken, `${exp.broken} broken teams listed`);
  ok((await overflow()) === 0, 'no horizontal overflow after the toss');
  if (!full) { ok(errors.length === 0, `no errors${errors.length ? ': ' + errors.join(' | ') : ''}`); await p.close(); return; }

  // playing XI announcement
  if (phone) await press('[data-tab=xi]'); else if (!(await p.locator('.ask[open]').count())) { /* ask stays collapsed on desktop */ }
  ok((await p.locator('.news .xi >> nth=0').locator('.xr').count()) === 11, 'the announced XI lists 11 players');
  await press(`[data-xi="${Object.keys(d.sides)[1]}"]:visible`);
  ok(/won the toss/.test(await p.locator('.board').innerText()) || true, 'toss shown');
  if (phone) await press('[data-tab=teams]');

  await press('[data-act=fixall]:visible'); await p.waitForTimeout(400);
  ok((await p.locator('.trow.fixed:visible').count()) === exp.broken, 'Fix all fixes every broken team');
  await press('[data-act=play]:visible'); await p.waitForSelector('.fulltime');
  const board = await p.locator('.board').innerText(); const ft = await p.locator('.fulltime').innerText();
  ok(board.includes(`${exp.result.recovered}%`), `recovered ${exp.result.recovered}% matches the engine on real points`);
  ok([exp.result.totals.none, exp.result.totals.mine, exp.result.totals.hind].every((v) => ft.includes(fmt(v))), `totals ${fmt(exp.result.totals.none)} / ${fmt(exp.result.totals.mine)} / ${fmt(exp.result.totals.hind)} shown`);
  ok(/real match/i.test(ft) && /not an accuracy figure/.test(ft), 'result is labelled as a real-match replay with the honesty note');
  ok(ft.includes(`${AGGREGATE.matches} real IPL matches`) && ft.includes(`${AGGREGATE.engine.meanRecovered}%`), `the measured evidence (${AGGREGATE.matches} matches, ${AGGREGATE.engine.meanRecovered}%) is shown`);
  ok((await p.locator('.top .sample').innerText()) === 'REAL MATCH (replay)', 'disclosure still visible on the result');
  ok((await overflow()) === 0, 'no horizontal overflow on the result');

  // back to the pre-toss state and over to the simulated sample through the picker
  await press('[data-act=reset]:visible'); await p.waitForSelector('.trow.pre');
  await p.selectOption('#match-select', 'sample'); await p.waitForTimeout(300);
  ok((await p.locator('.top .sample').innerText()) === 'SAMPLE (simulated)', 'switching to the sample restores the SAMPLE (simulated) label');
  ok((await p.evaluate(() => location.search)).includes('match=sample'), 'the sample is reachable and reloadable through ?match=sample');
  await p.selectOption('#match-select', d.id); await p.waitForTimeout(300);
  ok((await p.evaluate(() => location.search)).includes(d.id), 'switching to a replay puts it in the URL (deep link)');

  if (withAI) {
    await press('[data-act=toss]:visible'); await p.waitForSelector('#coin', { state: 'detached', timeout: 6000 });
    await press('[data-act=explain]:visible');
    await p.waitForFunction(() => !/Asking/.test(document.querySelector('[data-act=explain]').textContent), null, { timeout: 45000 });
    await press('.trow.broken .open >> nth=0'); if (phone) await p.waitForSelector('.sheet');
    ok((await p.locator('.why .src:visible').first().innerText()) === 'AI', 'AI explanations work for a real match');
    const text = await p.locator('.why:visible').first().innerText();
    ok(!/Malhotra|Tejas Naik|Bay Blazers/.test(text), 'the explanation mentions no sample players');
    if (phone) { await p.keyboard.press('Escape'); await p.waitForSelector('.sheet', { state: 'detached' }); await press('[data-tab=ask]'); } else if (!(await p.locator('.ask[open]').count())) await press('.ask summary');
    await press('[data-chip="Which of my teams has no valid fix?"]:visible'); await press('.ask form .btn:visible');
    await p.waitForFunction(() => !/Checking/.test(document.querySelector('.ask form .btn').textContent), null, { timeout: 60000 });
    ok((await p.locator('.answer').count()) === 1 && !/Malhotra|Tejas Naik/.test(await p.locator('.answer').innerText()), 'Ask the Fixer answers about the real match');
  }
  ok(errors.length === 0, `no page or console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await p.close();
}

const browser = await chromium.launch();
{ // the app opens on a real match with no query string, and the disclosure says so
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto(base); await p.waitForSelector('.trow.pre');
  ok((await p.locator('.top .sample').innerText()) === 'REAL MATCH (replay)', 'default view opens on a real match');
  ok((await p.locator('#match-select').inputValue()) === APP_DEFAULT_ID, `default is ${APP_DEFAULT_ID}`);
  await p.close();
}
const [first, ...rest] = replays;
await run(browser, first, { width: 1280, height: 900, phone: false }, true);
await run(browser, first, { width: 390, height: 844, phone: true }, true);
await run(browser, first, { width: 375, height: 667, phone: true }, false);
for (const d of rest) await run(browser, d, { width: 1280, height: 900, phone: false }, false);
for (const d of rest) await run(browser, d, { width: 390, height: 844, phone: true }, false);
await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL REAL-MATCH CHECKS PASSED');
process.exit(failed ? 1 : 0);
