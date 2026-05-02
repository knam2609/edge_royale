# Progress

## Current State

- As of May 2, 2026, fair ladder training is no longer Goat-only and the public training surface has been cleaned to `train:bot` and `train:ladder`.
- `train:bot` now trains a model-backed fair tier with `--target-tier <noob|mid|top|pro|goat>`.
- `bash scripts/train-bot-ladder.sh` now exports shard data, trains one model per fair tier, and benchmarks each saved artifact.
- Runtime selection now accepts same-tier neural artifacts for `noob`, `mid`, `top`, `pro`, and `goat` while preserving the existing delay/pass heuristic overlays.
- Legacy `train-goat` file/script naming has been removed from the working surface; the generic trainer now lives at `scripts/train-bot.mjs`.
- The self bot is still the old local bucket-count placeholder; the next-run self imitation + RL plan is now recorded in `docs/IMPLEMENTATION_PLAN.md`.

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

- `scripts/train-bot.mjs` is now the generic fair-tier trainer behind the `train:bot` script, with tier-specific default hidden sizes and `training_config.target_tier` metadata.
- `model:bench` now benchmarks any saved fair-tier model and infers the target tier from artifact metadata when possible.
- `scripts/train-bot-ladder.sh` runs shard export, model training, and saved-model benchmarking across `noob`, `mid`, `top`, `pro`, and `goat`.
- Fair-tier runtime selection can use same-tier neural artifacts and falls back to heuristics when no valid artifact is supplied.
- Empty shard files no longer poison multi-shard training; zero-row shards are skipped, and the trainer only fails when every shard is empty.

## Known Gaps

- Ladder artifacts are benchmark-ready, but the browser client still does not load per-tier saved model files for normal play. Live matches still default to heuristic ladder bots unless a model is passed in explicitly.
- Tiny smoke-trained ladder models mostly draw under short `max_ticks`; promotion-ready quality still needs larger exports, longer benchmarks, and real gating.
- God RL and playable God model work are still not implemented.
- The self bot still uses the old local bucket model and has not been migrated to legal-action imitation + RL yet.

## Next 3 Tasks

1. Add artifact loading/config so local play and benchmarks can switch specific ladder tiers between heuristic and saved-model policies without code edits.
2. Run larger fixed-seed ladder training sweeps, compare each saved tier against heuristic same-tier and adjacent tiers, and record promotion-ready benchmark thresholds.
3. Implement the self bot next slice from `docs/IMPLEMENTATION_PLAN.md`: full player decision logging, legal-action imitation model, and batched RL fine-tune.

## Validation

- May 2, 2026: `npm test` -> 103 tests passed.
- May 2, 2026: `bash -n scripts/train-bot-ladder.sh` -> shell syntax OK.
- May 2, 2026: `npm run train:bot -- --target-tier mid --episodes 1 --max-ticks 120 --iterations 1 --epochs 1 --eval-rounds 1 --eval-max-ticks 80 --max-negatives 2 --out /private/tmp/edge_royale_train_bot_smoke/model.json --summary-out /private/tmp/edge_royale_train_bot_smoke/summary.json` -> trained a smoke `mid` artifact and wrote model + summary outputs.

## Risks / Notes

- `noob` has a very high pass rate, so tiny shard exports can still produce sparse data; the ladder script now floors Noob smoke exports to at least 4 episodes, but serious Noob training should use materially larger episode counts.
- `train:bot` is now the single-tier entrypoint and `train:ladder` is the full fair-tier sweep entrypoint.
- The current fair-tier training path imitates existing heuristic tier behavior. It does not yet implement God-teacher distillation or RL for ladder tiers.
