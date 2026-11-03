import { ask } from '../../src/server/handlers.js';

export default (req, context) => ask(req, { context });
export const config = { path: '/api/ask' };
