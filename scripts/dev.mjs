// Local server: serves dist/ and routes /api/* to the same handlers the deployed functions use.
// Usage: ANTHROPIC_API_KEY=... node scripts/dev.mjs   (PORT defaults to 8888)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { explain, ask } from '../src/server/handlers.js';

const routes = { '/api/explain': explain, '/api/ask': ask };
const page = () => readFileSync(new URL('../dist/index.html', import.meta.url));

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (routes[path]) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request('http://localhost' + req.url, {
      method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    });
    const out = await routes[path](request, { context: { ip: req.socket.remoteAddress } });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    return res.end(await out.text());
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page());
}).listen(process.env.PORT || 8888, () => console.log(`http://localhost:${process.env.PORT || 8888}`));
