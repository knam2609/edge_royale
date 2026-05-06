# Progress

## Current State

- As of May 6, 2026, local `main` contains the God + self legal-action AI implementation, durable `progress.md` handoff contract, and compact offline ladder dataset export.
- Legal action enumeration uses `full_snapped_grid_v1`: troops enumerate legal deploy cells and spells enumerate every snapped arena cell.
- Offline `data:export` now stores the chosen action plus a bounded deterministic prefix of non-chosen legal candidates per sample, preserving `legal_action_count` for the full action-space size.
- `hashState` now streams canonical stable JSON tokens into FNV hashing instead of materializing one giant string.
- Playable God can load a same-tier `legal_action_mlp` from `artifacts/training/ladder-models.json`; God model features use `god_state_features_v1` with opponent exact elixir, hand, and deck queue.
- Self bot local training uses v2 localStorage keys, logs rewarded public-observation legal-action samples, trains a one-layer `legal_action_mlp`, and accepts RL v1 only when held-out imitation and benchmark gates do not regress.

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

- Fair ladder manifests gate `noob` through `goat`, while the same manifest can also carry a playable `god` model entry.
- Daily training has a capped God lane, merges fair and God candidate manifests, compares God with `scripts/compare-god-models.mjs`, and promotes whichever gate passes while preserving unchanged manifest entries.
- Daily workflow passes `LADDER_DATASET_MAX_NEGATIVES=8` for fair and God lanes so full-match shards stay below the prior giant-string failure size.
- Node training supports `--target-tier god` with hidden God feature size and schema-validated model artifacts.
- Browser self training runs imitation plus reward-weighted rollout fine-tune against Top and the highest unlocked fair tier.
- Tests cover full-grid spell actions, compact stored legal-action samples, streamed hash compatibility, self legal-action samples/model selection, God hidden schema/runtime, manifest God entries, daily God workflow wiring, and God bootstrap comparison.

## Known Gaps

- The compact export fix has local validation only; hosted `.github/workflows/daily-ladder-training.yml` still needs a fresh run on GitHub Actions.
- God bootstrap smoke used very small caps and produced draw-heavy short matches; real full-match signal still needs hosted/manual validation.
- Ladder ordering is still noisy at low rounds and is not stable enough for strict promotion.
- Existing checked-in promoted models do not include a God artifact until a God gate passes and a PR is reviewed.
- Browser self RL is intentionally lightweight reward-weighted fine-tuning, not a full policy-gradient system.
- Telemetry/export pipeline work from the roadmap is still incomplete beyond the current deterministic training export hooks.
- Browser validation is useful but not yet standardized into one repeatable repo command.

## Next Tasks

1. Manually run `.github/workflows/daily-ladder-training.yml` on `main` after the compact export fix and inspect total runtime, fair/God artifact sizes, God lane runtime, `god-comparison-summary.json`, and PR behavior.
2. If the God lane exceeds budget or produces all-draw signal, tune `LADDER_EPISODES`, `LADDER_BENCH_ROUNDS`, or `LADDER_MAX_TICKS` for the God lane separately from fair ladder training.
3. Browser-smoke self training after enough local samples: verify v2 localStorage, progress/status text, RL accepted/rejected messaging, and playable self model behavior.
4. Stabilize ladder ordering enough to support a stricter promotion gate, then update `docs/BOT_LEVELS.md` and training gate docs with the real threshold.
5. Standardize browser validation into one repeatable local command or documented workflow that works without registry access during smoke checks.
6. Continue telemetry/export pipeline work from `docs/IMPLEMENTATION_PLAN.md` and `docs/TRAINING_PIPELINE.md` so match data can support future self-play training beyond current local samples.

## Validation

- May 6, 2026: inspected GitHub Actions run `25396086873` -> `Train candidate ladder models` failed on `RangeError: Invalid string length` in `src/sim/hash.js` during first noob full-match shard hash.
- May 6, 2026: `npm test` -> 121 tests passed.
- May 6, 2026: `npm run data:export -- --seed 303 --episodes 150 --max-ticks 6040 --tiers noob --max-stored-negatives 8 --out /private/tmp/edge_royale-noob-150.json` -> completed; `episodes=150`, `samples=9142`, file size `27505382` bytes.
- May 6, 2026: `env LADDER_RUN_NAME=ci-size-smoke LADDER_OUTPUT_ROOT=artifacts/training/runs/ci-size-smoke LADDER_TIERS=noob LADDER_SHARDS=1 LADDER_EPISODES=2 LADDER_MAX_TICKS=6040 LADDER_ITERATIONS=1 LADDER_EPOCHS=1 LADDER_EVAL_ROUNDS=1 LADDER_EVAL_MAX_TICKS=120 LADDER_BENCH_ROUNDS=1 LADDER_BENCH_MAX_TICKS=120 bash scripts/train-bot-ladder.sh` -> completed; existing noob floor exported `episodes=4`, `samples=294`, trained `rows=1470`, benchmark completed with all 120-tick draws.
- May 4, 2026: `npm run bot:bench -- --tiers noob,mid,top,pro,goat,god --rounds 2 --seed 909 --max-ticks 6040` -> completed; God beat Goat `2-0` in the 2-round sample, but low-round matrix remained noisy.
- May 4, 2026: browser smoke was attempted. `npm run dev` in the sandbox failed with `listen EPERM: operation not permitted 127.0.0.1:5173`; escalated `npm run dev` started successfully at `http://127.0.0.1:5173`; Playwright CLI wrapper failed because restricted network blocked `@playwright/cli` resolution with `getaddrinfo ENOTFOUND registry.npmjs.org`; the fallback web-game Playwright runner hung and was killed.

## Risks / Notes

- Raw training artifacts remain ignored under `artifacts/training/runs/`; local `ci-size-smoke` output is intentionally ignored.
- The ladder smoke command defaulted `LADDER_MODEL_MANIFEST_PATH` to tracked `artifacts/training/ladder-models.json`; that validation-only change was restored.
- A `/private/tmp` God smoke produced an invalid manifest for comparison because manifest path validation rejects absolute `model_path` values. Workflow paths are repo-relative and the repo-relative smoke passed.
- Daily workflow timeout is still `350` minutes, but the added God lane may reduce margin versus the previous `1h59m5s` hosted fair-ladder run.
- Browser smoke still needs a clean repeat with a locally available Playwright CLI/browser runtime.
