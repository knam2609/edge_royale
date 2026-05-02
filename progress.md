# Progress

## Current State

- As of May 3, 2026, fair ladder model selection is manifest-driven and daily GitHub Actions training is wired.
- `bash scripts/train-bot-ladder.sh` exports shard data, trains one model per requested fair tier, benchmarks each saved artifact, and writes `artifacts/training/ladder-models.json`.
- The browser loads `artifacts/training/ladder-models.json` on startup and uses valid same-tier saved models for `noob`, `mid`, `top`, `pro`, and `goat`; missing, invalid, or mismatched entries fall back to heuristics.
- `npm run bot:bench -- --model-config artifacts/training/ladder-models.json` runs the ladder matrix with configured per-tier saved models.
- `model:bench` remains the one-artifact smoke benchmark, and `train:bot` remains the single-tier trainer.
- `.github/workflows/daily-ladder-training.yml` runs daily at `17:37 UTC`, trains the balanced large preset on GitHub-hosted Ubuntu, uploads the full ignored run, compares candidate models against the checked-in manifest, and opens/updates branch `training/daily-ladder-models` only when the improvement gate passes.
- The checked-in baseline manifest is currently empty, so fresh checkout falls back to heuristic ladder bots until a passing daily model PR is merged.
- The self bot is still the old local bucket-count placeholder; the next-run self imitation + RL plan remains in `docs/IMPLEMENTATION_PLAN.md`.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and next AI slices: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Ladder training workflow and schemas: `docs/TRAINING_PIPELINE.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- `src/ai/ladderModelManifest.js` validates manifest version, tier ids, model mode, safe relative artifact paths, and same-tier neural artifact metadata.
- The browser setup summary reports `Bot source: heuristic` or `Bot source: model` for the selected tier.
- `scripts/write-ladder-model-manifest.mjs` writes enabled model manifests from trained tier outputs.
- `scripts/train-bot-ladder.sh` writes the configured ladder manifest path at the end of each successful sweep.
- `scripts/bot-benchmark.mjs` accepts `--model-config`, loads valid configured artifacts, warns on invalid entries, and falls back per tier.
- `scripts/compare-ladder-models.mjs` runs deterministic fixed-seed candidate-vs-baseline matrix comparisons and enforces the daily full-requested-tier / `+0.02` average / `0.05` adjacent-regression gate.
- `scripts/promote-ladder-models.mjs` copies passing models and summaries to stable promoted paths, writes the runtime manifest, and prepares the daily PR body.

## Known Gaps

- The daily workflow has not yet been run on GitHub Actions; artifact upload, branch push, and PR upsert still need one real `workflow_dispatch` check.
- The balanced large preset may need tuning after the first hosted run reports wall time, artifact size, and benchmark signal.
- Tiny smoke-trained ladder models still are not promotion-ready; short `max_ticks` runs can mostly draw or produce unstable ordering.
- Promotion thresholds for model-backed ladder tiers still need larger fixed-seed sweeps and comparison against heuristic same-tier and adjacent tiers.
- God RL and playable God model work are still not implemented.
- The self bot still uses the old local bucket model and has not been migrated to legal-action imitation + RL.

## Next 3 Tasks

1. Trigger `.github/workflows/daily-ladder-training.yml` with `workflow_dispatch`, then verify uploaded artifact, comparison summary, branch update, and PR body.
2. Use the first full hosted run to tune `LADDER_SHARDS`, `LADDER_EPISODES`, benchmark rounds, and the improvement gate if runtime or signal is poor.
3. Implement the self bot next slice from `docs/IMPLEMENTATION_PLAN.md`: full player decision logging, legal-action imitation model, and batched RL fine-tune.

## Validation

- May 3, 2026: `node --check scripts/compare-ladder-models.mjs` -> syntax OK.
- May 3, 2026: `node --check scripts/promote-ladder-models.mjs` -> syntax OK.
- May 3, 2026: `bash -n scripts/train-bot-ladder.sh` -> shell syntax OK.
- May 3, 2026: `npm test` -> 111 tests passed.
- May 3, 2026: `LADDER_RUN_NAME=daily-smoke LADDER_OUTPUT_ROOT=artifacts/training/runs/daily-smoke LADDER_MODEL_MANIFEST_PATH=artifacts/training/runs/daily-smoke/candidate-ladder-models.json LADDER_TIERS=noob,mid LADDER_SHARDS=1 LADDER_EPISODES=1 LADDER_MAX_TICKS=80 LADDER_ITERATIONS=1 LADDER_EPOCHS=1 LADDER_BATCH_SIZE=8 LADDER_MAX_NEGATIVES=1 LADDER_EVAL_ROUNDS=1 LADDER_EVAL_MAX_TICKS=60 LADDER_BENCH_TIERS=noob,mid LADDER_BENCH_ROUNDS=1 LADDER_BENCH_MAX_TICKS=60 bash scripts/train-bot-ladder.sh` -> trained smoke `noob` and `mid` candidate artifacts under ignored `artifacts/training/runs/daily-smoke/`.
- May 3, 2026: `node scripts/compare-ladder-models.mjs --baseline-manifest artifacts/training/ladder-models.json --candidate-manifest artifacts/training/runs/daily-smoke/candidate-ladder-models.json --out artifacts/training/runs/daily-smoke/comparison-summary.json --tiers noob,mid --seed 909 --rounds 1 --max-ticks 60 --min-average-delta 0.02 --bootstrap-min-average-delta 0 --max-adjacent-regression 0.05` -> `comparison_passed=true`, `average_delta=0`, `worst_adjacent_delta=0`.
- May 3, 2026: `node scripts/promote-ladder-models.mjs --candidate-manifest artifacts/training/runs/daily-smoke/candidate-ladder-models.json --comparison-summary artifacts/training/runs/daily-smoke/comparison-summary.json --run-root artifacts/training/runs/daily-smoke --out-dir artifacts/training/runs/daily-smoke/promoted --manifest-out artifacts/training/runs/daily-smoke/promoted-ladder-models.json --summary-out artifacts/training/runs/daily-smoke/latest-training-summary.json --pr-body-out artifacts/training/runs/daily-smoke/pull-request-body.md` -> promoted smoke `noob,mid` into ignored smoke output and wrote PR body.

## Risks / Notes

- Raw training artifacts stay ignored under `artifacts/training/runs/`; only `artifacts/training/ladder-models.json` and `artifacts/training/promoted/**` are intended to be tracked.
- Local `train:ladder` still writes the default runtime manifest unless `LADDER_MODEL_MANIFEST_PATH` is overridden; use a run-local candidate manifest for scratch experiments that should not dirty tracked model config.
- `noob` has a very high pass rate, so tiny shard exports can still produce sparse data; serious Noob training should use materially larger episode counts.
- The current fair-tier training path imitates existing heuristic tier behavior. It does not yet implement God-teacher distillation, GPU-backed training, or RL for ladder tiers.
