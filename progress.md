## Current State

- As of July 19, 2026, the cumulative-v2 foundation is committed at `a62aa6b`; campaign operationalization is committed at `8dbca03`; live-v1 reference generation is committed at `b04c59e`.
- Live browser Edger remains the tracked v1 artifact. No v2 artifact was promoted or wired into gameplay.
- Collection is now paired, parallel, clean-SHA-bound, receipt-resumable, failure-reporting, and deterministic across worker counts.
- Scaling now reduces only nested training sets, keeps complete identical validation/test sets, runs a fixed five-opponent 200-game suite, and binds manifests/checkpoints/models/suite checksums.
- CI has a manual ten-shard S3 collector, no ephemeral corpus fallback, native Node 20 configuration, explicit Chromium installation, and a browser smoke supervisor/worker.
- League inputs distinguish the shadow learner parent, live champion/reference, and historical anchors. Exact-JS throughput and live-v1 reference report commands exist.

## Source of Truth

- Workflow and product boundaries: `AGENTS.md`
- Product overview and commands: `README.md`
- Gameplay: `docs/GAME_RULES.md` and `docs/CARD_SPECS.md`
- Live/shadow runtime: `docs/BOT_LEVELS.md`
- Corpus, scaling, learning, league, and scheduling: `docs/EDGER_TRAINING.md`
- Roadmap/backlog: `docs/IMPLEMENTATION_PLAN.md` and `docs/SPRINT_BACKLOG.md`
- Current implementation: `scripts/edger-collection-core.mjs`, `scripts/edger-corpus*.mjs`, `scripts/edger-dataset*.mjs`, `scripts/edger-scaling-evaluate.mjs`, `scripts/edger-v2-training.py`, `scripts/edger-league*.mjs`, and `scripts/edger-v2-evaluation*.mjs`

## What Works

- `--workers 1-32`, `--pair-offset`, even paired matches, stable spec hashes, ordered results, verified receipts, resume, failed reports, coverage, timings, provenance, and 16-worker cost projection are implemented.
- `.github/workflows/edger-corpus-collect.yml` preflights S3 and defines ten 1,000-game shards at pair offsets `0,500,…,4500` with four workers each.
- `edger_frozen_league_report_v1` runs 40 paired-side games each against live v1, heuristic, random, aggressive, and defender.
- Scaling reports reject non-nested train sets, changed held-out IDs, manifest/checkpoint mismatches, changed suite specs, model/checkpoint checksum mismatches, illegal actions, or replay failures.
- Offline AWR reports final accepted KL separately from rejected KL and records whether rollback occurred.
- Native Node 20 browser smoke validates the game-over replay download and recursively rejects identity fields.
- The 11,300-game throughput projection gate and live-v1 reference generator are operational.

## Known Gaps

- `EDGER_CORPUS_STORE` is unset locally and absent from GitHub Actions repository variables. The required durable S3 URI was not supplied, so the authoritative 64-game pilot and all later production stages were not run.
- The eight-game local canary corpus is validation-only: it has 7 train, 0 validation, and 1 test episode. Its scaling report correctly rejected missing held-out loss evidence.
- No authoritative 10,000-game corpus, valid scaling decision, offline KL result, league smoke/campaign, full live-v1 reference, or full promotion evaluation exists yet.
- The implementation commits are local on `main`; after this handoff update the branch is ahead of `origin/main` by four commits.

## Next Tasks

1. Supply/configure an S3-compatible `EDGER_CORPUS_STORE` and runner credentials, then push the four reviewed commits so workflows can use them.
2. Run the 64-game S3 pilot with seed `20260718`, eight workers, pair offset `0`, and retain its report/receipts/manifest/cache/smoke checkpoint.
3. Proceed with the ten-shard 10,000-game workflow only if the pilot’s 16-worker projection is at most eight hours.
4. Train/export/frozen-evaluate 1%/10%/100% BC with seed `20260718`, one epoch, batch 32, and learning rate `1e-3`; stop without threshold changes if scaling fails.
5. From a passing 100% checkpoint, run one AWR epoch at `1e-4`; retain accepted or rolled-back evidence with final KL at most `0.05`.
6. Run the 32-game league smoke, then the 1,000-game paired 16-worker V-trace campaign from the shadow parent.
7. Generate the full live-v1 reference, enforce throughput on the designated runner, run the full evaluator, and open—but never auto-merge—the checksum-bound promotion PR only if every gate passes.

## Validation

- July 19, 2026: native arm64 Node `v20.20.2`; clean `npm ci` -> 3 packages installed, 0 vulnerabilities; `node_modules/playwright/cli.js install chromium` -> Chromium/FFmpeg/headless shell installed.
- July 19, 2026: `PATH="/private/tmp/edge-royale-node20-native/node_modules/node-bin-darwin-arm64/bin:$PATH" npm test` -> 116 passed, 0 failed, including the legacy 90-match Edger floor; `284008.826459 ms`.
- July 19, 2026: the same native-Node PATH with `npm run smoke:browser` -> passed, including identity-free downloaded replay validation.
- July 19, 2026: `npm run edger:canary -- --seed 20260718 --canary-ticks 80` -> passed; final hash `d8a8e16d`, replay checksum `1377582fed82914b3fe95d157e2143e3cce7021a52cf1b17ff748cbad2558531`.
- July 19, 2026: one-worker and four-worker eight-match collector canaries at pair offset `6000` -> identical ordered episode/action/final/replay hashes; spec checksum `bee3bf0b2d6e1434963e613b43daa668c7152a1e3e2f541563129e9a5b3e3690`; four-worker fresh run `4.728 s`; exact rerun resumed 8/8 receipts in `0.596 s` with zero duplicate episode IDs.
- July 19, 2026: 32-match/16-worker exact-JS throughput -> `8.567756` matches/s, projected `21.981641` minutes for 11,300 matches; result checksum `6bdde1874f63bd0e3c7f62c4ab111405950b617cc23c93f21a96e4f8936d2582`.
- July 19, 2026: local eight-episode manifest/replay validation -> 8/8 passed; manifest `1ccbcf6c83a090fc1f86514137c5d56de75e5fafb60444bc36ed73b0e8093f68`; 493 decisions.
- July 19, 2026: non-authoritative 1%/10%/100% BC smoke used seed `20260718`, one epoch, batch 32, learning rate `1e-3`; all three 200-game frozen suites used spec checksum `b0517c71c5dcada16a16b23149b3b6f7ab96d08e45cfe7e2403a2a9a5695399b`, had zero illegal actions, and passed 200/200 replay checks. Scores were `0`, `0`, and `0.415`; scaling report rejected the corpus because validation loss was unavailable.
- July 19, 2026: `npm run edger:reference:v2 -- --champion artifacts/edger-training/promoted/edger_policy_current.json --games-per-opponent 2 --workers 2 --seed 20260718 --out artifacts/edger-training/smoke/live-v1-reference-smoke.json` -> 2/2 replay checks, zero illegal actions.
- July 19, 2026: all JavaScript syntax checks, Python compilation, workflow YAML parsing, focused tests, and `git diff --check` passed.

## Risks / Notes

- Live v1 is intentionally unchanged; all generated smoke models and reports are ignored, non-authoritative artifacts.
- Do not use the local canary projection as the S3 pilot decision. Measure the required 64-game durable run on its designated environment.
- Production collection/training refuses a dirty worktree and records the full Git SHA.
- Failed scaling, offline, league, or evaluation stages must retain evidence and must not weaken thresholds or update the live artifact.
