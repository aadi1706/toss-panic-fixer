// Shared sample data and engine context. Used by the browser bundle and the serverless functions.
import meta from '../data/sample-meta.json' with { type: 'json' };
import match from '../data/sample-match.json' with { type: 'json' };
import { makeContext } from './engine.js';
import { computePoints } from './scoring.js';

export { meta, match };
export const sides = meta.sides;
export const teams = meta.teams;
export const players = [...meta.squads.BAY, ...meta.squads.DSH];
export const ctx = makeContext(players, meta.xiOrder);

// Actual fantasy points per player id. Only the post-match evaluation reads this;
// recommendations never do.
export function actualPoints() {
  const byName = computePoints(match);
  return Object.fromEntries(players.map((p) => [p.id, byName[p.name]?.points ?? 0]));
}
