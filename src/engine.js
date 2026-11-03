// Pure fantasy-team repair engine. No DOM, no network.
// A player: { id, name, role: 'WK'|'BAT'|'AR'|'BOWL', credits, form, side }
// A team:   { id, name, players: [ids], captain, vc }
// ctx:      { pool: Map<id, player>, xi: Set<id>, order: Map<id, battingIndex> }

export const LIMITS = {
  total: 11, credits: 100, maxPerSide: 7,
  roles: { WK: [1, 4], BAT: [3, 6], AR: [1, 4], BOWL: [3, 6] },
};

export function makeContext(players, xiOrderBySide) {
  const pool = new Map(players.map((p) => [p.id, p]));
  const xi = new Set();
  const order = new Map();
  for (const ids of Object.values(xiOrderBySide)) ids.forEach((id, i) => { xi.add(id); order.set(id, i); });
  return { pool, xi, order };
}

export function teamStats(ids, pool) {
  const s = { credits: 0, sides: {}, roles: { WK: 0, BAT: 0, AR: 0, BOWL: 0 } };
  for (const id of ids) {
    const p = pool.get(id);
    s.credits += p.credits;
    s.sides[p.side] = (s.sides[p.side] || 0) + 1;
    s.roles[p.role]++;
  }
  s.credits = Math.round(s.credits * 10) / 10;
  return s;
}

export function validate(ids, pool, limits = LIMITS) {
  const errors = [];
  if (ids.length !== limits.total || new Set(ids).size !== ids.length) errors.push(`needs ${limits.total} distinct players`);
  const s = teamStats(ids, pool);
  if (s.credits > limits.credits + 1e-9) errors.push(`over credit cap (${s.credits}/${limits.credits})`);
  for (const [side, n] of Object.entries(s.sides)) if (n > limits.maxPerSide) errors.push(`${n} players from ${side} (max ${limits.maxPerSide})`);
  for (const [role, [lo, hi]] of Object.entries(limits.roles)) if (s.roles[role] < lo || s.roles[role] > hi) errors.push(`${role} count ${s.roles[role]} outside ${lo}-${hi}`);
  return { ok: errors.length === 0, errors, stats: s };
}

/** Pre-match projection from FORM ONLY (never from match results). */
export function project(id, ctx) {
  const p = ctx.pool.get(id);
  const idx = ctx.order.get(id);
  let f = 1;
  if (idx !== undefined) {
    if (p.role !== 'BOWL' && idx <= 3) f = 1.08; // top-order gets more balls
    else if (p.role !== 'BOWL' && idx >= 7) f = 0.93; // lower-order batters face fewer
  }
  return p.form * f;
}

export function findBroken(team, ctx) {
  const out = team.players.filter((id) => !ctx.xi.has(id));
  return { out, captainOut: out.includes(team.captain), vcOut: out.includes(team.vc), broken: out.length > 0 };
}

const mult = (id, c, v, m = { c: 2, v: 1.5 }) => (id === c ? m.c : id === v ? m.v : 1);

function chooseLeaders(players, team, score) {
  let c = players.includes(team.captain) ? team.captain : players.includes(team.vc) ? team.vc : null;
  let v = players.includes(team.vc) && team.vc !== c ? team.vc : null;
  const ranked = [...players].sort((a, b) => score(b) - score(a) || (a < b ? -1 : 1));
  if (!c) c = ranked[0];
  if (!v) v = ranked.find((id) => id !== c);
  return { c, v };
}

function* combinations(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= arr.length - (k - acc.length); i++) { acc.push(arr[i]); yield* combinations(arr, k, i + 1, acc); acc.pop(); }
}

/**
 * Enumerate every valid repair for one team (replace each non-playing player with a
 * player from the announced XI) and rank them by `score(id)`.
 * Returns [] if the team is fine OR if no valid repair exists (check findBroken).
 */
export function enumerateFixes(team, ctx, score, { top = 3 } = {}) {
  const { out } = findBroken(team, ctx);
  if (!out.length) return [];
  const candidates = [...ctx.xi].filter((id) => !team.players.includes(id)).sort();
  const kept = team.players.filter((id) => ctx.xi.has(id));
  const results = [];
  for (const ins of combinations(candidates, out.length)) {
    const players = [...kept, ...ins];
    const v = validate(players, ctx.pool);
    if (!v.ok) continue;
    const { c, v: vc } = chooseLeaders(players, team, score);
    const total = players.reduce((a, id) => a + score(id) * mult(id, c, vc), 0);
    results.push({ players, ins, removed: out, captain: c, vc, total, stats: v.stats });
  }
  results.sort((a, b) => b.total - a.total || (a.ins.join() < b.ins.join() ? -1 : 1));
  return results.slice(0, top).map((r) => ({ ...r, swaps: pairSwaps(r.removed, r.ins, ctx.pool) }));
}

/** Pair removed->added players, matching roles first, so each swap reads naturally. */
export function pairSwaps(removed, ins, pool) {
  const left = [...ins];
  const pairs = [];
  for (const o of removed) {
    const po = pool.get(o);
    let i = left.findIndex((x) => pool.get(x).role === po.role);
    if (i < 0) i = 0;
    pairs.push({ out: o, in: left.splice(i, 1)[0] });
  }
  return pairs;
}

/** Fixer: ranks by pre-match projection. Adds explanation facts. */
export function fixTeam(team, ctx, opts) {
  const score = (id) => project(id, ctx);
  const before = findBroken(team, ctx);
  const options = enumerateFixes(team, ctx, score, opts).map((o) => ({
    ...o,
    projGain: o.total - team.players.reduce((a, id) => a + (ctx.xi.has(id) ? score(id) * mult(id, team.captain, team.vc) : 0), 0),
    creditsLeft: Math.round((LIMITS.credits - o.stats.credits) * 10) / 10,
    facts: o.swaps.map((s) => {
      const po = ctx.pool.get(s.out), pi = ctx.pool.get(s.in);
      return { out: po.name, outRole: po.role, in: pi.name, inRole: pi.role, sameRole: po.role === pi.role, creditDelta: Math.round((pi.credits - po.credits) * 10) / 10, formIn: pi.form, formOut: po.form, battingSlot: ctx.order.get(s.in) !== undefined ? ctx.order.get(s.in) + 1 : null };
    }),
    captainChanged: o.captain !== team.captain,
    vcChanged: o.vc !== team.vc,
  }));
  return { teamId: team.id, ...before, options, impossible: before.broken && options.length === 0 };
}

/** Hindsight oracle: best repair if you knew each player's actual points. */
export function oracleFix(team, ctx, actual) {
  const score = (id) => actual[id] ?? 0;
  return enumerateFixes(team, ctx, score, { top: 1 })[0] || null;
}

export function pointsOf(players, captain, vc, actual) {
  return players.reduce((a, id) => a + (actual[id] ?? 0) * mult(id, captain, vc), 0);
}
