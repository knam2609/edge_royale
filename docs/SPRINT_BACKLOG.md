# Sprint Backlog

## Current priorities

- `AI-DATA-001` Build the first compatible full-match corpus.
  - Done when simulator collection has useful opponent/outcome coverage and replay validation is clean.
- `AI-SCALE-001` Run fixed 1%/10%/100% behavior-cloning experiments.
  - Done when 100% improves held-out joint action loss and does not regress frozen-league score relative to 10%.
- `AI-OFFLINE-001` Run conservative advantage-weighted improvement.
  - Done when one low-rate pass remains under `0.05` validation KL and produces a retained evaluation report.
- `AI-LEAGUE-001` Run the first 16–32 worker V-trace campaign.
  - Blocked on `AI-SCALE-001`; done when paired-seed exact-JS episodes and a lineage-preserving candidate checkpoint complete.
- `AI-PERF-001` Increase production rollout/evaluation throughput.
  - Done when 10,000 safety games and full promotion evaluation complete in a practical campaign window.
- `QA-BROWSER-001` Standardize browser smoke.
  - Done when Playwright imports and Chromium launch reliably locally and in CI.
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
- Deterministic paired-seed worker scheduling, snapshot/PFSP allocation, exact-JS rollout episodes, and V-trace learner.
- Daily corpus-health/canary workflow and separate cumulative campaign workflow.
- Full v2 evaluator with two champion blocks, paired bootstrap, anchor regression, weak baselines, frozen league, 10,000 repeated safety games, replay, parity, tactical, timing, test, and browser gates.
- Checksum-bound v2 promotion refusal and successful-campaign pull-request automation.

## Non-goals

- Online PvP.
- Player-facing bot levels or model controls.
- Unlock progression.
- Player-facing mirror/self-play.
- Automatic telemetry or replay upload.
- Expanded decks, MCTS/MuZero, CQL, UPGO, Decision Transformer, or recurrent runtime policy.
