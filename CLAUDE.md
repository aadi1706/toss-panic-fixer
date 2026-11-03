# Toss Panic Fixer: project brief (read this first)

Dream11 Forward Deployed Engineer Intern take-home. Goal: ONE working AI-powered artifact
that solves a real fan problem during a live match, plus a hosted link. Judged on the
problem chosen, understanding of the fan, and what is built, not on polish.

## The problem
Toss happens minutes before lock. Playing XIs drop; fans running many teams discover
players who will not play (they score 0). Fixing every team by hand under time pressure
is the pain. This app finds every broken team, ranks valid fixes, explains them in plain
English or Hinglish, and then proves the value after the match.

## Rules for this repo
- Git identity is Aadi Rawat. NEVER add Co-Authored-By or "Generated with" lines. One commit per step.
- Projections use pre-match form ONLY. Never use match results to recommend (no hindsight leakage).
  Actual points are only for the post-match evaluation panel.
- The sample match is SIMULATED with fictional players. Label it "SAMPLE (simulated)" in the UI.
- Be honest in the UI and README: results are from one simulated match.

## Done (see git log)
1. scripts/gen-sample.mjs: seeded Cricsheet-format match + squads + 8 fan teams -> data/
2. src/scoring.js: Dream11-style T20 points from Cricsheet JSON (approximation, configurable)
3. src/engine.js: validate, findBroken, fixTeam (top 3 valid repairs, C/VC logic), oracleFix, pointsOf
4. 12 passing tests: `npm test`
5. src/ai.js: written but NOT wired or tested. It uses window.claude.use("sample"), which only
   exists inside Claude artifacts. Replace the transport with a small serverless endpoint
   (e.g. Netlify/Vercel function calling the Anthropic API with a server-side key) so the
   deployed link has real AI. Keep the deterministic template fallback so the app works with no AI.

## Remaining
4. Mobile-first UI (src/app.js, style.css, index template): flow Pre-toss -> "Toss happens" ->
   broken teams flagged (captain/VC out called out) -> best 3 fixes per team with reasons ->
   "Fix all" -> "Play the match" result table: Without fixing / With your fixes / Hindsight-best,
   plus "recovered X% of the gap". Dark theme, role-coloured pills, credits visible.
5. Wire AI: explain-all (EN/Hinglish toggle) and "Ask the Fixer" with tools get_team,
   list_playing_xi, simulate_swap that call the real engine.
6. scripts/build.mjs with esbuild -> dist/index.html (single file). Deploy (Netlify/Vercel/GitHub Pages).
7. README: problem, how it works, how to run, honest limitations. Then the 200-word submission note.

## Known facts from this session
- On the sample match, 7 of 8 teams are broken. No action 3728.5 pts, engine top fix 5448.5,
  hindsight-best 5991.5 (about 76% of the gap recovered). One simulated match only.
- A naive "pick the most expensive replacement" baseline matched the engine because credits and
  form are correlated in the synthetic data, so it was removed. Do not claim a win over it.
