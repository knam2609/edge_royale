# Neural Ladder Training Pipeline

## Goal

Train fair, model-backed ladder tiers (`noob`, `mid`, `top`, `pro`, `goat`) without giving them hidden opponent hand or exact opponent elixir, and train playable God with a separate hidden-info schema.

The first implementation is offline-first with one automated daily training lane:

- deterministic headless rollouts export full training episodes
- TensorFlow.js trains a small legal-action MLP in Node
- runtime inference uses plain JavaScript matrix math in `src/ai`
- generated datasets and raw run models live under ignored `artifacts/training/runs/`
- accepted daily models are copied to stable tracked paths under `artifacts/training/promoted/`
- local self-play trains a browser-side `legal_action_mlp` from player decisions and a small reward-weighted RL fine-tune

## Data Shape

Dataset schema version: `1.0`

Each exported dataset contains:

- `dataset_hash`, `seed`, `tiers`, `episode_count`, `sample_count`
- `episodes[]` with seed, tiers, final result, state hash, replay hash, replay actions, and `samples[]`
- `episodes[].samples[]` with actor, tier, tick, phase, observation vector, stored legal actions, chosen action index, total legal-action count, and terminal reward from that actor's perspective

Observation schemas:

- `goat_state_features_v1` for fair ladder and self models.
- `god_state_features_v1` for playable God; it appends exact opponent elixir, opponent hand, and opponent deck queue.

The fair observation vector includes:

- phase/time and own elixir
- own hand and own deck queue
- public tower HP/activity summaries
- public troop summaries by lane, side, team, and card id

It intentionally excludes hidden opponent hand and exact opponent elixir.

Action schema: `goat_action_features_v2`
Action space: `full_snapped_grid_v1`

The action vector describes one legal candidate. `PLAY_CARD(cardId, x, y)` candidates enumerate every legal troop deploy grid cell and every snapped spell target. A synthetic `PASS` candidate is also scored in v2 with an explicit `is_pass` feature. Legacy `goat_action_features_v1` artifacts remain readable, but they do not score synthetic `PASS`. If no valid neural model is supplied, the tier falls back to its existing heuristic policy.

## Commands

Run the full fair-tier shard export, train, and benchmark flow:

```bash
bash scripts/train-bot-ladder.sh
```

By default the script writes a timestamped run under `artifacts/training/runs/`, exports shard files for each fair ladder tier, trains one saved model per tier, then benchmarks each saved model.
It also writes `artifacts/training/ladder-models.json`, an ignored local manifest that enables the newly trained model for each completed fair tier.
Fair tiers now use a fixed mixed-opponent curriculum inside `scripts/train-bot-ladder.sh`: `noob` -> `noob vs mid`; `mid` -> weighted `mid vs noob` / `mid vs top` at `2:1`; `top` -> weighted `top vs mid` / `top vs pro` at `2:1`; `pro` -> `pro vs top`, `pro vs goat`; `goat` -> `goat vs mid`, `goat vs top`, `goat vs pro`. `god` stays single-tier. `LADDER_EPISODES` is split by pairing weights with a minimum of one episode per pairing, so tiny smoke runs still cover every configured matchup.

Customize the run with env vars when needed:

```bash
LADDER_RUN_NAME=ladder-smoke LADDER_SHARDS=1 LADDER_EPISODES=2 LADDER_MAX_TICKS=120 LADDER_ITERATIONS=1 LADDER_EPOCHS=1 LADDER_EVAL_ROUNDS=1 LADDER_EVAL_MAX_TICKS=80 LADDER_BENCH_ROUNDS=2 LADDER_BENCH_MAX_TICKS=80 bash scripts/train-bot-ladder.sh
```

The ladder pipeline wraps `data:export`, `train:bot`, and `model:bench`. `data:export` writes compact JSON by default and stores only the chosen action plus a bounded deterministic prefix of non-chosen legal candidates per sample. Use `--max-stored-negatives <n>` or `LADDER_DATASET_MAX_NEGATIVES` to tune that cap; default export behavior stores `8` negatives. Each sample preserves `legal_action_count` so full action-space size remains measurable. `train:bot` still supports repeated `--dataset <file>` flags for manual debugging. When multiple shard files or dataset dirs are supplied, the trainer runs over the deterministic lexicographic union of those files, requires them to agree on one dataset `max_ticks`, filters supervised rows to `training_config.target_tier`, stores a corpus-level `dataset_hash` on the model artifact, and records the ordered shard metadata plus per-shard `max_ticks` under `training_config.dataset_sources`. In dataset-backed runs, artifact `training_config.max_ticks` reflects the shard dataset cap that actually trained the model; `--max-ticks` only controls on-the-fly dataset generation when no dataset files are supplied.

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

Valid fair tiers are `noob`, `mid`, `top`, `pro`, and `goat`. The same manifest can also include playable `god`; fair gates ignore God and the God gate handles it separately.
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

God artifacts use `training_config.target_tier: "god"` and `feature_schema_version: "god_state_features_v1"`.

## Promotion Gate

Fair ladder still keeps the pipeline-correctness gate:

