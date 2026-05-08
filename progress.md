# Progress

## Current State

- As of May 8, 2026, local `main` and `origin/main` are at `4af6bf8255f66d49a27f35fef83c520fd488cfec`, the merge commit for PR #5 (`training/daily-ladder-models`).
- PR #5 promoted a checked-in playable God model from scheduled daily run `25516896901`; `artifacts/training/ladder-models.json` now includes `god` pointing at `artifacts/training/promoted/models/god-model.json`.
- Daily run `25516896901` succeeded, but only the God bootstrap gate passed. The fair ladder gate failed with average delta `0.037842` and worst adjacent delta `-0.116216`; God vs Goat was `19-25-6` (`0.431818` resolved win rate for God).
- Current local work updates `scripts/promote-ladder-models.mjs`, `tests/daily-training.test.js`, and `progress.md` to make future daily PR bodies report fair and God gates separately.
- Legal action enumeration uses `full_snapped_grid_v1`: troops enumerate legal deploy cells and spells enumerate every snapped arena cell.
- Offline `data:export` now stores the chosen action plus a bounded deterministic prefix of non-chosen legal candidates per sample, preserving `legal_action_count` for the full action-space size.
- `hashState` now streams canonical stable JSON tokens into FNV hashing instead of materializing one giant string.
- Playable God can load a same-tier `legal_action_mlp` from `artifacts/training/ladder-models.json`; God model features use `god_state_features_v1` with opponent exact elixir, hand, and deck queue.
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

- Fair ladder manifests gate `noob` through `goat`, while the same manifest can also carry a playable `god` model entry.
- Daily training has a capped God lane, merges fair and God candidate manifests, compares God with `scripts/compare-god-models.mjs`, and promotes whichever gate passes while preserving unchanged manifest entries.
- Daily workflow passes `LADDER_DATASET_MAX_NEGATIVES=8` for fair and God lanes so full-match shards stay below the prior giant-string failure size.
- PR #5 confirms God-only promotion works when the fair gate fails but the God bootstrap gate passes.
- Future daily PR body generation now distinguishes fair gate status, God gate status, God bootstrap status, and fair/God failure reasons.
- Node training supports `--target-tier god` with hidden God feature size and schema-validated model artifacts.
- Browser self training runs imitation plus reward-weighted rollout fine-tune against Top and the highest unlocked fair tier.
- Tests cover full-grid spell actions, compact stored legal-action samples, streamed hash compatibility, self legal-action samples/model selection, God hidden schema/runtime, manifest God entries, daily God workflow wiring, God bootstrap comparison, and mixed fair-failed/God-passed PR body output.

## Known Gaps

- Daily run `25516896901` completed in `3h31m57s`, leaving less than two hours of margin under the `350` minute timeout.
- Artifact `ladder-training-25516896901` is `729M`: datasets `727M` total (`noob 104M`, `mid 127M`, `top 160M`, `pro 165M`, `goat 159M`, `god 13M`) and models `1.6M`.
- The fair daily gate still fails on adjacent regression despite positive average delta, so fair neural ladder promotion remains blocked.
- The checked-in God model is a bootstrap artifact, not a proven Goat-beating boss. Run `25516896901` accepted it because there was no prior checked-in God model.
- Promoted God training metadata still reports `training_config.max_ticks: 900` even though the workflow exported full-match datasets with `LADDER_MAX_TICKS=6040`; dataset-backed trainer metadata needs a follow-up fix or explicit handoff note.
- Ladder ordering is still noisy at low rounds and is not stable enough for strict promotion.
- Browser self RL is intentionally lightweight reward-weighted fine-tuning, not a full policy-gradient system.
- Telemetry/export pipeline work from the roadmap is still incomplete beyond the current deterministic training export hooks.
- Browser validation is useful but not yet standardized into one repeatable repo command.

## Next Tasks

1. Fix dataset-backed trainer metadata so saved model artifacts record the true dataset tick cap or stop implying `training_config.max_ticks` controlled pre-exported shards; add a regression test.
2. Browser-smoke self training after enough local samples: verify v2 localStorage, progress/status text, RL accepted/rejected messaging, and playable self model behavior.
3. Stabilize ladder ordering enough to support a stricter promotion gate, then update `docs/BOT_LEVELS.md` and training gate docs with the real threshold.
4. Standardize browser validation into one repeatable local command or documented workflow that works without registry access during smoke checks.
5. Continue telemetry/export pipeline work from `docs/IMPLEMENTATION_PLAN.md` and `docs/TRAINING_PIPELINE.md` so match data can support future self-play training beyond current local samples.

## Validation

- May 8, 2026: `gh pr merge 5 --merge --subject "Merge pull request #5 from knam2609/training/daily-ladder-models" --body "Update daily ladder models"` -> merged PR #5 at `2026-05-08T03:14:50Z`; merge commit `4af6bf8255f66d49a27f35fef83c520fd488cfec`.
- May 8, 2026: `gh run view 25516896901 --json status,conclusion,event,workflowName,headSha,createdAt,updatedAt,url,jobs` -> success; scheduled `main` daily run for commit `87eb357317e4024ecf0bf78a5d04839a296ab6d5`; `Train ladder models` completed in `3h31m57s`.
- May 8, 2026: `gh run download 25516896901 -n ladder-training-25516896901 -D /private/tmp/edge_royale_ladder_25516896901` plus `du -h -d 3 /private/tmp/edge_royale_ladder_25516896901` -> artifact `729M`; `comparison-summary.json` fair gate failed; `god-comparison-summary.json` God bootstrap gate passed.
- May 8, 2026: `git pull --ff-only` -> local `main` fast-forwarded from `87eb357` to `4af6bf8`.
- May 8, 2026: `node --test tests/daily-training.test.js` -> 8 tests passed.
- May 8, 2026: `npm test` -> 122 tests passed.
- May 4, 2026: browser smoke was attempted. `npm run dev` in the sandbox failed with `listen EPERM: operation not permitted 127.0.0.1:5173`; escalated `npm run dev` started successfully at `http://127.0.0.1:5173`; Playwright CLI wrapper failed because restricted network blocked `@playwright/cli` resolution with `getaddrinfo ENOTFOUND registry.npmjs.org`; the fallback web-game Playwright runner hung and was killed.

## Risks / Notes

- Raw training artifacts remain ignored under `artifacts/training/runs/`; local `ci-size-smoke` output is intentionally ignored.
- The prior run `25455693942` had similar fair/God comparison behavior, but PR #5 was updated by newer run `25516896901` before merge; `25516896901` is the checked-in source now.
- Daily workflow timeout is still `350` minutes; current successful runs are now around `3h32m`.
- GitHub Actions flagged Node.js 20 action deprecation for `actions/checkout@v4`, `actions/setup-node@v4`, and `actions/upload-artifact@v4`; Node.js 24 becomes default on June 2, 2026, and Node.js 20 is removed from runners on September 16, 2026.
- Browser smoke still needs a clean repeat with a locally available Playwright CLI/browser runtime.
