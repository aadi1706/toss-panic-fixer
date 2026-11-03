// AI layer. Optional: when the page runs inside Claude (window.claude.use("sample")) the
// model explains fixes and answers questions by calling the REAL engine through tools.
// Without it, everything still works with deterministic template explanations.

export async function getAI() {
  try {
    if (typeof window === 'undefined' || !window.claude || typeof window.claude.use !== 'function') return null;
    return (await window.claude.use('sample')) || null;
  } catch {
    return null;
  }
}

function extractJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model output');
  return JSON.parse(m[0]);
}

/** One call: explain every team's recommended fix. items = [{teamId, teamName, captainOut, vcOut, facts[], captainChange, creditsLeft}] */
export async function explainAll(sample, items, lang) {
  const style = lang === 'hinglish'
    ? 'Write in casual Hinglish (Hindi in Roman script mixed with English cricket terms), like a friend texting before lock.'
    : 'Write in plain, friendly English, like a friend texting before lock.';
  const prompt = `You are a fantasy cricket assistant. The toss just happened and some players in a fan's teams are NOT in the playing XI.
For each team below, write EXACTLY two short sentences: (1) what went wrong, (2) why the recommended swap is sensible.
Use ONLY the facts given. Do not invent stats, injuries or predictions. Mention captain/vice-captain changes if flagged. ${style}
Return ONLY JSON of the form {"<teamId>": "<two sentences>"} with every teamId present.

${JSON.stringify(items)}`;
  const res = await sample(prompt, { modelTier: 'quick', cache: false });
  const out = extractJSON(res.text || '');
  for (const it of items) if (typeof out[it.teamId] !== 'string') throw new Error('model omitted ' + it.teamId);
  return out;
}

/** Agentic Q&A. `api` exposes the real engine: getTeam(id), listXI(), simulateSwap(teamId,outName,inName). */
export async function askFixer(sample, question, api, lang) {
  const style = lang === 'hinglish' ? 'Reply in casual Hinglish.' : 'Reply in plain English.';
  const tools = [
    {
      name: 'get_team',
      description: 'Get a fan team: its players (name, role, credits, whether in the announced playing XI), captain and vice-captain.',
      inputSchema: { type: 'object', properties: { team: { type: 'string', description: 'team id like t1, or team name' } }, required: ['team'] },
      execute: (i) => api.getTeam(i.team),
    },
    {
      name: 'list_playing_xi',
      description: 'List both announced playing XIs with role, credits and pre-match form (avg fantasy points, last 5).',
      inputSchema: { type: 'object', properties: {} },
      execute: () => api.listXI(),
    },
    {
      name: 'simulate_swap',
      description: 'Check a hypothetical swap in a team using the real rules engine: is the resulting team valid, credits left, and projected points change.',
      inputSchema: { type: 'object', properties: { team: { type: 'string' }, out: { type: 'string', description: 'player name to remove' }, in: { type: 'string', description: 'player name to add' } }, required: ['team', 'out', 'in'] },
      execute: (i) => api.simulateSwap(i.team, i.out, i.in),
    },
  ];
  const prompt = `You are the Toss Panic Fixer, an assistant for fantasy cricket fans right after the toss.
Always use the tools to check facts before answering; never guess player status or credits. Projections come from pre-match form only, so say they are estimates, not guarantees. Keep the answer under 80 words. ${style}

Fan question: ${question}`;
  const res = await sample(prompt, { tools, modelTier: 'default', cache: false });
  return (res.text || '').trim();
}
