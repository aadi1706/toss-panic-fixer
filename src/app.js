// Browser UI. Pure engine code does the work; this file only renders and wires events.
// Layout model: a team ledger (all 8 teams, scannable) + a repair workspace for the selected team
// + a context rail (toss report, playing XIs, Ask). On phones the workspace is a bottom sheet.
import { DATASETS, DEFAULT_ID, APP_DEFAULT_ID, AGGREGATE, getDataset } from './datasets.js';
import { fixTeam, teamStats, LIMITS } from './engine.js';
import { explainTemplate, noFixText } from './explain.js';
import { evaluate } from './evaluate.js';
import { explainAll, askFixer } from './ai.js';

// The active dataset. `ctx, teams, meta, match, sides, players` always point at it; useDataset() swaps them.
let D, ctx, teams, meta, match, sides, players, actual;
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
  askOpen: window.innerWidth < 900, // desktop: a collapsed row at the top of the rail; phones: the Ask tab
  tab: 'teams', // phone only: teams | xi | ask
  sheet: null, // phone only: team id shown in the bottom sheet
  sel: null, // desktop only: team id shown in the workspace
  xiSide: '', // which playing XI the rail shows (first side of the active dataset)
  flash: new Set(), // team ids that were just fixed (row highlight)
  animateSel: false,
  toast: '',
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const P = (id) => ctx.pool.get(id);
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;
const ROLES = ['WK', 'BAT', 'AR', 'BOWL'];
const ROLE_NAME = { WK: 'Wicketkeepers', BAT: 'Batters', AR: 'All-rounders', BOWL: 'Bowlers' };
const RANK = { WK: 0, BAT: 1, AR: 2, BOWL: 3 };

// How many of the fan's teams each player appears in (derived from the real teams; used for exposure).
const exposure = new Map();

function useDataset(d) {
  D = d; ({ ctx, teams, meta, match, sides, players } = d);
  actual = d.actualPoints();
  exposure.clear();
  for (const t of teams) for (const id of t.players) exposure.set(id, (exposure.get(id) || 0) + 1);
  state.xiSide = Object.keys(sides)[0];
}
const isReplay = () => D.kind === 'replay';
const slotWord = () => (isReplay() ? 'Usually bats' : 'Bats');
const matchParam = () => (D.id === DEFAULT_ID ? undefined : D.id);
useDataset(getDataset(new URLSearchParams(location.search).get('match')) || getDataset(APP_DEFAULT_ID));

const ordered = () => (state.phase === 'toss'
  ? [...teams].sort((a, b) => Number(state.fixes.get(b.id).broken) - Number(state.fixes.get(a.id).broken))
  : teams);

/* ---------- players ---------- */

/** One player row, used everywhere: role, name, a context line, credits, C/VC and status. */
function prow(id, { out = false, isNew = false, cap = null, sub = null, delta = null } = {}) {
  const p = P(id);
  const slot = ctx.order.get(id);
  // Batting slots only exist once the XIs are announced; before the toss they would leak who is playing.
  const line = sub ?? (out ? 'Not in XI' : state.phase !== 'pre' && slot !== undefined ? `${slotWord()} ${slot + 1}, form ${p.form}` : `Form ${p.form}`);
  const d = delta === null ? '' : `<em class="${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta)}</em>`;
  return `<li class="prow r-${p.role}${out ? ' out' : ''}${isNew ? ' new' : ''}">
    <i class="rl">${p.role}</i>
    <span class="who"><span class="nm">${out ? '<span class="sr">Not playing: </span>' : ''}${esc(p.name)}</span><span class="sub"><b>${p.side}</b>${esc(line)}</span></span>
    <span class="end">${cap ? `<b class="cv" title="${cap === 'C' ? 'Captain' : 'Vice-captain'}">${cap}</b>` : ''}${out ? '<span class="chip bad">Out</span>' : isNew ? '<span class="chip ok">In</span>' : ''}<span class="cr num">${p.credits}${d}</span></span></li>`;
}

/** Players grouped under role headings with counts (the fantasy-app team view). */
function rolesList(ids, { captain = null, vc = null, newIds = [], outSet = null } = {}) {
  return `<div class="roles">${ROLES.map((r) => {
    const g = ids.filter((id) => P(id).role === r).sort((a, b) => P(b).credits - P(a).credits);
    if (!g.length) return '';
    return `<section class="rgrp r-${r}"><h4><i class="rl">${r}</i><span>${ROLE_NAME[r]}</span><b>${g.length}</b></h4><ul>${g.map((id) => prow(id, {
      cap: id === captain ? 'C' : id === vc ? 'VC' : null, isNew: newIds.includes(id), out: !!outSet && outSet.has(id),
    })).join('')}</ul></section>`;
  }).join('')}</div>`;
}

