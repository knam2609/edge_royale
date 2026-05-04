# Progress

## Current State

- As of May 4, 2026, local `main` contains the God + self legal-action AI implementation with uncommitted changes.
- Legal action enumeration now uses `full_snapped_grid_v1`: troops enumerate legal deploy cells and spells enumerate every snapped arena cell.
- Playable God can load a same-tier `legal_action_mlp` from `artifacts/training/ladder-models.json`; God model features use `god_state_features_v1` with opponent exact elixir, hand, and deck queue.
- `god_oracle` is available as an internal teacher/benchmark tier and is not exposed in the UI tier list.
- Self bot local training now uses v2 localStorage keys, logs rewarded public-observation legal-action samples, trains a one-layer `legal_action_mlp`, and accepts RL v1 only when held-out imitation and benchmark gates do not regress.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and next AI slices: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Ladder, God, and self training workflow: `docs/TRAINING_PIPELINE.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- Fair ladder manifests still gate `noob` through `goat`, while the same manifest can now also carry a playable `god` model entry.
- Daily training now has a capped God lane, merges fair and God candidate manifests, compares God with `scripts/compare-god-models.mjs`, and promotes whichever gate passes while preserving unchanged manifest entries.
- Node training supports `--target-tier god` with hidden God feature size and schema-validated model artifacts.
- Browser self training runs imitation plus reward-weighted rollout fine-tune against Top and the highest unlocked fair tier.
- Tests cover full-grid spell actions, self legal-action samples/model selection, God hidden schema/runtime, manifest God entries, daily God workflow wiring, and God bootstrap comparison.

## Known Gaps

- The new God daily lane has only local smoke validation; hosted runtime and artifact size still need inspection on GitHub Actions.
- God bootstrap smoke used very small caps and produced draw-heavy short matches; real full-match signal still needs hosted/manual validation.
- Ladder ordering is still noisy at low rounds and is not stable enough for strict promotion.
- Existing checked-in promoted models do not include a God artifact until a God gate passes and a PR is reviewed.
- Browser self RL is intentionally lightweight reward-weighted fine-tuning, not a full policy-gradient system.

## Next 3 Tasks

1. Manually run `.github/workflows/daily-ladder-training.yml` on `main` and inspect total runtime, God lane runtime, artifact size, `god-comparison-summary.json`, and PR behavior.
2. If the God lane exceeds budget or produces all-draw signal, tune `LADDER_EPISODES`, `LADDER_BENCH_ROUNDS`, or `LADDER_MAX_TICKS` for the God lane separately from fair ladder training.
3. Browser-smoke self training after enough local samples: verify v2 localStorage, progress/status text, RL accepted/rejected messaging, and playable self model behavior.

## Validation

- May 4, 2026: `npm test` -> 119 tests passed.
- May 4, 2026: `npm run bot:bench -- --tiers noob,mid,top,pro,goat,god --rounds 2 --seed 909 --max-ticks 6040` -> completed; God beat Goat `2-0` in the 2-round sample, but low-round matrix remained noisy.
- May 4, 2026: `env LADDER_RUN_NAME=god-smoke-codex LADDER_OUTPUT_ROOT=artifacts/training/runs/god-smoke-codex LADDER_MODEL_MANIFEST_PATH=artifacts/training/runs/god-smoke-codex/candidate-god-models.json LADDER_TIERS=god LADDER_SHARDS=1 LADDER_EPISODES=1 LADDER_MAX_TICKS=120 LADDER_ITERATIONS=1 LADDER_EPOCHS=1 LADDER_BATCH_SIZE=8 LADDER_MAX_NEGATIVES=2 LADDER_EVAL_ROUNDS=1 LADDER_EVAL_MAX_TICKS=120 LADDER_BENCH_TIERS=goat,god LADDER_BENCH_ROUNDS=1 LADDER_BENCH_MAX_TICKS=120 bash scripts/train-bot-ladder.sh` -> completed; exported `samples=4`, trained `rows=12`, wrote a God candidate manifest.
- May 4, 2026: `node scripts/compare-god-models.mjs --baseline-manifest artifacts/training/ladder-models.json --candidate-manifest artifacts/training/runs/god-smoke-codex/candidate-god-models.json --out artifacts/training/runs/god-smoke-codex/god-comparison-summary.json --seed 1009 --rounds 1 --max-ticks 120 --min-prior-god-win-rate 0.5` -> `god_comparison_passed=true`.
- May 4, 2026: browser smoke was attempted. `npm run dev` in the sandbox failed with `listen EPERM: operation not permitted 127.0.0.1:5173`; escalated `npm run dev` started successfully at `http://127.0.0.1:5173`; Playwright CLI wrapper failed because restricted network blocked `@playwright/cli` resolution with `getaddrinfo ENOTFOUND registry.npmjs.org`; the fallback web-game Playwright runner hung and was killed.

## Risks / Notes

- Raw training artifacts remain ignored under `artifacts/training/runs/`; the local God smoke output is intentionally ignored.
- A `/private/tmp` God smoke produced an invalid manifest for comparison because manifest path validation rejects absolute `model_path` values. Workflow paths are repo-relative and the repo-relative smoke passed.
- Daily workflow timeout is still `350` minutes, but the added God lane may reduce margin versus the previous `1h59m5s` hosted fair-ladder run.
- Browser smoke still needs a clean repeat with a locally available Playwright CLI/browser runtime.
