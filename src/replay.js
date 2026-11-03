// Builds a "replay" of a REAL completed match from Cricsheet ball-by-ball JSON.
//
// Everything the app treats as pre-match knowledge (form, roles, batting-slot proxy, bench, credits) is derived ONLY
// from matches dated strictly before the target match. The target match's own deliveries are used for exactly two
// things: the announced playing XI / toss, and the post-match evaluation. No hindsight leakage.
//
// Honest approximations (all disclosed in meta.source.assumptions and in the UI):
//   * roles are inferred from earlier matches (Cricsheet has no role field)
//   * credits are approximated from form (Dream11's credits are proprietary)
//   * squads are inferred: the XI plus regulars from the team's recent matches who are missing today
//   * the 8 fan teams are generated, deterministically
import { computePoints } from './scoring.js';
import { validate } from './engine.js';

export class ReplayError extends Error {}

export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Short side code from a team name: "Gujarat Titans" -> "GT". */
export function teamCode(name) {
  const words = name.split(/\s+/).filter(Boolean);
  return words.length > 1 ? words.map((w) => w[0]).join('').toUpperCase() : name.slice(0, 3).toUpperCase();
}

/** Per-player facts from one match: balls faced, legal balls bowled, stumpings, first-appearance batting slot. */
export function matchStats(match) {
  const S = {};
  const get = (n) => (S[n] ??= { bf: 0, bowled: 0, stump: 0, pos: null });
  for (const inn of match.innings) {
    const seen = [];
    for (const ov of inn.overs) {
      for (const d of ov.deliveries) {
        for (const n of [d.batter, d.non_striker]) if (n && !seen.includes(n)) seen.push(n);
        if (!d.extras?.wides) get(d.batter).bf++;
        if (!d.extras?.wides && !d.extras?.noballs) get(d.bowler).bowled++;
        for (const w of d.wickets || []) {
          if (w.kind === 'stumped') for (const f of (w.fielders || []).slice(0, 1)) if (f.name) get(f.name).stump++;
        }
      }
    }
    seen.forEach((n, i) => { const s = get(n); if (s.pos === null) s.pos = i + 1; });
  }
  return S;
}

/** A match is usable when both sides list exactly 11 (no impact-player substitutes, which would leak who started). */
export function isEligible(match) {
  const { teams, players, outcome } = match.info;
  return teams.length === 2 && teams.every((t) => players?.[t]?.length === 11)
    && match.innings?.length >= 2 && !!outcome?.winner && !!match.info.registry?.people;
}

/**
 * Index a list of Cricsheet matches ({id, info, innings}) once: per-player history, per-team match list.
 * Matches are ordered by date, then id.
 */
export function buildIndex(rawMatches) {
  const matches = [...rawMatches].map((m) => ({ ...m, date: m.info.dates[0] })).sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  const entries = new Map(); // regId -> ascending list of appearances
  const teamMatches = new Map(); // team name -> ascending list of match positions
  matches.forEach((m, i) => {
    const pts = computePoints(m);
    const stats = matchStats(m);
    for (const team of m.info.teams) {
      if (!teamMatches.has(team)) teamMatches.set(team, []);
      teamMatches.get(team).push(i);
      for (const name of m.info.players[team]) {
        const id = m.info.registry?.people?.[name];
        if (!id) continue;
        const st = stats[name] || { bf: 0, bowled: 0, stump: 0, pos: null };
        if (!entries.has(id)) entries.set(id, []);
        entries.get(id).push({ i, date: m.date, name, team, points: pts[name]?.points ?? 0, ...st });
      }
    }
  });
  return { matches, entries, teamMatches };
}

