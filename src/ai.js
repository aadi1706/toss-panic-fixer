// Browser side of the AI layer: two calls to the serverless functions. The model and the API key
// live on the server only. Callers must treat any rejection as "AI unavailable" and fall back to
// the deterministic template explanations.

async function post(path, body, timeoutMs = 25_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  } finally { clearTimeout(timer); }
}

/** -> { [teamId]: "two sentences" } for every team that has a fix. */
export async function explainAll(lang, match) {
  const { explanations } = await post('/api/explain', { lang, match });
  if (!explanations || typeof explanations !== 'object') throw new Error('bad response');
  return explanations;
}

/** -> { answer, toolCalls: [{ name, input }] } */
export async function askFixer(question, lang, match) {
  const out = await post('/api/ask', { question, lang, match });
  if (typeof out.answer !== 'string') throw new Error('bad response');
  return out;
}