/** The fantasy rules as one quiet line: players, per-side cap, credits. Role limits appear only if violated. */
function rules(ids, { available = null } = {}) {
  const s = teamStats(ids, ctx.pool);
  const avail = available ?? ids.length;
  const rule = (ok, label, value, title = '') => `<span class="rule ${ok ? 'ok' : 'bad'}"${title ? ` title="${title}"` : ''}><span>${label}</span> <b class="num">${value}</b></span>`;
  const roleBreaks = ROLES.filter((r) => s.roles[r] < LIMITS.roles[r][0] || s.roles[r] > LIMITS.roles[r][1]);
  return `<div class="rules" role="group" aria-label="Team rules">
    ${rule(avail === LIMITS.total, 'Playing', `${avail}/${LIMITS.total}`)}
    ${Object.entries(s.sides).map(([k, n]) => rule(n <= LIMITS.maxPerSide, k, `${n}/${LIMITS.maxPerSide}`, `At most ${LIMITS.maxPerSide} players from one side`)).join('')}
    ${rule(s.credits <= LIMITS.credits, 'Credits', `${fmt(s.credits)}/${LIMITS.credits}`)}
    ${roleBreaks.map((r) => rule(false, r, s.roles[r], `${LIMITS.roles[r][0]} to ${LIMITS.roles[r][1]} allowed`)).join('')}
  </div>`;
}

/** 11 ticks: one per player. Red = not playing, accent = fixed, role colour = pre-toss composition. */
function strip(team, mode) {
  const out = new Set(state.fixes.get(team.id)?.out || []);
  const ids = [...team.players].sort((a, b) => RANK[P(a).role] - RANK[P(b).role]);
  return `<span class="strip" aria-hidden="true">${ids.map((id) => `<i class="${mode === 'roles' ? 'r-' + P(id).role : out.has(id) && mode === 'health' ? 'out' : mode === 'fixed' ? 'fx' : 'in'}"></i>`).join('')}</span>`;
}

/* ---------- repair decision ---------- */

function explanation(team, fix, opt) {
  // AI text exists only for each team's best fix; every other option uses the built-in template.
  const ai = state.ai[state.lang]?.[team.id];
  if (ai && opt === fix.options[0]) return { text: ai, ai: true };
  return { text: explainTemplate(team, fix, opt, ctx, state.lang), ai: false };
}

const arrow = '<svg class="arr" viewBox="0 0 20 12" aria-hidden="true"><path d="M1 6h16m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const rc = (role) => `<i class="rl r-${role}">${role}</i>`;

/** One swap = one row: who goes out (muted, struck) and who comes in (prominent). */
function swapDiff(s) {
  const o = P(s.out), i = P(s.in);
  const d = Math.round((i.credits - o.credits) * 10) / 10;
  const slot = ctx.order.get(s.in);
  const delta = d === 0 ? '' : `<em class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</em>`;
  return `<li class="swap"><div class="old"><span class="nm"><span class="sr">Out: </span><s>${esc(o.name)}</s></span><span class="sub">${rc(o.role)}<b>${o.side}</b>${o.credits} cr</span></div>${arrow}
    <div class="new"><span class="nm"><span class="sr">In: </span>${esc(i.name)}</span><span class="sub">${rc(i.role)}<b>${i.side}</b>${i.credits} cr${delta}</span><span class="sub">${slotWord()} ${slot + 1}, form ${i.form}</span></div></li>`;
}

function leaderDiff(team, opt) {
  const one = (tag, was, now) => (was === now
    ? `<li class="swap stay"><b class="cv">${tag}</b><span>${esc(P(now).name)} stays</span></li>`
    : `<li class="swap lead"><div class="old"><span class="nm"><b class="cv">${tag}</b><span class="sr">was </span><s>${esc(P(was).name)}</s></span></div>${arrow}<div class="new"><span class="nm"><b class="cv">${tag}</b>${esc(P(now).name)}</span></div></li>`);
  return `${one('C', team.captain, opt.captain)}${one('VC', team.vc, opt.vc)}`;
}

function decision(team, fix) {
  const idx = state.pick.get(team.id) ?? 0;
  const opt = fix.options[idx];
  const x = explanation(team, fix, opt);
  const beforeCr = 100 - teamStats(team.players, ctx.pool).credits;
  return `<section class="decision" aria-label="Recommended fix">
    <h3>Recommended fix</h3>
    <div class="options" role="group" aria-label="Fix options for ${esc(team.name)}">
      ${fix.options.map((o, i) => `<button class="opt" aria-pressed="${i === idx}" data-opt="${team.id}:${i}"><span class="o-t">${i === 0 ? 'Best fix' : 'Option ' + (i + 1)}</span><b class="o-g num">+${fmt(o.projGain)}</b><span class="o-m">proj pts</span><span class="o-m">${o.creditsLeft} cr left</span></button>`).join('')}
    </div>
    <p class="shift num">Players out <b>${fix.out.length}</b> <span aria-hidden="true">→</span><span class="sr">to</span> <b>0</b>
      <span class="gap"></span>Credits left <b>${fmt(beforeCr)}</b> <span aria-hidden="true">→</span><span class="sr">to</span> <b>${fmt(opt.creditsLeft)}</b></p>
    <ul class="diffs">${opt.swaps.map(swapDiff).join('')}${leaderDiff(team, opt)}</ul>
    <p class="why"${state.lang === 'hinglish' ? ' lang="hi-Latn"' : ''}><span class="src">${x.ai ? 'AI' : 'Built-in'}</span>${esc(x.text)}</p>
    <div class="apply-row"><span class="a-sum"><b class="num">${opt.swaps.length}</b> ${opt.swaps.length === 1 ? 'swap' : 'swaps'}, <b class="num">${opt.creditsLeft}</b> cr left</span><button class="btn primary" data-apply="${team.id}">Apply fix</button></div>
  </section>`;
}

/* ---------- team detail (workspace on desktop, bottom sheet on phones) ---------- */

