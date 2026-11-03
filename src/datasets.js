// Every match the app can show, as a self-contained dataset: the simulated sample (default) plus real-match replays.
import sampleMeta from '../data/sample-meta.json' with { type: 'json' };
import sampleMatch from '../data/sample-match.json' with { type: 'json' };
import { REPLAYS } from './replay-registry.js';
import { makeContext } from './engine.js';
import { computePoints } from './scoring.js';

export function makeDataset(id, meta, match) {
  const kind = meta.source?.kind === 'replay' ? 'replay' : 'sample';
  const players = Object.values(meta.squads).flat();
  return {
    id, kind, meta, match, players,
    label: kind === 'replay' ? meta.source.label : 'Sample match (simulated)',
    sides: meta.sides, teams: meta.teams,
    ctx: makeContext(players, meta.xiOrder),
    // Actual fantasy points per player id. Only the post-match evaluation reads this; recommendations never do.
    actualPoints() {
      const byName = computePoints(match);
      return Object.fromEntries(players.map((p) => [p.id, byName[p.name]?.points ?? 0]));
    },
  };
}

export const DEFAULT_ID = 'sample';
export const DATASETS = [
  makeDataset(DEFAULT_ID, sampleMeta, sampleMatch),
  ...REPLAYS.map((r) => makeDataset(`ipl-${r.meta.source.id}`, r.meta, r.match)),
];

export const getDataset = (id) => DATASETS.find((d) => d.id === id) || null;
