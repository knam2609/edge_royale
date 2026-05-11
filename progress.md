# Progress

## Current State

- As of May 11, 2026, strict fair promotion path contract is fixed locally: `.github/workflows/strict-fair-ladder-promotion.yml` now downloads the daily artifact into `artifacts/training/runs/daily-<source_run_id>`, matching embedded candidate manifest model paths.
- GitHub has not used that fix yet. Manual strict workflow rerun `25664511411` still executed the old checked-in workflow with `RUN_ROOT=artifacts/training/runs/strict-25636585475`, so it again reported `candidate_model_tiers=none`.
- The May 11, 2026 strict workflow runs `25659568238` and `25664511411` are both invalid as ladder-strength evidence. Both used the old `strict-<run_id>` extraction path mismatch, not real fair candidate loading.
- Local strict smoke replay against daily run `25636585475` does load real fair candidate models from the downloaded artifact: `candidate_model_tiers=noob,mid,top,pro,goat`.
- Fair tracked runtime promotion remains blocked. Latest reviewed daily fair signal is still run `25636585475`, which failed the lighter daily gate at `average_delta=-0.020634` and `worst_adjacent_delta=-0.16093`.
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

- Fair ladder export still uses built-in mixed-opponent curricula, target-tier row filtering, strict gate summaries, and fair-only/God-only promotion scopes from the May 10, 2026 training pipeline slice.
- Local repo workflow contract is aligned with the daily artifact layout, so downloaded candidate manifests can resolve same-tier fair model files without manifest rewriting once this change reaches GitHub.
- Regression coverage now guards the strict workflow split and asserts the strict lane uses `artifacts/training/runs/daily-${{ github.event.inputs.source_run_id }}` instead of the broken `strict-*` path family.
- Local strict smoke replay on the downloaded May 10, 2026 daily artifact proves the fixed path contract loads fair candidate tiers instead of falling back to heuristics.

## Known Gaps

- No new full-match strict GitHub rerun has completed with the fixed workflow file on GitHub; real full-match adjacent-pair strict results for run `25636585475` still need confirmation from Actions after the local patch is pushed.
- Checked-in fair promoted models still come from legacy short-cap run `25276131849`, so their `training_config.max_ticks: 900` remains provenance until a newer full-match `6040` fair promotion passes the strict gate.
- Latest daily fair candidate evidence still shows regression under the lighter gate: run `25636585475` reported `average_delta=-0.020634` and `worst_adjacent_delta=-0.16093`.
- Browser self RL is intentionally lightweight reward-weighted fine-tuning, not a full policy-gradient system.
- Telemetry/export pipeline work from the roadmap is still incomplete beyond the current deterministic training export hooks.

## Next Tasks

1. Get the local strict workflow path fix onto GitHub, then re-dispatch `.github/workflows/strict-fair-ladder-promotion.yml` for source run `25636585475` and confirm the strict gate reports `candidate_model_tiers=noob,mid,top,pro,goat` instead of `none`.
2. Record the real full-match strict pair failures from the first rerun that uses the fixed workflow file, then use those pair-level results to choose the next ladder-tuning slice.
3. Replace legacy short-cap fair promoted models only after a new full-match `6040` fair promotion passes the strict gate.
4. Continue telemetry/export pipeline work from `docs/IMPLEMENTATION_PLAN.md` and `docs/TRAINING_PIPELINE.md` so match data can support future self-play training beyond current local samples.
5. Extend the browser smoke beyond seeded self-training flows if future client changes need layout, mobile, or ladder-manifest coverage.

## Validation

- May 11, 2026: `node --test tests/strict-ladder-gate.test.js tests/daily-training.test.js` -> 16 tests passed.
- May 11, 2026: `npm test` -> 139 tests passed.
- May 11, 2026: `gh run download 25636585475 --name ladder-training-25636585475 --dir artifacts/training/runs/daily-25636585475` -> passed.
- May 11, 2026: `node scripts/strict-ladder-gate.mjs --baseline-manifest artifacts/training/ladder-models.json --candidate-manifest artifacts/training/runs/daily-25636585475/candidate-ladder-models.json --out artifacts/training/runs/daily-25636585475/strict-comparison-summary.local-smoke.json --seed-base 1909 --batches 1 --rounds 1 --max-ticks 40` -> passed; reported `candidate_model_tiers=noob,mid,top,pro,goat`.
- May 11, 2026: GitHub strict workflow run `25664511411` -> completed, but still used `RUN_ROOT=artifacts/training/runs/strict-25636585475`; reported `candidate_model_tiers=none`, so it did not validate the local path fix.

## Risks / Notes

- Local smoke replay proved path wiring only. It does not replace the full-match `5x100x6040` strict gate result.
- GitHub rerun `25664511411` used the old remote workflow file, so remote/local workflow truth is currently diverged until the patch is pushed.
- Artifact retention still matters: both local replay and strict rerun depend on `ladder-training-25636585475` remaining downloadable.
- The new strict thresholds are intentionally higher than current fair ladder quality, so even after the path fix reaches GitHub the rerun is expected to fail on real ladder strength unless tuning improved elsewhere.
- Raw training artifacts remain ignored under `artifacts/training/runs/`.
- GitHub Actions still uses Node.js 20-based actions that GitHub has already scheduled for deprecation/removal.
