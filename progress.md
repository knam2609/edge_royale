## Current State

- As of July 10, 2026, Edger remains the only playable browser opponent with no bot selector, training UI, levels, or unlocks.
- `edger` still routes through the deterministic generated JS model import from `src/ai/generated/edgerPolicyCurrent.js`; the promoted tracked artifact is still `artifacts/edger-training/promoted/edger_policy_current.json`.
- Developer-only PPO candidate training and daily automation have been added: `npm run edger:train -- --mode ppo`, `npm run edger:evaluate -- --json-out`, `npm run edger:promote -- --require-gates`, and `npm run edger:daily`.
- GitHub Actions daily training is configured to run once per day at 18:00 UTC without an in-job Melbourne-hour skip guard, uploads artifacts for 30 days, and opens/updates a promotion PR only when local promotion gates and browser smoke pass.
- The current promoted model remains the bootstrap runtime seed until a daily or manual candidate passes every gate and is promoted.

## Source of Truth

- Durable agent workflow and handoff rules: `AGENTS.md`
- Product overview and run instructions: `README.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- ML Edger runtime, training, promotion criteria, daily automation, and hidden baselines: `docs/BOT_LEVELS.md`
- Implementation roadmap: `docs/IMPLEMENTATION_PLAN.md`
- Current backlog: `docs/SPRINT_BACKLOG.md`
- Current implemented behavior remains in code and tests, especially `src/ai/botRuntime.js`, `src/ai/mlPolicy.js`, `src/ai/benchmark.js`, `scripts/edger-training-core.mjs`, `scripts/edger-evaluation-core.mjs`, `scripts/edger-daily.mjs`, and `tests/edger-training-pipeline.test.js`.

## What Works

- `npm run edger:train -- --mode ppo --seed 20260704 --profile smoke --out-dir /private/tmp/edger-train-smoke` completes and writes a candidate model plus training report.
- `tests/edger-training-pipeline.test.js` covers deterministic masked sampling, Wilson confidence math, scenario report shape, timing report shape, and promotion refusal.
- `npm run edger:promote -- --require-gates` now refuses candidates when the evaluation report has failed gates.
- Daily orchestration treats promotion-gate failures as successful non-promotion outcomes and only runs browser smoke after gates pass.
- Runtime/browser code does not import `@tensorflow/tfjs`; it is a training-only development dependency.

## Known Gaps

- Full candidate evaluation is still expensive: July 4, 2026 `npm run edger:evaluate -- --model /private/tmp/edger-train-smoke/edger_policy_candidate.json --json-out /private/tmp/edger-train-smoke/evaluation_report.json` was interrupted after roughly 4 minutes without producing console results.
- Full `npm test` is still too slow locally: July 4, 2026 `npm test` was interrupted after about `395636.852625ms`; 93 tests had passed and `tests/bot-regression.test.js` was marked cancelled.
- `npm run smoke:browser` still fails before browser launch because importing Playwright times out.
- The smoke PPO trainer proves the model export path, but candidate tactical quality still needs real daily runs and tuning before promotion.
- The scenario league is intentionally small and should be expanded before trusting it as a broad tactical quality signal.

## Next Tasks

1. Reduce benchmark/evaluation runtime so full `npm test` and `npm run edger:evaluate` complete in a practical local and CI window.
2. Fix the local Playwright installation/import path so `npm run smoke:browser` can launch Chromium and complete the Edger-only smoke.
3. Run or observe the next GitHub Actions daily training workflow and confirm the 18:00 UTC schedule executes training, uploads artifacts, and preserves non-promotion behavior on failed gates.
4. Improve PPO rollout quality and scenario coverage until candidates can clear the `edger_heuristic` Wilson lower-bound gate.
5. Expand tactical scenario fixtures for defense, spell value, tower finishing, elixir punishment, and pocket pressure.
6. Keep UI polish scoped to Edger-only setup/HUD while exposing no model/training controls.

## Validation

- July 4, 2026: `node --test tests/edger-training-pipeline.test.js` -> focused tests passed: 5 tests. The PTY output was flushed after interrupting the idle session; reported duration was `62600.916958ms`.
- July 4, 2026: `npm run edger:train -- --mode ppo --seed 20260704 --profile smoke --out-dir /private/tmp/edger-train-smoke` -> passed; wrote `/private/tmp/edger-train-smoke/edger_policy_candidate.json` and `/private/tmp/edger-train-smoke/training_report.json`.
- July 4, 2026: `npm run edger:evaluate -- --model /private/tmp/edger-train-smoke/edger_policy_candidate.json --json-out /private/tmp/edger-train-smoke/evaluation_report.json` -> interrupted after roughly 4 minutes with no console result.
- July 4, 2026: `npm test` -> interrupted after about `395636.852625ms`; 93 tests passed, 0 failed, and `tests/bot-regression.test.js` was cancelled.
- July 4, 2026: `npm run smoke:browser` -> failed before browser launch with `Playwright is required for browser smoke: Timed out while importing Playwright.`
- July 10, 2026: `git diff --check` -> passed.
- July 10, 2026: `ruby -e "require 'yaml'; YAML.load_file('.github/workflows/edger-daily-training.yml'); puts 'valid yaml'"` -> passed.
- July 10, 2026: `command -v actionlint || true` -> no local `actionlint` found, so no GitHub Actions semantic lint was run.
- July 10, 2026: `npm test` was not run because this pass only changed workflow scheduling/docs/progress, not simulation, replay, profile, rules, AI heuristics, or client behavior.

## Risks / Notes

- Daily automation can produce candidates now, but promotion should remain gated; failed gates are expected until candidate quality improves.
- `edger_heuristic` remains a strong comparison baseline, not an intentionally weak smoke opponent.
- `random`, `aggressive`, and `defender` must remain hidden from the browser UI.
- Full-match evaluation cost is the main automation reliability risk.
- Core replay serialization remains in place because it supports deterministic debugging and regression coverage.
