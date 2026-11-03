// Generates a SIMULATED T20 match in Cricsheet JSON format (fictional players)
// plus squads and a set of fan teams. Deterministic: same seed -> same output.
// Usage: node scripts/gen-sample.mjs [seed]
import { writeFileSync, mkdirSync } from 'node:fs';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// name, role, bat skill, bowl skill, credits, form (avg fantasy pts, last 5 matches)
const BAY = [
  ['Kabir Sethi', 'WK', 0.72, 0, 9.0, 41],
  ['Ishaan Dutta', 'WK', 0.55, 0, 7.5, 22],
  ['Rohan Malhotra', 'BAT', 0.85, 0, 10.0, 52],
  ['Vihaan Kulkarni', 'BAT', 0.78, 0, 9.0, 38],
  ['Tanmay Bhide', 'BAT', 0.66, 0, 8.0, 30],
  ['Dev Chauhan', 'BAT', 0.6, 0, 7.5, 24],
  ['Aryan Nair', 'BAT', 0.7, 0, 8.5, 33],
  ['Siddharth Rao', 'AR', 0.7, 0.65, 9.5, 46],
  ['Yash Thakur', 'AR', 0.55, 0.6, 8.5, 34],
  ['Neel Gokhale', 'AR', 0.5, 0.55, 7.5, 26],
  ['Harsh Menon', 'BOWL', 0.2, 0.85, 9.0, 44],
  ['Pranav Iyer', 'BOWL', 0.2, 0.75, 8.5, 36],
  ['Zaid Qureshi', 'BOWL', 0.18, 0.7, 8.0, 31],
  ['Omkar Patwardhan', 'BOWL', 0.25, 0.6, 7.0, 22],
  ['Reyansh Bajaj', 'BOWL', 0.2, 0.65, 7.5, 25],
];
const DSH = [
  ['Aaryan Bhatt', 'WK', 0.8, 0, 9.5, 48],
  ['Mohit Saxena', 'WK', 0.5, 0, 7.5, 20],
  ['Shaurya Bedi', 'BAT', 0.82, 0, 9.5, 45],
  ['Lakshya Pillai', 'BAT', 0.75, 0, 9.0, 37],
  ['Ritvik Anand', 'BAT', 0.68, 0, 8.0, 29],
  ['Kunal Deshmukh', 'BAT', 0.62, 0, 7.5, 25],
  ['Madhav Joshi', 'BAT', 0.7, 0, 8.5, 32],
  ['Ayaan Farooqui', 'AR', 0.75, 0.7, 10.0, 50],
  ['Samar Khanna', 'AR', 0.6, 0.6, 8.5, 33],
  ['Parth Gill', 'AR', 0.5, 0.5, 7.5, 24],
  ['Tejas Naik', 'BOWL', 0.15, 0.88, 9.5, 47],
  ['Rudra Hegde', 'BOWL', 0.2, 0.76, 8.5, 38],
  ['Imran Sheikh', 'BOWL', 0.2, 0.72, 8.0, 32],
  ['Varun Lal', 'BOWL', 0.15, 0.62, 7.0, 21],
  ['Atharv Mishra', 'BOWL', 0.2, 0.66, 7.0, 23],
  ['Jay Solanki', 'BOWL', 0.15, 0.6, 6.5, 18],
];

// Announced XIs, in batting order. Everyone else is benched at the toss.
const XI_BAY = ['Kabir Sethi', 'Vihaan Kulkarni', 'Aryan Nair', 'Tanmay Bhide', 'Siddharth Rao', 'Yash Thakur', 'Neel Gokhale', 'Omkar Patwardhan', 'Pranav Iyer', 'Zaid Qureshi', 'Harsh Menon'];
const XI_DSH = ['Shaurya Bedi', 'Aaryan Bhatt', 'Lakshya Pillai', 'Ayaan Farooqui', 'Madhav Joshi', 'Ritvik Anand', 'Samar Khanna', 'Atharv Mishra', 'Imran Sheikh', 'Rudra Hegde', 'Varun Lal'];
// Bowling quotas (overs) per team (must sum to 20)
const QUOTA_BAY = { 'Harsh Menon': 4, 'Pranav Iyer': 4, 'Zaid Qureshi': 4, 'Omkar Patwardhan': 4, 'Siddharth Rao': 2, 'Yash Thakur': 2 };
const QUOTA_DSH = { 'Rudra Hegde': 4, 'Imran Sheikh': 4, 'Atharv Mishra': 4, 'Varun Lal': 4, 'Ayaan Farooqui': 2, 'Samar Khanna': 2 };

function mkSquad(rows, side) {
  return rows.map(([name, role, bat, bowl, credits, form]) => ({ id: slug(name), name, role, bat, bowl, credits, form, side }));
}

