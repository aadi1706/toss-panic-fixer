import test from 'node:test';
import assert from 'node:assert/strict';
import { ctx, teams, actualPoints } from '../src/data.js';
import { fixTeam } from '../src/engine.js';
import { evaluate } from '../src/evaluate.js';
import { explainTemplate, noFixText } from '../src/explain.js';

const actual = actualPoints();
const bestFixes = () => new Map(teams.map((t) => [t.id, fixTeam(t, ctx).options[0]]).filter(([, o]) => o));

test('no fixes applied: mine equals no-action and recovered is 0%', () => {
  const e = evaluate(teams, new Map(), ctx, actual);
  assert.equal(e.totals.mine, e.totals.none);
  assert.equal(e.recovered, 0);
});

test('fix all: none <= mine <= hindsight, and recovered is between 0 and 100', () => {
  const e = evaluate(teams, bestFixes(), ctx, actual);
  assert.ok(e.totals.none < e.totals.mine && e.totals.mine <= e.totals.hind);
  assert.ok(e.recovered > 0 && e.recovered <= 100);
});

test('unaffected control team is identical in all three columns', () => {
  const e = evaluate(teams, bestFixes(), ctx, actual);
  const ctrl = e.rows[7];
  assert.equal(ctrl.none, ctrl.mine);
  assert.equal(ctrl.none, ctrl.hind);
});

test('template explanations are two sentences in both languages and name the facts', () => {
  const t = teams[0];
  const fix = fixTeam(t, ctx);
  for (const lang of ['en', 'hinglish']) {
    const text = explainTemplate(t, fix, fix.options[0], ctx, lang);
    assert.equal(text.split(/(?<=\.)\s+/).length, 2, text);
    for (const id of fix.out) assert.ok(text.includes(ctx.pool.get(id).name));
  }
});

test('no-fix text mentions the out player', () => {
  const fix = { out: [teams[0].players[0]] };
  assert.ok(noFixText(teams[0], fix, ctx).includes(ctx.pool.get(fix.out[0]).name));
});
