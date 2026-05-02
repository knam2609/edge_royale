# Progress

## Current State

- As of May 2, 2026, the offline Goat pipeline is shard-native for file-backed training.
- The primary documented Goat workflow is now `bash scripts/train-goat-pipeline.sh`.
- `data:export` now writes compact JSON by default and supports `--pretty` for small inspection exports.
- `train:goat` now accepts repeated `--dataset <file>` inputs and `--dataset-dir <dir>`, loads shard files in deterministic lexicographic order, recomputes shard hashes, and records ordered shard metadata in model artifacts.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and phase intent: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Neural training workflow and schemas: `docs/TRAINING_PIPELINE.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- Deterministic rollout export still produces replayable training episodes with fair observations, legal action candidates, chosen labels, rewards, replay hashes, and state hashes.
- `scripts/train-goat-pipeline.sh` now wraps shard export, model training, and saved-model benchmarking behind one bash entrypoint.
- Single-file training still works when `train:goat` is pointed at one dataset file or generates data inline with no dataset flags.
- Multi-shard training now does a two-pass file-backed ingest: first pass counts rows and records shard metadata, second pass fills flat numeric buffers before TensorFlow.js training.
- Saved models still validate against the legal-action MLP schema and benchmark through the normal Goat runtime.

## Known Gaps

- Compact JSON avoids the immediate `Invalid string length` failure mode from pretty-printed large exports, but extremely large monolithic dataset files can still outgrow one-shot JSON serialization. JSONL/streaming is still future work if shard sizes grow further.
- The neural Goat pipeline is operational, but smoke-trained models are still not promotion-ready bosses.
- Bot strength ordering is still not reliable enough to serve as a promotion gate.
- Browser validation is still an ad hoc workflow rather than a single repo command.

## Next 3 Tasks

1. Run larger shard sweeps with fixed seeds, compare model artifacts against heuristic Goat and prior snapshots, and record payoff summaries.
2. Add corpus-level tooling for shard inspection and optional merge/report flows without reintroducing giant intermediate JSON files.
3. Stabilize ladder ordering by tuning `top` and `pro` heuristics against `mid`, then add stronger adjacent-tier benchmark assertions.

## Validation

- May 2, 2026: `npm test` -> 101 tests passed.
- May 2, 2026: `bash -n scripts/train-goat-pipeline.sh` -> shell syntax OK.
- May 2, 2026: `GOAT_OUTPUT_ROOT=/private/tmp/edge_royale_goat_pipeline_smoke GOAT_SHARDS=2 GOAT_EPISODES=2 GOAT_MAX_TICKS=120 GOAT_ITERATIONS=1 GOAT_EPOCHS=1 GOAT_EVAL_ROUNDS=1 GOAT_EVAL_MAX_TICKS=80 GOAT_MAX_NEGATIVES=2 GOAT_BENCH_ROUNDS=2 GOAT_BENCH_MAX_TICKS=80 GOAT_BENCH_SEED=9001 bash scripts/train-goat-pipeline.sh` -> exported 2 shards, trained `rows=45`, wrote model and summary, and completed deterministic smoke benchmarking with `0-0` draws vs `noob`, `mid`, `top`, and `goat`.

## Risks / Notes

- Multi-file model artifacts now carry a corpus hash plus ordered `training_config.dataset_sources`; downstream tooling should treat that as the primary provenance source for shard-backed training runs.
- The current shard loader expects one JSON dataset object per file and scans only the specified directory, not nested subdirectories.
- TensorFlow.js still prints the Node backend advisory during training; this is expected in the current setup.
