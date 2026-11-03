// End-to-end regression check in headless Chromium: toss -> fixes -> match -> result, on desktop and
// two phone widths. Expected numbers are computed here from the engine, not copied from the UI.
// Usage: node scripts/e2e.mjs [url]            (default: dist/index.html)
//        node scripts/e2e.mjs <url> --ai       also exercise the AI endpoints (needs a server with the key)
//        node scripts/e2e.mjs <url> --fallback also check the no-AI fallback (needs a server without the key)
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { teams, ctx, actualPoints } from '../src/data.js';
import { fixTeam } from '../src/engine.js';
import { evaluate } from '../src/evaluate.js';

const url = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : pathToFileURL(resolve('dist/index.html')).href;
const withAI = process.argv.includes('--ai');
const fallback = process.argv.includes('--fallback');

const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const actual = actualPoints();
const bestAll = new Map(teams.map((t) => [t.id, fixTeam(t, ctx).options[0]]).filter(([, o]) => o));
const expectFixAll = evaluate(teams, bestAll, ctx, actual);
const expectNone = evaluate(teams, new Map(), ctx, actual);

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };

async function scenario(browser, label, { width, height, phone }) {
  console.log(`\n--- ${label} ---`);
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  // In --fallback mode the server is deliberately down, so the browser's own 502 log line is expected.
  p.on('console', (m) => m.type() === 'error' && !/favicon|fonts\.g/.test(m.text()) && !(fallback && /status of 502/.test(m.text())) && errors.push(m.text()));
  const press = (sel) => (phone ? p.tap(sel) : p.click(sel));
  const count = (sel) => p.locator(sel).filter({ visible: true }).count();
  const overflow = () => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const toss = async () => { await press('[data-act=toss]:visible'); await p.waitForSelector('#coin', { state: 'detached', timeout: 6000 }); };
  const fresh = async () => { await p.goto(url); await p.waitForSelector('.trow.pre'); };
  const broken = '.trow.broken', fine = '.trow.fine', fixed = '.trow.fixed';
  // Open a team: a bottom sheet on phones, the workspace on desktop.
  const openTeam = async (name) => { await press(`.trow:has-text("${name}") .open`); if (phone) await p.waitForSelector('.sheet'); };
  const t1 = () => openTeam('Powerplay Pandits');
  const closeSheet = async () => { if (phone && (await p.locator('.sheet').count())) { await p.keyboard.press('Escape'); await p.waitForSelector('.sheet', { state: 'detached' }); } };

  // pre-toss
  await fresh();
  ok((await count('.trow.pre')) === 8, 'pre-toss shows all 8 fantasy teams');
  await press('.trow.pre .open >> nth=0'); if (phone) await p.waitForSelector('.sheet');
  ok(!/\bBats \d|Not in XI/.test(await p.locator(phone ? '.sheet' : '.workspace').innerText()), 'pre-toss player rows do not reveal the playing XI (no batting slots, no "Not in XI")');
  await closeSheet();
  ok(await p.locator('.sample:visible').first().isVisible(), 'SAMPLE (simulated) label visible');
  ok((await p.textContent('.top')).includes('SAMPLE (simulated)'), 'label text is exactly "SAMPLE (simulated)"');
  ok((await count('.tabs')) === (0), 'no tabs before the toss');
  ok((await overflow()) === 0, 'no horizontal overflow (pre-toss)');

  // toss
  await toss();
  await p.waitForTimeout(900); // the impact numbers count up for 0.7s after the toss
  const impact = await p.locator('.impact').first().innerText();
  ok(/7\s*\/8/.test(impact) && /7\s*players out/i.test(impact) && /3\s*captains out/i.test(impact) && /3\s*VCs out/i.test(impact) && /1 team is fine/.test(impact), 'impact summary: 7/8 teams, 7 players, 3 captains, 3 VCs, 1 fine');
  ok((await p.locator('.impact').first().boundingBox()).y + 120 < height, 'impact summary visible without scrolling');
  ok((await count(broken)) === 7 && (await count(fine)) === 1, '7 broken and 1 fine team shown');
  ok((await count(phone ? '.tabs' : '.news')) > 0, phone ? 'tabs visible on phone' : 'playing XIs and toss report visible on desktop');
  ok((await overflow()) === 0, 'no horizontal overflow (post-toss)');

  // interactions
  if (phone) {
    await t1();
    ok(await p.evaluate(() => !!history.state?.sheet), 'sheet open and pushed to history');
    await press('.sheet [data-opt="t1:1"]');
    ok((await p.getAttribute('.sheet [data-opt="t1:1"]', 'aria-pressed')) === 'true', 'option 2 selectable in sheet');
    await p.goBack(); await p.waitForSelector('.sheet', { state: 'detached' });
    ok(true, 'browser back closes the sheet');
    await t1(); await p.mouse.click(width / 2, 20); await p.waitForSelector('.sheet', { state: 'detached' });
    ok(true, 'backdrop tap closes the sheet');
    await t1(); await press('.sheet [data-apply]');
    await p.waitForSelector('.sheet', { state: 'detached' });
    ok(/Powerplay Pandits fixed/.test(await p.textContent('#toast')), 'apply from sheet closes it and shows a toast');
  } else {
    ok((await p.locator('.workspace h2').innerText()) === 'Powerplay Pandits', 'workspace starts on the first broken team');
    await p.click('.workspace [data-opt="t1:1"]');
    ok((await p.getAttribute('.workspace [data-opt="t1:1"]', 'aria-pressed')) === 'true', 'option 2 selectable');
    await p.click('.workspace [data-opt="t1:0"]');
    await openTeam('Super Over Squad');
    ok((await p.locator('.workspace h2').innerText()) === 'Super Over Squad', 'selecting a team in the ledger switches the workspace');
    await openTeam('Powerplay Pandits');
    await p.click('.workspace [data-apply="t1"]');
    ok((await p.locator('.workspace h2').innerText()) === 'Super Over Squad', 'after applying, the workspace advances to the next unfixed team');
  }
  ok((await count(fixed)) === 1, 'applying one fix marks exactly that team as fixed');
  ok(/Fix all \(6\)/.test(await p.textContent('[data-act=fixall]:visible')), 'Fix all counter drops to 6');
  await t1();
  await press((phone ? '.sheet' : '.workspace') + ' [data-undo="t1"]');
  await closeSheet();
  ok((await count(fixed)) === 0 && /Fix all \(7\)/.test(await p.textContent('[data-act=fixall]:visible')), 'undo restores the team and the counter');
  await press('[data-lang=hinglish]:visible');
  await t1();
  ok(/playing XI mein nahi/.test(await p.locator('.why:visible').first().innerText()), 'Hinglish toggle changes the explanation');
  await closeSheet();
  await press('[data-lang=en]:visible');
  // no-valid-fix path through the real render code
  await p.evaluate(() => { const f = window.__tpf.state.fixes.get('t3'); window.__tpf.state.fixes.set('t3', { ...f, options: [], impossible: true }); });
  await press('[data-lang=hinglish]:visible'); await press('[data-lang=en]:visible');
  await openTeam('Yorker Yodhas');
  ok((await count('.nofix')) === 1, 'no-valid-fix team shows the "No valid fix" explanation');
  await closeSheet();

  // flow B: fix all -> play -> result (fresh page so earlier edits cannot leak)
  await fresh(); await toss();
  await press('[data-act=fixall]:visible');
  ok((await count(fixed)) === 7 && (await count(fine)) === 1, 'Fix all fixes all 7 broken teams, leaves the control team');
  ok(await p.locator('[data-act=fixall]:visible').isDisabled(), 'Fix all disabled when nothing is left');
  await press('[data-act=play]:visible');
  await p.waitForSelector('.fulltime');
  const ft = (await p.locator('.board').innerText()) + (await p.locator('.fulltime').innerText());
  ok(ft.includes(`${expectFixAll.recovered}%`), `recovered ${expectFixAll.recovered}% matches the engine-computed value`);
  ok([expectFixAll.totals.none, expectFixAll.totals.mine, expectFixAll.totals.hind].every((v) => ft.includes(fmt(v))), `totals ${fmt(expectFixAll.totals.none)} / ${fmt(expectFixAll.totals.mine)} / ${fmt(expectFixAll.totals.hind)} shown`);
  ok(ft.includes('SAMPLE (simulated)') && /not a real-world accuracy figure/.test(ft), 'result is labelled SAMPLE (simulated) with the honesty note');
  ok((await count('.trow.result')) === 8, 'result lists all 8 teams');
  ok(/no change/.test(await p.locator('.rows').innerText()), 'control team shows no change');
  ok((await overflow()) === 0, 'no horizontal overflow (result)');
  await press('.trow.result .open >> nth=0'); if (phone) await p.waitForSelector('.sheet');
  ok(/Without fixing/.test(await p.locator((phone ? '.sheet' : '.workspace') + ' .score').innerText()), 'team detail shows the three-way scorecard');
  await closeSheet();

  // start over
  await press('[data-act=reset]:visible');
  await p.waitForSelector('.trow.pre');
  const st = await p.evaluate(() => ({ applied: window.__tpf.state.applied.size, phase: window.__tpf.state.phase, result: window.__tpf.state.result }));
  ok(st.phase === 'pre' && st.applied === 0 && st.result === null, 'Start over resets all state');

  // flow C: play without fixing
  await toss(); await press('[data-act=play]:visible'); await p.waitForSelector('.fulltime');
  const ft0 = (await p.locator('.board').innerText()) + (await p.locator('.fulltime').innerText());
  ok(ft0.includes('0%') && ft0.includes(fmt(expectNone.totals.none)), `playing without fixing: 0% recovered, total ${fmt(expectNone.totals.none)}`);

  // AI
  if (withAI || fallback) {
    await fresh(); await toss();
    await press('[data-act=explain]:visible');
    await p.waitForFunction(() => !/Asking/.test(document.querySelector('[data-act=explain]').textContent), null, { timeout: 45000 });
    await t1();
    const src = await p.locator('.why .src:visible').first().innerText();
    if (withAI) ok(src === 'AI', 'Explain with AI: explanations come from the model');
    else ok(src === 'Built-in' && (await count('.aierr')) > 0, 'AI down: clear notice and built-in explanations stay');
    await closeSheet();
    if (phone) await press('[data-tab=ask]');
    await press('[data-chip="Which of my teams has no valid fix?"]:visible');
    await press('.ask form .btn:visible');
    await p.waitForFunction(() => !/Checking/.test(document.querySelector('.ask form .btn').textContent), null, { timeout: 60000 });
    if (withAI) ok((await p.locator('.answer').count()) === 1 && /overview_all_teams|get_team|simulate_swap/.test(await p.locator('.answer').innerText()), 'Ask the Fixer: answer shown with the engine tools it used');
    else ok((await count('.ask .aierr')) === 1 && (await p.locator('.answer').count()) === 0, 'AI down: Ask shows an error, app keeps working');
  }

  ok(errors.length === 0, `no page or console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await p.close();
}

const browser = await chromium.launch();
await scenario(browser, 'desktop 1280x900', { width: 1280, height: 900, phone: false });
await scenario(browser, 'phone 390x844', { width: 390, height: 844, phone: true });
await scenario(browser, 'phone 375x667', { width: 375, height: 667, phone: true });
await browser.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
