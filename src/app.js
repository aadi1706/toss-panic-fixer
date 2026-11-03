// Browser UI. Pure engine code does the work; this file only renders and wires events.
import { ctx, teams, meta, match, sides, actualPoints } from './data.js';
import { fixTeam, findBroken, teamStats } from './engine.js';
import { explainTemplate, noFixText } from './explain.js';
import { evaluate } from './evaluate.js';
import { explainAll, askFixer } from './ai.js';

const actual = actualPoints();
const state = {
  phase: 'pre', // pre -> toss -> played
  lang: 'en',
  fixes: new Map(), // teamId -> fixTeam() result (computed at the toss)
  pick: new Map(), // teamId -> index of the option being viewed
  applied: new Map(), // teamId -> option the fan applied
  result: null,
  ai: { en: null, hinglish: null, loading: false, error: '' }, // AI explanations per language
  ask: { q: '', loading: false, answer: '', tools: [], error: '' },
  coin: false, // toss reveal overlay is showing
  fresh: false, // XIs are animating in
  xiOpen: true,
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const P = (id) => ctx.pool.get(id);
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ROLES = ['WK', 'BAT', 'AR', 'BOWL'];

/* ---------- players ---------- */

function pill(id, { out = false, cap = null, isNew = false } = {}) {
  const p = P(id);
  const tag = out ? '<u class="tg out">Out</u>' : isNew ? '<u class="tg in">In</u>' : '';
  return `<li class="pl r-${p.role}${out ? ' out' : ''}${isNew ? ' new' : ''}" title="${esc(p.name)}, ${p.role}, ${p.credits} credits, ${esc(sides[p.side])}">
    <i class="rl">${p.role}</i><span class="nm">${esc(p.name)}</span><span class="sub"><span class="cr">${p.credits} cr</span>${cap ? `<b class="cv">${cap}</b>` : ''}${tag}</span></li>`;
}

function pills(ids, { captain = null, vc = null, outSet = null, newIds = [] } = {}) {
  const rank = { WK: 0, BAT: 1, AR: 2, BOWL: 3 };
  const sorted = [...ids].sort((a, b) => rank[P(a).role] - rank[P(b).role] || P(b).credits - P(a).credits);
  return `<ul class="pills">${sorted.map((id) => pill(id, {
    out: !!outSet && outSet.has(id), cap: id === captain ? 'C' : id === vc ? 'VC' : null, isNew: newIds.includes(id),
  })).join('')}</ul>`;
}

/** Role split bar + credits + side split for a set of 11 players. */
function composition(ids, { sidesToo = false } = {}) {
  const s = teamStats(ids, ctx.pool);
  const bar = ROLES.filter((r) => s.roles[r]).map((r) => `<i class="seg r-${r}" style="flex:${s.roles[r]}"></i>`).join('');
  const legend = ROLES.map((r) => `<span class="lg r-${r}"><i></i>${s.roles[r]} ${r}</span>`).join('');
  const split = Object.entries(s.sides).map(([k, n]) => `${k} ${n}`).join(' / ');
  return `<div class="comp"><div class="bar-roles" role="img" aria-label="Role split">${bar}</div>
    <div class="legend">${legend}<span class="cl"><b>${fmt(s.credits)}</b> / 100 cr</span></div>
    ${sidesToo ? `<div class="facts"><span>Players per side</span><span>${split}</span></div>` : ''}</div>`;
}

function leaders(team, { captain = team.captain, vc = team.vc, outSet = null } = {}) {
  const one = (tag, id) => `<span class="ld${outSet && outSet.has(id) ? ' gone' : ''}"><b>${tag}</b>${esc(P(id).name)}</span>`;
  return `<div class="leaders">${one('C', captain)}${one('VC', vc)}</div>`;
}

/* ---------- team card ---------- */

function swapRows(opt) {
  return `<ul class="swaps">${opt.swaps.map((s) => {
    const o = P(s.out), i = P(s.in);
    const d = Math.round((i.credits - o.credits) * 10) / 10;
    return `<li class="swap"><span class="from r-${o.role}"><i class="rl">${o.role}</i><s>${esc(o.name)}</s></span>
      <svg class="arr" viewBox="0 0 20 12" aria-hidden="true"><path d="M1 6h16m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="to r-${i.role}"><i class="rl">${i.role}</i><b>${esc(i.name)}</b></span>
      <em class="num">${i.credits} cr <span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)}</span></em></li>`;
  }).join('')}</ul>`;
}

