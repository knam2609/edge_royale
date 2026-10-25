# Sprint Backlog

## Current priorities

- `AI-RUNTIME-COST-001` Profile unchanged learned-trained checkpoints before a runtime decision.
  - October 4: the two [symlink admission gaps](EDGER_RUNTIME_COST_PLAN.md#freeze-repair-review--october-4-2026) found in review are [repaired](EDGER_RUNTIME_COST_PLAN.md#symlink-admission-repair--october-4-2026). Freeze containment uses resolved paths. The [worker follow-up](EDGER_RUNTIME_COST_PLAN.md#worker-link-repair--october-4-2026) shares the strict inventory with preflight, rejects unlisted entries and refuses linked/special server paths on each request. Targeted suites pass 47/47 and `npm test` 194/194; supervised link controls refuse before browser launch. Live smoke and filtered smoke/jump/bank/24 fast-forward checks pass from a disposable stage, with verified cleanup. Saved checksums pass 2,259/2,259 and freeze `bed6ff1e…` is unchanged. Include the changed worker/stager provenance in the successor stage and full validation. All headed/v1/measurement prerequisites remain open.
  - October 4: the two pre-existing P3 server findings are [repaired](EDGER_RUNTIME_COST_PLAN.md#server-robustness-repair--october-4-2026): `stream.pipeline` closes aborted-response descriptors and malformed URLs return 400. Targeted suites pass 49/49; `npm test` passes 196/196 from a byte-verified outside-iCloud copy with pinned Node 20. The first repository/Node 25 run had three existing supervisor failures; isolated controls and the copied suite pass, with a `dataless` process helper observed. Live smoke and the filtered 2 smoke/2 jump/1 bank/24 fast-forward run pass on the fresh disposable stage with verified cleanup and unchanged inventory. Include this worker revision in the successor stage and full validation; headed/v1/measurement prerequisites remain open.
  - Follow the [October 1 runtime-cost plan](EDGER_RUNTIME_COST_PLAN.md): validate a browser adapter against the frozen controller, measure all three checkpoints at learned/every-tick cadence, include the production selector and live-v1 cost baseline, and report complete decision and rendered-frame costs separately. Use development states only, stage outside iCloud, preserve all results and resource stops. Then prepare an exact, bounded timing-only `c7g.4xlarge` request with a verified dollar ceiling and cleanup for separate approval. The existing p95 ≤5 ms method stays unchanged; no runtime switch or cloud dispatch is authorized.
  - Status, October 6, 2026: the [successor harness review](EDGER_RUNTIME_COST_PLAN.md#successor-harness-review--october-6-2026) accepted the saved correctness evidence and found three P2 measurement defects. All three, and the observer-overhead boundary, are now [repaired in code](EDGER_RUNTIME_COST_PLAN.md#measurement-repair--october-6-2026): per-path model objects with identity admission; endpoint-checked windows and admitted browser GC pairs; full, identity-matched Node GC coverage; and a timer bracketing the whole hook lifecycle. Regression controls and 8/8 mutation controls pass; targeted suites pass 66/66 and verified-copy `npm test` 213/213. The predecessor pin is now `800e6dc5…`. Measurement remains unadmitted until a new linked successor is staged, validated, frozen and reviewed.
    - Display: headed DPR 2; `--kiosk` with a per-page CDP fullscreen window; settled admission and per-poll monitoring of window, frontmost process, visibility, scale and viewport.
    - The favicon exemption is narrowed to the exact 404 at the local URL. Live-v1 baselines are checked against an independent reference.
    - Measurement paths: existing-method, all-state complete-path, production-selector, observer-overhead and paired Node/browser GC. CPU totals are qualified as lower bounds when a process exits.
    - Gates: verified-copy `npm test` 209/209, targeted 62/62 and live smoke.
    - The full unfiltered headed validation passed, including all eight real-time matches and 16 v1 fast-forward matches. The measurement dry run passed 8/8.
    - Successor freeze `800e6dc5…` (28 conditions) links `bed6ff1e…`.
    - The [repair review](EDGER_MEASUREMENT_REPAIR_REVIEW.md) found no blocking defect. [Fresh stage and pre-display gates](EDGER_RUNTIME_COST_PLAN.md#fresh-stage-and-pre-display-gates--october-6-2026): expectations `5d313a3a…` (deterministic content equal to `d0c0d9f0…`), stage `ecb846b0…` whose sources equal the reviewed copy, verified-copy `npm test` 213/213, targeted 66/66 and headless live smoke pass.
    - October 7: on the reserved display, the [full headed validation and dry run passed](EDGER_RUNTIME_COST_PLAN.md#headed-validation-dry-run-and-successor-freeze--october-7-2026). All 122 matches passed, with zero display violations. The dry run passed 8/8, with complete browser and Node GC pairs. Successor freeze `75dd33fe…` (28 conditions, measurement plan unchanged) links `800e6dc5…`.
    - October 8: the [independent freeze review](EDGER_FREEZE_REVIEW.md) accepts `75dd33fe…`, with 4,880 audit checks/zero problems, zero freeze-input problems, 11 focused tests and nine synthetic controls passing. Spotlight exclusion and disk (15.54 GiB) pass, but host admission fails: pressure level 2, 425.9/412.6 MiB swap-in/out over 94.4 s, and battery power.
    - October 17: after a reboot and an iCloud backlog drain, host admission passed (pressure 1/1/1, zero swap-in/out over 120.4 s, 10.92 GiB free, pins unchanged). The frozen measurement ran once to completion: 6,792.6 s, no incomplete/failed/not-run conditions, cleanup verified. See the [local results](EDGER_RUNTIME_COST_RESULTS.md). Existing-method p95 is 0.88–0.96 ms (15/15 pass). The production complete path is p95 2.25 ms, p99 3.54 ms. Every-tick costs about 2 ms/tick of browser policy time against 0.08–0.14 ms for learned. Catch-up never fired across 327,311 frames. In 18/24 v2 matches the cold first decision drops one frame at start.
    - October 24: the [runtime review](EDGER_RUNTIME_REVIEW.md) accepts the complete-path and warm frame costs for both controllers on desktop-class hosts at 60 Hz. The cold-start frame drop is a known, non-blocking defect, with a proposed decision-preserving warm-up. Mobile, reference-host and 120 Hz costs are not accepted. The two recommended decision-preserving speed-ups, a load-time warm-up decision and cached sort keys, are [implemented](EDGER_RUNTIME_REVIEW.md#implementation-of-proposals-1-and-2--october-24-2026), with `npm test`, smoke and a byte-identical bot-bench passing. Remaining: a fresh-page browser confirmation of the warm-up, and the timing-only reference-host packet (cloud admission pending budget).
    - October 25: the [browser confirmation](EDGER_RUNTIME_REVIEW.md#browser-confirmation-of-the-warm-up--october-25-2026) shows the warm-up removes the match-start frame drop in headless Chromium. With it, 0 of 30 fresh pages dropped a frame (v1 and r0); without it, 20 of 30 did. Headed, 120 Hz and mobile are not re-measured.

- `AI-GATES-001` Resolve full-evaluation failures locally before a new learning/full-evaluation cloud run.
  - Follow [the September diagnosis](EDGER_EVALUATION_DIAGNOSIS.md): validate candidate quality in a bounded real-corpus experiment using the corrected parity gate. Review found that the first mid-match bank forced PASS throughout; it now covers every legal card branch and its selected placement. `83.886` is an advisory scale warning, not a proven parity cutoff or training-abort rule. Target freshness, tactical fixtures, preflight, convolution performance, and lossless export have local fixes. The failed candidate remains rejected. No dispatch, promotion, or Git publication is authorized.

- `AI-DATA-001` Build the first compatible full-match corpus.
  - Done when simulator collection has useful opponent/outcome coverage and replay validation is clean.
- `AI-SCALE-001` Run fixed 1%/10%/100% behavior-cloning experiments.
  - Recovered scaling passed under `20260904-v2-recovery`. Changed protected runtime code requires fresh scaling or a separately reviewed provenance design; never bypass the recovery guard.
- `AI-CACHE-001` Validate and persist the recovered full cache.
  - Passed under `20260904-v2-recovery`: exact canonical schema, rows/splits, row groups, content/Parquet checksums, and cleanup verified. Preserve immutable evidence.
- `AI-OFFLINE-001` Run conservative advantage-weighted improvement.
  - Offline stage passed by rollback with `accepted_epochs=0`; no learned-improvement claim. A useful accepted update remains open.
- `AI-LEAGUE-001` Run the first 16–32 worker V-trace campaign.
  - Production episodes/checkpoint completed, but the candidate degraded severely and failed evaluation. Validate fresh-per-episode V-trace targets and resulting quality before a new approved campaign.
  - September 26 local cadence diagnostic: on-policy collect/update/recollect V-trace from the same parent improved deterministic play against v1 (+0.078 with the learned delay, +0.243 at a fixed one-tick cadence). Every-tick evaluation helped the learned-trained checkpoint far more than the parent. At matched every-tick evaluation, training cadence showed no demonstrated difference ([review](EDGER_CADENCE_REVIEW.md)).
  - September 27 replication (three runs; critic-only and value-detached controls): RL gains replicate against v1 and heuristic. The two-run fixed-cadence controls support actor-loss-driven improvement; they do not identify the mechanism of the preferred learned-trained pipeline. Every-tick training has no demonstrated advantage over learned-delay training at matched evaluation, and point estimates favour learned-delay training. Among the main arms, learned-delay training with every-tick evaluation is the only configuration that beats the original parent against v1, aggressive and heuristic in all runs. A runtime cadence change is a separate product decision needing approval and reference-host timing; see [the diagnosis](EDGER_EVALUATION_DIAGNOSIS.md). Diagnostic models remain non-promotable and fail parity/tactical gates.
  - September 29 locked confirmation (200 reserved seed pairs, 9,600 games, no engineering stop): every-tick minus learned inference for the three learned-trained checkpoints is +0.158 [+0.128, +0.190] against v1. Secondary opponents are positive run-averaged, and the pre-registered research rule holds. Every-tick inference does not help the parent. It clears no parity, tactical, runtime-cost or promotion gate ([confirmation run](EDGER_REPLICATION_REVIEW.md#confirmation-run--september-29-03450646-utc-13451646-aest)).
  - September 27 gate audits: the parent also exceeds absolute `1e-5` on 45/56 fixtures under float64 evaluation, supporting a tolerance/scale issue. JS float32 pooling and decimal-double weights remain separate numerical differences to investigate. The tactical suite is coarse and lenient in two categories, and shipped v1 scores 0.451 on it. Any gate or runtime change needs explicit review.
  - October 25 [tactical review](EDGER_TACTICAL_REVIEW.md):
    - Troop-placement ties are structural (identical all-zero 3×3 patches, lowest-index tie-break to back-center, a cell teachers use in 0.9% of tied rows).
    - Fireball loss has three measured causes: no lethal or cluster signal in the representation, opportunity states diluted by non-casting teachers, and RL suppression (P(Fireball) down 80–370× for r0/r1).
    - Proposals, including broader defense and punishment scoring, await review.
  - October 25 [parity-contract packet](EDGER_PARITY_CONTRACT_REVIEW.md):
    - All seven models agree with PyTorch on every argmax and tie set; only absolute placement error fails.
    - The float64 mean pool is decision-preserving (banks plus 70 full matches) and cuts the worst error from 11 to 3 ULP.
    - Recommended for review: land the pool fix, then a hybrid `max(1e-5, 4 ULP)` tolerance. `1e-5` is unchanged until approved.
- `AI-PERF-001` Increase production rollout/evaluation throughput.
  - Done when 10,000 safety games and full promotion evaluation complete in a practical campaign window.
- `AI-OPS-001` Execute the first production campaign on dedicated AWS infrastructure.
  - September campaign closed with failed full evaluation, retained failure reports, terminated runner/deleted volume, and unchanged live v1. The next run needs explicit approval and a new immutable SHA/prefix.
- `QA-BROWSER-001` Standardize browser smoke.
  - October 5: [supervisor assertion diagnostics](EDGER_RUNTIME_COST_PLAN.md#supervisor-test-diagnostics--october-5-2026) now preserve worker exit/logs before test cleanup. Targeted suites pass 50/50 from a verified outside-iCloud copy; deliberate failure output retains its original assertion and worker stack after cleanup. Runtime files/deadlines are unchanged. The earlier 193/196 cause remains unconfirmed; continue freeze full-suite gates from a verified copy and record their location.
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
- Bounded-memory two-pass cache generation, deterministic BC/offline row-group training, and fresh episode V-trace targets with accumulated microbatch gradients.
- Strict ten-report collection aggregation, parallel full-corpus validation, and base-manifest/current-rollout league lineage.
- Dedicated encrypted/versioned AWS campaign stack, main-only GitHub OIDC, SSM remote control, immutable stage resume, and resource gates.

## Non-goals

- Online PvP.
- Player-facing bot levels or model controls.
- Unlock progression.
- Player-facing mirror/self-play.
- Automatic telemetry or replay upload.
- Expanded decks, MCTS/MuZero, CQL, UPGO, Decision Transformer, or recurrent runtime policy.
