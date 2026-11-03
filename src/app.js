// Browser UI. Pure engine code does the work; this file only renders and wires events.
import { ctx, teams, meta, sides, actualPoints } from './data.js';
import { fixTeam, findBroken } from './engine.js';
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
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const P = (id) => ctx.pool.get(id);

function pill(id, { out = false, cap = null, isNew = false } = {}) {
  const p = P(id);
  const badge = cap ? `<b class="cv">${cap}</b>` : '';
  return `<li class="pill r-${p.role}${out ? ' out' : ''}${isNew ? ' new' : ''}" title="${esc(p.name)} · ${p.role} · ${p.credits} cr · ${p.side}">
    <span class="role">${p.role}</span><span class="nm">${esc(p.name)}</span>${badge}<span class="cr">${p.credits}</span></li>`;
}

function pills(team, ids = team.players, { captain = team.captain, vc = team.vc, newIds = [], flagOut = false } = {}) {
  const rank = { WK: 0, BAT: 1, AR: 2, BOWL: 3 };
  const sorted = [...ids].sort((a, b) => rank[P(a).role] - rank[P(b).role] || P(b).credits - P(a).credits);
  return `<ul class="pills">${sorted.map((id) => pill(id, {
    out: flagOut && !ctx.xi.has(id), cap: id === captain ? 'C' : id === vc ? 'VC' : null, isNew: newIds.includes(id),
  })).join('')}</ul>`;
}

// AI text exists only for each team's best fix; every other option uses the built-in template.
function explanation(team, fix, opt) {
  const ai = state.ai[state.lang]?.[team.id];
  if (ai && opt === fix.options[0]) return { text: ai, ai: true };
  return { text: explainTemplate(team, fix, opt, ctx, state.lang), ai: false };
}

function swapRows(opt) {
  return opt.swaps.map((s) => {
    const o = P(s.out), i = P(s.in);
    const d = Math.round((i.credits - o.credits) * 10) / 10;
    return `<li class="swap"><span class="gone r-${o.role}">${esc(o.name)}</span><i aria-hidden="true">→</i>
      <span class="r-${i.role} came">${esc(i.name)}</span><em>${i.role} · ${i.credits} cr (${d > 0 ? '+' : ''}${d})</em></li>`;
  }).join('');
}

function leaderChange(team, opt) {
  const bits = [];
  if (opt.captainChanged) bits.push(`C: <s>${esc(P(team.captain).name)}</s> → <b>${esc(P(opt.captain).name)}</b>`);
  if (opt.vcChanged) bits.push(`VC: <s>${esc(P(team.vc).name)}</s> → <b>${esc(P(opt.vc).name)}</b>`);
  return bits.length ? `<p class="lead">${bits.join(' · ')}</p>` : `<p class="lead keep">Captain and vice-captain stay the same</p>`;
}

function teamCard(team) {
  const fix = state.fixes.get(team.id);
  const status = state.phase === 'toss' || state.phase === 'played' ? fix : null;
  if (!status || !fix.broken) {
    return `<article class="card fine"><header><h3>${esc(team.name)}</h3><span class="tag ok">All 11 playing</span></header>
      ${pills(team)}<p class="muted">Nothing to fix. This is your control team.</p></article>`;
  }
  const applied = state.applied.get(team.id);
  const cap = fix.captainOut ? '<span class="tag bad">Captain out</span>' : fix.vcOut ? '<span class="tag warn">VC out</span>' : '';
  const locked = state.phase === 'played';
  if (fix.impossible) {
    return `<article class="card broken"><header><h3>${esc(team.name)}</h3><span class="tag bad">${fix.out.length} out</span>${cap}</header>
      ${pills(team, team.players, { flagOut: true })}
      <p class="nofix"><strong>No valid fix.</strong> ${esc(noFixText(team, fix, ctx, state.lang))}</p></article>`;
  }
  const idx = state.pick.get(team.id) ?? 0;
  const opt = fix.options[idx];
  if (applied) {
    return `<article class="card done"><header><h3>${esc(team.name)}</h3><span class="tag ok">Fixed</span></header>
      ${pills(team, applied.players, { captain: applied.captain, vc: applied.vc, newIds: applied.ins })}
      ${leaderChange(team, applied)}
      ${locked ? '' : `<button class="ghost" data-undo="${team.id}">Undo</button>`}</article>`;
  }
  return `<article class="card broken" data-team="${team.id}">
    <header><h3>${esc(team.name)}</h3><span class="tag bad">${fix.out.length} out</span>${cap}</header>
    ${pills(team, team.players, { flagOut: true })}
    <div class="opts" role="tablist" aria-label="Fix options for ${esc(team.name)}">
      ${fix.options.map((o, i) => `<button role="tab" aria-selected="${i === idx}" data-opt="${team.id}:${i}">${i === 0 ? 'Best fix' : 'Option ' + (i + 1)}<small>+${fmt(o.projGain)} proj</small></button>`).join('')}
    </div>
    <ul class="swaps">${swapRows(opt)}</ul>
    ${leaderChange(team, opt)}
    ${(() => { const x = explanation(team, fix, opt); return `<p class="why"><span class="src">${x.ai ? 'AI' : 'Built-in'}</span>${esc(x.text)}</p>`; })()}
    <footer><span class="cl">${opt.creditsLeft} cr left</span><button class="apply" data-apply="${team.id}">Apply this fix</button></footer>
  </article>`;
}