function leaderChange(team, opt) {
  const bits = [];
  if (opt.captainChanged) bits.push(`<span><b>C</b><s>${esc(P(team.captain).name)}</s> to <strong>${esc(P(opt.captain).name)}</strong></span>`);
  if (opt.vcChanged) bits.push(`<span><b>VC</b><s>${esc(P(team.vc).name)}</s> to <strong>${esc(P(opt.vc).name)}</strong></span>`);
  return bits.length ? `<div class="lchange">${bits.join('')}</div>` : `<div class="lchange keep">Captain and vice-captain stay as they are</div>`;
}

function explanation(team, fix, opt) {
  // AI text exists only for each team's best fix; every other option uses the built-in template.
  const ai = state.ai[state.lang]?.[team.id];
  if (ai && opt === fix.options[0]) return { text: ai, ai: true };
  return { text: explainTemplate(team, fix, opt, ctx, state.lang), ai: false };
}

function scoreRow(team) {
  const r = state.result?.rows.find((x) => x.team.id === team.id);
  if (!r) return '';
  const gain = r.mine - r.none;
  return `<div class="score"><div><span>Without fixing</span><b class="num">${fmt(r.none)}</b></div>
    <div class="mine"><span>With my fixes</span><b class="num">${fmt(r.mine)}</b>${gain > 0 ? `<small class="num">+${fmt(gain)}</small>` : ''}</div>
    <div><span>Hindsight-best</span><b class="num">${fmt(r.hind)}</b></div></div>`;
}

function teamCard(team) {
  const fix = state.fixes.get(team.id);
  const played = state.phase === 'played';
  if (!fix.broken) {
    return `<article class="team fine"><header><h3>${esc(team.name)}</h3><span class="st ok">Fine</span></header>
      <p class="line">All 11 players are in the playing XI. Nothing to fix.</p>
      ${scoreRow(team)}${composition(team.players)}${leaders(team)}
      <details class="more"><summary>View players</summary>${pills(team.players)}</details></article>`;
  }
  const outSet = new Set(fix.out);
  const alert = fix.captainOut ? '<span class="st bad soft">Captain out</span>' : fix.vcOut ? '<span class="st warn soft">VC out</span>' : '';
  const applied = state.applied.get(team.id);
  if (applied) {
    return `<article class="team fixed"><header><h3>${esc(team.name)}</h3><span class="st ok">Fixed</span></header>
      ${scoreRow(team)}${composition(applied.players)}${leaders(team, { captain: applied.captain, vc: applied.vc })}
      ${swapRows(applied)}${leaderChange(team, applied)}
      <details class="more"><summary>View new XI</summary>${pills(applied.players, { captain: applied.captain, vc: applied.vc, newIds: applied.ins })}</details>
      ${played ? '' : `<button class="ghost" data-undo="${team.id}">Undo fix</button>`}</article>`;
  }
  if (fix.impossible) {
    return `<article class="team broken"><header><h3>${esc(team.name)}</h3><span class="st bad">Broken</span>${alert}</header>
      <p class="line"><b>${fix.out.length}</b> of 11 players are out</p>
      ${scoreRow(team)}${composition(team.players)}${leaders(team, { outSet })}${pills(team.players, { captain: team.captain, vc: team.vc, outSet })}
      <div class="nofix"><b>No valid fix</b><p>${esc(noFixText(team, fix, ctx, state.lang))}</p></div></article>`;
  }
  const idx = state.pick.get(team.id) ?? 0;
  const opt = fix.options[idx];
  const x = explanation(team, fix, opt);
  return `<article class="team broken" data-team="${team.id}">
    <header><h3>${esc(team.name)}</h3><span class="st bad">Broken</span>${alert}</header>
    <p class="line"><b>${fix.out.length}</b> of 11 players are out</p>
    ${scoreRow(team)}${composition(team.players)}${leaders(team, { outSet })}
    ${pills(team.players, { captain: team.captain, vc: team.vc, outSet })}
    <div class="opts" role="tablist" aria-label="Fix options for ${esc(team.name)}">
      ${fix.options.map((o, i) => `<button role="tab" aria-selected="${i === idx}" data-opt="${team.id}:${i}"><span>${i === 0 ? 'Best fix' : 'Option ' + (i + 1)}</span><small class="num">+${fmt(o.projGain)} proj</small></button>`).join('')}
    </div>
    ${swapRows(opt)}${leaderChange(team, opt)}
    <p class="why"><span class="src">${x.ai ? 'AI' : 'Built-in'}</span>${esc(x.text)}</p>
    <footer><span class="left"><b class="num">${opt.creditsLeft}</b> cr left</span><button class="apply" data-apply="${team.id}">Apply fix</button></footer>
  </article>`;
}

