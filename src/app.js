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
  askOpen: true,
  tab: 'teams', // phone only: teams | xi | ask
  sheet: null, // phone only: team id shown in the bottom sheet
  toast: '',
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

/** Players grouped under role headings: denser, and the role chip is not repeated on every pill. */
function pillsByRole(ids, opts = {}) {
  const { captain = null, vc = null, newIds = [] } = opts;
  return `<div class="groups">${ROLES.map((r) => {
    const g = ids.filter((id) => P(id).role === r).sort((a, b) => P(b).credits - P(a).credits);
    if (!g.length) return '';
    return `<section class="grp r-${r}"><h5>${r}<b>${g.length}</b></h5><ul class="pills one">${g.map((id) => pill(id, { cap: id === captain ? 'C' : id === vc ? 'VC' : null, isNew: newIds.includes(id) })).join('')}</ul></section>`;
  }).join('')}</div>`;
}

/** Role split bar + credits + side split for a set of 11 players. */
function composition(ids, { legend = true } = {}) {
  const s = teamStats(ids, ctx.pool);
  const bar = ROLES.filter((r) => s.roles[r]).map((r) => `<i class="seg r-${r}" style="flex:${s.roles[r]}"></i>`).join('');
  const legendHtml = ROLES.map((r) => `<span class="lg r-${r}"><i></i>${s.roles[r]} ${r}</span>`).join('');
  return `<div class="comp"><div class="bar-roles" role="img" aria-label="Role split">${bar}</div>
    ${legend ? `<div class="legend">${legendHtml}<span class="cl"><b>${fmt(s.credits)}</b> / 100 cr</span></div>` : ''}</div>`;
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
    return `<li class="swap"><span class="from"><s>${esc(o.name)}</s></span>
      <svg class="arr" viewBox="0 0 20 12" aria-hidden="true"><path d="M1 6h16m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="to r-${i.role}"><i class="rl">${i.role}</i><b>${esc(i.name)}</b></span>
      <em class="num">${i.credits} cr <span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)}</span></em></li>`;
  }).join('')}</ul>`;
}

function leaderChange(team, opt) {
  const one = (tag, was, now) => (was === now
    ? `<span class="stay"><b>${tag}</b>${esc(P(now).name)} stays</span>`
    : `<span><b>${tag}</b><s>${esc(P(was).name)}</s> to <strong>${esc(P(now).name)}</strong></span>`);
  return `<div class="lchange">${one('C', team.captain, opt.captain)}${one('VC', team.vc, opt.vc)}</div>`;
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
      ${scoreRow(team)}${composition(team.players, { legend: false })}${leaders(team)}
      <details class="more"><summary>View players</summary>${pillsByRole(team.players, { captain: team.captain, vc: team.vc })}</details></article>`;
  }
  const outSet = new Set(fix.out);
  const alert = fix.captainOut ? '<span class="st bad soft">Captain out</span>' : fix.vcOut ? '<span class="st warn soft">VC out</span>' : '';
  const applied = state.applied.get(team.id);
  if (applied) {
    return `<article class="team fixed"><header><h3>${esc(team.name)}</h3><span class="st ok">Fixed</span></header>
      <p class="line"><span><b>${applied.swaps.length}</b> ${applied.swaps.length === 1 ? 'swap' : 'swaps'} applied</span><span class="cl"><b>${fmt(applied.stats.credits)}</b> / 100 cr</span></p>
      ${scoreRow(team)}${composition(applied.players, { legend: false })}${leaderChange(team, applied)}
      <details class="more"><summary>Swaps and new XI</summary>${swapRows(applied)}${pillsByRole(applied.players, { captain: applied.captain, vc: applied.vc, newIds: applied.ins })}</details>
      ${played ? '' : `<button class="ghost" data-undo="${team.id}">Undo fix</button>`}</article>`;
  }
  if (fix.impossible) {
    return `<article class="team broken"><header><h3>${esc(team.name)}</h3><span class="st bad">Broken</span>${alert}</header>
      <p class="line"><span><b>${fix.out.length}</b> of 11 players are out</span></p>
      ${scoreRow(team)}${composition(team.players, { legend: false })}${pills(fix.out, { captain: team.captain, vc: team.vc, outSet })}
      <details class="more keep"><summary>${team.players.length - fix.out.length} still playing</summary>${pillsByRole(team.players.filter((id) => !outSet.has(id)), { captain: team.captain, vc: team.vc })}</details>
      <div class="nofix"><b>No valid fix</b><p>${esc(noFixText(team, fix, ctx, state.lang))}</p></div></article>`;
  }
  const idx = state.pick.get(team.id) ?? 0;
  const opt = fix.options[idx];
  const x = explanation(team, fix, opt);
  const stay = team.players.filter((id) => !outSet.has(id));
  return `<article class="team broken" data-team="${team.id}">
    <header><h3>${esc(team.name)}</h3><span class="st bad">Broken</span>${alert}</header>
    <p class="line"><span><b>${fix.out.length}</b> of 11 players are out</span><span class="cl"><b>${fmt(teamStats(team.players, ctx.pool).credits)}</b> / 100 cr</span></p>
    ${scoreRow(team)}${composition(team.players, { legend: false })}
    ${pills(fix.out, { captain: team.captain, vc: team.vc, outSet })}
    <details class="more keep"><summary>${stay.length} still playing</summary>${pillsByRole(stay, { captain: team.captain, vc: team.vc })}</details>
    <div class="opts" role="tablist" aria-label="Fix options for ${esc(team.name)}">
      ${fix.options.map((o, i) => `<button role="tab" aria-selected="${i === idx}" data-opt="${team.id}:${i}"><span>${i === 0 ? 'Best fix' : 'Option ' + (i + 1)}</span><small class="num">+${fmt(o.projGain)} proj</small></button>`).join('')}
    </div>
    <div class="cmp" aria-label="Before and after this fix">
      <div><span>Players out</span><b class="num">${fix.out.length}<i>to</i>0</b></div>
      <div><span>Credits left</span><b class="num">${fmt(100 - teamStats(team.players, ctx.pool).credits)}<i>to</i>${fmt(opt.creditsLeft)}</b></div>
      <div><span>Projected</span><b class="num pos">+${fmt(opt.projGain)}</b></div>
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
  return `<section class="impact" data-panel="teams" aria-label="Impact summary">
    <div class="hero"><b class="num">${aff.length}<small>/${teams.length}</small></b><span>teams broken<i> by the toss</i><em>${fine} ${fine === 1 ? 'team is' : 'teams are'} fine</em></span></div>
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
  return `<section class="news" data-panel="xi"><div class="lower"><b>${esc(t.winner)}</b> won the toss and chose to ${esc(t.decision)}</div>
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
  const open = state.askOpen || a.q || a.answer || a.error || a.loading;
  return `<details class="ask" data-panel="ask" ${open ? 'open' : ''}><summary><h2>Ask the Fixer</h2><span>Check any swap against the real rules</span></summary>
    <form data-ask><input name="q" maxlength="300" placeholder="e.g. Is swapping Tejas Naik for Harsh Menon valid in t1?" value="${esc(a.q)}" aria-label="Your question" autocomplete="off">
      <button class="apply" ${a.loading ? 'disabled' : ''}>${a.loading ? 'Checking…' : 'Ask'}</button></form>
    <div class="chips">${chips.map((c) => `<button type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    ${a.answer ? `<div class="answer"><p>${esc(a.answer)}</p><small>Checked with the real engine: ${a.tools.length ? a.tools.map((t) => `<code>${esc(t)}</code>`).join(' ') : 'no tools used'}. Projections use pre-match form only.</small></div>` : ''}
    ${a.error ? `<p class="aierr" role="status">${esc(a.error)}</p>` : ''}</details>`;
}

/* ---------- full time ---------- */

function fullTime() {
  const e = state.result;
  const pct = e.recovered === null ? 'n/a' : `${e.recovered}%`;
  const max = Math.max(e.totals.hind, e.totals.mine, e.totals.none, 1);
  const w = (v) => `${Math.max(2, Math.round((v / max) * 100))}%`;
  const line = (cls, label, v, extra = '') => `<div class="inn ${cls}"><div class="il"><span>${label}</span><b class="num">${fmt(v)}</b></div><div class="track"><i style="width:${w(v)}"></i></div>${extra}</div>`;
  return `<section class="fulltime" data-panel="teams" aria-label="Full time">
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

/* ---------- phone: list rows, result rows, bottom sheet, tabs ---------- */

const chev = '<svg class="chev" viewBox="0 0 8 14" aria-hidden="true"><path d="m1 1 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function teamRow(team) {
  const fix = state.fixes.get(team.id);
  const applied = state.applied.get(team.id);
  const name = esc(team.name);
  const open = (inner) => `<button class="open" data-open="${team.id}" aria-label="Open ${name}">${inner}</button>`;
  if (!fix.broken) {
    return `<div class="trow fine">${open(`<span class="tn">${name}</span><span class="ts ok">All 11 playing</span>`)}<span class="pillst ok">Fine</span>${chev}</div>`;
  }
  if (applied) {
    return `<div class="trow fixed">${open(`<span class="tn">${name}</span><span class="ts ok">${applied.swaps.length} ${applied.swaps.length === 1 ? 'swap' : 'swaps'} applied, +${fmt(applied.projGain)} proj</span>`)}<span class="pillst ok">Fixed</span>${chev}</div>`;
  }
  const flag = fix.captainOut ? '<span class="fl bad">Captain out</span>' : fix.vcOut ? '<span class="fl warn">VC out</span>' : '';
  if (fix.impossible) {
    return `<div class="trow broken">${open(`<span class="tn">${name}</span><span class="ts"><span class="bad">${fix.out.length} out</span>${flag}<span class="bad">No valid fix</span></span>`)}${chev}</div>`;
  }
  const best = fix.options[state.pick.get(team.id) ?? 0];
  return `<div class="trow broken">${open(`<span class="tn">${name}</span><span class="ts"><span class="bad">${fix.out.length} out</span>${flag}<span class="gain num">+${fmt(best.projGain)} proj</span></span>`)}<button class="qa" data-apply="${team.id}" aria-label="Apply best fix to ${name}">Fix</button></div>`;
}

function resultRow(team) {
  const e = state.result;
  const r = e.rows.find((x) => x.team.id === team.id);
  const max = Math.max(...e.rows.map((x) => x.hind), 1);
  const w = (v) => `${(v / max) * 100}%`;
  const gain = r.mine - r.none;
  return `<div class="trow result"><button class="open" data-open="${team.id}" aria-label="Open ${esc(team.name)}">
    <span class="rtop"><span class="tn">${esc(team.name)}</span><span class="rg num ${gain > 0 ? 'pos' : ''}">${gain > 0 ? '+' + fmt(gain) : 'no change'}</span></span>
    <span class="stack" role="img" aria-label="Without ${fmt(r.none)}, with fixes ${fmt(r.mine)}, hindsight best ${fmt(r.hind)}"><i class="s0" style="width:${w(r.none)}"></i><i class="s1" style="width:${w(gain)}"></i><i class="s2" style="width:${w(r.hind - r.mine)}"></i></span>
    <span class="rnums num"><span><i class="s0"></i>${fmt(r.none)}</span><span><i class="s1"></i>${fmt(r.mine)}</span><span><i class="s2"></i>${fmt(r.hind)}</span></span></button>${chev}</div>`;
}

function sheet() {
  const team = teams.find((t) => t.id === state.sheet);
  if (!team) return '';
  return `<div class="sheet-wrap"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(team.name)}">
    <div class="grab" aria-hidden="true"></div>
    <button class="x" data-closesheet aria-label="Close"><svg viewBox="0 0 14 14" aria-hidden="true"><path d="m2 2 10 10M12 2 2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
    <div class="sheet-body">${teamCard(team)}</div></div></div>`;
}

function tabs() {
  const left = [...state.fixes.values()].filter((f) => f.broken && !f.impossible && !state.applied.has(f.teamId)).length;
  const t = (id, label, badge = '') => `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}${badge}</button>`;
  return `<nav class="tabs" role="tablist" aria-label="Sections">${t('teams', 'My teams', left ? `<i>${left}</i>` : '')}${t('xi', 'Playing XIs')}${t('ask', 'Ask')}</nav>`;
}

function showToast(msg) {
  state.toast = msg;
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg;
  el.className = 'show';
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => { el.className = ''; }, 2400);
}

function preCard(t) {
  return `<article class="team pre"><details><summary><span class="sm-h"><h3>${esc(t.name)}</h3><span class="cl"><b>${fmt(teamStats(t.players, ctx.pool).credits)}</b> / 100 cr</span></span>
    ${composition(t.players, { legend: false })}${leaders(t)}</summary>${pillsByRole(t.players, { captain: t.captain, vc: t.vc })}</details></article>`;
}

function render() {
  const app = $('#app');
  let side = '';
  let main = '';
  if (state.phase === 'pre') {
    side = `<section class="intro"><h2>Before the toss</h2>
      <p>Your ${teams.length} teams are all valid right now. When the toss happens, the playing XIs drop and any player who is not in them scores zero.</p></section>`;
    main = `<div class="list-h"><h2>Your ${teams.length} teams</h2><span class="allvalid">All valid</span></div>${teams.map(preCard).join('')}`;
  } else if (state.phase === 'toss') {
    const ordered = [...teams].sort((a, b) => Number(state.fixes.get(b.id).broken) - Number(state.fixes.get(a.id).broken));
    side = `${impact()}${tossNews()}${askBox()}`;
    main = `<div class="list-h"><h2>Your teams</h2>${langToggle()}</div>
      <div class="dcards">${ordered.map(teamCard).join('')}</div><div class="mrows">${ordered.map(teamRow).join('')}</div>`;
  } else {
    side = fullTime();
    main = `<div class="list-h"><h2>Team by team</h2>${langToggle()}</div>
      <p class="rlegend"><span><i class="s0"></i>Without</span><span><i class="s1"></i>With my fixes</span><span><i class="s2"></i>Hindsight-best</span></p>
      <div class="dcards">${teams.map(teamCard).join('')}</div><div class="mrows">${teams.map(resultRow).join('')}</div>`;
  }
  const sheetBody = $('.sheet-body');
  const keep = sheetBody ? sheetBody.scrollTop : 0;
  app.className = state.fresh ? 'fresh' : '';
  if (state.phase === 'toss') app.dataset.tab = state.tab; else delete app.dataset.tab;
  app.innerHTML = `${topbar()}${matchHeader()}${state.phase === 'toss' ? tabs() : ''}<div class="shell"><aside>${side}<nav class="bar" aria-label="Actions">${footerBar()}</nav></aside><main data-panel="teams">${main}</main></div>${state.sheet ? sheet() : ''}${state.coin ? coinOverlay() : ''}`;
  document.documentElement.classList.toggle('lock', !!state.sheet);
  if (state.sheet && keep) $('.sheet-body').scrollTop = keep;
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
    state.phase = 'pre'; state.fixes.clear(); state.pick.clear(); state.applied.clear(); state.result = null; state.ai = { en: null, hinglish: null, loading: false, error: '' }; state.ask = { q: '', loading: false, answer: '', tools: [], error: '' }; state.tab = 'teams'; state.sheet = null;
    render(); window.scrollTo({ top: 0 });
  } else if (d.apply) { state.applied.set(d.apply, state.fixes.get(d.apply).options[state.pick.get(d.apply) ?? 0]); render(); }
  else if (d.undo) { state.applied.delete(d.undo); render(); }
  else if (d.opt) { const [id, i] = d.opt.split(':'); state.pick.set(id, Number(i)); render(); }
  else if (d.lang) { state.lang = d.lang; render(); }
});

document.addEventListener('click', (e) => { if (e.target.closest('#coin')) endCoin(); });

// Phone navigation: tabs, bottom sheet (with browser back support), and action feedback.
function openSheet(id) {
  state.sheet = id;
  history.pushState({ sheet: id }, '');
  render();
}
function closeSheet() {
  if (history.state?.sheet) history.back(); // popstate does the rest
  else { state.sheet = null; render(); }
}
window.addEventListener('popstate', () => { if (state.sheet) { state.sheet = null; render(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sheet) closeSheet(); });
document.addEventListener('click', (e) => {
  if (e.target.classList?.contains('sheet-wrap')) return closeSheet();
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.open) openSheet(d.open);
  else if (d.closesheet !== undefined) closeSheet();
  else if (d.tab) { state.tab = d.tab; render(); window.scrollTo({ top: 0 }); }
  else if (d.apply) {
    const name = teams.find((t) => t.id === d.apply).name;
    const wasSheet = !!state.sheet;
    state.sheet = null; render();
    if (wasSheet && history.state?.sheet) history.back();
    showToast(`${name} fixed`);
  } else if (d.act === 'fixall') showToast(`Fixed ${state.applied.size} teams`);
});
// <details> does not bubble 'toggle'; capture it so the open state survives re-renders.
document.addEventListener('toggle', (e) => {
  if (e.target.matches('details.xi')) state.xiOpen = e.target.open;
  if (e.target.matches('details.ask')) state.askOpen = e.target.open;
}, true);

render();
// Exposed for tests and for debugging in the console.
window.__tpf = { state, findBroken };
