import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, buildReplay, buildFanTeams, inferRole, isEligible, matchStats, teamCode, ReplayError } from '../src/replay.js';
import { validate, makeContext, findBroken, fixTeam } from '../src/engine.js';
import { DATASETS, getDataset } from '../src/datasets.js';
import { explainItems, explain, ask } from '../src/server/handlers.js';

// ---- a tiny synthetic league in Cricsheet format -------------------------------------------------------------
const REDS = Array.from({ length: 14 }, (_, i) => `Red ${i + 1}`);
const BLUES = Array.from({ length: 14 }, (_, i) => `Blue ${i + 1}`);
const reg = (names) => Object.fromEntries(names.map((n) => [n, `id-${n.replace(' ', '')}`]));

/** Deterministic mini match: top six face 12 balls, the tail 6; the last six of each XI bowl; the first player of an XI keeps. */
function mkMatch(id, date, xiR, xiB, { boost = 0 } = {}) {
  const teams = ['Reds', 'Blues'];
  const innings = [['Reds', xiR, xiB], ['Blues', xiB, xiR]].map(([team, bat, bowl]) => {
    const keeper = bowl[0];
    const bowlers = bowl.slice(-6); // the 6th-last also bats a full innings, so he reads as an all-rounder
    const deliveries = [];
    bat.forEach((b, i) => {
      const balls = i >= 6 ? 6 : 12; // the tail faces few balls
      for (let k = 0; k < balls; k++) {
        const d = { batter: b, bowler: bowlers[(i + k) % 6], non_striker: bat[(i + 1) % bat.length], runs: { batter: 1 + ((i * 5 + k) % 4) + boost, extras: 0, total: 1 + ((i * 5 + k) % 4) + boost } };
        if (k === balls - 1 && i < 3) d.wickets = [{ player_out: b, kind: 'stumped', fielders: [{ name: keeper }] }];
        deliveries.push(d);
      }
    });
    const overs = [];
    for (let o = 0; o * 6 < deliveries.length; o++) overs.push({ over: o, deliveries: deliveries.slice(o * 6, o * 6 + 6) });
    return { team, overs };
  });
  return {
    id, info: { dates: [date], match_type: 'T20', gender: 'male', teams, players: { Reds: xiR, Blues: xiB }, registry: { people: reg([...xiR, ...xiB]) }, toss: { winner: 'Reds', decision: 'bat' }, outcome: { winner: 'Reds', by: { runs: 10 } }, venue: 'Test Ground', season: '2020', event: { name: 'Test League' } },
    innings,
  };
}
const xi = (names, skip = []) => names.filter((n) => !skip.includes(n)).slice(0, 11);
function league() {
  const ms = [];
  // earlier matches: all 14 appear over time; regulars 12 and 13 play the last two matches before the target
  ms.push(mkMatch('m1', '2020-04-01', xi(REDS), xi(BLUES)));
  ms.push(mkMatch('m2', '2020-04-03', xi(REDS), xi(BLUES)));
  ms.push(mkMatch('m3', '2020-04-05', REDS.slice(3, 14), BLUES.slice(3, 14)));
  ms.push(mkMatch('m4', '2020-04-07', REDS.slice(3, 14), BLUES.slice(3, 14)));
  ms.push(mkMatch('m5', '2020-04-09', REDS.slice(3, 14), BLUES.slice(3, 14)));
  ms.push(mkMatch('m6', '2020-04-11', REDS.slice(3, 14), BLUES.slice(3, 14)));
  ms.push(mkMatch('target', '2020-04-20', xi(REDS), xi(BLUES))); // Red 12, 13, 14 and Blue 12, 13, 14 are absent
  return ms;
}

test('teamCode makes a short unique-ish code from a team name', () => {
  assert.equal(teamCode('Gujarat Titans'), 'GT');
  assert.equal(teamCode('Royal Challengers Bangalore'), 'RCB');
  assert.equal(teamCode('Reds'), 'RED');
});