const mean = (xs) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; if (!n) return 0; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/** Role inferred from up to `window` earlier appearances. Documented heuristic, not an official role. */
export function inferRole(history) {
  const h = history;
  if (h.length < 3) return 'BAT';
  const stump = h.reduce((a, e) => a + e.stump, 0);
  if (stump >= 2) return 'WK';
  const n = h.length;
  const bowled = h.reduce((a, e) => a + e.bowled, 0) / n;
  const bf = h.reduce((a, e) => a + e.bf, 0) / n;
  const pos = mean(h.filter((e) => e.pos !== null).map((e) => e.pos)) || 11;
  if (bowled >= 6 && bf >= 9 && pos <= 8) return 'AR'; // bowls about an over a match and bats in the top 8
  if (bowled >= 8) return 'BOWL';
  if (pos >= 8.5 && bf < 8) return 'BOWL';
  return 'BAT';
}

function codeFor(names) {
  const a = teamCode(names[0]);
  let b = teamCode(names[1]);
  if (a === b) b = `${b}2`;
  return [a, b];
}

/** The generated fan teams: deterministic, always valid, designed so most are affected by absent regulars. */
export function buildFanTeams(allPlayers, xiIds, seed = 7) {
  const rng = mulberry32(seed);
  const byId = new Map(allPlayers.map((p) => [p.id, p]));
  const pool = byId;
  const inXI = new Set(xiIds);
  const benched = allPlayers.filter((p) => !inXI.has(p.id)).sort((a, b) => b.form - a.form || a.id.localeCompare(b.id));
  const stars = allPlayers.filter((p) => inXI.has(p.id)).sort((a, b) => b.form - a.form || a.id.localeCompare(b.id));
  const B = benched.map((p) => p.id), S = stars.map((p) => p.id);
  const pick = (arr, k) => arr[k];
  const plans = [
    { name: 'Powerplay Pandits', force: [pick(B, 0), pick(B, 1)], c: pick(B, 0), vc: pick(B, 1) },
    { name: 'Super Over Squad', force: [pick(B, 0), pick(B, 1)], c: pick(S, 0), vc: pick(B, 1) },
    { name: 'Yorker Yodhas', force: [pick(B, 0)], c: pick(B, 0), vc: pick(S, 0) },
    { name: 'Chai Break XI', force: [pick(B, 1), pick(B, 2)], c: pick(S, 1), vc: pick(B, 1) },
    { name: 'Dugout Legends', force: [pick(B, 0)], c: pick(S, 0), vc: pick(B, 0) },
    { name: 'Mid-Off Mavericks', force: [pick(B, 2)], c: pick(S, 1), vc: pick(S, 2) },
    { name: 'Hat-Trick Heroes', force: [0, 1, 2, 3].map((k) => pick(B, k)), c: pick(S, 0), vc: pick(S, 1) },
    { name: 'Clean Sweep (control)', force: [], noBench: true, c: pick(S, 0), vc: pick(S, 1) },
  ];
  return plans.map((plan, i) => {
    const forced = plan.force.filter(Boolean);
    const c = plan.c ?? S[0], vc = plan.vc ?? S[1];
    const cands = allPlayers.filter((p) => !forced.includes(p.id) && !(plan.noBench && !inXI.has(p.id)));
    for (let attempt = 0; attempt < 30000; attempt++) {
      const picked = [...forced];
      const bag = [...cands];
      while (picked.length < 11) {
        const wts = bag.map((p) => Math.pow(Math.max(p.form, 1), 1.5) * (inXI.has(p.id) ? 1 : 0.3));
        let x = rng() * wts.reduce((a, v) => a + v, 0), k = 0;
        for (; k < bag.length; k++) { if ((x -= wts[k]) <= 0) break; }
        picked.push(bag.splice(Math.min(k, bag.length - 1), 1)[0].id);
      }
      if (!picked.includes(c)) { const j = picked.findIndex((id) => !forced.includes(id)); if (j >= 0) picked[j] = c; }
      if (!picked.includes(vc)) { const j = picked.findIndex((id) => !forced.includes(id) && id !== c); if (j >= 0) picked[j] = vc; }
      if (new Set(picked).size === 11 && validate(picked, pool).ok) return { id: `t${i + 1}`, name: plan.name, players: picked, captain: c, vc };
    }
    throw new ReplayError(`could not build a valid fan team (${plan.name})`);
  });
}

/**
 * Build one replay dataset: { meta, match } in the same shape the sample uses, plus meta.source describing it.
 * `index` comes from buildIndex(). Throws ReplayError when the match cannot be replayed honestly.
 */
