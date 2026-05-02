#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LADDER_RUN_NAME="${LADDER_RUN_NAME:-ladder-$(date +%Y%m%d-%H%M%S)}"
LADDER_OUTPUT_ROOT="${LADDER_OUTPUT_ROOT:-artifacts/training/runs/${LADDER_RUN_NAME}}"
LADDER_TIERS="${LADDER_TIERS:-noob,mid,top,pro,goat}"
LADDER_MODEL_MANIFEST_PATH="${LADDER_MODEL_MANIFEST_PATH:-artifacts/training/ladder-models.json}"

LADDER_SHARDS="${LADDER_SHARDS:-2}"
LADDER_BASE_SEED="${LADDER_BASE_SEED:-303}"
LADDER_SEED_STEP="${LADDER_SEED_STEP:-1}"
LADDER_EPISODES="${LADDER_EPISODES:-8}"
LADDER_MAX_TICKS="${LADDER_MAX_TICKS:-900}"

LADDER_TRAIN_SEED_BASE="${LADDER_TRAIN_SEED_BASE:-505}"
LADDER_TRAIN_SEED_STEP="${LADDER_TRAIN_SEED_STEP:-101}"
LADDER_ITERATIONS="${LADDER_ITERATIONS:-1}"
LADDER_EPOCHS="${LADDER_EPOCHS:-4}"
LADDER_BATCH_SIZE="${LADDER_BATCH_SIZE:-32}"
LADDER_LEARNING_RATE="${LADDER_LEARNING_RATE:-0.01}"
LADDER_MAX_NEGATIVES="${LADDER_MAX_NEGATIVES:-4}"
LADDER_EVAL_ROUNDS="${LADDER_EVAL_ROUNDS:-4}"
LADDER_EVAL_MAX_TICKS="${LADDER_EVAL_MAX_TICKS:-400}"

LADDER_BENCH_TIERS="${LADDER_BENCH_TIERS:-noob,mid,top,pro,goat}"
LADDER_BENCH_ROUNDS="${LADDER_BENCH_ROUNDS:-10}"
LADDER_BENCH_SEED_BASE="${LADDER_BENCH_SEED_BASE:-404}"
LADDER_BENCH_SEED_STEP="${LADDER_BENCH_SEED_STEP:-101}"
LADDER_BENCH_MAX_TICKS="${LADDER_BENCH_MAX_TICKS:-}"

if ! [[ "$LADDER_SHARDS" =~ ^[0-9]+$ ]] || [[ "$LADDER_SHARDS" -lt 1 ]]; then
  echo "LADDER_SHARDS must be a positive integer" >&2
  exit 1
fi

default_eval_tiers() {
  case "$1" in
    noob) echo "noob,mid" ;;
    mid) echo "noob,mid,top" ;;
    top) echo "mid,top,pro" ;;
    pro) echo "top,pro,goat" ;;
    *) echo "noob,mid,top" ;;
  esac
}

episodes_for_tier() {
  local tier="$1"
  local base="$LADDER_EPISODES"
  if [[ "$tier" == "noob" && "$base" -lt 4 ]]; then
    echo "4"
    return
  fi
  echo "$base"
}

IFS=',' read -r -a TRAIN_TIERS <<< "$LADDER_TIERS"
TRAINED_TIERS=()
TRAINED_MODEL_PATHS=()

mkdir -p "$LADDER_OUTPUT_ROOT"

echo "repo_root=$REPO_ROOT"
echo "output_root=$LADDER_OUTPUT_ROOT"
echo "tiers=$LADDER_TIERS"

for tier_index in "${!TRAIN_TIERS[@]}"; do
  tier="$(echo "${TRAIN_TIERS[$tier_index]}" | xargs)"
  if [[ -z "$tier" ]]; then
    continue
  fi

  dataset_dir="${LADDER_OUTPUT_ROOT}/datasets/${tier}"
  model_path="${LADDER_OUTPUT_ROOT}/models/${tier}-model.json"
  summary_path="${LADDER_OUTPUT_ROOT}/models/${tier}-training-summary.json"
  mkdir -p "$dataset_dir" "$(dirname "$model_path")"
  tier_episodes="$(episodes_for_tier "$tier")"

  echo
  echo "==> tier=${tier} exporting shards episodes=${tier_episodes}"
  for ((shard_index = 1; shard_index <= LADDER_SHARDS; shard_index += 1)); do
    shard_seed=$((LADDER_BASE_SEED + tier_index * 1000 + (shard_index - 1) * LADDER_SEED_STEP))
    shard_path=$(printf "%s/shard-%03d.json" "$dataset_dir" "$shard_index")
    echo "  shard ${shard_index}/${LADDER_SHARDS} seed=${shard_seed}"
    npm run data:export -- \
      --seed "$shard_seed" \
      --episodes "$tier_episodes" \
      --max-ticks "$LADDER_MAX_TICKS" \
      --tiers "$tier" \
      --out "$shard_path"
  done

  train_seed=$((LADDER_TRAIN_SEED_BASE + tier_index * LADDER_TRAIN_SEED_STEP))
  eval_tiers="$(default_eval_tiers "$tier")"

  echo
  echo "==> tier=${tier} training model"
  npm run train:bot -- \
    --target-tier "$tier" \
    --seed "$train_seed" \
    --dataset-dir "$dataset_dir" \
    --iterations "$LADDER_ITERATIONS" \
    --epochs "$LADDER_EPOCHS" \
    --batch-size "$LADDER_BATCH_SIZE" \
    --learning-rate "$LADDER_LEARNING_RATE" \
    --max-negatives "$LADDER_MAX_NEGATIVES" \
    --eval-tiers "$eval_tiers" \
    --eval-rounds "$LADDER_EVAL_ROUNDS" \
    --eval-max-ticks "$LADDER_EVAL_MAX_TICKS" \
    --out "$model_path" \
    --summary-out "$summary_path"

  bench_seed=$((LADDER_BENCH_SEED_BASE + tier_index * LADDER_BENCH_SEED_STEP))
  bench_cmd=(
    npm run model:bench -- --model "$model_path" --target-tier "$tier" --tiers "$LADDER_BENCH_TIERS" --rounds "$LADDER_BENCH_ROUNDS" --seed "$bench_seed"
  )
  if [[ -n "$LADDER_BENCH_MAX_TICKS" ]]; then
    bench_cmd+=(--max-ticks "$LADDER_BENCH_MAX_TICKS")
  fi

  echo
  echo "==> tier=${tier} benchmarking saved model"
  "${bench_cmd[@]}"

  TRAINED_TIERS+=("$tier")
  TRAINED_MODEL_PATHS+=("$model_path")
done

manifest_cmd=(node scripts/write-ladder-model-manifest.mjs --out "$LADDER_MODEL_MANIFEST_PATH")
for tier_index in "${!TRAINED_TIERS[@]}"; do
  manifest_cmd+=(--tier "${TRAINED_TIERS[$tier_index]}" "${TRAINED_MODEL_PATHS[$tier_index]}")
done

echo
echo "==> writing ladder model manifest"
"${manifest_cmd[@]}"

echo
echo "done"
echo "artifacts_root=$LADDER_OUTPUT_ROOT"
echo "ladder_model_manifest=$LADDER_MODEL_MANIFEST_PATH"
