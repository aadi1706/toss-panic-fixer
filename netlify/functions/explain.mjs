import { explain } from '../../src/server/handlers.js';

export default (req, context) => explain(req, { context });
export const config = { path: '/api/explain' };
