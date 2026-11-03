// Fantasy points from a Cricsheet-format match JSON.
// NOTE: an approximation of Dream11 T20 scoring, for demonstration. Every value is
// configurable via DEFAULT_RULES; verify against the official table before relying on it.

export const DEFAULT_RULES = {
  playingXI: 4,
  run: 1, four: 4, six: 6,
  milestones: [[100, 16], [50, 8], [30, 4]], // highest threshold reached counts
  duck: -2,
  strikeRate: { minBalls: 10, bands: [[170, 6, Infinity], [150, 4, 170], [130, 2, 150], [60, -2, 70], [50, -4, 60], [-1, -6, 50]] },
  wicket: 25, lbwBowledBonus: 8,
  hauls: [[5, 16], [4, 8], [3, 4]],
  maiden: 12,
  economy: { minOvers: 2, bands: [[-1, 6, 5], [5, 4, 6], [6, 2, 7], [10, -2, 11], [11, -4, 12], [12, -6, Infinity]] },
  catch: 8, threeCatchBonus: 4, stumping: 12, runOutDirect: 12, runOutShared: 6,
  captain: 2, viceCaptain: 1.5,
};

const BOWLER_WICKETS = new Set(['bowled', 'caught', 'lbw', 'stumped', 'caught and bowled', 'hit wicket']);

const band = (bands, v) => {
  // bands: [lowInclusive, points, highExclusive]
  for (const [lo, pts, hi] of bands) if (v >= lo && v < hi) return pts;
  return 0;
};

/** Returns { [playerName]: { points, parts } } for every player listed in info.players. */
export function computePoints(match, rules = DEFAULT_RULES) {
  const P = {};
  const get = (n) => (P[n] ??= { bat: { runs: 0, balls: 0, fours: 0, sixes: 0, out: false }, bowl: { legal: 0, runs: 0, wkts: 0, bonusW: 0, maidens: 0 }, field: { catches: 0, stumpings: 0, roDirect: 0, roShared: 0 } });
  for (const team of match.info.teams) for (const n of match.info.players[team]) get(n);

  for (const inn of match.innings) {
    for (const ov of inn.overs) {
      const bowlerRuns = {}, bowlerLegal = {};
      for (const d of ov.deliveries) {
        const wide = d.extras?.wides, nb = d.extras?.noballs;
        const bt = get(d.batter), bw = get(d.bowler);
        const isLegal = !wide && !nb;
        if (!wide) bt.bat.balls++;
        bt.bat.runs += d.runs.batter;
        if (d.runs.batter === 4 && !d.runs.non_boundary) bt.bat.fours++;
        if (d.runs.batter === 6) bt.bat.sixes++;
        const conceded = d.runs.batter + (wide || 0) + (nb || 0);
        bw.bowl.runs += conceded;
        bowlerRuns[d.bowler] = (bowlerRuns[d.bowler] || 0) + conceded;
        if (isLegal) { bw.bowl.legal++; bowlerLegal[d.bowler] = (bowlerLegal[d.bowler] || 0) + 1; }
        for (const w of d.wickets || []) {
          get(w.player_out).bat.out = true;
          if (BOWLER_WICKETS.has(w.kind)) {
            bw.bowl.wkts++;
            if (w.kind === 'bowled' || w.kind === 'lbw') bw.bowl.bonusW++;
          }
          const f = (w.fielders || []).map((x) => x.name).filter(Boolean);
          if (w.kind === 'caught') f.slice(0, 1).forEach((n) => get(n).field.catches++);
          if (w.kind === 'caught and bowled') get(d.bowler).field.catches++;
          if (w.kind === 'stumped') f.slice(0, 1).forEach((n) => get(n).field.stumpings++);
          if (w.kind === 'run out') {
            if (f.length <= 1) f.forEach((n) => get(n).field.roDirect++);
            else f.forEach((n) => get(n).field.roShared++);
          }
        }
      }
      for (const [b, legal] of Object.entries(bowlerLegal)) if (legal === 6 && bowlerRuns[b] === 0) get(b).bowl.maidens++;
    }
  }

  const out = {};
  for (const [name, s] of Object.entries(P)) {
    const parts = {};
    parts.playing = rules.playingXI;
    const { runs, balls, fours, sixes, out: dismissed } = s.bat;
    parts.runs = runs * rules.run;
    parts.boundaries = fours * rules.four + sixes * rules.six;
    parts.milestone = (rules.milestones.find(([t]) => runs >= t) || [0, 0])[1];
    parts.duck = dismissed && runs === 0 && balls > 0 ? rules.duck : 0;
    parts.strikeRate = balls >= rules.strikeRate.minBalls ? band(rules.strikeRate.bands, (runs / balls) * 100) : 0;
    const b = s.bowl;
    parts.wickets = b.wkts * rules.wicket + b.bonusW * rules.lbwBowledBonus;
    parts.haul = (rules.hauls.find(([t]) => b.wkts >= t) || [0, 0])[1];
    parts.maidens = b.maidens * rules.maiden;
    const overs = b.legal / 6;
    parts.economy = overs >= rules.economy.minOvers ? band(rules.economy.bands, b.runs / overs) : 0;
    const f = s.field;
    parts.fielding = f.catches * rules.catch + (f.catches >= 3 ? rules.threeCatchBonus : 0) + f.stumpings * rules.stumping + f.roDirect * rules.runOutDirect + f.roShared * rules.runOutShared;
    out[name] = { points: Object.values(parts).reduce((a, c) => a + c, 0), parts, line: { runs, balls, wkts: b.wkts, overs: Math.round(overs * 10) / 10, catches: f.catches } };
  }
  return out;
}

/** Points for a team given base points, with C / VC multipliers. */
export function teamPoints(playerIds, captain, viceCaptain, basePoints, rules = DEFAULT_RULES) {
  let t = 0;
  for (const id of playerIds) {
    const base = basePoints[id] ?? 0;
    t += base * (id === captain ? rules.captain : id === viceCaptain ? rules.viceCaptain : 1);
  }
  return t;
}
