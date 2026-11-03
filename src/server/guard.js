// Request validation and a simple abuse cap for the serverless functions.
// The limiter is in memory, so it is per warm function instance: good enough to stop a
// loop or a casual abuser from burning the API budget, not a hard global guarantee.

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

export function makeLimiter({ perIp = 12, windowMs = 10 * 60_000, daily = 400, now = () => Date.now() } = {}) {
  const hits = new Map(); // ip -> timestamps
  let day = { key: '', n: 0 };
  return function check(ip) {
    const t = now();
    const dayKey = new Date(t).toISOString().slice(0, 10);
    if (day.key !== dayKey) day = { key: dayKey, n: 0 };
    if (day.n >= daily) return { ok: false, reason: 'daily cap reached' };
    const recent = (hits.get(ip) || []).filter((x) => t - x < windowMs);
    if (recent.length >= perIp) return { ok: false, reason: 'too many requests, try again in a few minutes', retryAfter: Math.ceil((windowMs - (t - recent[0])) / 1000) };
    recent.push(t);
    hits.set(ip, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    day.n++;
    return { ok: true };
  };
}

export async function readJson(req, maxBytes = 4096) {
  if (req.method !== 'POST') return { error: 'POST only', status: 405 };
  const text = await req.text();
  if (text.length > maxBytes) return { error: 'request too large', status: 413 };
  try { return { body: JSON.parse(text) }; } catch { return { error: 'invalid JSON', status: 400 }; }
}

export const parseLang = (v) => (v === 'hinglish' ? 'hinglish' : v === 'en' || v === undefined ? 'en' : null);

export function parseQuestion(v) {
  if (typeof v !== 'string') return null;
  const q = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return q.length >= 3 && q.length <= 300 ? q : null;
}

export const clientIp = (req, context) =>
  context?.ip || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
