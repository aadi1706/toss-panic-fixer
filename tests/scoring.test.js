import test from 'node:test';
import assert from 'node:assert/strict';
import { computePoints, teamPoints } from '../src/scoring.js';

const mk = (deliveries) => ({
  info: { teams: ['A', 'B'], players: { A: ['Bat1', 'Bat2'], B: ['Bowl1', 'Fld1'] } },
  innings: [{ team: 'A', overs: [{ over: 0, deliveries }] }],
});
const d = (batter, runs, extra = {}) => ({ batter, bowler: 'Bowl1', non_striker: 'Bat2', runs: { batter: runs, extras: 0, total: runs }, ...extra });

test('runs, boundaries and playing XI points', () => {
  const m = mk([d('Bat1', 4), d('Bat1', 6), d('Bat1', 1)]);
  const p = computePoints(m);
  // playing 4 + runs 11 + boundaries (4 + 6)
  assert.equal(p.Bat1.points, 4 + 11 + 4 + 6);
  assert.equal(p.Bat2.points, 4); // played, did nothing
});

test('duck and bowler wicket with LBW bonus, catch credited to fielder', () => {
  const m = mk([
    d('Bat1', 0, { wickets: [{ player_out: 'Bat1', kind: 'lbw' }] }),
    d('Bat2', 0, { wickets: [{ player_out: 'Bat2', kind: 'caught', fielders: [{ name: 'Fld1' }] }] }),
  ]);
  const p = computePoints(m);
  assert.equal(p.Bat1.parts.duck, -2);
  assert.equal(p.Bowl1.parts.wickets, 25 * 2 + 8); // two wickets + one lbw bonus
  assert.equal(p.Fld1.parts.fielding, 8);
});

test('run out is not credited to the bowler', () => {
  const m = mk([d('Bat1', 0, { wickets: [{ player_out: 'Bat1', kind: 'run out', fielders: [{ name: 'Fld1' }] }] })]);
  const p = computePoints(m);
  assert.equal(p.Bowl1.parts.wickets, 0);
  assert.equal(p.Fld1.parts.fielding, 12);
});

test('wides do not count as balls faced; maiden needs six legal dot balls', () => {
  const dots = Array.from({ length: 6 }, () => d('Bat1', 0));
  const p = computePoints(mk(dots));
  assert.equal(p.Bowl1.parts.maidens, 12);
  const w = computePoints(mk([...dots, { ...d('Bat1', 0), extras: { wides: 1 }, runs: { batter: 0, extras: 1, total: 1 } }]));
  assert.equal(w.Bat1.line.balls, 6);
  assert.equal(w.Bowl1.parts.maidens, 0); // the wide cost a run
});

test('captain 2x and vice-captain 1.5x', () => {
  assert.equal(teamPoints(['a', 'b', 'c'], 'a', 'b', { a: 10, b: 10, c: 10 }), 20 + 15 + 10);
  assert.equal(teamPoints(['a', 'x'], 'a', 'x', { a: 10 }), 20); // benched player scores 0
});
