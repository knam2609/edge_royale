# Progress

## Current State

- As of May 8, 2026, local `main` and `origin/main` are at `4770a5ba32d24c83c631c80e214ba8c863e7d307` (`Fix dataset-backed training tick metadata`); this workspace adds uncommitted browser smoke validation files plus README/runtime hook updates.
- PR #5 promoted a checked-in playable God model from scheduled daily run `25516896901`; `artifacts/training/ladder-models.json` includes `god` pointing at `artifacts/training/promoted/models/god-model.json`.
- Daily run `25516896901` succeeded, but only the God bootstrap gate passed. The fair ladder gate failed with average delta `0.037842` and worst adjacent delta `-0.116216`; God vs Goat was `19-25-6` (`0.431818` resolved win rate for God).
- Dataset-backed `train:bot` records true shard `max_ticks` in saved model metadata, carries per-shard `dataset_sources[].max_ticks`, and rejects mixed-cap corpora.
- Self bot local training uses v2 localStorage keys, logs rewarded public-observation legal-action samples, trains a one-layer `legal_action_mlp`, and accepts RL v1 only when held-out imitation and benchmark gates do not regress.

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

- Fair ladder manifests gate `noob` through `goat`, and the same manifest can carry a playable `god` model entry.
- Daily training has a capped God lane, merges fair and God candidate manifests, compares God with `scripts/compare-god-models.mjs`, and promotes whichever gate passes while preserving unchanged manifest entries.
- Dataset-backed `train:bot` artifacts use the actual shard `max_ticks` cap instead of the CLI default, and training summaries mirror per-shard `dataset_sources[].max_ticks`.
- Node training supports `--target-tier god` with hidden God feature size and schema-validated model artifacts.
- Browser self training runs imitation plus reward-weighted rollout fine-tune against Top and the highest unlocked fair tier.
- `npm run smoke:browser` now starts the repo dev server on an ephemeral localhost port, seeds deterministic self-training fixtures, checks v2 localStorage behavior, verifies under-threshold and RL accepted/fallback messaging, and confirms playable Self runtime with a ready model.
- `window.render_game_to_text()` now exposes additive `status_message` and `profile_summary_text` fields for browser automation assertions.
- Tests cover full-grid spell actions, compact stored legal-action samples, streamed hash compatibility, self legal-action samples/model selection, God hidden schema/runtime, manifest God entries, daily God workflow wiring, God bootstrap comparison, mixed fair-failed/God-passed PR body output, truthful dataset-backed tick metadata, mixed-cap shard rejection, and browser smoke fixture determinism.

## Known Gaps

- Daily run `25516896901` completed in `3h31m57s`, leaving less than two hours of margin under the `350` minute timeout.
- Artifact `ladder-training-25516896901` is `729M`: datasets `727M` total (`noob 104M`, `mid 127M`, `top 160M`, `pro 165M`, `goat 159M`, `god 13M`) and models `1.6M`.
- The fair daily gate still fails on adjacent regression despite positive average delta, so fair neural ladder promotion remains blocked.
- The checked-in God model is a bootstrap artifact, not a proven Goat-beating boss. Run `25516896901` accepted it because there was no prior checked-in God model.
- Checked-in fair promoted models still come from legacy short-cap run `25276131849`, so their `training_config.max_ticks: 900` remains provenance until a newer full-match fair promotion replaces them.
- Ladder ordering is still noisy at low rounds and is not stable enough for strict promotion.
- Browser self RL is intentionally lightweight reward-weighted fine-tuning, not a full policy-gradient system.
- Telemetry/export pipeline work from the roadmap is still incomplete beyond the current deterministic training export hooks.

## Next Tasks

1. Stabilize ladder ordering enough to support a stricter promotion gate, then update `docs/BOT_LEVELS.md` and training gate docs with the real threshold.
2. Replace legacy short-cap fair promoted models only after a new full-match `6040` fair promotion passes the gate.
3. Continue telemetry/export pipeline work from `docs/IMPLEMENTATION_PLAN.md` and `docs/TRAINING_PIPELINE.md` so match data can support future self-play training beyond current local samples.
4. Extend the new browser smoke beyond seeded self-training flows if future client changes need layout, mobile, or ladder-manifest coverage.

## Validation

- May 8, 2026: `node --test tests/browser-smoke-fixtures.test.js` -> 4 tests passed.
- May 8, 2026: `npm test` -> 127 tests passed.
- May 8, 2026: `npm run smoke:browser` -> first sandboxed run failed with `listen EPERM: operation not permitted 127.0.0.1`; escalated rerun passed `under-threshold self-training`, `RL accepted path`, `RL fallback path`, and `self runtime model path`.
- May 8, 2026: `gh run view 25516896901 --json status,conclusion,event,workflowName,headSha,createdAt,updatedAt,url,jobs` -> success; scheduled `main` daily run for commit `87eb357317e4024ecf0bf78a5d04839a296ab6d5`; `Train ladder models` completed in `3h31m57s`.
- May 8, 2026: `gh run download 25516896901 -n ladder-training-25516896901 -D /private/tmp/edge_royale_ladder_25516896901` plus `du -h -d 3 /private/tmp/edge_royale_ladder_25516896901` -> artifact `729M`; `comparison-summary.json` fair gate failed; `god-comparison-summary.json` God bootstrap gate passed.

## Risks / Notes

- Raw training artifacts remain ignored under `artifacts/training/runs/`; local `ci-size-smoke` output is intentionally ignored.
- Daily workflow timeout is still `350` minutes; current successful runs are around `3h32m`.
- GitHub Actions flagged Node.js 20 action deprecation for `actions/checkout@v4`, `actions/setup-node@v4`, and `actions/upload-artifact@v4`; Node.js 24 becomes default on June 2, 2026, and Node.js 20 is removed from runners on September 16, 2026.
- `npm run smoke:browser` is registry-independent once dependencies and Playwright Chromium are installed locally, but sandboxed agent environments still need escalated localhost bind permission for the dev server.