function banner() {
  const fixes = [...state.fixes.values()];
  const aff = fixes.filter((f) => f.broken);
  const outIds = new Set(aff.flatMap((f) => f.out));
  const caps = aff.filter((f) => f.captainOut).length;
  const vcs = aff.filter((f) => f.vcOut).length;
  const stat = (n, l, cls = '') => `<div class="stat ${cls}"><b>${n}</b><span>${l}</span></div>`;
  return `<section class="banner" aria-label="Summary">
    ${stat(`${aff.length}<small>/${teams.length}</small>`, 'teams affected', 'bad')}
    ${stat(outIds.size, 'players out', 'warn')}
    ${stat(caps, 'captains out', 'bad')}
    ${stat(vcs, 'vice-captains out', 'warn')}
  </section>`;
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

function tossNews() {
  const t = meta.toss;
  return `<section class="news"><h2>Toss news</h2>
    <p><b>${esc(t.winner)}</b> won the toss and chose to <b>${esc(t.decision)}</b>.</p>
    <ul>${meta.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    <details><summary>Announced Playing XIs</summary>
      ${Object.entries(meta.xiOrder).map(([s, ids]) => `<h4>${esc(sides[s])}</h4><ul class="pills">${ids.map((id) => pill(id)).join('')}</ul>`).join('')}
    </details></section>`;
}

function langToggle() {
  const ai = state.ai[state.lang] ? 'AI explanations on' : state.ai.loading ? 'Asking Claude…' : 'Explain with AI';
  return `<div class="lang-row"><button class="aibtn" data-act="explain" ${state.ai.loading || state.ai[state.lang] ? 'disabled' : ''}>${ai}</button>
    <div class="lang" role="group" aria-label="Explanation language">
    <button data-lang="en" aria-pressed="${state.lang === 'en'}">English</button>
    <button data-lang="hinglish" aria-pressed="${state.lang === 'hinglish'}">Hinglish</button></div></div>
    ${state.ai.error ? `<p class="aierr" role="status">${esc(state.ai.error)}</p>` : ''}`;
}

function resultTable() {
  const e = state.result;
  const row = (r) => `<tr><th scope="row">${esc(r.team.name)}</th><td>${fmt(r.none)}</td><td>${fmt(r.mine)}</td><td>${fmt(r.hind)}</td></tr>`;
  const pct = e.recovered === null ? 'n/a' : `${e.recovered}%`;
  return `<section class="result"><h2>Full time</h2>
    <div class="big"><b>${pct}</b><span>of the gap recovered</span></div>
    <p class="muted">Gap = hindsight-best minus doing nothing, ${fmt(e.totals.hind - e.totals.none)} pts across your ${teams.length} teams.</p>
    <div class="tablewrap"><table>
      <thead><tr><th>Team</th><th>Without fixing</th><th>With my fixes</th><th>Hindsight best</th></tr></thead>
      <tbody>${e.rows.map(row).join('')}</tbody>
      <tfoot><tr><th>Total</th><td>${fmt(e.totals.none)}</td><td class="hl">${fmt(e.totals.mine)}</td><td>${fmt(e.totals.hind)}</td></tr></tfoot>
    </table></div>
    <p class="honest">One simulated match with fictional players. Recommendations used pre-match form only; actual points appear only in this table. This is not a real-world accuracy figure.</p>
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

function render() {
  const app = $('#app');
  const head = `<header class="top"><div class="brand"><span class="coin" aria-hidden="true"></span><h1>Toss Panic Fixer</h1></div>
    <span class="sample" title="Fictional players and a generated match">SAMPLE (simulated)</span></header>
    <section class="match"><div class="side bay"><b>${esc(sides.BAY)}</b></div><div class="vs">vs</div><div class="side dsh"><b>${esc(sides.DSH)}</b></div></section>`;
  let body = '';
  if (state.phase === 'pre') {
    body = `<section class="intro"><h2>Your ${teams.length} teams, before the toss</h2>
      <p>All teams are valid right now. Once the XIs drop, some of these players may not play.</p></section>
      ${teams.map((t) => `<article class="card"><header><h3>${esc(t.name)}</h3></header>${pills(t)}</article>`).join('')}`;
  } else if (state.phase === 'toss') {
    body = `${tossNews()}${banner()}${askBox()}<div class="toolbar"><h2>Your teams</h2>${langToggle()}</div>
      ${[...teams].sort((a, b) => Number(state.fixes.get(b.id).broken) - Number(state.fixes.get(a.id).broken)).map(teamCard).join('')}`;
  } else {
    body = `${resultTable()}<div class="toolbar"><h2>Your teams</h2>${langToggle()}</div>${teams.map(teamCard).join('')}`;
  }
  app.innerHTML = `${head}<main>${body}</main><nav class="bar" aria-label="Actions">${footerBar()}</nav>`;
}

function toss() {
  for (const t of teams) state.fixes.set(t.id, fixTeam(t, ctx));
  state.phase = 'toss';
  render();
  window.scrollTo({ top: 0 });
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

render();
// Exposed for tests and for debugging in the console.
window.__tpf = { state, findBroken };
