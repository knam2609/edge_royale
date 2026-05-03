# Progress

## Current State

- As of May 3, 2026, PR #4 (`https://github.com/knam2609/edge_royale/pull/4`) is merged into `main` at `38ee3ddca14773a1f66b89398f9ebc898eab581b`.
- The daily ladder workflow has been tuned locally from short 900-tick runs to full-match 6040-tick training, eval, saved-model bench, and compare caps.
- The daily preset now uses `LADDER_SHARDS=4`, `LADDER_EPISODES=150`, and keeps the existing gate thresholds: average delta `+0.02`, bootstrap delta `0`, adjacent regression `0.05`.
- Local validation shows same-manifest non-bootstrap candidates now fail the gate with `average_delta=0`, while bootstrap zero-delta behavior remains allowed only when no baseline model tiers exist.

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

- `.github/workflows/daily-ladder-training.yml` still runs tests, trains all fair tiers, compares candidates, uploads artifacts, promotes passing candidates, pushes `training/daily-ladder-models`, and opens/updates the model PR.
- Daily training now exports/evaluates/benchmarks full matches with a 6040-tick cap while reducing per-shard episodes to keep the run within the 180-minute budget.
- `scripts/compare-ladder-models.mjs` still enforces full requested-tier coverage, deterministic benchmark output, average delta, and adjacent-regression gates.
- Tests cover non-bootstrap zero-delta rejection, bootstrap zero-delta allowance, and workflow full-match preset values.
- The browser and benchmark paths still load valid same-tier saved models from `artifacts/training/ladder-models.json` and fall back to heuristics for missing or invalid entries.

## Known Gaps

- The full-match daily preset has not yet been validated on GitHub Actions; hosted runtime and artifact size need inspection against the 180-minute target.
- Ladder ordering is still not stable enough to serve as a strict promotion gate.
- The currently promoted models are the merged bootstrap artifacts and did not prove strength improvement.
- GitHub Actions previously emitted Node.js 20 action deprecation warnings for `actions/checkout@v4`, `actions/setup-node@v4`, and `actions/upload-artifact@v4`.
- God RL and playable God model work are still not implemented.
- The self bot still uses the old local bucket model and has not been migrated to legal-action imitation + RL.

## Next 3 Tasks

1. Run `.github/workflows/daily-ladder-training.yml` manually on `main` after this full-match preset lands, then inspect runtime, artifact size, candidate matrix, and PR behavior.
2. Tune the daily preset/gate from the first hosted full-match result if runtime exceeds budget or signal remains noisy.
3. Implement the self bot next slice from `docs/IMPLEMENTATION_PLAN.md`: full player decision logging, legal-action imitation model, and batched RL fine-tune.

## Validation

- May 3, 2026: `npm test` -> 114 tests passed.
- May 3, 2026: `npm run bot:bench -- --tiers noob,mid,top,pro,goat --rounds 2 --seed 909 --max-ticks 6040` -> completed with resolved full-match outcomes instead of an all-draw matrix.
- May 3, 2026: `npm run bot:bench -- --model-config artifacts/training/ladder-models.json --tiers noob,mid,top,pro,goat --rounds 2 --seed 909 --max-ticks 6040` -> completed with `model_tiers=noob,mid,top,pro,goat` and resolved full-match outcomes.
- May 3, 2026: `node scripts/compare-ladder-models.mjs --baseline-manifest artifacts/training/ladder-models.json --candidate-manifest artifacts/training/ladder-models.json --out /private/tmp/edge-royale-same-manifest-compare.json --tiers noob,mid,top,pro,goat --seed 909 --rounds 2 --max-ticks 6040 --min-average-delta 0.02 --bootstrap-min-average-delta 0 --max-adjacent-regression 0.05` -> `comparison_passed=false`, `average_delta=0`, `gate_reason=average win-rate delta 0 is below required 0.02`.
- May 3, 2026: `env LADDER_RUN_NAME=full-match-smoke LADDER_OUTPUT_ROOT=/private/tmp/edge-royale-full-match-smoke LADDER_MODEL_MANIFEST_PATH=/private/tmp/edge-royale-full-match-smoke/candidate-ladder-models.json LADDER_TIERS=mid LADDER_SHARDS=1 LADDER_EPISODES=1 LADDER_MAX_TICKS=6040 LADDER_ITERATIONS=1 LADDER_EPOCHS=1 LADDER_BATCH_SIZE=8 LADDER_MAX_NEGATIVES=2 LADDER_EVAL_ROUNDS=1 LADDER_EVAL_MAX_TICKS=6040 LADDER_BENCH_TIERS=noob,mid LADDER_BENCH_ROUNDS=1 LADDER_BENCH_MAX_TICKS=6040 bash scripts/train-bot-ladder.sh` -> completed under `/private/tmp`, exported `samples=112`, trained `rows=336`, wrote candidate manifest.

## Risks / Notes

- Raw training artifacts stay ignored under `artifacts/training/runs/`; only `artifacts/training/ladder-models.json` and `artifacts/training/promoted/**` are intended to be tracked on promoted branches.
- Full-match training increases per-episode sample count; `LADDER_EPISODES=150` is a budgeted starting point, not a proven hosted optimum.
- The current fair-tier training path imitates existing heuristic tier behavior. It does not yet implement God-teacher distillation, GPU-backed training, or RL for ladder/self tiers.
