# Neural Ladder Training Pipeline

## Goal

Train fair, model-backed ladder tiers (`noob`, `mid`, `top`, `pro`, `goat`) without giving them hidden opponent hand or exact opponent elixir.

The first implementation is offline-first with one automated daily training lane:

- deterministic headless rollouts export full training episodes
- TensorFlow.js trains a small legal-action MLP in Node
- runtime inference uses plain JavaScript matrix math in `src/ai`
- generated datasets and raw run models live under ignored `artifacts/training/runs/`
- accepted daily models are copied to stable tracked paths under `artifacts/training/promoted/`

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

The action vector describes one legal `PLAY_CARD(cardId, x, y)` candidate. The model scores every legal candidate and chooses the highest-scoring legal action. If no valid neural model is supplied, the tier falls back to its existing heuristic policy.

## Commands

Run the full fair-tier shard export, train, and benchmark flow:

```bash
bash scripts/train-bot-ladder.sh
```

By default the script writes a timestamped run under `artifacts/training/runs/`, exports shard files for each fair ladder tier, trains one saved model per tier, then benchmarks each saved model.
It also writes `artifacts/training/ladder-models.json`, an ignored local manifest that enables the newly trained model for each completed fair tier.

Customize the run with env vars when needed:

```bash
LADDER_RUN_NAME=ladder-smoke LADDER_SHARDS=1 LADDER_EPISODES=2 LADDER_MAX_TICKS=120 LADDER_ITERATIONS=1 LADDER_EPOCHS=1 LADDER_EVAL_ROUNDS=1 LADDER_EVAL_MAX_TICKS=80 LADDER_BENCH_ROUNDS=2 LADDER_BENCH_MAX_TICKS=80 bash scripts/train-bot-ladder.sh
```

The ladder pipeline wraps `data:export`, `train:bot`, and `model:bench`. `data:export` still writes compact JSON by default so large shard files stay within practical string sizes, and `train:bot` still supports repeated `--dataset <file>` flags for manual debugging. When multiple shard files are supplied, the trainer runs over the deterministic lexicographic union of those files, stores a corpus-level `dataset_hash` on the model artifact, and records the ordered shard metadata under `training_config.dataset_sources`.

## Local Model Manifest

The shared manifest lives at `artifacts/training/ladder-models.json` by default:

```json
{
  "version": 1,
  "tiers": {
    "mid": {
      "mode": "model",
      "model_path": "artifacts/training/runs/ladder-smoke/models/mid-model.json"
    }
  }
}
```

Valid fair tiers are `noob`, `mid`, `top`, `pro`, and `goat`.
`mode: "heuristic"` disables model usage for that tier.
The browser and `bot:bench -- --model-config <path>` only use valid same-tier artifacts; missing, invalid, or mismatched models fall back to heuristic policies.

The daily workflow writes a candidate manifest inside its ignored run directory first. Only a passing candidate is promoted into the checked-in shared manifest and stable promoted model paths.

## Model Artifact

Model schema version: `1`

Model artifacts contain:

- `kind: "legal_action_mlp"`
- feature/action schema versions
- `input_size`
- `training_config.target_tier`
- training config, seed, dataset hash, and shard source metadata when training from multiple files
- dense layer weights and biases exported from TensorFlow.js

Saved-model evaluation is deterministic for a fixed model, seed, and benchmark config. Training records seed/config/hash metadata, but TensorFlow.js weight generation is not treated as a cross-platform bit-for-bit contract.

## Promotion Gate

The current gate is pipeline correctness:

- dataset export is replayable from saved actions
- model artifact validates
- model-backed fair tier returns only legal actions
- saved model benchmark output is deterministic
- trained model is compared against heuristic same-tier and adjacent fair tiers before any gameplay promotion

This gate is still about pipeline correctness first. Ladder ordering and stronger promotion thresholds remain follow-up work.

## Daily Training Automation

`.github/workflows/daily-ladder-training.yml` runs at `17:37 UTC` daily and supports manual `workflow_dispatch`.

Daily training uses the balanced large preset:

```bash
LADDER_TIERS=noob,mid,top,pro,goat
LADDER_SHARDS=4
LADDER_EPISODES=500
LADDER_MAX_TICKS=900
LADDER_ITERATIONS=3
LADDER_EPOCHS=8
LADDER_BATCH_SIZE=64
LADDER_MAX_NEGATIVES=8
LADDER_EVAL_ROUNDS=50
LADDER_EVAL_MAX_TICKS=900
LADDER_BENCH_ROUNDS=25
LADDER_BENCH_MAX_TICKS=900
```

After training, `scripts/compare-ladder-models.mjs` benchmarks the candidate manifest against the checked-in manifest with the same seeds. The daily improvement gate passes only when:

- the candidate benchmark matrix is deterministic
- every requested fair tier has a valid same-tier candidate model
- average win-rate delta is at least `+0.02` after bootstrap
- no adjacent tier pair regresses by more than `0.05`

When the gate passes, `scripts/promote-ladder-models.mjs` copies accepted models and per-tier summaries to `artifacts/training/promoted/`, writes `artifacts/training/ladder-models.json`, and prepares the PR body. The workflow pushes branch `training/daily-ladder-models` and opens or updates a PR to `main`; it does not auto-merge. If repository settings block Action-created PRs, the workflow leaves the branch pushed and emits a warning instead of failing. Configure `LADDER_MODEL_PR_TOKEN` with pull-request permissions when automatic PR creation is required without changing repository workflow permissions.

The first accepted run can bootstrap from a heuristic baseline if no checked-in models exist. This daily improvement gate is not the strict promotion gate in `docs/BOT_LEVELS.md`; it is a safe automatic refresh gate for candidate model artifacts.
