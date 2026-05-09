# Progress

## Current State

- As of May 9, 2026, local `main` is still at `4770a5ba32d24c83c631c80e214ba8c863e7d307` (`Fix dataset-backed training tick metadata`) with uncommitted strict fair ladder gate, workflow split, test, and docs updates.
- Fair tracked runtime promotion now has a separate strict lane: `npm run train:ladder:strict -- ...` and `.github/workflows/strict-fair-ladder-promotion.yml`. Daily training still trains fair candidates and uploads artifacts, but only God may auto-promote from `.github/workflows/daily-ladder-training.yml`.
- `src/ai/strictFairGateConfig.js` currently seeds strict adjacent fair thresholds from the checked-in fair manifest plus the May 8, 2026 candidate artifact from run `25516896901`: `mid>noob 0.72`, `top>mid 0.67`, `pro>top 0.52`, `goat>pro 0.52`, mean resolved fraction `0.75`, win-rate stddev cap `0.08`, and per-pair regression caps `0.05`.

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

- `scripts/strict-ladder-gate.mjs` emits machine-readable strict fair summaries with `thresholds`, `batches`, `pairs`, `baseline_deltas`, and `gate` results, and it also exposes calibration mode for threshold recommendation output.
- `scripts/promote-ladder-models.mjs` now supports fair-only or God-only promotion scopes while preserving untouched manifest entries, so strict fair promotion can update tracked fair models without clobbering an existing God entry.
- Daily training still runs tests, trains fair and God candidates, uploads the full run artifact, compares fair and God candidates, and auto-promotes God only. The workflow step summary now records the fair candidate handoff for the strict manual lane.
- `.github/workflows/strict-fair-ladder-promotion.yml` can download `ladder-training-<run_id>`, run the strict fair gate, and push `training/daily-ladder-models` only when the stricter fair gate passes.
- Tests now cover strict gate pass/fail cases, resolved-rate floor failures, baseline-regression failures, deterministic strict output, calibration output shape, workflow split, and fair-only promotion preservation.

## Known Gaps

- Current checked-in fair promoted models and the May 8, 2026 candidate artifact still do not satisfy the strict fair thresholds, so fair tracked runtime promotion remains blocked pending ladder tuning.
- Checked-in fair promoted models still come from legacy short-cap run `25276131849`, so their `training_config.max_ticks: 900` remains provenance until a newer full-match `6040` fair promotion passes the strict gate.
- The full `5x100` adjacent-pair calibration command is expensive enough that it was not completed in this session; current strict thresholds are seeded from the checked-in fair manifest and run `25516896901` artifact data rather than a fresh completed local calibration sweep.
- Browser self RL is intentionally lightweight reward-weighted fine-tuning, not a full policy-gradient system.
- Telemetry/export pipeline work from the roadmap is still incomplete beyond the current deterministic training export hooks.

## Next Tasks

1. Tune fair ladder heuristics and/or training so `pro>top` and `goat>pro` clear the strict gate, then rerun `npm run train:ladder:strict -- --candidate-manifest <latest artifact> --seed-base 1909 --batches 5 --rounds 100 --max-ticks 6040`.
2. Replace legacy short-cap fair promoted models only after a new full-match `6040` fair promotion passes the strict gate.
3. Continue telemetry/export pipeline work from `docs/IMPLEMENTATION_PLAN.md` and `docs/TRAINING_PIPELINE.md` so match data can support future self-play training beyond current local samples.
4. Extend the new browser smoke beyond seeded self-training flows if future client changes need layout, mobile, or ladder-manifest coverage.

## Validation

- May 9, 2026: `node --test tests/strict-ladder-gate.test.js tests/daily-training.test.js` -> 16 tests passed.
- May 9, 2026: `npm run train:ladder:strict -- --candidate-manifest artifacts/training/runs/daily-smoke/candidate-ladder-models.json --tiers noob,mid --batches 1 --rounds 1 --max-ticks 60` -> CLI smoke passed plumbing and failed gate as expected with `mid>noob` below strict win-rate and resolved-rate floors.
- May 9, 2026: `npm test` -> 135 tests passed.
- May 9, 2026: `node scripts/strict-ladder-gate.mjs --calibrate --baseline-manifest artifacts/training/ladder-models.json --candidate-manifest /private/tmp/edge_royale_ladder_25516896901/candidate-ladder-models.json --calibration-manifest artifacts/training/ladder-models.json --calibration-manifest /private/tmp/edge_royale_ladder_25516896901/candidate-ladder-models.json --batches 5 --rounds 100 --max-ticks 6040 --out /private/tmp/edge_royale_strict_calibration_20260509.json` -> started, but not completed during this session because of runtime cost.

## Risks / Notes

- The strict manual workflow depends on the daily artifact `ladder-training-<run_id>` remaining available long enough for review/promotion follow-up.
- The new strict thresholds are intentionally higher than current fair ladder quality, so daily PR activity may continue to carry God-only updates until fair ladder tuning lands.
- Raw training artifacts remain ignored under `artifacts/training/runs/`.
- GitHub Actions still uses Node.js 20-based actions that GitHub has already scheduled for deprecation/removal.