test('matchStats and inferRole: keepers are found by stumpings, bowlers by overs, openers by slot', () => {
  const m = mkMatch('x', '2020-01-01', xi(REDS), xi(BLUES));
  const s = matchStats(m);
  assert.equal(s['Blue 1'].stump, 3, 'Blue 1 is the keeper in the fixture');
  assert.ok(s['Red 11'].bowled >= 12, 'the tail bowls');
  assert.equal(s['Red 1'].pos, 1);
  const hist = (name) => Array.from({ length: 5 }, () => ({ ...s[name] }));
  assert.equal(inferRole(hist('Blue 1')), 'WK');
  assert.equal(inferRole(hist('Red 11')), 'BOWL');
  assert.equal(inferRole(hist('Red 2')), 'BAT');
  assert.equal(inferRole([]), 'BAT', 'no history defaults to BAT');
});

test('only matches with exactly 11 per side and a result are eligible', () => {
  const m = mkMatch('x', '2020-01-01', xi(REDS), xi(BLUES));
  assert.ok(isEligible(m));
  assert.ok(!isEligible({ ...m, info: { ...m.info, players: { Reds: REDS.slice(0, 12), Blues: xi(BLUES) } } }), 'a 12th (impact) player makes it ineligible');
  assert.ok(!isEligible({ ...m, info: { ...m.info, outcome: {} } }), 'no result');
});

test('replay: XI comes from the match, bench from earlier matches only, everything is valid and deterministic', () => {
  const index = buildIndex(league());
  const { meta } = buildReplay(index, 'target');
  const ctx = makeContext(Object.values(meta.squads).flat(), meta.xiOrder);
  const names = (side) => meta.xiOrder[side].map((id) => ctx.pool.get(id).name);
  assert.deepEqual(new Set([...names('RED'), ...names('BLU')]), new Set([...xi(REDS), ...xi(BLUES)]), 'the announced XI is the listed players');
  const bench = Object.values(meta.squads).flat().filter((p) => !ctx.xi.has(p.id)).map((p) => p.name);
  assert.ok(bench.length >= 3);
  for (const n of bench) assert.ok(![...xi(REDS), ...xi(BLUES)].includes(n) && /^(Red|Blue) (12|13|14)$/.test(n), `${n} is a regular from earlier matches who is absent today`);
  for (const t of meta.teams) assert.ok(validate(t.players, ctx.pool).ok, `${t.name} is a valid fantasy team`);
  assert.ok(meta.teams.some((t) => findBroken(t, ctx).broken), 'some fan teams are affected by absent regulars');
  assert.equal(findBroken(meta.teams.at(-1), ctx).broken, false, 'the control team is unaffected');
  assert.deepEqual(buildReplay(index, 'target').meta, meta, 'deterministic');
});

test('NO HINDSIGHT LEAKAGE: changing what happens in the target match changes nothing the fixer can see', () => {
  const a = buildReplay(buildIndex(league()), 'target');
  const altered = league().map((m) => (m.id === 'target' ? mkMatch('target', '2020-04-20', xi(REDS), xi(BLUES), { boost: 5 }) : m));
  const b = buildReplay(buildIndex(altered), 'target');
  assert.deepEqual(b.meta, a.meta, 'squads, form, roles, credits, batting slots, notes and fan teams are identical');
  assert.notDeepEqual(b.match.innings, a.match.innings, 'while the match itself (used only for evaluation) did change');
});

test('replay refuses to build when history is too thin or the match is ineligible', () => {
  const ms = league();
  assert.throws(() => buildReplay(buildIndex(ms), 'm2'), ReplayError, 'too few earlier matches');
  assert.throws(() => buildReplay(buildIndex(ms), 'nope'), ReplayError);
});