/* ---------- match header, toss, XIs ---------- */

function topbar() {
  return `<header class="top"><div class="brand">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 6.5c3 2.5 3 8.5 0 11M18 6.5c-3 2.5-3 8.5 0 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <h1>Toss Panic Fixer</h1></div>
    <span class="sample" title="Fictional players and a generated match">SAMPLE (simulated)</span></header>`;
}

function matchHeader() {
  const status = state.phase === 'pre' ? 'Pre-toss, XIs not announced' : state.phase === 'toss' ? 'Toss done, XIs confirmed' : 'Match played';
  return `<section class="match" aria-label="Match">
    <div class="tm"><i class="crest">BAY</i><b>${esc(sides.BAY)}</b></div>
    <div class="vs"><span>vs</span></div>
    <div class="tm r"><b>${esc(sides.DSH)}</b><i class="crest">DSH</i></div>
    <div class="meta"><span class="stat-dot ${state.phase}"></span>${status}<span class="venue">${esc(match.info.match_type)} at ${esc(match.info.venue)}</span></div>
  </section>`;
}

function impact() {
  const fixes = [...state.fixes.values()];
  const aff = fixes.filter((f) => f.broken);
  const outIds = new Set(aff.flatMap((f) => f.out));
  const caps = aff.filter((f) => f.captainOut).length;
  const vcs = aff.filter((f) => f.vcOut).length;
  const fine = fixes.length - aff.length;
  return `<section class="impact" aria-label="Impact summary">
    <div class="hero"><b class="num">${aff.length}<small>/${teams.length}</small></b><span>teams broken by the toss<em>${fine} ${fine === 1 ? 'team is' : 'teams are'} fine</em></span></div>
    <div class="cell"><b class="num warn">${outIds.size}</b><span>players out</span></div>
    <div class="cell"><b class="num bad">${caps}</b><span>captains out</span></div>
    <div class="cell"><b class="num warn">${vcs}</b><span>VCs out</span></div>
  </section>`;
}

function xiRow(id, i) {
  const p = P(id);
  return `<li class="xr r-${p.role}" style="--i:${i}"><span class="nm"><em>${i + 1}</em>${esc(p.name)}</span><span class="sub"><i class="rl">${p.role}</i><span class="cr">${p.credits} cr</span></span></li>`;
}

function tossNews() {
  const t = meta.toss;
  const benched = (s) => meta.squads[s].filter((p) => !ctx.xi.has(p.id));
  const side = (s) => `<div class="xi-side"><h4>${esc(sides[s])}</h4>
      <ol>${meta.xiOrder[s].map(xiRow).join('')}</ol>
      ${benched(s).length ? `<p class="bench">Not playing</p><ul class="benchlist">${benched(s).map((p) => `<li class="r-${p.role}"><i class="rl">${p.role}</i><s>${esc(p.name)}</s></li>`).join('')}</ul>` : ''}</div>`;
  return `<section class="news"><div class="lower"><b>${esc(t.winner)}</b> won the toss and chose to ${esc(t.decision)}</div>
    <ul class="notes">${meta.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    <details class="xi" ${state.xiOpen ? 'open' : ''}><summary>Confirmed playing XIs</summary><div class="xi-grid">${side('BAY')}${side('DSH')}</div></details></section>`;
}

function coinOverlay() {
  const t = meta.toss;
  return `<div id="coin" class="coin-wrap" role="status"><div class="coin"><i>T</i><i>H</i></div>
    <p><b>${esc(t.winner)}</b> won the toss<span>and chose to ${esc(t.decision)}</span></p><small>Tap to skip</small></div>`;
}

/* ---------- AI controls (unchanged behaviour) ---------- */

