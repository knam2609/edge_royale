# Neural Goat Training Pipeline

## Goal

Train a fair, model-backed `goat` boss without giving it hidden opponent hand or exact opponent elixir.

The first implementation is offline-first:

- deterministic headless rollouts export full training episodes
- TensorFlow.js trains a small legal-action MLP in Node
- runtime inference uses plain JavaScript matrix math in `src/ai`
- generated datasets and models live under ignored `artifacts/`

## Data Shape

Dataset schema version: `1.0`

Each exported dataset contains:

- `dataset_hash`, `seed`, `tiers`, `episode_count`, `sample_count`
- `episodes[]` with seed, tiers, final result, state hash, replay hash, replay actions, and `samples[]`
- `episodes[].samples[]` with actor, tier, tick, phase, fair observation vector, legal actions, chosen action index, and terminal reward from that actor's perspective

Observation schema: `goat_state_features_v1`

The fair observation vector includes:

- phase/time and own elixir
- own hand and own deck queue
- public tower HP/activity summaries
- public troop summaries by lane, side, team, and card id

It intentionally excludes hidden opponent hand and exact opponent elixir.

Action schema: `goat_action_features_v1`

The action vector describes one legal `PLAY_CARD(cardId, x, y)` candidate. The model scores every legal candidate and chooses the highest-scoring legal action. If no valid neural model is supplied, `goat` falls back to the existing heuristic policy.

## Commands

Run the full shard export, train, and benchmark flow:

```bash
bash scripts/train-goat-pipeline.sh
```

By default the script writes a timestamped run under `artifacts/training/runs/`, exports shard files, trains from the shard directory, then benchmarks the saved model.

Customize the run with env vars when needed:

```bash
GOAT_RUN_NAME=goat-smoke GOAT_SHARDS=2 GOAT_EPISODES=2 GOAT_MAX_TICKS=120 GOAT_ITERATIONS=1 GOAT_EPOCHS=1 GOAT_EVAL_ROUNDS=1 GOAT_EVAL_MAX_TICKS=80 GOAT_BENCH_ROUNDS=2 GOAT_BENCH_MAX_TICKS=80 GOAT_BENCH_SEED=9001 bash scripts/train-goat-pipeline.sh
```

The pipeline script wraps `data:export`, `train:goat`, and `model:bench`. `data:export` still writes compact JSON by default so large shard files stay within practical string sizes, and `train:goat` still supports repeated `--dataset <file>` flags for manual debugging. When multiple shard files are supplied, `train:goat` trains over the deterministic lexicographic union of those files, stores a corpus-level `dataset_hash` on the model artifact, and records the ordered shard metadata under `training_config.dataset_sources`.

## Model Artifact

Model schema version: `1`

Model artifacts contain:

- `kind: "legal_action_mlp"`
- feature/action schema versions
- `input_size`
- training config, seed, dataset hash, and shard source metadata when training from multiple files
- dense layer weights and biases exported from TensorFlow.js

Saved-model evaluation is deterministic for a fixed model, seed, and benchmark config. Training records seed/config/hash metadata, but TensorFlow.js weight generation is not treated as a cross-platform bit-for-bit contract.

## Promotion Gate

The current gate is pipeline correctness:

- dataset export is replayable from saved actions
- model artifact validates
- model-backed Goat returns only legal actions
- saved model benchmark output is deterministic
- trained model is compared against Noob/Mid/Top and prior snapshots before any gameplay promotion

Beating Top is not required for this first pass because ladder ordering is still being stabilized separately.
