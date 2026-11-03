import test from 'node:test';
import assert from 'node:assert/strict';
import { explain, ask, explainItems } from '../src/server/handlers.js';
import { makeLimiter } from '../src/server/guard.js';
import { makeTools } from '../src/tools.js';
import { ctx, teams, sides, players } from '../src/data.js';

const post = (body) => new Request('http://x/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const env = { ANTHROPIC_API_KEY: 'test-key' };
const open = () => ({ explain: () => ({ ok: true }), ask: () => ({ ok: true }) });
const reply = (content, stop = 'end_turn') => ({ ok: true, status: 200, json: async () => ({ content, stop_reason: stop, model: 'm' }) });
const text = (t) => [{ type: 'text', text: t }];

test('explain: returns one explanation per fixable team and sends only engine facts', async () => {
  let sent;
  const items = explainItems();
  const answer = Object.fromEntries(items.map((i) => [i.teamId, 'One. Two.']));
  const fetchImpl = async (_u, init) => { sent = JSON.parse(init.body); return reply(text('```json\n' + JSON.stringify(answer) + '\n```')); };
  const res = await explain(post({ lang: 'hinglish' }), { env, deps: { fetchImpl, limiters: open() } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.explanations).sort(), items.map((i) => i.teamId).sort());
  assert.match(sent.messages[0].content, /Hinglish/);
  assert.equal(sent.model.startsWith('claude-'), true);
});

test('explain: invalid lang, bad JSON, oversize body and wrong method are rejected before any AI call', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  const deps = { fetchImpl, limiters: open() };
  assert.equal((await explain(post({ lang: 'fr' }), { env, deps })).status, 400);
  assert.equal((await explain(post('{nope'), { env, deps })).status, 400);
  assert.equal((await explain(post({ lang: 'en', pad: 'x'.repeat(5000) }), { env, deps })).status, 413);
  assert.equal((await explain(new Request('http://x/api'), { env, deps })).status, 405);
});

test('explain: model omitting a team, upstream error, missing key and timeout all give a clean 5xx (client falls back)', async () => {
  const limiters = open();
  const missing = await explain(post({ lang: 'en' }), { env, deps: { limiters, fetchImpl: async () => reply(text('{"t1":"x"}')) } });
  assert.equal(missing.status, 502);
  const upstream = await explain(post({ lang: 'en' }), { env, deps: { limiters, fetchImpl: async () => ({ ok: false, status: 529, json: async () => ({}) }) } });
  assert.equal(upstream.status, 502);
  const nokey = await explain(post({ lang: 'en' }), { env: {}, deps: { limiters, fetchImpl: async () => reply(text('{}')) } });
  assert.equal(nokey.status, 502);
  const slow = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
  const timed = await explain(post({ lang: 'en' }), { env, deps: { limiters, fetchImpl: slow, timeoutMs: 20 } });
  assert.equal(timed.status, 502);
  assert.doesNotMatch(JSON.stringify(await timed.json()), /test-key/);
});

test('ask: runs the tool loop against the real engine and returns the final answer', async () => {
  const calls = [];
  const script = [
    reply([{ type: 'tool_use', id: 'u1', name: 'get_team', input: { team: 't1' } }], 'tool_use'),
    reply([{ type: 'tool_use', id: 'u2', name: 'simulate_swap', input: { team: 't1', out: 'Mohit Saxena', in: 'Siddharth Rao' } }], 'tool_use'),
    reply(text('Swap is valid.')),
  ];
  const fetchImpl = async (_u, init) => { calls.push(JSON.parse(init.body)); return script.shift(); };
  const res = await ask(post({ question: 'Fix Powerplay Pandits?', lang: 'en' }), { env, deps: { fetchImpl, limiters: open() } });
  const body = await res.json();
  assert.equal(body.answer, 'Swap is valid.');
  assert.deepEqual(body.toolCalls.map((c) => c.name), ['get_team', 'simulate_swap']);
  const toolResult = JSON.parse(calls[1].messages.at(-1).content[0].content);
  assert.equal(toolResult.name, 'Powerplay Pandits');
  assert.ok(toolResult.notPlaying.includes('Mohit Saxena'));
  const swapResult = JSON.parse(calls[2].messages.at(-1).content[0].content);
  assert.equal(typeof swapResult.valid, 'boolean');
});

test('ask: validates the question and stops a model that never stops calling tools', async () => {
  const deps = { limiters: open(), fetchImpl: async () => reply([{ type: 'tool_use', id: 'u', name: 'list_playing_xi', input: {} }], 'tool_use') };
  assert.equal((await ask(post({ question: 'hi' }), { env, deps })).status, 400);
  assert.equal((await ask(post({ question: 'x'.repeat(301), lang: 'en' }), { env, deps })).status, 400);
  assert.equal((await ask(post({ question: 'who is playing?', lang: 'en' }), { env, deps })).status, 502);
});

test('rate limiter: per-IP window, per-day cap, and recovery', () => {
  let t = Date.UTC(2026, 10, 3);
  const check = makeLimiter({ perIp: 2, windowMs: 1000, daily: 3, now: () => t });
  assert.ok(check('a').ok && check('a').ok);
  assert.equal(check('a').ok, false);
  assert.ok(check('b').ok);
  assert.equal(check('c').reason, 'daily cap reached');
  t += 86_400_000;
  assert.ok(check('a').ok);
});

test('tools: real engine results, and errors the model can recover from', () => {
  const tools = makeTools({ ctx, teams, sides });
  assert.equal(tools.get_team({ team: 'Chai Break XI' }).id, 't4');
  assert.ok(tools.get_team({ team: 'nope' }).error);
  const xi = tools.list_playing_xi();
  assert.deepEqual(Object.keys(xi), Object.values(sides));
  assert.equal(xi['Bay Blazers'].length, 11);
  const p = (n) => players.find((x) => x.name === n);
  const t = teams[0];
  const out = p('Mohit Saxena'), inn = p('Siddharth Rao');
  const r = tools.simulate_swap({ team: 't1', out: out.name, in: inn.name });
  assert.equal(r.incomingIsPlaying, true);
  assert.equal(r.creditsLeft, Math.round((100 - (t.players.reduce((a, id) => a + ctx.pool.get(id).credits, 0) - out.credits + inn.credits)) * 10) / 10);
  assert.ok(tools.simulate_swap({ team: 't1', out: 'Siddharth Rao', in: 'Kabir Sethi' }).error);
});

test('tools: overview_all_teams summarises every team in one call from the real engine', () => {
  const tools = makeTools({ ctx, teams, sides });
  const o = tools.overview_all_teams();
  assert.equal(o.length, teams.length);
  assert.equal(o.filter((x) => x.status === 'fine').length, 1);
  assert.equal(o.filter((x) => x.status === 'broken, no valid fix').length, 0);
  const t1 = o.find((x) => x.id === 't1');
  assert.ok(t1.captainOut && t1.notPlaying.includes('Rohan Malhotra'));
  assert.equal(t1.bestFix.swaps.length, t1.notPlaying.length);
  assert.equal(o.find((x) => x.status === 'fine').bestFix, undefined);
});
