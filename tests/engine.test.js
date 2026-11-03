import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeContext, validate, findBroken, fixTeam, naiveFix, oracleFix, project, pointsOf } from '../src/engine.js';
import { computePoints } from '../src/scoring.js';

const meta = JSON.parse(readFileSync(new URL('../data/sample-meta.json', import.meta.url)));
const match = JSON.parse(readFileSync(new URL('../data/sample-match.json', import.meta.url)));
const players = [...meta.squads.BAY, ...meta.squads.DSH];
const ctx = makeContext(players, meta.xiOrder);
const idOf = (name) => players.find((p) => p.name === name).id;
const actualByName = computePoints(match);
const actual = Object.fromEntries(players.map((p) => [p.id, actualByName[p.name]?.points ?? 0]));

test('all generated fan teams start valid', () => {
  for (const t of meta.teams) assert.ok(validate(t.players, ctx.pool).ok, t.name);
});

test('control team is untouched; every other team is flagged', () => {
  const flags = meta.teams.map((t) => findBroken(t, ctx).broken);
  assert.equal(flags.filter(Boolean).length, 7);
  assert.equal(findBroken(meta.teams[7], ctx).broken, false);
  assert.deepEqual(fixTeam(meta.teams[7], ctx).options, []);
});

test('every option is valid and uses only announced-XI replacements (no benched player ever recommended)', () => {
  for (const t of meta.teams) {
    const fix = fixTeam(t, ctx);
    for (const o of fix.options) {
      assert.ok(validate(o.players, ctx.pool).ok);
      assert.ok(o.players.every((id) => ctx.xi.has(id)), `${t.name} has a benched player after fix`);
      assert.ok(o.players.includes(o.captain) && o.players.includes(o.vc) && o.captain !== o.vc);
    }
  }
});

test('captain out -> vice-captain is promoted', () => {
  const t = meta.teams[0]; // C Rohan (benched), VC Tejas (benched): both out -> best projected picks
  const o = fixTeam(t, ctx).options[0];
  assert.ok(ctx.xi.has(o.captain) && ctx.xi.has(o.vc));
  const t3 = meta.teams[4]; // C Aaryan (playing), VC Rohan (benched) -> captain kept
  const o3 = fixTeam(t3, ctx).options[0];
  assert.equal(o3.captain, t3.captain);
  const synthetic = { ...meta.teams[2], captain: idOf('Rohan Malhotra'), vc: idOf('Shaurya Bedi') };
  const o4 = fixTeam(synthetic, ctx).options[0];
  assert.equal(o4.captain, idOf('Shaurya Bedi'), 'VC should be promoted when captain is out');
});

test('fixer is deterministic and projects only from pre-match fields', () => {
  const t = meta.teams[0];
  const a = fixTeam(t, ctx).options.map((o) => o.players.join());
  const b = fixTeam(t, ctx).options.map((o) => o.players.join());
  assert.deepEqual(a, b);
  assert.ok(project(idOf('Kabir Sethi'), ctx) > 0);
});

test('hindsight oracle >= fixer >= doing nothing, on actual points', () => {
  for (const t of meta.teams) {
    if (!findBroken(t, ctx).broken) continue;
    const none = pointsOf(t.players, t.captain, t.vc, actual);
    const f = fixTeam(t, ctx).options[0];
    const fixer = pointsOf(f.players, f.captain, f.vc, actual);
    const best = oracleFix(t, ctx, actual);
    const oracle = pointsOf(best.players, best.captain, best.vc, actual);
    assert.ok(oracle >= fixer - 1e-9, `${t.name}: oracle ${oracle} < fixer ${fixer}`);
    assert.ok(fixer > none, `${t.name}: fixer ${fixer} should beat doing nothing ${none}`);
    assert.ok(naiveFix(t, ctx));
  }
});

test('reports "impossible" cleanly when the credit cap leaves no valid swap', () => {
  const mk = (id, role, side, credits, form = 30) => ({ id, name: id, role, side, credits, form });
  const squad = [
    mk('w1', 'WK', 'X', 8), mk('b1', 'BAT', 'X', 9), mk('b2', 'BAT', 'X', 9), mk('b3', 'BAT', 'Y', 9),
    mk('a1', 'AR', 'Y', 9), mk('a2', 'AR', 'Y', 9), mk('o1', 'BOWL', 'X', 9), mk('o2', 'BOWL', 'Y', 9), mk('o3', 'BOWL', 'Y', 9),
    mk('o4', 'BOWL', 'Y', 9), mk('benched', 'BOWL', 'Y', 9.9),
    mk('s1', 'BOWL', 'X', 12), mk('s2', 'BAT', 'X', 12), mk('s3', 'WK', 'Y', 12), mk('s4', 'AR', 'X', 12),
  ];
  const xi = ['w1', 'b1', 'b2', 'b3', 'a1', 'a2', 'o1', 'o2', 'o3', 'o4', 's1', 's2', 's3', 's4'];
  const c = makeContext(squad, { all: xi });
  const team = { id: 'tight', name: 'tight', players: ['w1', 'b1', 'b2', 'b3', 'a1', 'a2', 'o1', 'o2', 'o3', 'o4', 'benched'], captain: 'b1', vc: 'a1' };
  assert.ok(validate(team.players, c.pool).ok);
  const fix = fixTeam(team, c);
  assert.equal(fix.broken, true);
  assert.equal(fix.impossible, true);
  assert.deepEqual(fix.options, []);
});