function scoreRow(team) {
  const r = state.result?.rows.find((x) => x.team.id === team.id);
  if (!r) return '';
  const gain = r.mine - r.none;
  return `<div class="score" role="group" aria-label="Match points"><div><span>Without fixing</span><b class="num">${fmt(r.none)}</b></div>
    <div class="mine"><span>With my fixes</span><b class="num">${fmt(r.mine)}</b>${gain > 0 ? `<small class="num">+${fmt(gain)}</small>` : ''}</div>
    <div><span>Hindsight-best</span><b class="num">${fmt(r.hind)}</b></div></div>`;
}

function detail(team) {
  const head = (chips) => `<header class="rw-h"><h2>${esc(team.name)}</h2><div class="chips-row">${chips}</div></header>`;
  const fix = state.fixes.get(team.id);
  if (state.phase === 'pre' || !fix) {
    return `<article class="rw" data-team="${team.id}">${head('<span class="chip neutral">Valid</span>')}
      ${rules(team.players)}<h3 class="sec-h">Team</h3>${rolesList(team.players, { captain: team.captain, vc: team.vc })}</article>`;
  }
  const played = state.phase === 'played';
  const applied = state.applied.get(team.id);
  if (!fix.broken) {
    return `<article class="rw fine" data-team="${team.id}">${head('<span class="chip ok solid">Fine</span>')}${scoreRow(team)}
      <p class="lead-in">All 11 players are in the playing XI. Nothing to fix.</p>${rules(team.players)}
      <h3 class="sec-h">Team</h3>${rolesList(team.players, { captain: team.captain, vc: team.vc })}</article>`;
  }
  if (applied) {
    return `<article class="rw fixed" data-team="${team.id}">${head('<span class="chip ok solid">Fixed</span>')}${scoreRow(team)}
      ${rules(applied.players)}
      <section class="decision" aria-label="Applied fix"><h3>Applied fix</h3>
        <ul class="diffs">${applied.swaps.map(swapDiff).join('')}${leaderDiff(team, applied)}</ul></section>
      <h3 class="sec-h">New team</h3>${rolesList(applied.players, { captain: applied.captain, vc: applied.vc, newIds: applied.ins })}
      ${played ? '' : `<div class="apply-row"><span class="a-sum">Not what you wanted?</span><button class="btn ghost" data-undo="${team.id}">Undo fix</button></div>`}</article>`;
  }
  const outSet = new Set(fix.out);
  const alert = fix.captainOut ? '<span class="chip bad">Captain out</span>' : fix.vcOut ? '<span class="chip warn">VC out</span>' : '';
  const stay = team.players.filter((id) => !outSet.has(id));
  return `<article class="rw broken" data-team="${team.id}">${head(`<span class="chip bad solid">Broken</span>${alert}`)}${scoreRow(team)}
    ${rules(team.players, { available: stay.length })}
    <section class="out-sec" aria-label="Players not playing"><h3>Not playing <b class="num">${fix.out.length}</b></h3>
      <ul class="plist">${fix.out.map((id) => prow(id, { out: true, cap: id === team.captain ? 'C' : id === team.vc ? 'VC' : null })).join('')}</ul></section>
    ${fix.impossible
    ? `<div class="nofix"><b>No valid fix</b><p${state.lang === 'hinglish' ? ' lang="hi-Latn"' : ''}>${esc(noFixText(team, fix, ctx, state.lang))}</p></div>`
    : decision(team, fix)}
    <details class="more keep"><summary>${stay.length} still playing</summary>${rolesList(stay, { captain: team.captain, vc: team.vc })}</details></article>`;
}

/* ---------- ledger (all eight teams at a glance) ---------- */

const chev = '<svg class="chev" viewBox="0 0 8 14" aria-hidden="true"><path d="m1 1 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function teamRow(team) {
  const fix = state.fixes.get(team.id);
  const applied = state.applied.get(team.id);
  const name = esc(team.name);
  let kind, chip, line, mode, qa = '';
  if (!fix.broken) {
    kind = 'fine'; mode = 'health'; chip = '<span class="chip ok">Fine</span>'; line = '<span class="ok">All 11 playing</span>';
  } else if (applied) {
    kind = 'fixed'; mode = 'fixed'; chip = '<span class="chip ok">Fixed</span>';
    line = `<span class="ok">${applied.swaps.length} ${applied.swaps.length === 1 ? 'swap' : 'swaps'} applied</span><span class="gain num"><span class="sr">projected </span>+${fmt(applied.projGain)}</span>`;
  } else {
    kind = 'broken'; mode = 'health'; chip = '<span class="chip bad">Broken</span>';
    const flag = fix.captainOut ? '<span class="chip bad">C out</span>' : fix.vcOut ? '<span class="chip warn">VC out</span>' : '';
    if (fix.impossible) line = `<span class="bad">${fix.out.length} out</span>${flag}<span class="bad">No valid fix</span>`;
    else {
      const best = fix.options[state.pick.get(team.id) ?? 0];
      line = `<span class="bad">${fix.out.length} out</span>${flag}<span class="gain num"><span class="sr">projected </span>+${fmt(best.projGain)}</span>`;
      qa = `<button class="qa" data-apply="${team.id}" aria-label="Apply best fix to ${name}">Fix</button>`;
    }
  }
  const sel = isDesktop() && state.sel === team.id;
  return `<div class="trow ${kind}${sel ? ' selected' : ''}${state.flash.has(team.id) ? ' flash' : ''}">
    <button class="open" data-open="${team.id}"${sel ? ' aria-current="true"' : ''}><span class="r1"><span class="tn">${name}</span>${chip}</span><span class="r2">${strip(team, mode)}<span class="ts">${line}</span></span></button>${qa}</div>`;
}

