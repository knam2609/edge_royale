# Sprint Backlog

## Current priorities

- `AI-DATA-001` Build the first compatible full-match corpus.
  - Done when simulator collection has useful opponent/outcome coverage and replay validation is clean.
- `AI-SCALE-001` Run fixed 1%/10%/100% behavior-cloning experiments.
  - Recovered scaling marker passed under `20260810-v2-recovery`; reproduce the same source evidence under the new reviewed recovery SHA/prefix.
- `AI-CACHE-001` Validate and persist the recovered full cache.
  - Canonical-schema correction awaits review and a fresh `20260904-v2-recovery` run. Done when exact schema, rows/splits, row groups, content and Parquet checksums pass, fractional league probabilities survive losslessly, and runner cleanup is verified.
- `AI-OFFLINE-001` Run conservative advantage-weighted improvement.
  - Done when one low-rate pass remains under `0.05` validation KL and produces a retained evaluation report.
- `AI-LEAGUE-001` Run the first 16–32 worker V-trace campaign.
  - Blocked on `AI-CACHE-001` and `AI-OFFLINE-001`; done when paired-seed exact-JS episodes and a lineage-preserving candidate checkpoint complete.
- `AI-PERF-001` Increase production rollout/evaluation throughput.
  - Done when 10,000 safety games and full promotion evaluation complete in a practical campaign window.
- `AI-OPS-001` Execute the first production campaign on dedicated AWS infrastructure.
  - Next: staged `full-cache`, `offline`, `full-evaluation`, then manual `promote` for one reviewed recovery SHA. Done when all gates clear or later gate retains immutable failure evidence with live v1 untouched.
- `QA-BROWSER-001` Standardize browser smoke.
  - Done when the Node 20 supervisor/worker smoke, replay-download schema check, Chromium launch, and CI run all pass.
- `DOC-001` Keep cumulative training and Edger-only product docs aligned.
  - Done continuously; no daily-PPO or player-facing training claims may return.

## Completed foundation

- Deterministic game engine, fixed deck, six-tower Royale arena, pockets, replay serialization, and browser UI.
- One live v1 Edger and frozen internal baselines.
- Shared production-match factory used by browser and training.
- Manual identity-free post-match replay export and validated developer import.
- `edger_training_episode_v1`, compressed content-addressed local/S3 storage, quarantine, deduplication, and replay verification.
- `edger_decision_sequence_v1`, sparse delays, potential rewards, and V-trace eligibility.
- `edger_dataset_manifest_v1`, stable game splits, 90/10 default mix, and Parquet/Zstd caches.
- Compact 36,402-parameter v2 actor with full-oracle spatial observation and autoregressive masks.
- PyTorch behavior cloning, critic, top-quartile winner pass, offline advantage weighting, KL rollback, and float32 export.
- Golden PyTorch/generated-JS parity tests.
- Fixed scaling-cache/report interfaces and hard league gate.
- Nested training-only scaling manifests with complete identical held-out sets.
- Frozen five-opponent scaling evaluator and checksum-bound scaling evidence.
- Parallel paired corpus workers, verified content-addressed receipts, failed reports, and exact resumption.
- Manual ten-shard S3 production collection with mandatory read/write preflight.
- Browser smoke supervisor/worker split and identity-free replay-download assertions.
- Deterministic paired-seed worker scheduling, snapshot/PFSP allocation, exact-JS rollout episodes, and V-trace learner.
- Daily corpus-health/canary workflow and separate cumulative campaign workflow.
- Full v2 evaluator with two champion blocks, paired bootstrap, anchor regression, weak baselines, frozen league, 10,000 repeated safety games, replay, parity, tactical, timing, test, and browser gates.
- Checksum-bound v2 promotion refusal and successful-campaign pull-request automation.
- Bounded-memory two-pass cache generation, deterministic Parquet row-group training, and episode-grouped temporary V-trace targets.
- Strict ten-report collection aggregation, parallel full-corpus validation, and base-manifest/current-rollout league lineage.
- Dedicated encrypted/versioned AWS campaign stack, main-only GitHub OIDC, SSM remote control, immutable stage resume, and resource gates.

## Non-goals

- Online PvP.
- Player-facing bot levels or model controls.
- Unlock progression.
- Player-facing mirror/self-play.
- Automatic telemetry or replay upload.
- Expanded decks, MCTS/MuZero, CQL, UPGO, Decision Transformer, or recurrent runtime policy.