export function buildReplay(index, matchId, { seed = 7, benchCap = 6, formWindow = 5, roleWindow = 40, teamWindow = 8 } = {}) {
  const t = index.matches.findIndex((m) => String(m.id) === String(matchId));
  if (t < 0) throw new ReplayError(`match ${matchId} not found`);
  const target = index.matches[t];
  if (!isEligible(target)) throw new ReplayError('match is not eligible (needs exactly 11 listed per side and a result)');
  const date = target.date;
  const before = (regId) => (index.entries.get(regId) || []).filter((e) => e.date < date);
  const [codeA, codeB] = codeFor(target.info.teams);
  const sides = { [codeA]: target.info.teams[0], [codeB]: target.info.teams[1] };
  const codeOf = { [target.info.teams[0]]: codeA, [target.info.teams[1]]: codeB };

  // candidates per side: XI (from the announced lineup) + regulars from the side's recent matches who are absent today
  const draft = [];
  const notes = [];
  for (const team of target.info.teams) {
    const side = codeOf[team];
    const xiNames = target.info.players[team];
    const xiRegIds = new Set(xiNames.map((n) => target.info.registry.people[n]));
    for (const name of xiNames) draft.push({ name, regId: target.info.registry.people[name], team, side, inXI: true });
    const prior = (index.teamMatches.get(team) || []).filter((i) => index.matches[i].date < date).slice(-teamWindow);
    if (prior.length < 3) throw new ReplayError(`not enough earlier matches for ${team}`);
    const seen = new Map(); // regId -> {name, count, last}
    const otherXI = new Set(target.info.teams.filter((x) => x !== team).flatMap((x) => target.info.players[x].map((n) => target.info.registry.people[n])));
    for (const i of prior) {
      const m = index.matches[i];
      for (const n of m.info.players[team]) {
        const id = m.info.registry.people[n];
        if (!id || xiRegIds.has(id) || otherXI.has(id)) continue;
        // a player who has since played for another side (a trade) is not this side's regular
        if (before(id).at(-1)?.team !== team) continue;
        const cur = seen.get(id) || { name: n, count: 0, last: -1 };
        cur.count++; cur.last = i; cur.name = n; seen.set(id, cur);
      }
    }
    const bench = [...seen.entries()].sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last || a[0].localeCompare(b[0])).slice(0, benchCap);
    for (const [regId, info] of bench) draft.push({ name: info.name, regId, team, side, inXI: false });
    const lastMatch = index.matches[prior.at(-1)];
    const lastXI = lastMatch.info.players[team].filter((n) => !xiRegIds.has(lastMatch.info.registry.people[n]));
    if (lastXI.length) notes.push(`${team}: ${lastXI.slice(0, 3).join(', ')} played in their previous match but are not in this XI.`);
  }
  const names = draft.map((d) => d.name);
  if (new Set(names).size !== names.length) throw new ReplayError('duplicate player names in the candidate pool');

  // pre-match form and role, from earlier matches only
  for (const d of draft) {
    const h = before(d.regId);
    d.recent = h.slice(-formWindow);
    d.role = inferRole(h.slice(-roleWindow));
    d.rawForm = d.recent.length >= 2 ? mean(d.recent.map((e) => e.points)) : null;
    d.slot = mean(h.slice(-20).filter((e) => e.pos !== null).map((e) => e.pos)) || null;
  }
  const known = draft.map((d) => d.rawForm).filter((v) => v !== null);
  if (known.length < draft.length * 0.6) throw new ReplayError('too little earlier form data');
  const fallback = median(known);
  for (const d of draft) d.form = Math.round((d.rawForm ?? fallback) * 10) / 10;

  // approximate credits: percentile of form inside this match's pool, mapped to 6.5..11 in half-credit steps
  const sorted = [...draft].map((d) => d.form).sort((a, b) => a - b);
  for (const d of draft) {
    const p = sorted.filter((v) => v < d.form).length / Math.max(sorted.length - 1, 1);
    d.credits = Math.min(11, Math.max(6.5, Math.round((6.5 + 4.5 * p) * 2) / 2));
  }

  const counts = (side) => draft.filter((d) => d.side === side).reduce((m, d) => (m[d.role] = (m[d.role] || 0) + 1, m), {});
  const roleTotals = draft.reduce((m, d) => (m[d.role] = (m[d.role] || 0) + 1, m), {});
  if ((roleTotals.WK || 0) < 2 || (roleTotals.BAT || 0) < 4 || (roleTotals.AR || 0) < 1 || (roleTotals.BOWL || 0) < 4) throw new ReplayError(`role mix too thin to build fantasy teams (${JSON.stringify(roleTotals)})`);
  if (draft.filter((d) => !d.inXI).length < 3) throw new ReplayError('fewer than 3 benched regulars');

  const squads = {};
  for (const side of Object.keys(sides)) {
    squads[side] = draft.filter((d) => d.side === side).map((d) => ({ id: slug(d.name), name: d.name, role: d.role, credits: d.credits, form: d.form, side }));
  }
  // announced XI ordered by typical batting slot (earlier matches only); unknown slots go last, bowlers after batters
  const xiOrder = {};
  for (const team of target.info.teams) {
    const side = codeOf[team];
    const rank = { WK: 0, BAT: 0, AR: 1, BOWL: 2 };
    xiOrder[side] = draft.filter((d) => d.side === side && d.inXI)
      .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99) || rank[a.role] - rank[b.role] || a.name.localeCompare(b.name)).map((d) => slug(d.name));
  }
  const all = Object.values(squads).flat();
  const teams = buildFanTeams(all, Object.values(xiOrder).flat(), seed);

  const trimmed = {
    meta: { source: 'Cricsheet.org', note: 'Real match, trimmed to the fields the scorer uses.' },
    info: {
      match_type: target.info.match_type, gender: target.info.gender, dates: target.info.dates, season: target.info.season,
      event: target.info.event, venue: target.info.venue, teams: target.info.teams, toss: target.info.toss, outcome: target.info.outcome,
      players: target.info.players, registry: { people: Object.fromEntries(target.info.players[target.info.teams[0]].concat(target.info.players[target.info.teams[1]]).map((n) => [n, target.info.registry.people[n]])) },
    },
    innings: target.innings.map((inn) => ({
      team: inn.team,
      overs: inn.overs.map((ov) => ({ over: ov.over, deliveries: ov.deliveries.map((d) => {
        const o = { batter: d.batter, bowler: d.bowler, non_striker: d.non_striker, runs: d.runs };
        if (d.extras) o.extras = d.extras;
        if (d.wickets) o.wickets = d.wickets.map((w) => ({ player_out: w.player_out, kind: w.kind, ...(w.fielders ? { fielders: w.fielders.map((f) => ({ name: f.name })) } : {}) }));
        return o;
      }) })),
    })),
  };

  const title = `${target.info.event?.name || 'Match'} ${target.info.season ?? ''}${target.info.event?.stage ? ' ' + target.info.event.stage : ''}`.trim();
  const meta = {
    sides, toss: target.info.toss, squads, xiOrder, teams, notes,
    source: {
      kind: 'replay', id: String(matchId), title, label: `${sides[codeA]} v ${sides[codeB]}, ${title}`, date, venue: target.info.venue,
      attribution: 'Match data: Cricsheet.org (ODC-By licence).',
      assumptions: [
        'Roles are inferred from each player\'s earlier matches.',
        'Credits are approximated from pre-match form, not Dream11\'s credits.',
        'Squads are inferred: the announced XI plus regulars from the side\'s recent matches who are absent today.',
        'Batting slots are typical slots from earlier matches, not an announced order.',
        'The 8 fantasy teams are generated for this demo.',
      ],
      diagnostics: { roles: roleTotals, benched: draft.filter((d) => !d.inXI).length, sideRoles: Object.fromEntries(Object.keys(sides).map((s) => [s, counts(s)])) },
    },
  };
  return { meta, match: trimmed };
}