function preRow(team) {
  const sel = isDesktop() && state.sel === team.id;
  return `<div class="trow pre${sel ? ' selected' : ''}"><button class="open" data-open="${team.id}"${sel ? ' aria-current="true"' : ''}>
    <span class="r1"><span class="tn">${esc(team.name)}</span><span class="cl num">${fmt(teamStats(team.players, ctx.pool).credits)} / 100 cr</span></span>
    <span class="r2">${strip(team, 'roles')}</span>
    <span class="r3"><span class="ld"><b class="cv">C</b>${esc(P(team.captain).name)}</span><span class="ld"><b class="cv">VC</b>${esc(P(team.vc).name)}</span></span></button>${chev}</div>`;
}

function resultRow(team) {
  const e = state.result;
  const r = e.rows.find((x) => x.team.id === team.id);
  const max = Math.max(...e.rows.map((x) => x.hind), 1);
  const w = (v) => `${(v / max) * 100}%`;
  const gain = r.mine - r.none;
  const sel = isDesktop() && state.sel === team.id;
  return `<div class="trow result${sel ? ' selected' : ''}"><button class="open" data-open="${team.id}"${sel ? ' aria-current="true"' : ''}>
    <span class="r1"><span class="tn">${esc(team.name)}</span><span class="rg num ${gain > 0 ? 'pos' : ''}">${gain > 0 ? '+' + fmt(gain) : 'no change'}</span></span>
    <span class="stack" role="img" aria-label="Without ${fmt(r.none)}, with fixes ${fmt(r.mine)}, hindsight best ${fmt(r.hind)}"><i class="s0" style="width:${w(r.none)}"></i><i class="s1" style="width:${w(gain)}"></i><i class="s2" style="width:${w(r.hind - r.mine)}"></i></span>
    <span class="rnums num"><span><i class="s0"></i>${fmt(r.none)}</span><span><i class="s1"></i>${fmt(r.mine)}</span><span><i class="s2"></i>${fmt(r.hind)}</span></span></button>${chev}</div>`;
}

/* ---------- scoreboard, impact, rail ---------- */

/** The always-visible data disclosure: simulated sample vs real replay. */
function disclosure(small = false) {
  const cls = `sample${small ? ' sm' : ''}${isReplay() ? ' real' : ''}`;
  return isReplay()
    ? `<span class="${cls}" title="A replay of a real match. Squads, roles, credits and fan teams are inferred or generated.">REAL MATCH (replay)</span>`
    : `<span class="${cls}" title="Fictional players and a generated match">SAMPLE (simulated)</span>`;
}

function topbar() {
  return `<header class="top"><div class="brand">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 6.5c3 2.5 3 8.5 0 11M18 6.5c-3 2.5-3 8.5 0 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <h1>Toss Panic Fixer</h1></div>
    ${disclosure()}</header>`;
}

function impact() {
  const fixes = [...state.fixes.values()];
  const aff = fixes.filter((f) => f.broken);
  const outIds = new Set(aff.flatMap((f) => f.out));
  const caps = aff.filter((f) => f.captainOut).length;
  const vcs = aff.filter((f) => f.vcOut).length;
  const fine = fixes.length - aff.length;
  const n = (v) => `<b class="num" data-count="${v}">${v}</b>`;
  return `<div class="impact" role="group" aria-label="Impact summary">
    <div class="hero">${n(aff.length)}<small class="num">/${teams.length}</small><span>teams broken<i> by the toss</i><em>${fine} ${fine === 1 ? 'team is' : 'teams are'} fine</em></span></div>
    <div class="cell">${n(outIds.size)}<span>players out</span></div>
    <div class="cell">${n(caps)}<span>captains out</span></div>
    <div class="cell">${n(vcs)}<span>VCs out</span></div>
  </div>`;
}

function resultBand() {
  const e = state.result;
  const pct = e.recovered === null ? 'n/a' : `${e.recovered}%`;
  return `<div class="rband" role="group" aria-label="Result"><b class="num">${pct}</b><span>of the gap recovered<em class="num">${fmt(e.totals.mine - e.totals.none)} of ${fmt(e.totals.hind - e.totals.none)} points</em></span></div>`;
}

function matchPicker() {
  const opt = (d) => `<option value="${d.id}"${d.id === D.id ? ' selected' : ''}>${esc(d.kind === 'replay' ? d.meta.source.label : d.label)}</option>`;
  return `<div class="picker"><label for="match-select">Match</label><select id="match-select" data-pick="match">
    <optgroup label="Simulated">${DATASETS.filter((d) => d.kind === 'sample').map(opt).join('')}</optgroup>
    <optgroup label="Real matches (replay)">${DATASETS.filter((d) => d.kind === 'replay').map(opt).join('')}</optgroup></select></div>`;
}

