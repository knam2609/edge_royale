#!/usr/bin/env bash
set -euo pipefail

# Override these env vars when you want a different run size or output location.
# The script always exports shards, trains from the shard directory, then benchmarks the saved model.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GOAT_RUN_NAME="${GOAT_RUN_NAME:-goat-$(date +%Y%m%d-%H%M%S)}"
GOAT_OUTPUT_ROOT="${GOAT_OUTPUT_ROOT:-artifacts/training/runs/${GOAT_RUN_NAME}}"
GOAT_DATASET_DIR="${GOAT_DATASET_DIR:-${GOAT_OUTPUT_ROOT}/datasets}"
GOAT_MODEL_PATH="${GOAT_MODEL_PATH:-${GOAT_OUTPUT_ROOT}/model/goat-model.json}"
GOAT_SUMMARY_PATH="${GOAT_SUMMARY_PATH:-${GOAT_OUTPUT_ROOT}/model/goat-training-summary.json}"

GOAT_SHARDS="${GOAT_SHARDS:-2}"
GOAT_BASE_SEED="${GOAT_BASE_SEED:-303}"
GOAT_SEED_STEP="${GOAT_SEED_STEP:-1}"
GOAT_EPISODES="${GOAT_EPISODES:-8}"
GOAT_MAX_TICKS="${GOAT_MAX_TICKS:-900}"
GOAT_TIERS="${GOAT_TIERS:-top,goat}"

GOAT_TRAIN_SEED="${GOAT_TRAIN_SEED:-505}"
GOAT_ITERATIONS="${GOAT_ITERATIONS:-1}"
GOAT_EPOCHS="${GOAT_EPOCHS:-4}"
GOAT_BATCH_SIZE="${GOAT_BATCH_SIZE:-32}"
GOAT_LEARNING_RATE="${GOAT_LEARNING_RATE:-0.01}"
GOAT_MAX_NEGATIVES="${GOAT_MAX_NEGATIVES:-4}"
GOAT_EVAL_TIERS="${GOAT_EVAL_TIERS:-noob,mid,top}"
GOAT_EVAL_ROUNDS="${GOAT_EVAL_ROUNDS:-4}"
GOAT_EVAL_MAX_TICKS="${GOAT_EVAL_MAX_TICKS:-400}"

GOAT_BENCH_TIERS="${GOAT_BENCH_TIERS:-noob,mid,top,goat}"
GOAT_BENCH_ROUNDS="${GOAT_BENCH_ROUNDS:-10}"
GOAT_BENCH_SEED="${GOAT_BENCH_SEED:-404}"
GOAT_BENCH_MAX_TICKS="${GOAT_BENCH_MAX_TICKS:-}"

if ! [[ "$GOAT_SHARDS" =~ ^[0-9]+$ ]] || [[ "$GOAT_SHARDS" -lt 1 ]]; then
  echo "GOAT_SHARDS must be a positive integer" >&2
  exit 1
fi

mkdir -p "$GOAT_DATASET_DIR" "$(dirname "$GOAT_MODEL_PATH")" "$(dirname "$GOAT_SUMMARY_PATH")"

echo "repo_root=$REPO_ROOT"
echo "output_root=$GOAT_OUTPUT_ROOT"
echo "dataset_dir=$GOAT_DATASET_DIR"
echo "model_path=$GOAT_MODEL_PATH"
echo "summary_path=$GOAT_SUMMARY_PATH"

for ((shard_index = 1; shard_index <= GOAT_SHARDS; shard_index += 1)); do
  shard_seed=$((GOAT_BASE_SEED + (shard_index - 1) * GOAT_SEED_STEP))
  shard_path=$(printf "%s/shard-%03d.json" "$GOAT_DATASET_DIR" "$shard_index")

  echo
  echo "==> exporting shard ${shard_index}/${GOAT_SHARDS} seed=${shard_seed}"
  npm run data:export -- \
    --seed "$shard_seed" \
    --episodes "$GOAT_EPISODES" \
    --max-ticks "$GOAT_MAX_TICKS" \
    --tiers "$GOAT_TIERS" \
    --out "$shard_path"
done

echo
echo "==> training model from $GOAT_DATASET_DIR"
npm run train:goat -- \
  --seed "$GOAT_TRAIN_SEED" \
  --dataset-dir "$GOAT_DATASET_DIR" \
  --iterations "$GOAT_ITERATIONS" \
  --epochs "$GOAT_EPOCHS" \
  --batch-size "$GOAT_BATCH_SIZE" \
  --learning-rate "$GOAT_LEARNING_RATE" \
  --max-negatives "$GOAT_MAX_NEGATIVES" \
  --eval-tiers "$GOAT_EVAL_TIERS" \
  --eval-rounds "$GOAT_EVAL_ROUNDS" \
  --eval-max-ticks "$GOAT_EVAL_MAX_TICKS" \
  --out "$GOAT_MODEL_PATH" \
  --summary-out "$GOAT_SUMMARY_PATH"

bench_cmd=(
  npm run model:bench -- --model "$GOAT_MODEL_PATH" --tiers "$GOAT_BENCH_TIERS" --rounds "$GOAT_BENCH_ROUNDS" --seed "$GOAT_BENCH_SEED"
)
if [[ -n "$GOAT_BENCH_MAX_TICKS" ]]; then
  bench_cmd+=(--max-ticks "$GOAT_BENCH_MAX_TICKS")
fi

echo
echo "==> benchmarking saved model"
"${bench_cmd[@]}"

echo
echo "done"
echo "artifacts_root=$GOAT_OUTPUT_ROOT"
