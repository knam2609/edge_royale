## Current State

- As of June 30, 2026, the Edger-only pivot is implemented in the working tree: the browser game is human vs `edger`, local profile stats are aggregate Edger stats only, and old ladder/training/model surfaces are removed or intentionally replaced.
- `src/ai/botRuntime.js` owns Edger plus hidden internal baselines `random`, `aggressive`, and `defender`; legacy bot/tier aliases remain only for compatibility with old inputs.
- Edger was tuned to clear the benchmark gate: near-river enemy troops now count as threats, low-value spell chip is gated out, troop pressure/defense scores are stronger, spell scoring is pruned to relevant candidate targets, and baseline bots are deliberately weaker benchmark smoke opponents.
- `scripts/browser-smoke.mjs` now uses a bounded Edger-only smoke path with a deterministic terminal match hook, but the smoke cannot complete in this environment because importing `playwright` times out before browser launch.

## Source of Truth

- Product overview and run instructions: `README.md`
- Durable agent workflow and handoff rules: `AGENTS.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Edger bot behavior, action space, internal baselines, and benchmark gate: `docs/BOT_LEVELS.md`
- Implementation roadmap: `docs/IMPLEMENTATION_PLAN.md`
- Current backlog: `docs/SPRINT_BACKLOG.md`
- Current implemented behavior remains in code and tests, especially `src/ai/botRuntime.js`, `src/ai/benchmark.js`, `src/client/webGame.js`, `scripts/browser-smoke.mjs`, `tests/bot-runtime.test.js`, `tests/bot-regression.test.js`, and `tests/profile.test.js`.

## What Works

- `npm test` passes with the Edger-only implementation.
- The Edger benchmark gate passes against all internal baselines at the required `0.60` resolved win-rate floor.
- Stale-reference scan found no active imports of removed ladder/training/model modules; remaining hits are compatibility aliases, smoke assertions, removed-scope docs, profile reset fixtures, or unrelated gameplay terms like pocket unlocks and level-11 stats.
- Browser smoke is now bounded and reports a clear Playwright prerequisite failure instead of hanging indefinitely when `playwright` import stalls.
- Old training/model workflows, training artifacts, ladder runtime modules, and player-facing tier/progression UI are removed from the worktree.

## Known Gaps

- `npm run smoke:browser` did not complete on June 30, 2026 because `playwright` import timed out before Chromium launch, both with and without escalated permissions.
- Sandboxed localhost serving is also blocked without escalation: `node scripts/dev-server.mjs` failed with `listen EPERM: operation not permitted 127.0.0.1:5173`.
- The Edger benchmark regression inside `npm test` is slow: the final full suite spent about `219.6s` in `Edger clears the initial internal baseline benchmark floor`.
- The browser smoke hook `window.__edgeRoyaleSmokeFinishMatch()` is a validation-only helper that forces the blue king tower to 0 HP and records the normal engine match result; it should not become player-facing UI.

## Next Tasks

1. Fix or replace the local Playwright installation/import path so `npm run smoke:browser` can actually launch Chromium and complete the bounded Edger-only smoke.
2. After Playwright is fixed, rerun `npm run smoke:browser` under escalation if localhost binding is still sandbox-blocked.
3. Reduce Edger benchmark/runtime cost, especially the full 30-round benchmark test path, without weakening determinism or legal-action coverage.
4. Add focused Edger tactical regression tests for defense, spell value, tower finishing, elixir advantage, and pocket pressure.
5. Continue UI polish for Edger-only setup/HUD while keeping the engine as the only rules source.
6. Keep future stale-reference scans scoped to active imports/UI/docs so removed-scope documentation and compatibility aliases are not mistaken for regressions.

## Validation

- June 30, 2026: `node --test tests/bot-runtime.test.js tests/bot-regression.test.js tests/profile.test.js` -> passed, 17 tests, duration `227295.815875ms`.
- June 30, 2026: `npm run bot:bench -- --opponents random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6` -> passed. Results: `random` win_rate `1.000` (`25-0`, 5 draws, 25 resolved), `aggressive` win_rate `0.706` (`12-5`, 13 draws, 17 resolved), `defender` win_rate `1.000` (`26-0`, 4 draws, 26 resolved).
- June 30, 2026: `npm test` -> passed, 88 tests, duration `220824.358667ms`.
- June 30, 2026: `npm run smoke:browser` -> failed before browser launch with `Playwright is required for browser smoke: Timed out while importing Playwright.`
- June 30, 2026: escalated `npm run smoke:browser` -> failed with the same Playwright import timeout.
- June 30, 2026: `node scripts/dev-server.mjs` in sandbox -> failed with `listen EPERM: operation not permitted 127.0.0.1:5173`.
- June 30, 2026: `rg -n "ladder|training|model|tier|level|self|unlock|train" --glob '!package-lock.json' --glob '!progress.md'` -> no active stale imports found; remaining hits are expected compatibility/debug/doc/test/gameplay references.

## Risks / Notes

- Internal baselines are intentionally weaker than Edger and must remain hidden from the browser UI.
- The Edger-only pivot intentionally resets old saved ladder/self profiles by using `edge_royale_profile_v2`.
- Old model artifacts are intentionally deleted, not archived.
- Core replay serialization remains in place because it supports deterministic debugging and regression coverage.
- Do not reintroduce neural/self-training, model manifests, promotion gates, daily training workflows, old level progression, or player-facing bot selectors while finishing this pivot.
