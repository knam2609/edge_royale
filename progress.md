# Progress

## Current State

- As of May 2, 2026, local fair ladder model selection is manifest-driven.
- `bash scripts/train-bot-ladder.sh` exports shard data, trains one model per requested fair tier, benchmarks each saved artifact, and writes `artifacts/training/ladder-models.json`.
- The browser loads `artifacts/training/ladder-models.json` on startup and uses valid same-tier saved models for `noob`, `mid`, `top`, `pro`, and `goat`; missing, invalid, or mismatched entries fall back to heuristics.
- `npm run bot:bench -- --model-config artifacts/training/ladder-models.json` runs the ladder matrix with configured per-tier saved models.
- `model:bench` remains the one-artifact smoke benchmark, and `train:bot` remains the single-tier trainer.
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
- `scripts/train-bot-ladder.sh` now updates the ignored manifest at the end of each successful sweep.
- `scripts/bot-benchmark.mjs` accepts `--model-config`, loads valid configured artifacts, warns on invalid entries, and falls back per tier.

## Known Gaps

- Tiny smoke-trained ladder models still are not promotion-ready; short `max_ticks` runs can mostly draw or produce unstable ordering.
- Promotion thresholds for model-backed ladder tiers still need larger fixed-seed sweeps and comparison against heuristic same-tier and adjacent tiers.
- God RL and playable God model work are still not implemented.
- The self bot still uses the old local bucket model and has not been migrated to legal-action imitation + RL.

## Next 3 Tasks

1. Run larger fixed-seed ladder training sweeps using the manifest path, then compare model-backed tiers against heuristic same-tier and adjacent tiers.
2. Record promotion-ready benchmark thresholds and gating policy in `docs/BOT_LEVELS.md` / `docs/TRAINING_PIPELINE.md`.
3. Implement the self bot next slice from `docs/IMPLEMENTATION_PLAN.md`: full player decision logging, legal-action imitation model, and batched RL fine-tune.

## Validation

- May 2, 2026: `npm test` -> 108 tests passed.
- May 2, 2026: `bash -n scripts/train-bot-ladder.sh` -> shell syntax OK.
- May 2, 2026: `node --check scripts/write-ladder-model-manifest.mjs` -> syntax OK.
- May 2, 2026: `node --check scripts/bot-benchmark.mjs` -> syntax OK.
- May 2, 2026: `LADDER_RUN_NAME=manifest-smoke LADDER_TIERS=noob,mid LADDER_SHARDS=1 LADDER_EPISODES=1 LADDER_MAX_TICKS=80 LADDER_ITERATIONS=1 LADDER_EPOCHS=1 LADDER_BATCH_SIZE=8 LADDER_MAX_NEGATIVES=1 LADDER_EVAL_ROUNDS=1 LADDER_EVAL_MAX_TICKS=60 LADDER_BENCH_ROUNDS=1 LADDER_BENCH_MAX_TICKS=60 bash scripts/train-bot-ladder.sh` -> trained smoke `noob` and `mid` artifacts and wrote `artifacts/training/ladder-models.json`.
- May 2, 2026: `npm run bot:bench -- --tiers noob,mid --rounds 1 --seed 515 --model-config artifacts/training/ladder-models.json` -> loaded `noob,mid` model tiers and completed matrix.
- May 2, 2026: `npm run dev` required escalated local serving because sandbox returned `listen EPERM`; browser smoke at `http://127.0.0.1:5173` showed `Bot source: model`, started a match, and reported 0 console errors.

## Risks / Notes

- Generated training artifacts and the manifest stay under ignored `artifacts/`; normal fresh checkout without local training still uses heuristic ladder bots.
- `noob` has a very high pass rate, so tiny shard exports can still produce sparse data; serious Noob training should use materially larger episode counts.
- The current fair-tier training path imitates existing heuristic tier behavior. It does not yet implement God-teacher distillation or RL for ladder tiers.