function langToggle() {
  const ai = state.ai[state.lang] ? 'AI explanations on' : state.ai.loading ? 'Asking Claude…' : 'Explain with AI';
  return `<div class="lang-row"><button class="aibtn" data-act="explain" ${state.ai.loading || state.ai[state.lang] ? 'disabled' : ''}>${ai}</button>
    <div class="lang" role="group" aria-label="Explanation language">
    <button data-lang="en" aria-pressed="${state.lang === 'en'}">English</button>
    <button data-lang="hinglish" aria-pressed="${state.lang === 'hinglish'}">Hinglish</button></div></div>
    ${state.ai.error ? `<p class="aierr" role="status">${esc(state.ai.error)}</p>` : ''}`;
}

function askBox() {
  const a = state.ask;
  const chips = ['Who should captain Powerplay Pandits?', 'Can I swap Mohit Saxena for Siddharth Rao in t1?', 'Which of my teams has no valid fix?'];
  return `<section class="ask"><h2>Ask the Fixer</h2>
    <form data-ask><input name="q" maxlength="300" placeholder="e.g. Is swapping Tejas Naik for Harsh Menon valid in t1?" value="${esc(a.q)}" aria-label="Your question" autocomplete="off">
      <button class="apply" ${a.loading ? 'disabled' : ''}>${a.loading ? 'Checking…' : 'Ask'}</button></form>
    <div class="chips">${chips.map((c) => `<button type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    ${a.answer ? `<div class="answer"><p>${esc(a.answer)}</p><small>Checked with the real engine: ${a.tools.length ? a.tools.map((t) => `<code>${esc(t)}</code>`).join(' ') : 'no tools used'}. Projections use pre-match form only.</small></div>` : ''}
    ${a.error ? `<p class="aierr" role="status">${esc(a.error)}</p>` : ''}</section>`;
}

/* ---------- full time ---------- */

function fullTime() {
  const e = state.result;
  const pct = e.recovered === null ? 'n/a' : `${e.recovered}%`;
  const max = Math.max(e.totals.hind, e.totals.mine, e.totals.none, 1);
  const w = (v) => `${Math.max(2, Math.round((v / max) * 100))}%`;
  const line = (cls, label, v, extra = '') => `<div class="inn ${cls}"><div class="il"><span>${label}</span><b class="num">${fmt(v)}</b></div><div class="track"><i style="width:${w(v)}"></i></div>${extra}</div>`;
  return `<section class="fulltime" aria-label="Full time">
    <div class="ft-head"><h2>Full time</h2><span class="sample sm">SAMPLE (simulated)</span></div>
    <div class="rec"><b class="num">${pct}</b><span>of the gap recovered<em class="num">${fmt(e.totals.mine - e.totals.none)} of ${fmt(e.totals.hind - e.totals.none)} points</em></span></div>
    ${line('none', 'Without fixing', e.totals.none)}
    ${line('mine', 'With my fixes', e.totals.mine, `<p class="rcv num">+${fmt(e.totals.mine - e.totals.none)} recovered</p>`)}
    ${line('hind', 'Hindsight-best', e.totals.hind)}
    <p class="honest">One simulated match with fictional players. Recommendations used pre-match form only; actual points appear only here. This is not a real-world accuracy figure.</p>
  </section>`;
}

function footerBar() {
  const left = [...state.fixes.values()].filter((f) => f.broken && !f.impossible && !state.applied.has(f.teamId)).length;
  if (state.phase === 'pre') return `<button class="cta" data-act="toss">Toss happens</button>`;
  if (state.phase === 'toss') {
    return `<button class="cta ghosty" data-act="fixall" ${left ? '' : 'disabled'}>Fix all${left ? ` (${left})` : ''}</button>
      <button class="cta" data-act="play">Play the match</button>`;
  }
  return `<button class="cta" data-act="reset">Start over</button>`;
}

function preCard(t) {
  return `<article class="team pre"><details><summary><span class="sm-h"><h3>${esc(t.name)}</h3><span class="st neutral">Valid</span></span>
    ${composition(t.players, { sidesToo: true })}${leaders(t)}<span class="expand">View players</span></summary>${pills(t.players, { captain: t.captain, vc: t.vc })}</details></article>`;
}

function render() {
  const app = $('#app');
  let side = '';
  let main = '';
  if (state.phase === 'pre') {
    side = `<section class="intro"><h2>Before the toss</h2>
      <p>Your ${teams.length} teams are all valid right now. When the toss happens, the playing XIs drop and any player who is not in them scores zero.</p></section>`;
    main = `<div class="list-h"><h2>Your ${teams.length} teams</h2></div>${teams.map(preCard).join('')}`;
  } else if (state.phase === 'toss') {
    side = `${impact()}${tossNews()}${askBox()}`;
    main = `<div class="list-h"><h2>Your teams</h2>${langToggle()}</div>
      ${[...teams].sort((a, b) => Number(state.fixes.get(b.id).broken) - Number(state.fixes.get(a.id).broken)).map(teamCard).join('')}`;
  } else {
    side = fullTime();
    main = `<div class="list-h"><h2>Team by team</h2>${langToggle()}</div>${teams.map(teamCard).join('')}`;
  }
  app.className = state.fresh ? 'fresh' : '';
  app.innerHTML = `${topbar()}${matchHeader()}<div class="shell"><aside>${side}<nav class="bar" aria-label="Actions">${footerBar()}</nav></aside><main>${main}</main></div>${state.coin ? coinOverlay() : ''}`;
}

function endCoin() {
  state.coin = false;
  $('#coin')?.remove();
}

function toss() {
  for (const t of teams) state.fixes.set(t.id, fixTeam(t, ctx));
  state.phase = 'toss';
  state.coin = !reduceMotion();
  state.fresh = true;
  render();
  window.scrollTo({ top: 0 });
  if (state.coin) setTimeout(endCoin, 2300);
  setTimeout(() => { state.fresh = false; $('#app').classList.remove('fresh'); }, 3600);
}

async function runExplain() {
  const lang = state.lang;
  state.ai.loading = true; state.ai.error = ''; render();
  try { state.ai[lang] = await explainAll(lang); }
  catch { state.ai.error = 'AI is unavailable right now, so you are seeing the built-in explanations. The fixes themselves are unaffected.'; }
  state.ai.loading = false; render();
}

async function runAsk(q) {
  state.ask = { q, loading: true, answer: '', tools: [], error: '' }; render();
  try {
    const out = await askFixer(q, state.lang);
    state.ask = { q, loading: false, answer: out.answer, tools: [...new Set(out.toolCalls.map((t) => t.name))], error: '' };
  } catch (err) {
    state.ask = { q, loading: false, answer: '', tools: [], error: `${err.message}. Everything else still works.` };
  }
  render();
}

document.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-ask]')) return;
  e.preventDefault();
  const q = new FormData(e.target).get('q').trim();
  if (q.length >= 3 && !state.ask.loading) runAsk(q);
});
document.addEventListener('input', (e) => { if (e.target.name === 'q') state.ask.q = e.target.value; });

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.chip) { state.ask.q = d.chip; render(); return; }
  if (d.act === 'explain') runExplain();
  else if (d.act === 'toss') toss();
  else if (d.act === 'fixall') {
    for (const [id, f] of state.fixes) if (f.options.length && !state.applied.has(id)) state.applied.set(id, f.options[state.pick.get(id) ?? 0]);
    render();
  } else if (d.act === 'play') {
    state.result = evaluate(teams, state.applied, ctx, actual);
    state.phase = 'played';
    render();
    window.scrollTo({ top: 0 });
  } else if (d.act === 'reset') {
    state.phase = 'pre'; state.fixes.clear(); state.pick.clear(); state.applied.clear(); state.result = null; state.ai = { en: null, hinglish: null, loading: false, error: '' }; state.ask = { q: '', loading: false, answer: '', tools: [], error: '' };
    render(); window.scrollTo({ top: 0 });
  } else if (d.apply) { state.applied.set(d.apply, state.fixes.get(d.apply).options[state.pick.get(d.apply) ?? 0]); render(); }
  else if (d.undo) { state.applied.delete(d.undo); render(); }
  else if (d.opt) { const [id, i] = d.opt.split(':'); state.pick.set(id, Number(i)); render(); }
  else if (d.lang) { state.lang = d.lang; render(); }
});

document.addEventListener('click', (e) => { if (e.target.closest('#coin')) endCoin(); });
// <details> does not bubble 'toggle'; capture it so the open state survives re-renders.
document.addEventListener('toggle', (e) => { if (e.target.matches('details.xi')) state.xiOpen = e.target.open; }, true);

render();
// Exposed for tests and for debugging in the console.
window.__tpf = { state, findBroken };