function scoreboard() {
  const toss = state.phase !== 'pre';
  const t = meta.toss;
  const status = state.phase === 'pre' ? 'Pre-toss' : state.phase === 'toss' ? 'Toss done' : 'Full time';
  const o = match.info.outcome;
  const by = o?.by ? Object.entries(o.by)[0] : null;
  const line = state.phase === 'pre'
    ? '<p class="b-line muted">Playing XIs are announced at the toss</p>'
    : state.phase === 'toss'
      ? `<p class="b-line"><b>${esc(t.winner)}</b> won the toss and chose to ${esc(t.decision)}</p>`
      : `<p class="b-line"><b>${esc(o.winner)}</b> won${by ? ` by ${by[1]} ${esc(by[0])}` : ''}${isReplay() ? '' : '<span class="muted"> (simulated)</span>'}</p>`;
  const team = (k, right) => `<div class="b-team${right ? ' r' : ''}"><i class="crest">${k}</i><span><b>${esc(sides[k])}</b>${toss ? `<small>${meta.xiOrder[k].length} confirmed</small>` : '<small>XI to be announced</small>'}</span></div>`;
  return `<section class="board" aria-label="Match">
    <div class="b-main">
      <div class="b-top"><span class="b-status ${state.phase}"><i></i>${status}</span><span class="b-meta">${esc(match.info.match_type)} at ${esc(match.info.venue)}${isReplay() ? `, ${new Date(match.info.dates[0]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</span></div>
      ${state.phase === 'pre' ? matchPicker() : ''}
      <div class="b-teams">${team(Object.keys(sides)[0], false)}<span class="b-vs">vs</span>${team(Object.keys(sides)[1], true)}</div>
      ${line}
    </div>
    ${state.phase === 'toss' ? impact() : state.phase === 'played' ? resultBand() : ''}
  </section>`;
}

function xiRow(id, i) {
  const p = P(id);
  const n = exposure.get(id) || 0;
  return `<li class="xr" style="--i:${i}"><span class="bo">${i + 1}</span><span class="nm">${esc(p.name)}</span>${rc(p.role)}<span class="ex num">${n || '–'}<span class="sr"> of your teams</span></span><span class="cr num">${p.credits}</span></li>`;
}

function xiPanel() {
  const notes = meta.notes.map((n) => {
    const pl = players.find((p) => n.includes(p.name));
    const ex = pl ? exposure.get(pl.id) || 0 : 0;
    return `<li><span>${esc(n)}</span>${ex ? `<small>In ${ex} of your ${teams.length} teams</small>` : ''}</li>`;
  }).join('');
  const side = state.xiSide;
  const benched = meta.squads[side].filter((p) => !ctx.xi.has(p.id));
  const head = '<div class="xh" aria-hidden="true"><span></span><span>Player</span><span>Role</span><span>Teams</span><span>Cr</span></div>';
  return `<section class="card news" data-panel="xi"><h2>Playing XIs</h2>
    <ul class="notes">${notes}</ul>
    <div class="seg-switch" role="group" aria-label="Choose a side">${Object.entries(sides).map(([k, name]) => `<button data-xi="${k}" aria-pressed="${k === side}">${esc(name)}</button>`).join('')}</div>
    ${head}<ol class="xi">${meta.xiOrder[side].map(xiRow).join('')}</ol>
    ${benched.length ? `<h3 class="sec-h bench-h">Not playing</h3><ol class="xi">${benched.map((p) => {
    const n = exposure.get(p.id) || 0;
    return `<li class="xr out"><span class="bo"></span><span class="nm"><span class="sr">Not playing: </span><s>${esc(p.name)}</s></span>${rc(p.role)}<span class="ex num">${n || '–'}<span class="sr"> of your teams</span></span><span class="cr num">${p.credits}</span></li>`;
  }).join('')}</ol>` : ''}</section>`;
}

function coinOverlay() {
  const t = meta.toss;
  return `<div id="coin" class="coin-wrap" role="dialog" aria-modal="true" aria-label="Toss result" tabindex="-1"><div class="coin"><i>T</i><i>H</i></div>
    <p><b>${esc(t.winner)}</b> won the toss<span>and chose to ${esc(t.decision)}</span></p><small>Tap or press Escape to skip</small></div>`;
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

function askChips() {
  if (!isReplay()) return ['Who should captain Powerplay Pandits?', 'Can I swap Mohit Saxena for Siddharth Rao in t1?', 'Which of my teams has no valid fix?'];
  const t1 = teams[0];
  const sw = state.fixes.get(t1.id)?.options?.[0]?.swaps?.[0];
  return [`Who should captain ${t1.name}?`, ...(sw ? [`Can I swap ${P(sw.out).name} for ${P(sw.in).name} in ${t1.id}?`] : []), 'Which of my teams has no valid fix?'];
}

function askBox() {
  const a = state.ask;
  const chips = askChips();
  const open = state.askOpen || a.q || a.answer || a.error || a.loading;
  return `<details class="ask card" data-panel="ask" ${open ? 'open' : ''}><summary><h2>Ask the Fixer</h2><span>Check any swap against the real rules</span></summary>
    <form data-ask><input name="q" maxlength="300" placeholder="e.g. Is swapping Tejas Naik for Harsh Menon valid in t1?" value="${esc(a.q)}" aria-label="Your question" autocomplete="off">
      <button class="btn primary" ${a.loading ? 'disabled' : ''}>${a.loading ? 'Checking…' : 'Ask'}</button></form>
    <div class="chips">${chips.map((c) => `<button type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div aria-live="polite">${a.answer ? `<div class="answer"><p>${esc(a.answer)}</p><small>Checked with the real engine: ${a.tools.length ? a.tools.map((t) => `<code>${esc(t)}</code>`).join(' ') : 'no tools used'}. Projections use pre-match form only.</small></div>` : ''}
    ${a.error ? `<p class="aierr">${esc(a.error)}</p>` : ''}</div></details>`;
}

function fullTime() {
  const e = state.result;
  const max = Math.max(e.totals.hind, e.totals.mine, e.totals.none, 1);
  const w = (v) => `${Math.max(2, Math.round((v / max) * 100))}%`;
  const line = (cls, label, v, extra = '') => `<div class="inn ${cls}"><div class="il"><span>${label}</span><b class="num">${fmt(v)}</b></div><div class="track"><i style="width:${w(v)}"></i></div>${extra}</div>`;
  return `<section class="card fulltime" data-panel="teams" aria-label="Full time">
    <div class="ft-head"><h2>Full time</h2>${disclosure(true)}</div>
    ${line('none', 'Without fixing', e.totals.none)}
    ${line('mine', 'With my fixes', e.totals.mine, `<p class="rcv num">+${fmt(e.totals.mine - e.totals.none)} recovered</p>`)}
    ${line('hind', 'Hindsight-best', e.totals.hind)}
    <p class="honest">${isReplay()
    ? 'A replay of one real match. The match, toss, playing XIs and points are real; squads, roles, credits and the 8 fan teams are inferred or generated. Recommendations used pre-match form only; actual points appear only here. One match is not an accuracy figure.'
    : 'One simulated match with fictional players. Recommendations used pre-match form only; actual points appear only here. This is not a real-world accuracy figure.'}</p>
    ${isReplay() ? evidence() : ''}
  </section>`;
}

/** Measured across many real matches (not just this one). Shown only for real replays. */
function evidence() {
  const e = AGGREGATE.engine, x = AGGREGATE.engineMinusNaive;
  return `<p class="honest evidence">Across ${AGGREGATE.matches} real IPL matches (${AGGREGATE.range.slice(0, 4)} to ${AGGREGATE.range.slice(14, 18)}), the same method recovered <b class="num">${e.meanRecovered}%</b> of the gap on average (95% CI ${e.ci95[0]} to ${e.ci95[1]}), and gained points in ${e.positiveShare}% of them. A naive "most expensive replacement" baseline recovered ${AGGREGATE.naiveMostExpensive.meanRecovered}%, so the edge over it is small (${x.meanPercentagePoints} points, CI ${x.ci95[0]} to ${x.ci95[1]}).</p>`;
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

function replayNote() {
  const src = meta.source;
  return `<p class="src-note">This replays a real match. ${esc(src.attribution)}</p>
    <details class="more src-how"><summary>How this replay was built</summary><ul>${src.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}<li>Form, roles, benches and credits use only matches played before this one. This match's own points appear only after "Play the match".</li></ul></details>`;
}

function context() {
  if (state.phase === 'pre') {
    return `<div class="context" role="region" aria-label="Before the toss"><section class="card intro"><h2>Before the toss</h2>
      <p>Your ${teams.length} teams are all valid right now. When the toss happens, the playing XIs drop and any player who is not in them scores zero.</p>
      <p>Select a team to see its players, credits and captain choices.</p>${isReplay() ? replayNote() : ''}</section></div>`;
  }
  if (state.phase === 'toss') return `<div class="context" role="region" aria-label="Ask the Fixer and playing XIs">${askBox()}${xiPanel()}</div>`;
  return `<div class="context" role="region" aria-label="Result summary">${fullTime()}</div>`;
}

/* ---------- phone: tabs, bottom sheet, toast ---------- */

function sheet() {
  const team = teams.find((t) => t.id === state.sheet);
  if (!team) return '';
  return `<div class="sheet-wrap"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(team.name)}, team details" tabindex="-1">
    <div class="grab" aria-hidden="true"></div>
    <button class="x" data-closesheet aria-label="Close"><svg viewBox="0 0 14 14" aria-hidden="true"><path d="m2 2 10 10M12 2 2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
    <div class="sheet-body" role="region" aria-label="${esc(team.name)} details" tabindex="0">${detail(team)}</div></div></div>`;
}

function tabs() {
  const left = [...state.fixes.values()].filter((f) => f.broken && !f.impossible && !state.applied.has(f.teamId)).length;
  const t = (id, label, badge = '') => `<button data-tab="${id}" aria-current="${state.tab === id ? 'page' : 'false'}">${label}${badge}</button>`;
  return `<nav class="tabs" aria-label="Sections">${t('teams', 'My teams', left ? `<i><span aria-hidden="true">${left}</span><span class="sr">${left} to fix</span></i>` : '')}${t('xi', 'Playing XIs')}${t('ask', 'Ask')}</nav>`;
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

/* ---------- focus management: render() rebuilds the DOM, so keyboard focus must be put back ---------- */

function focusSelector(el) {
  if (!el || el === document.body || !el.closest?.('#app')) return null;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
  const [k, v] = Object.entries(el.dataset)[0] || [];
  return k ? `${el.tagName.toLowerCase()}[data-${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}="${CSS.escape(v)}"]` : null;
}
// If the focused control disappears (e.g. Apply fix becomes Undo), land on its natural successor.
const FOCUS_FALLBACK = {
  apply: (v) => [`[data-undo="${v}"]`, `[data-open="${v}"]`],
  undo: (v) => [`[data-apply="${v}"]`, `[data-open="${v}"]`],
  fixall: () => ['[data-act=play]'],
  reset: () => ['[data-act=toss]'],
};
let wasSheet = false;
let opener = null;
const visible = (q) => [...document.querySelectorAll(q)].find((n) => n.offsetParent !== null);

/* ---------- render ---------- */

function ensureSel() {
  const list = ordered();
  if (!list.some((t) => t.id === state.sel)) state.sel = list[0].id;
}

function render() {
  const app = $('#app');
  const active = document.activeElement;
  const sel = focusSelector(active);
  const [fk, fv] = Object.entries(active?.dataset || {})[0] || [];
  const caret = active?.name ? [active.selectionStart, active.selectionEnd] : null;
  const sheetBody = $('.sheet-body');
  const keep = sheetBody ? sheetBody.scrollTop : 0;

  ensureSel();
  const rows = state.phase === 'pre' ? teams.map(preRow) : state.phase === 'toss' ? ordered().map(teamRow) : teams.map(resultRow);
  const legend = state.phase === 'played'
    ? '<p class="rlegend" data-panel="teams"><span><i class="s0"></i>Without</span><span><i class="s1"></i>With my fixes</span><span><i class="s2"></i>Hindsight-best</span></p>' : '';
  const ledger = `<section class="ledger" aria-label="Your teams"><div class="ledger-in">
      <div class="list-h" data-panel="teams"><h2>Your ${teams.length} teams</h2>${state.phase === 'pre' ? '<span class="allvalid">All valid</span>' : langToggle()}</div>
      ${legend}<div class="rows" data-panel="teams">${rows.join('')}</div>
      <nav class="bar" aria-label="Actions">${footerBar()}</nav></div></section>`;
  const workspace = `<section class="workspace${state.animateSel ? ' enter' : ''}" aria-label="Team detail">${detail(teams.find((t) => t.id === state.sel))}</section>`;
  state.animateSel = false;

  app.className = state.fresh ? 'fresh' : '';
  if (state.phase === 'toss') app.dataset.tab = state.tab; else delete app.dataset.tab;
  // While the sheet or toss dialog is open, the page behind it is inert: no focus, no screen-reader reach.
  const inert = state.sheet || state.coin ? ' inert' : '';
  app.innerHTML = `<a class="skip" href="#teams-main">Skip to teams</a><div class="page"${inert}>${topbar()}${scoreboard()}${state.phase === 'toss' ? tabs() : ''}<main id="teams-main" tabindex="-1"><div class="shell">${ledger}${workspace}${context()}</div></main></div>${state.sheet ? sheet() : ''}${state.coin ? coinOverlay() : ''}`;
  document.documentElement.classList.toggle('lock', !!state.sheet);
  if (state.sheet && keep) $('.sheet-body').scrollTop = keep;

  if (state.sheet && !wasSheet) $('.sheet')?.focus();
  else if (state.coin) $('#coin')?.focus();
  else if (!state.sheet && wasSheet && opener) visible(`[data-open="${opener}"]`)?.focus({ preventScroll: true });
  else if (sel) {
    const target = visible(sel) || (FOCUS_FALLBACK[fk] || (() => []))(fv).map(visible).find(Boolean);
    if (target) { target.focus({ preventScroll: true }); if (caret && target.setSelectionRange) target.setSelectionRange(...caret); }
  }
  wasSheet = !!state.sheet;
}

function endCoin() {
  if (!state.coin) return;
  state.coin = false;
  $('#coin')?.remove();
  $('.page')?.removeAttribute('inert');
  $('#teams-main')?.focus({ preventScroll: true });
}

function countUp() {
  if (reduceMotion()) return;
  for (const el of document.querySelectorAll('.impact [data-count]')) {
    const to = Number(el.dataset.count);
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 700);
      el.textContent = String(Math.round(to * (1 - (1 - k) ** 3)));
      if (k < 1 && document.body.contains(el)) requestAnimationFrame(step); else el.textContent = String(to);
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  }
}

function toss() {
  for (const t of teams) state.fixes.set(t.id, fixTeam(t, ctx));
  state.phase = 'toss';
  state.coin = !reduceMotion();
  state.fresh = true;
  state.sel = ordered()[0].id;
  render();
  window.scrollTo({ top: 0 });
  if (state.coin) setTimeout(() => { endCoin(); countUp(); }, 2300); else countUp();
  setTimeout(() => { state.fresh = false; $('#app').classList.remove('fresh'); }, 3600);
}

/* ---------- actions ---------- */

function resetAll() {
  state.phase = 'pre'; state.fixes.clear(); state.pick.clear(); state.applied.clear(); state.result = null;
  state.ai = { en: null, hinglish: null, loading: false, error: '' };
  state.ask = { q: '', loading: false, answer: '', tools: [], error: '' };
  state.tab = 'teams'; state.sheet = null; state.sel = null; state.xiSide = Object.keys(sides)[0]; state.flash = new Set();
}

function switchDataset(id) {
  const d = getDataset(id);
  if (!d || d === D) return;
  useDataset(d);
  resetAll();
  const url = new URL(location.href);
  if (d.id === APP_DEFAULT_ID) url.searchParams.delete('match'); else url.searchParams.set('match', d.id);
  history.replaceState(null, '', url);
  render();
}

async function runExplain() {
  const lang = state.lang;
  state.ai.loading = true; state.ai.error = ''; render();
  try { state.ai[lang] = await explainAll(lang, matchParam()); }
  catch { state.ai.error = 'AI is unavailable right now, so you are seeing the built-in explanations. The fixes themselves are unaffected.'; }
  state.ai.loading = false; render();
}

async function runAsk(q) {
  state.ask = { q, loading: true, answer: '', tools: [], error: '' }; render();
  try {
    const out = await askFixer(q, state.lang, matchParam());
    state.ask = { q, loading: false, answer: out.answer, tools: [...new Set(out.toolCalls.map((t) => t.name))], error: '' };
  } catch (err) {
    state.ask = { q, loading: false, answer: '', tools: [], error: `${err.message}. Everything else still works.` };
  }
  render();
}

function settleFlash() {
  setTimeout(() => { state.flash = new Set(); document.querySelectorAll('.trow.flash').forEach((n) => n.classList.remove('flash')); }, 1100);
}

function applyFix(id) {
  const fix = state.fixes.get(id);
  state.applied.set(id, fix.options[state.pick.get(id) ?? 0]);
  state.flash = new Set([id]);
  const hadSheet = !!state.sheet;
  state.sheet = null;
  if (isDesktop()) {
    // Triage flow: jump to the next team that still needs a decision.
    const list = ordered();
    const from = list.findIndex((t) => t.id === id);
    const next = [...list.slice(from + 1), ...list.slice(0, from)].find((t) => {
      const f = state.fixes.get(t.id);
      return f.broken && !f.impossible && !state.applied.has(t.id);
    });
    if (next && state.sel === id) { state.sel = next.id; state.animateSel = true; }
  }
  render();
  settleFlash();
  if (hadSheet && history.state?.sheet) history.back();
  showToast(`${teams.find((t) => t.id === id).name} fixed`);
}

function openTeam(id) {
  if (isDesktop()) { if (state.sel !== id) { state.sel = id; state.animateSel = true; } render(); return; }
  openSheet(id);
}
function openSheet(id) {
  opener = id;
  state.sheet = id;
  history.pushState({ sheet: id }, '');
  render();
}
function closeSheet() {
  if (history.state?.sheet) history.back(); // popstate does the rest
  else { state.sheet = null; render(); }
}
window.addEventListener('popstate', () => { if (state.sheet) { state.sheet = null; render(); } });

document.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-ask]')) return;
  e.preventDefault();
  const q = new FormData(e.target).get('q').trim();
  if (q.length >= 3 && !state.ask.loading) runAsk(q);
});
document.addEventListener('input', (e) => { if (e.target.name === 'q') state.ask.q = e.target.value; });
document.addEventListener('change', (e) => { if (e.target.id === 'match-select') switchDataset(e.target.value); });

document.addEventListener('click', (e) => {
  if (e.target.closest?.('.skip')) { e.preventDefault(); $('#teams-main')?.focus(); return; }
  if (e.target.closest?.('#coin')) { endCoin(); countUp(); return; }
  if (e.target.classList?.contains('sheet-wrap')) return closeSheet();
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.chip) { state.ask.q = d.chip; render(); }
  else if (d.act === 'explain') runExplain();
  else if (d.act === 'toss') toss();
  else if (d.act === 'fixall') {
    state.flash = new Set();
    for (const [id, f] of state.fixes) if (f.options.length && !state.applied.has(id)) { state.applied.set(id, f.options[state.pick.get(id) ?? 0]); state.flash.add(id); }
    render(); settleFlash();
    showToast(`Fixed ${state.applied.size} teams`);
  } else if (d.act === 'play') {
    state.result = evaluate(teams, state.applied, ctx, actual);
    state.phase = 'played';
    render();
    window.scrollTo({ top: 0 });
  } else if (d.act === 'reset') {
    resetAll();
    render(); window.scrollTo({ top: 0 });
  } else if (d.apply) applyFix(d.apply);
  else if (d.undo) { state.applied.delete(d.undo); render(); }
  else if (d.opt) { const [id, i] = d.opt.split(':'); state.pick.set(id, Number(i)); render(); }
  else if (d.lang) { state.lang = d.lang; render(); }
  else if (d.open) openTeam(d.open);
  else if (d.closesheet !== undefined) closeSheet();
  else if (d.tab) { state.tab = d.tab; render(); window.scrollTo({ top: 0 }); }
  else if (d.xi) { state.xiSide = d.xi; render(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && (state.sheet || state.coin)) {
    const box = $(state.coin ? '#coin' : '.sheet');
    const items = [...box.querySelectorAll('button, [href], input, summary, [tabindex]:not([tabindex="-1"])')].filter((n) => n.offsetParent !== null || n.tagName === 'SUMMARY');
    if (!items.length) return e.preventDefault();
    const first = items[0], last = items[items.length - 1];
    if (!box.contains(document.activeElement) || document.activeElement === box) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if (e.key !== 'Escape') return;
  if (state.coin) { endCoin(); countUp(); } else if (state.sheet) closeSheet();
});

// <details> does not bubble 'toggle'; capture it so the open state survives re-renders.
document.addEventListener('toggle', (e) => {
  if (e.target.matches('details.ask')) state.askOpen = e.target.open;
}, true);

// Some hosts inject a fixed badge over the bottom-right corner (Netlify's free plan does). When one is present,
// the app lifts its own bottom controls above it so the primary buttons stay tappable.
const syncHostBadge = () => document.documentElement.classList.toggle('host-badge', !!document.getElementById('nl-badge-frame'));
new MutationObserver(syncHostBadge).observe(document.body, { childList: true });
syncHostBadge();

render();
// Exposed for tests and for debugging in the console.
window.__tpf = { state, get dataset() { return D; } };
