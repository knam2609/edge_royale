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
- `episodes[]` with seed, tiers, final result, state hash, replay hash, replay actions, and samples
- `samples[]` with actor, tier, tick, phase, fair observation vector, legal actions, chosen action index, and terminal reward from that actor's perspective

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

Export deterministic rollout data:

```bash
npm run data:export -- --seed 303 --episodes 8 --tiers top,goat --max-ticks 900 --out artifacts/training/datasets/goat-dataset.json
```

Train a model:

```bash
npm run train:goat -- --dataset artifacts/training/datasets/goat-dataset.json --iterations 1 --epochs 4 --out artifacts/training/models/goat-model.json
```

Benchmark a saved model:

```bash
npm run model:bench -- --model artifacts/training/models/goat-model.json --tiers noob,mid,top,goat --rounds 10 --seed 404
```

## Model Artifact

Model schema version: `1`

Model artifacts contain:

- `kind: "legal_action_mlp"`
- feature/action schema versions
- `input_size`
- training config, seed, and dataset hash
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