function simulateInnings(rng, batTeam, bowlTeam, batXI, bowlXI, quota, target) {
  const byName = (arr) => Object.fromEntries(arr.map((p) => [p.name, p]));
  const bats = byName(batTeam), bowls = byName(bowlTeam);
  const keeper = bowlXI.find((n) => bowls[n].role === 'WK');
  const overs = [];
  let wk = 0, runs = 0, next = 2, striker = batXI[0], non = batXI[1];
  const left = { ...quota };
  let prevBowler = null;
  for (let o = 0; o < 20 && wk < 10; o++) {
    const elig = Object.keys(left).filter((b) => left[b] > 0 && b !== prevBowler);
    const pool = elig.length ? elig : Object.keys(left).filter((b) => left[b] > 0);
    const bowler = pool[Math.floor(rng() * pool.length)];
    left[bowler]--; prevBowler = bowler;
    const w = bowls[bowler].bowl;
    const del = [];
    let legal = 0;
    while (legal < 6 && wk < 10) {
      const b = bats[striker].bat;
      const phase = o < 6 ? 1.05 : o >= 16 ? 1.3 : 1.0;
      const rec = { batter: striker, bowler, non_striker: non, runs: { batter: 0, extras: 0, total: 0 } };
      const r = rng();
      if (r < 0.03) { rec.runs = { batter: 0, extras: 1, total: 1 }; rec.extras = { wides: 1 }; del.push(rec); runs += 1; continue; }
      if (r < 0.038) { rec.runs = { batter: 0, extras: 1, total: 1 }; rec.extras = { noballs: 1 }; del.push(rec); runs += 1; continue; }
      legal++;
      const pW = Math.min(0.1, Math.max(0.015, 0.04 + 0.05 * (w - b) + (o >= 16 ? 0.015 : 0)));
      if (rng() < pW) {
        const k = rng();
        let kind, fielders;
        const fld = bowlXI.filter((n) => n !== bowler);
        if (k < 0.22) kind = 'bowled';
        else if (k < 0.34) kind = 'lbw';
        else if (k < 0.89) {
          if (rng() < 0.12) { kind = 'caught and bowled'; }
          else { kind = 'caught'; fielders = [{ name: rng() < 0.15 && keeper ? keeper : fld[Math.floor(rng() * fld.length)] }]; }
        } else if (k < 0.95) { kind = 'run out'; fielders = [{ name: fld[Math.floor(rng() * fld.length)] }]; }
        else { kind = 'stumped'; fielders = [{ name: keeper && keeper !== bowler ? keeper : fld[0] }]; }
        rec.wickets = [{ player_out: striker, kind, ...(fielders ? { fielders } : {}) }];
        del.push(rec); wk++;
        if (next < batXI.length) striker = batXI[next++]; else break;
        continue;
      }
      // runs
      const agg = (b * 0.55 + (1 - w) * 0.35 + 0.3) * phase;
      const wts = [0.40 - 0.10 * agg, 0.33, 0.08, 0.008, 0.07 + 0.07 * agg, 0.03 + 0.07 * agg];
      const vals = [0, 1, 2, 3, 4, 6];
      const tot = wts.reduce((a, c) => a + c, 0);
      let x = rng() * tot, rr = 0;
      for (let i = 0; i < wts.length; i++) { if ((x -= wts[i]) <= 0) { rr = vals[i]; break; } }
      rec.runs = { batter: rr, extras: 0, total: rr };
      del.push(rec); runs += rr;
      if (rr % 2 === 1) [striker, non] = [non, striker];
      if (target != null && runs >= target) { overs.push({ over: o, deliveries: del }); return { overs, runs, wk, chased: true }; }
    }
    [striker, non] = [non, striker];
    overs.push({ over: o, deliveries: del });
  }
  return { overs, runs, wk, chased: false };
}

export function buildSample(seed = 2611) {
  const rng = mulberry32(seed);
  const bay = mkSquad(BAY, 'BAY'), dsh = mkSquad(DSH, 'DSH');
  const i1 = simulateInnings(rng, bay, dsh, XI_BAY, XI_DSH, QUOTA_DSH, null);
  const i2 = simulateInnings(rng, dsh, bay, XI_DSH, XI_BAY, QUOTA_BAY, i1.runs + 1);
  const winner = i2.chased ? 'Desert Hawks' : i1.runs > i2.runs ? 'Bay Blazers' : 'Desert Hawks';
  const match = {
    meta: { data_version: '1.1.0', note: 'SIMULATED SAMPLE: fictional players, generated by scripts/gen-sample.mjs' },
    info: {
      match_type: 'T20', gender: 'male', dates: ['2026-11-03'], venue: 'Sample Ground (simulated)',
      teams: ['Bay Blazers', 'Desert Hawks'],
      toss: { winner: 'Desert Hawks', decision: 'field' },
      players: { 'Bay Blazers': XI_BAY, 'Desert Hawks': XI_DSH },
      outcome: { winner, by: i2.chased ? { wickets: 10 - i2.wk } : { runs: i1.runs - i2.runs } },
    },
    innings: [
      { team: 'Bay Blazers', overs: i1.overs },
      { team: 'Desert Hawks', overs: i2.overs },
    ],
  };
  return { match, squads: { BAY: bay, DSH: dsh }, xiOrder: { BAY: XI_BAY.map(slug), DSH: XI_DSH.map(slug) }, scores: { i1, i2 } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] || 2611);
  const { match, scores } = buildSample(seed);
  mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../data/sample-match.json', import.meta.url), JSON.stringify(match));
  console.log(`seed ${seed}: BAY ${scores.i1.runs}/${scores.i1.wk}, DSH ${scores.i2.runs}/${scores.i2.wk}, winner ${match.info.outcome.winner}`);
}
