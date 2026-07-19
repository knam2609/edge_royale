## Current State

- As of July 18, 2026, the daily PPO trainer and daily promotion workflow have been removed.
- Live browser Edger still uses tracked `edger_policy_model_v1` from `artifacts/edger-training/promoted/edger_policy_current.json` and `src/ai/generated/edgerPolicyCurrent.js`.
- `edger_policy_model_v2` exists beside v1 in shadow mode with a 36,402-parameter, synchronous generated-JavaScript-compatible actor and no handcrafted inference prior.
- The cumulative v2 foundation now covers full production episodes, content-addressed local/S3 storage, manual player replay import, manifests/caches, PyTorch BC/offline improvement, scaling evidence, exact-JS snapshot workers, and V-trace checkpoints.
- The full v2 evaluator, checksum-bound promotion command, and successful-campaign promotion PR path are implemented; v2 still cannot be promoted until a real full campaign passes them.

## Source of Truth

- Workflow and product boundaries: `AGENTS.md`
- Product overview and commands: `README.md`
- Gameplay: `docs/GAME_RULES.md` and `docs/CARD_SPECS.md`
- Live/shadow runtime: `docs/BOT_LEVELS.md`
- Corpus, learning, league, and scheduling: `docs/EDGER_TRAINING.md`
- Roadmap/backlog: `docs/IMPLEMENTATION_PLAN.md` and `docs/SPRINT_BACKLOG.md`
- Current behavior: `src/sim/productionMatch.js`, `src/ai/v2/observation.js`, `src/ai/v2/policy.js`, `scripts/edger-corpus-core.mjs`, `scripts/edger-v2-training.py`, `scripts/edger-league*.mjs`, and `scripts/edger-v2-evaluation*.mjs`

## What Works

- Browser, corpus collection, replay import, and rollout workers share the exact six-tower 18×32 production match.
- `edger_training_episode_v1` records complete matches with compatibility versions, policy/checkpoint lineage, sparse decisions, result, final hash, replay events/checksum, source, and content ID.
- Gzip content-addressed object writes are idempotent locally or through `s3://` using the AWS CLI; incompatible imports are quarantined.
- Whole-game hash splits and fixed 1%/10%/100% subset manifests are stable; disposable PyTorch caches are Parquet/Zstd; player data is capped at 10% and unknown human probabilities are excluded from V-trace.
- V2 observation/action schemas, legal masks, deterministic stable argmax, parameter/size caps, PyTorch training, offline KL rollback, float32 export, and generated-JS parity are implemented.
- Snapshot league scheduling preassigns paired seeds, supports champion/heuristic/seven history/four contenders, implements 40/20/20/20 allocation and PFSP, and records exact-JS trajectories with behavior log-probabilities.
- Full evaluation creates two champion seed blocks, heuristic/anchor/weak matchups, 10,000 repeated safety games, parity/replay/tactical/timing/external gates, and a checksum-bound byte-identical promotion artifact.
- Daily automation now performs corpus health and deterministic canaries; full campaigns are separate and cumulative.

## Known Gaps

- No real corpus or 1%/10%/100% scaling campaign has been run yet; local validation used passive/small synthetic smoke corpora.
- A one-worker two-game full snapshot-league smoke took roughly 86 seconds; production evaluation throughput needs improvement.
- Browser smoke cannot currently run in this local environment because importing Playwright times out.
- The legacy 90-match benchmark test remains too slow for the local validation window; all other tests pass.

## Next Tasks

1. Collect and validate the first useful full production simulator corpus.
2. Run fixed 1%/10%/100% BC experiments and generate a real scaling report.
3. Optimize exact-JS rollout throughput before the first 10,000-match safety run.
4. Run the conservative offline phase and retain KL/evaluation evidence.
5. Run the first 16–32 worker V-trace campaign only after scaling passes.
6. Run the full v2 evaluator and review its promotion PR without weakening failed gates.
7. Fix/standardize local Playwright import and rerun browser smoke.

## Validation

- July 18, 2026: passive full-match episode smoke -> result at tick 6000; replay actions/events/result/final hash reproduced; 60 sparse decisions derived with `13824` board and `96` global values each.
- July 18, 2026: Parquet/PyTorch smoke -> 60 decision rows written with Zstd; BC checkpoint completed; current exported actor had 36,402 parameters and 744,944 bytes.
- July 18, 2026: PyTorch/generated-JS golden fixture -> maximum logit difference `0`, masked argmax agreement `100%`.
- July 18, 2026: `node scripts/edger-league.mjs --scaling-report <smoke> --model <bootstrap-v2> --store <tmp> --manifest-out <tmp> --matches 2 --workers 1 --seed 99` -> passed; two full paired matches, 41 stored decisions.
- July 18, 2026: V-trace smoke on the two league episodes -> passed; wrote an immutable child checkpoint with human exclusion and clipped V-trace metadata.
- July 18, 2026: v2 evaluator smoke -> 16 production matches; safety, repeated streams, zero illegal actions, replay, and candidate-specific PyTorch/JS parity passed; smoke correctly remained non-promotable.
- July 18, 2026: optimized synchronous v2 timing after 10 warmups -> `p95_ms=4.3023` over 100 samples on the local reference process, below the 5 ms gate.
- July 18, 2026: every JavaScript source/test passed `node --check`; `python3 -m py_compile scripts/edger-v2-training.py`, both workflow YAML parses, package JSON parsing, and `git diff --check` passed.
- July 18, 2026: every test except `tests/bot-regression.test.js` -> passed, 108 tests in 5.1 seconds.
- July 18, 2026: `npm test` -> 105 tests passed with zero failures; the final legacy `tests/bot-regression.test.js` process was cancelled after 647.9 seconds while its 90-match gate remained CPU-bound.
- July 18, 2026: `npm run edger:canary` -> passed at tick 80 with final state hash `d8a8e16d` and replay checksum `1377582fed82914b3fe95d157e2143e3cce7021a52cf1b17ff748cbad2558531`.
- July 18, 2026: `npm run smoke:browser` -> not completed; the smoke script timed out while importing Playwright.
- The full Edger benchmark gate was not rerun because the promoted v1 model and frozen handcrafted heuristic were not changed; the first v2 promotion remains gated by the full evaluator.

## Risks / Notes

- Live behavior is intentionally unchanged: v1 remains promoted and v2 remains shadow-only.
- Full production trajectories are expensive; never restore short one-tower training to hide that cost.
- Failed campaigns retain reports/checkpoints without changing a promoted artifact; successful campaigns prepare the exact evaluated artifact on a review branch.
- `edger_heuristic`, `random`, `aggressive`, and `defender` remain internal and must not appear as player-facing choices.
- Player replay export is explicit and local; there is no identity field or automatic upload.
