// Post-match evaluation. This is the only place actual points are used.
import { oracleFix, pointsOf, findBroken } from './engine.js';

const r1 = (n) => Math.round(n * 10) / 10;

/**
 * applied: Map<teamId, option> of the fixes the fan applied.
 * Returns per-team rows and totals for: no action, with the fan's fixes, hindsight-best.
 */
export function evaluate(teams, applied, ctx, actual) {
  const rows = teams.map((t) => {
    const none = pointsOf(t.players, t.captain, t.vc, actual);
    const opt = applied.get(t.id);
    const mine = opt ? pointsOf(opt.players, opt.captain, opt.vc, actual) : none;
    const best = findBroken(t, ctx).broken ? oracleFix(t, ctx, actual) : null;
    // Hindsight can never be worse than what the fan did (or than no action).
    const hind = Math.max(best ? pointsOf(best.players, best.captain, best.vc, actual) : none, mine, none);
    return { team: t, none: r1(none), mine: r1(mine), hind: r1(hind) };
  });
  const sum = (k) => r1(rows.reduce((a, r) => a + r[k], 0));
  const totals = { none: sum('none'), mine: sum('mine'), hind: sum('hind') };
  const gap = totals.hind - totals.none;
  // null when there is no gap to recover (nothing was broken)
  const recovered = gap > 1e-9 ? Math.round(((totals.mine - totals.none) / gap) * 100) : null;
  return { rows, totals, recovered };
}
