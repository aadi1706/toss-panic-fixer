// The simulated sample dataset, exposed as plain constants (used by tests and scripts).
// The app itself and the server functions pick a dataset through src/datasets.js.
import { getDataset, DEFAULT_ID } from './datasets.js';

const sample = getDataset(DEFAULT_ID);
export const { meta, match, sides, teams, players, ctx } = sample;
export const actualPoints = () => sample.actualPoints();