test('the fan-team generator always returns valid teams and keeps the control team clean', () => {
  const { meta } = buildReplay(buildIndex(league()), 'target');
  const players = Object.values(meta.squads).flat();
  const ids = Object.values(meta.xiOrder).flat();
  for (const seed of [1, 7, 42]) {
    const teams = buildFanTeams(players, ids, seed);
    const ctx = makeContext(players, meta.xiOrder);
    assert.equal(teams.length, 8);
    for (const t of teams) assert.ok(validate(t.players, ctx.pool).ok);
    assert.equal(findBroken(teams[7], ctx).broken, false);
  }
});

// ---- the committed real-match data ----------------------------------------------------------------------------
const replays = DATASETS.filter((d) => d.kind === 'replay');

test('there are real-match replays registered, and the sample is still the default', () => {
  assert.ok(replays.length >= 3);
  assert.equal(DATASETS[0].id, 'sample');
  assert.equal(getDataset('nope'), null);
});

for (const d of replays) {
  test(`replay ${d.id}: ${d.meta.source.label}`, () => {
    const { ctx, teams, meta, match } = d;
    for (const side of Object.keys(meta.sides)) assert.equal(meta.xiOrder[side].length, 11, 'announced XI has 11');
    assert.equal(match.info.teams.length, 2);
    for (const t of teams) assert.ok(validate(t.players, ctx.pool).ok, `${t.name} valid before the toss`);
    const broken = teams.filter((t) => findBroken(t, ctx).broken);
    assert.ok(broken.length >= 5 && broken.length < teams.length, `${broken.length} broken, with a control`);
    for (const t of broken) assert.ok(fixTeam(t, ctx).options.length > 0 || fixTeam(t, ctx).impossible);
    const actual = d.actualPoints();
    assert.ok(Object.values(actual).some((v) => v > 50), 'real points were computed from the real deliveries');
    assert.ok(meta.source.attribution.includes('Cricsheet') && meta.source.assumptions.length >= 4, 'attribution and assumptions are carried with the data');
    for (const p of Object.values(meta.squads).flat()) assert.ok(p.credits >= 6.5 && p.credits <= 11 && ['WK', 'BAT', 'AR', 'BOWL'].includes(p.role));
  });
}

// ---- server functions pick the dataset -----------------------------------------------------------------------
const post = (body) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const open = () => ({ explain: () => ({ ok: true }), ask: () => ({ ok: true }) });

test('explain facts are built from the requested dataset', () => {
  const r = replays[0];
  const items = explainItems(r);
  assert.ok(items.length >= 5);
  const text = JSON.stringify(items);
  assert.ok(text.includes(r.players.find((p) => !r.ctx.xi.has(p.id)).name.split(' ')[0]) || items[0].playersOut.length > 0);
  assert.ok(!text.includes('Rohan Malhotra'), 'no sample players leak into a replay');
});

test('API validates the match id and routes to the right dataset', async () => {
  const deps = { limiters: open(), fetchImpl: async () => { throw new Error('AI must not be called for a bad request'); } };
  assert.equal((await explain(post({ lang: 'en', match: 'nope' }), { env: { ANTHROPIC_API_KEY: 'k' }, deps })).status, 400);
  assert.equal((await explain(post({ lang: 'en', match: '../etc' }), { env: { ANTHROPIC_API_KEY: 'k' }, deps })).status, 400);
  assert.equal((await ask(post({ question: 'who is playing?', lang: 'en', match: 7 }), { env: { ANTHROPIC_API_KEY: 'k' }, deps })).status, 400);
  // a valid replay id reaches the model with replay facts and the real-match system prompt
  let sent;
  const fetchImpl = async (_u, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Fine.' }], stop_reason: 'end_turn' }) }; };
  const res = await ask(post({ question: 'who is playing?', lang: 'en', match: replays[0].id }), { env: { ANTHROPIC_API_KEY: 'k' }, deps: { ...deps, fetchImpl } });
  assert.equal(res.status, 200);
  assert.match(sent.system, /REAL past IPL match/);
});
