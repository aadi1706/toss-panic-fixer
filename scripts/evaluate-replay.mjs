// Measures the fixer across many REAL IPL matches (from a local Cricsheet archive; see build-replay.mjs).
// For each match and each of several generated fan-team sets (seeds) it compares, on actual fantasy points:
//   * doing nothing,  * the engine's best fix (pre-match form only),  * a naive baseline (most expensive valid replacement),
//   * the hindsight-best fix (an oracle that knows the points).
// Only numbers measured here are reported. Output: data/replay/aggregate.json
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { buildIndex, buildReplay, ReplayError, isEligible, mulberry32 } from '../src/replay.js';
import { makeContext, fixTeam, enumerateFixes, findBroken } from '../src/engine.js';
import { computePoints } from '../src/scoring.js';
import { evaluate } from '../src/evaluate.js';

const FROM = '2015-01-01', TO = '2022-12-31', SEEDS = [7, 11, 23];
const dir = new URL('../.cache/cricsheet-ipl/json/', import.meta.url);
const raw = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ id: f.replace('.json', ''), ...JSON.parse(readFileSync(new URL(f, dir), 'utf8')) }));
const index = buildIndex(raw);

const pct = (e) => { const gap = e.totals.hind - e.totals.none; return gap > 1e-9 ? ((e.totals.mine - e.totals.none) / gap) * 100 : null; };
const quant = (xs, q) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return null; const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };
const mean = (xs) => xs.reduce((a, c) => a + c, 0) / (xs.length || 1);
const r1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

const rows = [];
const skipped = {};
const candidates = index.matches.filter((m) => m.date >= FROM && m.date <= TO && isEligible(m));
for (const m of candidates) {
  for (const seed of SEEDS) {
    let built;
    try { built = buildReplay(index, m.id, { seed }); } catch (e) {
      if (!(e instanceof ReplayError)) throw e;
      const why = e.message.replace(/\(.*\)/, '').replace(/\d+/g, 'N').trim();
      skipped[why] = (skipped[why] || 0) + 1; continue;
    }
    const { meta, match } = built;
    const players = Object.values(meta.squads).flat();
    const ctx = makeContext(players, meta.xiOrder);
    const byName = computePoints(match);
    const actual = Object.fromEntries(players.map((p) => [p.id, byName[p.name]?.points ?? 0]));
    const engine = new Map(), naive = new Map();
    for (const t of meta.teams) {
      if (!findBroken(t, ctx).broken) continue;
      const f = fixTeam(t, ctx).options[0]; if (f) engine.set(t.id, f);
      const n = enumerateFixes(t, ctx, (id) => ctx.pool.get(id).credits, { top: 1 })[0]; if (n) naive.set(t.id, n);
    }
    const eE = evaluate(meta.teams, engine, ctx, actual), eN = evaluate(meta.teams, naive, ctx, actual);
    rows.push({ id: m.id, season: String(m.info.season), seed, broken: meta.teams.filter((t) => findBroken(t, ctx).broken).length, none: eE.totals.none, engine: eE.totals.mine, naive: eN.totals.mine, hind: eE.totals.hind, recEngine: pct(eE), recNaive: pct({ totals: { none: eE.totals.none, mine: eN.totals.mine, hind: eE.totals.hind } }) });
  }
}

// one number per match (average over the seeds), so matches are the unit of analysis
const byMatch = new Map();
for (const r of rows) { const a = byMatch.get(r.id) || []; a.push(r); byMatch.set(r.id, a); }
const perMatch = [...byMatch.entries()].map(([id, rs]) => ({ id, season: rs[0].season, recEngine: mean(rs.filter((r) => r.recEngine !== null).map((r) => r.recEngine)), recNaive: mean(rs.filter((r) => r.recNaive !== null).map((r) => r.recNaive)), engineGain: mean(rs.map((r) => r.engine - r.none)), naiveGain: mean(rs.map((r) => r.naive - r.none)), hindGain: mean(rs.map((r) => r.hind - r.none)) })).filter((r) => Number.isFinite(r.recEngine) && Number.isFinite(r.recNaive));

// bootstrap the mean over matches (seeded), for an honest confidence interval
const rng = mulberry32(2026);
const boot = (xs) => { const ms = []; for (let b = 0; b < 4000; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[xs.length > 0 ? Math.floor(rng() * xs.length) : 0]; ms.push(s / xs.length); } return [quant(ms, 0.025), quant(ms, 0.975)]; };
const eng = perMatch.map((r) => r.recEngine), nai = perMatch.map((r) => r.recNaive);
const diff = perMatch.map((r) => r.recEngine - r.recNaive);
const seasons = [...new Set(perMatch.map((r) => r.season))].sort();
const out = {
  method: 'For each real IPL match, 3 generated sets of 8 fantasy teams (seeds). Recommendations use only pre-match information. Points are Dream11-style approximations computed from the real deliveries.',
  range: `${FROM} to ${TO}`, source: 'Cricsheet.org (ODC-By)',
  eligibleMatches: candidates.length, matches: perMatch.length, runs: rows.length, skipped, seasons,
  engine: { meanRecovered: r1(mean(eng)), medianRecovered: r1(quant(eng, 0.5)), p25: r1(quant(eng, 0.25)), p75: r1(quant(eng, 0.75)), ci95: boot(eng).map(r1), positiveShare: r1(100 * eng.filter((v) => v > 0).length / eng.length), meanPointsGainedPerRun: r1(mean(perMatch.map((r) => r.engineGain))) },
  naiveMostExpensive: { meanRecovered: r1(mean(nai)), medianRecovered: r1(quant(nai, 0.5)), ci95: boot(nai).map(r1), meanPointsGainedPerRun: r1(mean(perMatch.map((r) => r.naiveGain))) },
  engineMinusNaive: { meanPercentagePoints: r1(mean(diff)), ci95: boot(diff).map(r1), engineBetterShare: r1(100 * diff.filter((v) => v > 0).length / diff.length) },
  caveats: [
    'Credits are approximated from pre-match form in these replays, so the "most expensive replacement" baseline is effectively a form baseline and strong by construction.',
    'Fantasy teams are generated; a real fan\'s teams would differ.',
    'Points use an approximation of Dream11 T20 scoring, computed from the real deliveries.',
    'Matches are skipped when a valid pool cannot be built (role mix, credit cap) or earlier history is thin; the skip counts are listed above.',
    'Only IPL matches with exactly 11 listed per side (2015 to 2022) are used, to avoid impact-player leakage.',
  ],
  hindsightMeanPointsGainedPerRun: r1(mean(perMatch.map((r) => r.hindGain))),
  bySeason: Object.fromEntries(seasons.map((s) => { const xs = perMatch.filter((r) => r.season === s); return [s, { matches: xs.length, meanRecovered: r1(mean(xs.map((r) => r.recEngine))) }]; })),
};
writeFileSync(new URL('../data/replay/aggregate.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
