// Tools the "Ask the Fixer" model can call. Each one runs the real engine on the sample data
// and returns plain JSON. Errors are returned as { error } so the model can recover.
import { validate, findBroken, project, LIMITS } from './engine.js';

const r1 = (n) => Math.round(n * 10) / 10;
const norm = (s) => String(s ?? '').trim().toLowerCase();

export function makeTools({ ctx, teams, sides }) {
  const findTeam = (q) => teams.find((t) => norm(t.id) === norm(q) || norm(t.name) === norm(q))
    || teams.find((t) => norm(t.name).includes(norm(q)) && norm(q).length >= 3);
  const findPlayer = (q) => [...ctx.pool.values()].find((p) => norm(p.name) === norm(q) || p.id === norm(q))
    || [...ctx.pool.values()].find((p) => norm(p.name).includes(norm(q)) && norm(q).length >= 3);
  const view = (p) => ({ name: p.name, role: p.role, credits: p.credits, side: sides[p.side], inPlayingXI: ctx.xi.has(p.id) });

  return {
    get_team({ team }) {
      const t = findTeam(team);
      if (!t) return { error: `no team matches "${team}"`, teams: teams.map((x) => `${x.id} ${x.name}`) };
      const b = findBroken(t, ctx);
      return {
        id: t.id, name: t.name, captain: ctx.pool.get(t.captain).name, viceCaptain: ctx.pool.get(t.vc).name,
        players: t.players.map((id) => view(ctx.pool.get(id))),
        notPlaying: b.out.map((id) => ctx.pool.get(id).name), captainOut: b.captainOut, viceCaptainOut: b.vcOut,
      };
    },

    list_playing_xi() {
      const out = {};
      for (const [side, name] of Object.entries(sides)) {
        out[name] = [...ctx.order.entries()]
          .map(([id, i]) => ({ id, i, p: ctx.pool.get(id) })).filter((x) => x.p.side === side).sort((a, b) => a.i - b.i)
          .map(({ p, i }) => ({ battingPosition: i + 1, name: p.name, role: p.role, credits: p.credits, preMatchForm: p.form }));
      }
      return out;
    },

    simulate_swap({ team, out, in: inName }) {
      const t = findTeam(team);
      if (!t) return { error: `no team matches "${team}"` };
      const po = findPlayer(out), pi = findPlayer(inName);
      if (!po) return { error: `no player matches "${out}"` };
      if (!pi) return { error: `no player matches "${inName}"` };
      if (!t.players.includes(po.id)) return { error: `${po.name} is not in ${t.name}` };
      if (t.players.includes(pi.id)) return { error: `${pi.name} is already in ${t.name}` };
      const players = t.players.map((id) => (id === po.id ? pi.id : id));
      const v = validate(players, ctx.pool);
      return {
        team: t.name, out: view(po), in: view(pi),
        valid: v.ok, problems: v.errors,
        creditsUsed: v.stats.credits, creditsLeft: r1(LIMITS.credits - v.stats.credits),
        incomingIsPlaying: ctx.xi.has(pi.id),
        // Pre-match form only; this is an estimate, not a prediction of the result.
        projectedPointsChange: r1(project(pi.id, ctx) - project(po.id, ctx)),
        note: t.captain === po.id ? 'this player is the captain; the captaincy would need to move' : t.vc === po.id ? 'this player is the vice-captain' : undefined,
      };
    },
  };
}

// Anthropic tool definitions (JSON schema) matching makeTools().
export const TOOL_DEFS = [
  {
    name: 'get_team',
    description: 'Get one of the fan\'s teams: players (role, credits, whether in the announced playing XI), captain, vice-captain and who is not playing.',
    input_schema: { type: 'object', properties: { team: { type: 'string', description: 'team id like t1, or the team name' } }, required: ['team'] },
  },
  {
    name: 'list_playing_xi',
    description: 'List both announced playing XIs with batting position, role, credits and pre-match form (average fantasy points).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'simulate_swap',
    description: 'Check one hypothetical swap in a team with the real rules engine: validity under the 11 players / 100 credits / max 7 per side / role limits, credits left and projected points change.',
    input_schema: {
      type: 'object',
      properties: { team: { type: 'string' }, out: { type: 'string', description: 'player name to remove' }, in: { type: 'string', description: 'player name to add' } },
      required: ['team', 'out', 'in'],
    },
  },
];
