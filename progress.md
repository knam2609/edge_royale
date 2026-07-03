## Current State

- As of July 1, 2026, the Edger ML runtime path is reopened in the working tree while the browser remains human vs `edger` only with no bot selector, training UI, levels, or unlocks.
- `edger` now routes through a deterministic feed-forward policy scorer using stable legal-action ordering, appended `PASS`, no sampling, no runtime RNG, and a generated JS model import from `src/ai/generated/edgerPolicyCurrent.js`.
- The previous handcrafted oracle is frozen as `edger_heuristic` with alias `heuristic`; `random`, `aggressive`, and `defender` remain hidden internal baselines.
- The tracked promoted artifact is a bootstrap runtime seed, not a fully trained PPO/self-play model: `artifacts/edger-training/promoted/edger_policy_current.json`.
- Developer scripts now exist for the model file contract: `npm run edger:train`, `npm run edger:evaluate`, and `npm run edger:promote`.

## Source of Truth

- Durable agent workflow and handoff rules: `AGENTS.md`
- Product overview and run instructions: `README.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- ML Edger runtime, heuristic baseline, action space, model format, and promotion criteria: `docs/BOT_LEVELS.md`
- Implementation roadmap: `docs/IMPLEMENTATION_PLAN.md`
- Current backlog: `docs/SPRINT_BACKLOG.md`
- Current implemented behavior remains in code and tests, especially `src/ai/botRuntime.js`, `src/ai/mlPolicy.js`, `src/ai/benchmark.js`, `tests/bot-runtime.test.js`, `tests/edger-ml-determinism.test.js`, and `tests/bot-regression.test.js`.

## What Works

- `npm test` passes, including ML policy schema validation, route selection, deterministic action streams, and replay round-trip coverage.
- `npm run edger:evaluate -- --model artifacts/edger-training/promoted/edger_policy_current.json` runs and reports deterministic same-seed behavior.
- `npm run bot:bench -- --opponents edger_heuristic,random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6` passes the point win-rate gate for all four opponents.
- The generated runtime JS imports the promoted model synchronously; gameplay does not fetch model files asynchronously.
- Raw training runs are ignored under `artifacts/edger-training/runs/`; promoted JSON and report files are tracked under `artifacts/edger-training/promoted/`.

## Known Gaps

- Full PPO/self-play training is not implemented yet; `npm run edger:train` currently exports a deterministic bootstrap model that uses the runtime model contract.
- `npm run edger:promote` validates and canonicalizes model JSON but does not yet enforce benchmark, scenario, replay, timing, or Wilson lower-bound gates.
- The bootstrap model did not meet the heuristic promotion confidence criterion on July 1, 2026: vs `edger_heuristic`, point win rate was `0.650` but Wilson lower bound was `0.433`.
- `npm run smoke:browser` still fails before browser launch because importing `playwright` times out, both sandboxed and escalated.
- The full Node suite is slow: July 1, 2026 `npm test` took `297286.172542ms`, with `Edger clears the initial internal baseline benchmark floor` taking `295229.605708ms`.
- In this environment, standard `node`/`git` commands sometimes hang or hit filesystem read timeouts under the ambient shell; running with a stripped environment resolved the successful validations.

## Next Tasks

1. Fix the local Playwright installation/import path so `npm run smoke:browser` can launch Chromium and complete the Edger-only smoke.
2. Implement masked PPO/self-play training with `@tensorflow/tfjs` limited to training scripts, starting from heuristic behavior cloning.
3. Add tactical scenario league evaluation for defense, spell value, tower finishing, elixir punishment, and pocket pressure.
4. Make `npm run edger:promote` enforce schema, determinism, replay, timing, heuristic, baseline, and scenario gates before updating promoted artifacts.
5. Train and evaluate a candidate that clears the `edger_heuristic` Wilson lower-bound promotion requirement.
6. Reduce ML Edger benchmark/runtime cost, especially the full 30-round benchmark test path, without weakening legal-action coverage or determinism.
7. Continue UI polish for Edger-only setup/HUD while keeping the engine as the only rules source and exposing no model/training controls.

## Validation

- July 1, 2026: `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/Users/thangnguyen USER=thangnguyen TMPDIR=/var/folders/fl/t1q3j3rn0dg278fhg2bvg0dw0000gn/T/ npm test` -> passed, 94 tests, duration `297286.172542ms`.
- July 1, 2026: `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/Users/thangnguyen USER=thangnguyen TMPDIR=/var/folders/fl/t1q3j3rn0dg278fhg2bvg0dw0000gn/T/ npm run edger:evaluate -- --model artifacts/edger-training/promoted/edger_policy_current.json` -> passed command. Results: `edger_heuristic` win_rate `0.650` (`13-7`, 10 draws, 20 resolved, Wilson lower bound `0.433`), `random` win_rate `1.000` (`27-0`, 3 draws, 27 resolved), `aggressive` win_rate `0.789` (`15-4`, 11 draws, 19 resolved), `defender` win_rate `1.000` (`20-0`, 10 draws, 20 resolved), deterministic same seed `yes`.
- July 1, 2026: `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/Users/thangnguyen USER=thangnguyen TMPDIR=/var/folders/fl/t1q3j3rn0dg278fhg2bvg0dw0000gn/T/ npm run bot:bench -- --opponents edger_heuristic,random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6` -> passed. Results: `edger_heuristic` win_rate `0.650` (`13-7`, 10 draws, 20 resolved), `random` win_rate `1.000` (`27-0`, 3 draws, 27 resolved), `aggressive` win_rate `0.789` (`15-4`, 11 draws, 19 resolved), `defender` win_rate `1.000` (`20-0`, 10 draws, 20 resolved).
- July 1, 2026: `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/Users/thangnguyen USER=thangnguyen TMPDIR=/var/folders/fl/t1q3j3rn0dg278fhg2bvg0dw0000gn/T/ npm run smoke:browser` -> failed before browser launch with `Playwright is required for browser smoke: Timed out while importing Playwright.`
- July 1, 2026: escalated `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/Users/thangnguyen USER=thangnguyen TMPDIR=/var/folders/fl/t1q3j3rn0dg278fhg2bvg0dw0000gn/T/ npm run smoke:browser` -> failed with the same Playwright import timeout.

## Risks / Notes

- The current tracked model is useful for deterministic runtime integration, but it is not a completed trained policy under the documented promotion criteria.
- `edger_heuristic` is a strong comparison baseline, not an intentionally weak smoke opponent.
- `random`, `aggressive`, and `defender` must remain hidden from the browser UI.
- The bootstrap model uses a heuristic-prior feature; future PPO/self-play work should reduce dependence on that prior before promotion.
- Core replay serialization remains in place because it supports deterministic debugging and regression coverage.
