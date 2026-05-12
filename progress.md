## Current State

- As of May 12, 2026, local code supports pass-aware neural action schema `goat_action_features_v2` end to end: runtime scoring appends a deterministic synthetic `PASS`, training/export keeps `PASS` samples, readers still accept legacy v1 card-only artifacts, and mismatched or invalid models still fall back to heuristics.
- GitHub strict fair run `25668355760` on commit `de60f9c` is the current remote source of truth. It loaded real candidate tiers and failed all adjacent fair pairs, so the old `candidate_model_tiers=none` workflow-path blocker is resolved and obsolete.
- Lower-tier retrain run `pass-aware-lower-ladder-20260512` produced local candidate models for `noob`, `mid`, and `top` at `artifacts/training/runs/pass-aware-lower-ladder-20260512/models/*.json`; those artifacts report `action_schema_version=goat_action_features_v2`. `pro`, `goat`, and `god` remain frozen.
- Free bench direction improved for `mid>noob`, but reduced strict gate still fails: `mid>noob` candidate mean win rate `0.555555`, mean resolved rate `0.42`; `top>mid` candidate mean win rate `0.565484`.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and next AI slices: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Ladder, God, and self training workflow: `docs/TRAINING_PIPELINE.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- Fair/daily/strict GitHub workflow path contract is fixed on GitHub now; strict run `25668355760` proved candidate tiers load remotely.
- Neural scorer, training, and runtime accept both legacy v1 and new v2 action schemas, so older promoted artifacts still load.
- Bot sample export and self-training normalization preserve `PASS` instead of dropping pass-chosen decisions.
- Lower-tier curriculum weighting now skews `mid-vs-noob` and `top-vs-mid` `2:1` in `scripts/train-bot-lib.mjs`.
- `scripts/train-bot-ladder.sh` now works on macOS bash 3.2 without `mapfile`.
- Automated coverage and browser smoke fixtures are green under the pass-aware slice.
- Local retrain generated readable candidate manifest `artifacts/training/runs/pass-aware-lower-ladder-20260512/candidate-ladder-models.json`.

## Known Gaps

- Reduced strict subset shows the pass-aware lower ladder increased draws heavily on `mid>noob` (`58/100` draws, resolved-rate delta `-0.45` vs baseline).
- `top>mid` remains below the strict floor even after the weighted curriculum (`0.565484` vs required `0.67`).
- No full local preflight strict subset (`--batches 5 --rounds 100 --max-ticks 6040`) has been run for the new candidate set.
- No new GitHub candidate artifact exists yet for this retrain, so the pass-aware lower-tier slice has not been rechecked in remote Actions against daily source run `25636585475`.
- Checked-in promoted fair models still trace to legacy short-cap run `25276131849` with `training_config.max_ticks: 900`.
- Telemetry/export pipeline work from the roadmap remains incomplete beyond current deterministic sample hooks.

## Next Tasks

1. Diagnose why `mid>noob` resolved rate collapsed under pass-aware scoring: inspect pass frequency, timeout-heavy replays, and whether `PASS` needs extra training or runtime discouragement when legal plays exist.
2. Retune `top` specifically against `mid`; current `2:1` weighting improved little under strict thresholds.
3. After the next lower-tier retune, rerun reduced strict subset on `noob,mid,top` with `--batches 2 --rounds 50 --max-ticks 6040`.
4. If reduced strict improves materially, run the full local preflight subset with `--batches 5 --rounds 100 --max-ticks 6040`.
5. Once a new GitHub candidate artifact exists, rerun `.github/workflows/strict-fair-ladder-promotion.yml` against source run `25636585475` and record real adjacent-pair deltas.

## Validation

- May 12, 2026: `npm test` -> passed, `145` tests passed.
- May 12, 2026: `LADDER_RUN_NAME=pass-aware-lower-ladder-20260512 LADDER_OUTPUT_ROOT=artifacts/training/runs/pass-aware-lower-ladder-20260512 LADDER_MODEL_MANIFEST_PATH=artifacts/training/runs/pass-aware-lower-ladder-20260512/candidate-ladder-models.json LADDER_TIERS=noob,mid,top LADDER_SHARDS=4 LADDER_EPISODES=150 LADDER_MAX_TICKS=6040 LADDER_ITERATIONS=3 LADDER_EPOCHS=8 LADDER_BATCH_SIZE=64 LADDER_MAX_NEGATIVES=8 LADDER_DATASET_MAX_NEGATIVES=8 LADDER_EVAL_ROUNDS=50 LADDER_EVAL_MAX_TICKS=6040 LADDER_BENCH_TIERS=noob,mid,top LADDER_BENCH_ROUNDS=25 LADDER_BENCH_MAX_TICKS=6040 bash scripts/train-bot-ladder.sh` -> passed; wrote local candidate manifest and pass-aware `noob`, `mid`, and `top` models under `artifacts/training/runs/pass-aware-lower-ladder-20260512/`.
- May 12, 2026: `npm run bot:bench -- --model-config artifacts/training/runs/pass-aware-lower-ladder-20260512/candidate-ladder-models.json --tiers noob,mid,top --rounds 25 --max-ticks 6040` -> `mid>noob 0.867` (`13-2`, `10` draws), `top>noob 0.667` (`4-2`, `19` draws), `top>mid 0.450` (`9-11`, `5` draws).
- May 12, 2026: `npm run train:ladder:strict -- --baseline-manifest artifacts/training/ladder-models.json --candidate-manifest artifacts/training/runs/pass-aware-lower-ladder-20260512/candidate-ladder-models.json --tiers noob,mid,top --out artifacts/training/runs/pass-aware-lower-ladder-20260512/strict-comparison-summary.reduced.json --seed-base 1909 --batches 2 --rounds 50 --max-ticks 6040` -> completed; gate failed on `mid>noob` and `top>mid`.
- May 11, 2026: GitHub strict fair run `25668355760` on `de60f9c` -> loaded real candidate tiers and failed all adjacent fair pairs; this supersedes older invalid `candidate_model_tiers=none` strict runs.

## Risks / Notes

- Free matrix bench can hide draw explosions; strict resolved-rate metrics now show the pass-aware slice is producing too many unresolved `mid>noob` games.
- Per-iteration training summaries already show draw-heavy or weak evals for the new lower-tier models, so the issue appears in training outputs themselves, not just in the strict comparison harness.
- The local candidate manifest does not carry schema metadata itself; v2 proof lives in the referenced model artifacts.
- Remote validation still depends on getting a fresh candidate artifact into GitHub Actions, not just local files under `artifacts/training/runs/`.
- Raw training artifacts remain ignored under `artifacts/training/runs/`.
