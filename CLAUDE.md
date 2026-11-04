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

## Status
Built, tested and deployed (https://toss-panic-fixer-aadi.netlify.app). See README.md for the product, the AI design and the limitations.
- Engine (src/engine.js, src/scoring.js) is deterministic and unchanged since the first commits.
- AI: Netlify functions /api/explain and /api/ask (src/server/), key in a server-side env var, template fallback in src/explain.js.
- Data: simulated sample (data/sample-*.json) plus real IPL replays built from Cricsheet (src/replay.js, data/replay/).
  The app opens on a real match; the sample is ?match=sample.
- Checks: `npm test` (44), `npm run e2e`, `npm run e2e:replay`, `npm run a11y`.

## Measured facts (do not invent others)
- Across 319 real IPL matches (2015-2022, 3 generated team sets each) the engine recovers 52.8% of the gap (95% CI 51.5-54.2);
  a naive most-expensive baseline recovers 51.0%. The edge is small (1.8 pts, CI 0.6-3.1). Source: data/replay/aggregate.json.
- The simulated sample recovers 76%; it is one made-up match and is not evidence.