- dataset export is replayable from saved actions
- model artifact validates
- model-backed fair tier returns only legal actions
- saved model benchmark output is deterministic
- trained model is compared against heuristic same-tier and adjacent fair tiers before any gameplay promotion

Tracked fair runtime models now require a second, stricter gate after that correctness pass. `scripts/strict-ladder-gate.mjs` benchmarks only adjacent fair pairs (`mid>noob`, `top>mid`, `pro>top`, `goat>pro`) at full-match `6040` ticks with `5` fixed seed batches of `100` rounds per pair. The current strict config lives in `src/ai/strictFairGateConfig.js` and requires:

- pair mean resolved win rate floors of `0.72`, `0.67`, `0.52`, and `0.52`
- mean resolved fraction >= `0.75` for every adjacent pair
- win-rate stddev <= `0.08` for every adjacent pair
- no adjacent pair win-rate regression vs checked-in fair baseline below `-0.05`
- no adjacent pair resolved-rate regression vs checked-in fair baseline below `-0.05`

These thresholds were seeded from the current checked-in fair manifest and the May 8, 2026 daily candidate artifact from run `25516896901`. They are intentionally strict enough that current fair ladder promotion remains blocked until the ladder is retuned.

Playable God uses `scripts/compare-god-models.mjs`. Bootstrap accepts a valid deterministic same-tier God model. After bootstrap, the candidate God model must avoid regression versus Goat and score at least `0.5` resolved win rate against the prior God model.

## Daily Training Automation

`.github/workflows/daily-ladder-training.yml` runs at `17:37 UTC` daily and supports manual `workflow_dispatch`.

Daily training uses the full-match signal preset:

```bash
LADDER_TIERS=noob,mid,top,pro,goat
LADDER_SHARDS=4
LADDER_EPISODES=150
LADDER_MAX_TICKS=6040
LADDER_ITERATIONS=3
LADDER_EPOCHS=8
LADDER_BATCH_SIZE=64
LADDER_MAX_NEGATIVES=8
LADDER_EVAL_ROUNDS=50
LADDER_EVAL_MAX_TICKS=6040
LADDER_BENCH_ROUNDS=25
LADDER_BENCH_MAX_TICKS=6040
```

The same workflow also trains a capped God lane:

```bash
LADDER_TIERS=god
LADDER_SHARDS=1
LADDER_EPISODES=50
LADDER_MAX_TICKS=6040
LADDER_ITERATIONS=2
LADDER_EPOCHS=6
LADDER_BENCH_ROUNDS=25
LADDER_BENCH_MAX_TICKS=6040
```

`6040` ticks covers one full match: 180 seconds of regulation, 120 seconds of overtime, and a 40-tick buffer at 20 ticks per second. The reduced `150` episodes per shard keeps the daily workflow under the current `350` minute workflow timeout while avoiding the all-draw benchmark signal produced by short `900` tick runs.

After training, `scripts/compare-ladder-models.mjs` benchmarks the candidate manifest against the checked-in manifest with the same seeds and full-match `6040` tick cap. The daily improvement gate passes only when:

- the candidate benchmark matrix is deterministic
- every requested fair tier has a valid same-tier candidate model
- average win-rate delta is at least `+0.02` after bootstrap
- no adjacent tier pair regresses by more than `0.05`

The daily workflow now uses that lighter fair comparison only as candidate refresh signal. It uploads the full run artifact, writes the fair candidate manifest, and records a strict-gate handoff in the workflow summary. Daily automation still auto-promotes God when the God gate passes by calling `scripts/promote-ladder-models.mjs --promote-god`, preserving unchanged fair entries.

Strict fair promotion happens in `.github/workflows/strict-fair-ladder-promotion.yml`. That manual workflow takes a daily source run id, downloads `ladder-training-<run_id>`, runs `scripts/strict-ladder-gate.mjs`, and only on strict pass copies fair tracked models into `artifacts/training/promoted/`, preserves unchanged manifest entries, writes `artifacts/training/ladder-models.json`, and pushes `training/daily-ladder-models` for review. If repository settings block Action-created PRs, the workflow leaves the branch pushed and emits a warning instead of failing. Configure `LADDER_MODEL_PR_TOKEN` with pull-request permissions when automatic PR creation is required without changing repository workflow permissions.

The first accepted run can bootstrap from a heuristic baseline if no checked-in models exist. This daily improvement gate is not the strict promotion gate in `docs/BOT_LEVELS.md`; it is a safe automatic refresh gate for candidate model artifacts.

## Local Self Bot Training

Player matches append local public-observation decision samples whenever the player plays a card. Each sample records the legal action candidates, chosen action index, state feature vector, action feature vectors, phase, elixir, hand, tick, and opponent tier context.

`Train Self Bot` fits a deterministic one-layer `legal_action_mlp` from those samples. It then runs a small reward-weighted RL v1 fine-tune from deterministic self rollouts against Top and the highest unlocked fair tier. The RL candidate is accepted only if held-out imitation top-1 accuracy stays within `0.05` of the imitation baseline and benchmark win rate does not regress. Retraining is batched: samples are always collected, but an existing ready self model is not retrained until enough new legal decision samples have accumulated.
