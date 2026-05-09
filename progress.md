# Progress

## Current State

- As of May 10, 2026, local `main` is at `dfd0b221becb96e722c504ca6c53ed0930796f2d` with uncommitted strict fair curriculum prep: `scripts/train-bot-ladder.sh` now exports built-in mixed-opponent fair datasets, `scripts/train-bot.mjs` and `src/ai/neuralTraining.js` now filter mixed dataset rows to the requested `target_tier`, and docs/tests were updated to match.
- Fair tracked runtime promotion still uses a separate strict lane: `npm run train:ladder:strict -- ...` and `.github/workflows/strict-fair-ladder-promotion.yml`. Daily training still trains fair candidates and uploads artifacts, but only God may auto-promote from `.github/workflows/daily-ladder-training.yml`.
- `src/ai/strictFairGateConfig.js` remains unchanged from the May 9, 2026 calibration seed: `mid>noob 0.72`, `top>mid 0.67`, `pro>top 0.52`, `goat>pro 0.52`, mean resolved fraction `0.75`, win-rate stddev cap `0.08`, and per-pair regression caps `0.05`.

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

- Fair ladder export now uses built-in curricula instead of same-tier-only self-play: `noob -> noob vs mid`, `mid -> mid vs noob/top`, `top -> top vs mid/pro`, `pro -> pro vs top/goat`, `goat -> goat vs mid/top/pro`; `god` remains single-tier.
- `train:bot` now supports mixed-tier dataset dirs without cross-tier imitation leakage because action rows are filtered to `training_config.target_tier` before row counting and buffer fill; default goat eval opponents are now `mid,top,pro,goat`.
- Tests now cover mixed-tier row filtering, curriculum episode splits (including tiny clamped smoke presets), goat eval defaults, multi-dir target-tier training, strict gate behavior, and workflow split behavior.
- `scripts/strict-ladder-gate.mjs` emits machine-readable strict fair summaries with `thresholds`, `batches`, `pairs`, `baseline_deltas`, and `gate` results, and it also exposes calibration mode for threshold recommendation output.
- `scripts/promote-ladder-models.mjs` now supports fair-only or God-only promotion scopes while preserving untouched manifest entries, so strict fair promotion can update tracked fair models without clobbering an existing God entry.
- Daily training still runs tests, trains fair and God candidates, uploads the full run artifact, compares fair and God candidates, and auto-promotes God only. The workflow step summary now records the fair candidate handoff for the strict manual lane.
- `.github/workflows/strict-fair-ladder-promotion.yml` can download `ladder-training-<run_id>`, run the strict fair gate, and push `training/daily-ladder-models` only when the stricter fair gate passes.

## Known Gaps

- No new full-match `daily-ladder-training` artifact has been reviewed after the curriculum change, so fair tracked runtime promotion is still blocked until the next daily or manual workflow run shows whether adjacent fair pairs improved.
- Checked-in fair promoted models still come from legacy short-cap run `25276131849`, so their `training_config.max_ticks: 900` remains provenance until a newer full-match `6040` fair promotion passes the strict gate.
- The full `5x100` adjacent-pair calibration command still was not rerun after the curriculum change; strict thresholds remain seeded from the checked-in fair manifest and run `25516896901` artifact data rather than a fresh completed local calibration sweep.
- Browser self RL is intentionally lightweight reward-weighted fine-tuning, not a full policy-gradient system.
- Telemetry/export pipeline work from the roadmap is still incomplete beyond the current deterministic training export hooks.

## Next Tasks

1. Review the next `daily-ladder-training` artifact, or manually dispatch the workflow, to measure whether the mixed-opponent curriculum fixes the adjacent fair regressions from run `25516896901`.
2. Run `npm run train:ladder:strict -- --candidate-manifest <latest artifact> --seed-base 1909 --batches 5 --rounds 100 --max-ticks 6040` against the next fair candidate and record which adjacent pairs still fail, if any.
3. Replace legacy short-cap fair promoted models only after a new full-match `6040` fair promotion passes the strict gate.
4. Continue telemetry/export pipeline work from `docs/IMPLEMENTATION_PLAN.md` and `docs/TRAINING_PIPELINE.md` so match data can support future self-play training beyond current local samples.
5. Extend the browser smoke beyond seeded self-training flows if future client changes need layout, mobile, or ladder-manifest coverage.

## Validation

- May 10, 2026: `bash -n scripts/train-bot-ladder.sh` -> passed.
- May 10, 2026: `node --test tests/training-data.test.js tests/train-bot-lib.test.js tests/daily-training.test.js tests/strict-ladder-gate.test.js` -> 30 tests passed.
- May 10, 2026: `npm test` -> 139 tests passed.
- May 10, 2026: not run locally by design: `bash scripts/train-bot-ladder.sh` and `npm run train:ladder:strict -- ...` full-match validation still waits for the next daily workflow artifact or an explicit manual run because of runtime cost.

## Risks / Notes

- First full-match signal for the curriculum change is still pending; code-level validation passed, but ladder-strength impact is not yet measured against a new daily artifact.
- The strict manual workflow depends on the daily artifact `ladder-training-<run_id>` remaining available long enough for review/promotion follow-up.
- The new strict thresholds are intentionally higher than current fair ladder quality, so daily PR activity may continue to carry God-only updates until fair ladder tuning lands.
- Raw training artifacts remain ignored under `artifacts/training/runs/`.
- GitHub Actions still uses Node.js 20-based actions that GitHub has already scheduled for deprecation/removal.
