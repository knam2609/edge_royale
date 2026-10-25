# Current State

- October 25, 2026 (latest): the approved **parity decision is implemented**. Evidence is in `L` = `~/edge_royale-runs/20261025-float64-pool.noindex/`.
  - **Step 1, the float64 mean pool** ([record](docs/EDGER_PARITY_CONTRACT_REVIEW.md#step-1-landed--october-25-2026)), in `meanPool`, `src/ai/v2/policy.js`. It is committed locally as `83fa42e` on `edger-v2-accumulated` (not pushed).
    - It is bit-identical to scratch V1 on all seven parity banks (468 fixtures), and all 70 full matches (3,785 decisions) are identical to the float32 pool.
    - Tests pin the pool arithmetic, the golden hash (`87c3a171…`) and a seeded model's bank and full-match decisions.
  - **Step 2, option C** ([record](docs/EDGER_PARITY_CONTRACT_REVIEW.md#step-2-landed--october-25-2026)), in `scripts/edger-v2-evaluation-core.mjs`. It is committed locally on `edger-v2-accumulated` as its own change, after `83fa42e` (not pushed).
    - Legal logits must satisfy `|js − pytorch| ≤ max(1e-5, 4·ulp32)` against float32, masked logits keep `1e-5`, and identical tie sets are now required. Fragile margins are reported and set `review_required`; they do not fail the gate.
    - `compareCandidateParity` is now a separate export. `PARITY_ABSOLUTE_TOLERANCE` in `scripts/edger-v2-training.py` has no parity check (it only feeds the advisory warning), so it stays `1e-5`, with a comment.
    - On the recorded logits, V0 is rejected for exactly learned r0 and fixed r0–r2, and V1 passes 7/7. End to end (fresh banks, real PyTorch), the shipped runtime passes 7/7, worst 0.75 of tolerance (3 ULP), with identical tie sets and zero fragile margins.
  - Live v1 (`src/ai/mlPolicy.js`) is unaffected. k = 4 rests on one M1 with PyTorch 2.11.0; re-measure on the reference host before a campaign relies on it.
- October 25, 2026 (later): the owner **approved** both recommendations below. The parity decision is implemented (above); the tactical proposals are not. The order and scope are in each doc's decision section.
  - **Parity:** the float64 pool first, then option C with k = 4 against float32, explicit tie-set identity and fragile-margin reporting. Option F stays advisory.
  - **Tactical:** all four proposals, including the scoring gate change.
  - Gates and models are unchanged until those changes land.
- October 25, 2026: former Next Tasks 1–3 are done as read-only local diagnostics. The repository changes are docs only, committed locally as `f904e68` on `edger-v2-accumulated` (not pushed). Evidence is in `X` = `~/edge_royale-runs/20261025-tactical-parity-warmup.noindex/` (`SHA256SUMS` `89dc327c…`, 376 files).
  - **Tactical** ([review](docs/EDGER_TACTICAL_REVIEW.md)). Troop-placement ties are structural.
    - 84 of the 86 fixture ties, and all 3,334 tied corpus troop rows, have identical all-zero 3×3 input patches.
    - The lowest-index tie-break picks own back-center, which teachers use in 0.9% of those rows. Every model matches the teacher on 1.5% of them, against about 62% elsewhere.
    - Fireball has three measured causes:
      - the card head has no lethal or cluster signal: no step at the 207-HP threshold, and the HP signal arrives only via globals 51/95;
      - opportunity states are 1–5% of rows, diluted by aggressive and defender, which never cast;
      - RL suppression: P(Fireball) is down 80–370× for r0/r1 and is no longer conditioned on opportunity.
    - Live v1 casts lethal Fireball in 76% of corpus opportunities. The proposals were approved on October 25 and are not implemented.
  - **Parity** ([packet](docs/EDGER_PARITY_CONTRACT_REVIEW.md)).
    - All seven models agree with PyTorch on every masked argmax and tie set; only absolute placement error fails, with logits of 149–746.
    - The float64 mean pool cuts the worst error from 11 to 3 ULP against float32. It brings card and delay within `1e-5` and changes no decision (banks plus 70 full matches, 3,785 decisions).
    - Approved on October 25: land the pool fix, then `abs ≤ max(1e-5, 4·ulp32)` against float32, with explicit tie-set identity. Both landed the same day (above).
  - **Warm-up** ([browser confirmation](docs/EDGER_RUNTIME_REVIEW.md#browser-confirmation-of-the-warm-up--october-25-2026)), in headless Chromium with 15 fresh pages per condition:
    - with the warm-up, tick 1 costs 9.8 ms (v1) and 8.5 ms (r0), and 0 of 30 pages dropped a frame;
    - without it, tick 1 costs 13.6 and 13.7 ms, and 20 of 30 pages dropped one;
    - the warm-up adds about 8–11 ms before the first frame at load.
- October 24, 2026 (later): review proposals 1 and 2 are [implemented](docs/EDGER_RUNTIME_REVIEW.md#implementation-of-proposals-1-and-2--october-24-2026), and neither changes a decision.
  - Legal-action sort keys are now built once per enumeration (`src/ai/botRuntime.js`).
  - The new `warmUpBotDecision` makes one throwaway decision on a disposable engine with its own RNG. `src/client/webGame.js` calls it once at page load.
  - Node 20, ad-hoc: enumeration over a full match is 70% faster (2,413.6 → 731.2 ms), with an identical order/state fingerprint. The median first live decision drops from 20.2 to 5.9 ms for v1 and from 23.5 to 4.4 ms for r0, with identical decisions. The warm-up costs about 23 ms at load.
  - Validation: `npm test` passes 216/216 and smoke passes. The bot-bench gate passes, with output byte-identical to the original code.
  - The runtime-cost harness pin for `src/client/webGame.js` is updated (`ca29cf42…` → `1143352c…`); every guarded substitution block is unchanged.
  - Live v1 benefits now. The October 25 headless check confirms the match-start frame drop is gone (above).
- October 24, 2026: the explicit [runtime review](docs/EDGER_RUNTIME_REVIEW.md) of the October 17 results is **done**.
  - Verification: both checksum lists re-verified (23/23 and 6,117/6,117). The summary reproduces byte for byte. An independent recount from raw records (177,000 complete-path samples, 15 existing-method records, all 28 rendered matches) found no problems.
  - Decision: for desktop-class hosts at 60 Hz, the complete-path and warm frame costs are **accepted** for both controllers. The cold-start frame drop is a **known, non-blocking** defect. Mobile, reference-host, 120 Hz and sustained-thermal costs are **unmeasured and not accepted**. The existing p95 ≤5 ms gate is unchanged; no controller or checkpoint was chosen, and no promotion gate is cleared.
  - Cold start: each harness match used a fresh page. The first v2 call (12–36 ms) is mostly cold enumeration (2.8–19.4 ms) and encoding (6.6–15.1 ms, including the one-time model validation and conv compilation). Tick 1 also includes the harness opponent driver's first decision (5.9–13.1 ms), which a human match lacks. In the live client the hitch is expected once per page load (not measured).
  - Optimization proposals: two are decision-preserving and recommended, model preparation/warm-up and cached action sort keys (both now implemented, see above); a third, lazy placement masks, is low value and not implemented. A forced-PASS inference shortcut is **rejected** under the learned-delay contract, because the delay head still sets the next decision tick.
  - Side check: the order of legal-action keys for the fixed deck is identical in 11 locales and equals code-unit order, so there is no determinism hazard.
- October 17, 2026 (local; UTC October 16 18:33–20:27Z): the frozen runtime-cost measurement for freeze `75dd33fe…` **ran once and completed**. Results are in the [local results](docs/EDGER_RUNTIME_COST_RESULTS.md).
  - Run: 6,792.6 s of the 10,800 s cap; worker complete, supervisor exit 0, cleanup verified. There were no incomplete, failed or not-run conditions and no retries.
  - Coverage: 15 existing-method invocations, 1,770 complete-path combinations with zero mismatches, 12 Node GC windows, 28 rendered conditions and 14 browser GC windows.
  - Key numbers: existing-method p95 0.88–0.96 ms (15/15 pass the 5 ms budget). The production complete path is p50/p95/p99 0.81/2.25/3.54 ms. Browser policy time is about 1.8–2.1 ms/tick for every-tick against 0.08–0.14 ms for learned and 0.18–0.64 ms for v1. Chromium CPU is 0.30–0.33 s per game second for all controllers.
  - Frame pacing: rAF p99 ≤18.7 ms. Catch-up never fired across 327,311 frames: zero multi-tick frames, maximum pre-drain lag 68.7 ms. In 18 of 24 v2 matches the cold first decision (20–36 ms) drops one frame at match start; warm decisions peaked at 7–13 ms.
  - These costs were accepted, with the scope above, by the October 24 review.
- Admission (`A` = `~/edge_royale-runs/20261017-runtime-cost-admission.noindex/`): a reboot, then only Terminal/Finder plus one agent session, AC and the lid open.
  - Durable pins unchanged: 4,880 audit checks/zero problems, zero freeze-input problems, both outputs byte-identical to October 13.
  - iCloud spent about 3 h after boot applying a leftover `~/Documents/GitHub/project-b` tree (about 58,600 items) at 2–2.5 cores. It was left alone and drained to zero at 18:31Z.
  - `host-check.py` over 120.4 s: pressure 1/1/1, zero swap-in/out, 10.92 GiB free, Spotlight exclusion passes.
- The repository now lives at `~/Developer/edge_royale`, outside iCloud Desktop & Documents. Reviewed audit copies use that path.
- The accepted freeze review (October 8) and headed validation (122/122, 2,828.0 s) and dry run (8/8) stand unchanged. Those durations are validation, not cost evidence.
- September 29 [confirmation](docs/EDGER_REPLICATION_REVIEW.md#confirmation-run--september-29-03450646-utc-13451646-aest) is complete on immutable plan `9e6b6da2…`: 9,600 games plus 336 identical repeats, no illegal attempts, stops or reruns, 2.96 h of 4.5 h. Every-tick minus learned gains are +0.158 [+0.128, +0.190] vs v1, +0.062 [+0.040, +0.082] vs aggressive and +0.097 [+0.073, +0.122] vs heuristic; four research rules hold. These trained-weight-specific results and the spent holdout clear no promotion gate. All eight replication exports remain non-promotable.
- Live v1 remains `895d5541b5650e620db69ccfe999833c05f93abcae08374710d79d0dd913c3aa`; `main` is `0270d828686a3ef984b89c6043a46a1c306dc0e6`. On October 25 the accumulated work was committed as-is to the local branch `edger-v2-accumulated` (`28311bc`), followed by the October 25 docs (`f904e68`). It has not been pushed and still needs the publication review (task 6). `campaigns/20260904-v2-recovery` remains failed and immutable.
- The October 24 session was read-only against `A`/`M`. It wrote review evidence to the new `R`, including `R/speedup/`, and added the review doc and the doc updates. Its code change is limited to `src/ai/botRuntime.js`, `src/client/webGame.js`, `tests/bot-runtime.test.js` and the webGame pin in `scripts/edger-v2-runtime-cost-stage.mjs`. There was no gameplay-rule, policy-weight or controller change, frozen profiling run, cloud action, Git staging or commit.

# Source of Truth

- Product/workflow: `AGENTS.md`, `README.md`, `docs/BOT_LEVELS.md`. Training: `docs/EDGER_TRAINING.md`. Roadmap: `docs/IMPLEMENTATION_PLAN.md`, `docs/SPRINT_BACKLOG.md`.
- Parity implementation (October 25): `L` holds, for step 1, `landed-check.mjs`/`.json`/`.log`, the seeded-model `probe.mjs` outputs from `a3e01e5` and the new code, `golden.mjs` and the bot-bench output; for step 2, `contract-check.mjs`/`.json`/`.log`, the end-to-end gate reports in `gate/` and `mutations.log`.
- [Tactical review](docs/EDGER_TACTICAL_REVIEW.md) and [parity-contract packet](docs/EDGER_PARITY_CONTRACT_REVIEW.md) (October 25), plus the warm-up browser confirmation in the runtime review. Evidence, scripts and checksums are in `X` (see its `README.md`). Byte copies of the September 27/28 audit and isolation scripts are in `X/prior/`. The ignored `artifacts/edger-training/experiments/` now lives only in the iCloud archive `~/Documents/edge_royale-training-archive/experiments/`, which holds dataless files; copy them out before reading.
- [Runtime review](docs/EDGER_RUNTIME_REVIEW.md) (October 24): the decision, the cold-start attribution, optimization proposals and reproduction. `R` = `~/edge_royale-runs/20261024-runtime-review.noindex/` holds `spotcheck.py`, `check.mjs`, the summary rerun, their outputs, the speed-up timing scripts and logs (`speedup/`) and `SHA256SUMS`.
- Latest [local runtime-cost results](docs/EDGER_RUNTIME_COST_RESULTS.md). Session records, launcher, watcher, summary script, `measurement-summary.json`/`measurement-tables.md` and checksums are in `A` (above). `A/SHA256SUMS` (`3edc3ebb…`) covers 23 files; `A/SHA256SUMS-measurement` (`7d8e67a6…`) covers all 6,117 raw output files in `M/measurement/` plus `M/out/measurement.log`.
- [Freeze review](docs/EDGER_FREEZE_REVIEW.md). Review scripts/results: `~/edge_royale-runs/20261008-runtime-cost-freeze-review.noindex/` (`Q`), including `audit.py`/`.json`, `freeze-check.mjs`/`freeze-input-check.json`, focused-test log, synthetic controls, host/Spotlight observations and `SHA256SUMS`.
- [Runtime-cost plan](docs/EDGER_RUNTIME_COST_PLAN.md) is the full source for methods, masks/catch-up boundaries, immutable prior evidence, review/repair records and exact gate/measurement commands. The [measurement repair review](docs/EDGER_MEASUREMENT_REPAIR_REVIEW.md) covers the verified-copy implementation.
- Reviewed run `M`: `~/edge_royale-runs/20261006-runtime-cost-measurement-repair.noindex/`. `stage/` holds 607 files; `validation/` and `dry-run/` are immutable evidence; `test-copy/` is the reviewed 139-file copy (manifest `1c87c620…`); `out/` holds expectations `5d313a3a…`, wrappers, fresh gate logs, five gates, freeze `75dd33fe…`, comparisons, mutation controls, both checksum lists and the October 17 `measurement.log`. `measurement/` is the spent measurement output. Never edit the stage, freeze or measurement output, and never rerun into them.
- Preserved predecessor `800e6dc5…`: `~/edge_royale-runs/20261006-runtime-cost-successor.noindex/`; original browser evidence/freeze `bed6ff1e…`: `~/edge_royale-runs/20261003T0213Z-runtime-cost-browser-validation/` (2,259 checksums). Original Node evidence: `~/edge_royale-runs/20261001T1641Z-runtime-cost-node-validation/` (40 checksums). These are correctness evidence, not timing evidence; predecessor measurement semantics remain unadmitted.
- [Replication review](docs/EDGER_REPLICATION_REVIEW.md) preserves confirmation plans/provenance and exact commands. Durable confirmation: `~/edge_royale-runs/20260929T0346Z-cadence-confirmation-evidence/` (153 checksums) and `~/edge_royale-runs/20260929T0346Z-cadence-confirmation/`. Ignored bundle: `artifacts/edger-training/experiments/20260928-cadence-confirmation/`.
- [Evaluation diagnosis](docs/EDGER_EVALUATION_DIAGNOSIS.md), [cadence review](docs/EDGER_CADENCE_REVIEW.md), [recovery closeout](docs/EDGER_RECOVERY_CLOSEOUT.md) retain numerical/tactical, lineage and cloud-cleanup evidence. Ignored repaired audit: `20260928-tactical-audit-repair/`.
- Runtime-cost implementation: `scripts/edger-v2-runtime-cost-{adapter,collectors,browser}.js`, `-core.mjs`, `-measure.mjs`, `-stage.mjs`, `-browser-worker.mjs`, `-supervisor.mjs`, `-process.mjs` and corresponding runtime-cost/cadence tests. Learner/export/evaluator implementation and tests remain separately unreviewed for publication.

# What Works

- Runtime-cost adapter/state replay equals the frozen reference; forced/elective PASS, spell/busy/pocket/overtime states are covered. Diagnostic mask count is two; production is ten (18 legal-list passes). The production renderer's uncapped 20-tick/s catch-up loop is preserved.
- Stage admission pins source closure, live v1, models, development seeds, state bank, expectations, Node and the whole browser install tree; linked/special/unlisted entries are refused. Both generated pages reproduce from pinned source. Server URL/aborted-stream handling and supervisor failure diagnostics are repaired.
- Headed DPR 2 kiosk/fullscreen is admitted and checked every poll, with native visible captures. Live-v1 baselines equal an independent reference. Measurement paths cover existing-method, complete-path, production selector, observer overhead and paired Node/browser GC, one process/page at a time, bounded and without retries.
- The October 17 measurement evidence is independently reproducible: checksums, the byte-identical summary rerun and a raw-record recount all agree (see `R`).
- The frozen measurement path works end to end on the real host: all five measurement families completed, every rendered condition matched its Node expectation with zero display violations, both GC pair kinds matched identities and hashes, and cleanup was verified.
- Repaired v2 result schemas enforce per-path model/layer isolation, the full observer timer, exact window endpoints, full Node coverage and matching pair identities. The successful dry run exercises one real pair of each kind; negative worker controls remain synthetic.
- Confirmation run/budget/cleanup enforcement, seed-set rejection, finite fresh-target V-trace, lossless parent recovery, streaming caches and repaired tactical decoding are implemented and documented in the linked replication/diagnosis records. Production scaling/safety/quality/parity/tactical/replay/timing/promotion gates remain intact.

# Known Gaps

- Runtime acceptance covers desktop-class hosts at 60 Hz only. It rests on one local fanless M1 run on one development seed, with thermal state unrecorded. Phones, the reference host, 120 Hz displays (8.3 ms frames; warm v2 peaks are 7–13 ms and v1 peaks 16–20 ms) and sustained thermal load are unmeasured. Portrait usability is a product priority, so a mobile cost claim needs its own measurement.
- The cold first v2 decision dropped one frame at match start in 18 of 24 October 17 matches. The warm-up removes it in headless Chromium (0 of 30 fresh pages, October 25). Headed DPR 2, 120 Hz and mobile were not re-measured, and that check used a scratch r0 module substitution. The frozen harness never ran a second match in the same page.
- Catch-up never fired in real time (zero multi-tick frames), so its overshoot path is exercised only by the synthetic jump validation. Failure paths remain unit/synthetic controls.
- Browser decision times exceed the Node complete path (for example every-tick forced PASS p95 about 2.4 ms against 0.83 ms); no cross-build equivalence is claimed.
- The legal-action sort comparator was about 53% of sampled Node allocation in the October 17 traces. It is fixed (enumeration is 70% faster in Node), but GC/allocation and browser cost have not been re-traced.
- The October 4 193/196 supervisor failures remain unexplained and did not reproduce with the same files evicted. Accepted assertion diagnostics now preserve evidence for a recurrence; iCloud eviction is plausible, unconfirmed. Keep freeze full-suite gates on a verified outside-iCloud copy and record where they ran (latest gate: 213/213 at `~/edge_royale-runs/20261006-runtime-cost-measurement-repair.noindex/test-copy`). On October 24 the first repository runs from `~/Developer/edge_royale` passed: `npm test` 216/216 in 309 s (Node v25.2.1) and smoke in 4 s.
- Confirmation covers three checkpoints of one parent, lr/budget, roughly 80% v1 training opponents and local hardware. Intervals cover evaluation seeds, not future training runs. Aggressive C1 r1 is +0.018 [−0.013, +0.050]; trained-over-parent at learned cadence is inconsistent (r0 −0.050 [−0.095, −0.005], r1 +0.048, r2 +0.007). Fixed-trained/intermediate cadences were excluded; training-cadence superiority was not reconfirmed. Replication controls had two runs and secondary development opponents 100 pairs.
- Reference-host cost is unknown. Browser equivalence covers the bank, 12 conditions, the two v1 baselines and two predeclared real-time cases on one development seed. Headed full validation (October 7) passed at DPR 2 under kiosk/per-page fullscreen; rendered measurement matches are checked against Node only as they run. Independent review accepts correctness, repairs and freeze `75dd33fe…`; a fresh passing host admission remains required. The existing method reports only p95/max per invocation. Chromium CPU totals are lower bounds when an observed process exits between `ps` samples (flagged). Display monitoring and its `ps` sampling add about 50 ms of worker work per real-time poll (recorded; up to 75 ms per check on October 17); brief focus excursions entirely between polls cannot be detected. Two-state development checks of the complete path were observed before the freeze. High-resolution isolated diagnostics do not establish cross-build timing equivalence or mobile performance. Trained every-tick models make 3,300–3,900 decisions/game versus 64–150 at learned cadence. Six-worker means (enumeration excluded) are 1.8–2.1 ms/decision and 6.3–8.0 s/game; these are not latency certification or comparable with static local p95 <1 ms. Production v2 makes ten mask builds (18 legal-list passes); the diagnostic makes two (two PASS / three play passes). The browser drains at 20 ticks/s without a lag clamp or per-frame tick limit; catch-up bursts remain intentional. Runtime contract still uses learned delay.
- Tactical: v1 scores 0.451; two scorers accept distant back-center plays. Every v2 model picks Giant in both spell fixtures (Fireball probability ≤0.015); forced spells already use maximum-scoring cells.
  - The placement-tie cause is now established: a 3×3 receptive field, no coordinate or geometry channels, and the lowest-index tie-break. 47.9% of corpus troop rows are structurally tied.
  - Fireball causes are measured but not fixed.
  - The representation, data/learning and scoring proposals are approved (October 25) but not implemented. The RL suppression mechanism is inferred from outputs, not traced in training logs.
- Parity: under the old `1e-5`, all seven models failed on placement alone (magnitudes 149–746) while decisions agreed everywhere. Under the October 25 contract the shipped runtime passes 7/7 locally with one ULP of headroom (worst 3 of 4 ULP).
  - That headroom is measured only on one M1 with PyTorch 2.11.0. The reference host's PyTorch/BLAS accumulation order may need a different k; re-measure before a campaign relies on it.
  - Decimal-double weights (V2, deferred) matter only against a float64 reference. Option F (bounding logit scale in training) stays an advisory warning.
  - Fragile-margin review has no automated enforcement: `review_required` is a report flag, and promotion is already manual.
  - The pool change's runtime cost is not re-measured; the October 17 costs describe the pre-change runtime.
- September 27 provenance: plan mtime 06:10:14Z predates launch 06:14:06Z; analysis was written 06:15:43–06:15:57Z, after training began and before evaluation at 07:35:39Z. Declared `frozen_at_utc: 06:15:00Z` and earlier analysis content remain unexplained. Confirmation used actual timestamps and pre-run analysis hashes; it does not repair predecessor provenance.
- Historical league regression remains unattributed; equal-update experiment outstanding. Held-out imitation loss worsens in every RL arm (5.1–8.3 vs parent 3.566) despite better play; sampled rollout scores also mislead. Subset weights/derived manifest hash remain machine-specific.

# Next Tasks

1. Implement the approved [tactical proposals](docs/EDGER_TACTICAL_REVIEW.md#proposals--approved-october-25-not-yet-implemented). New models must pass the new parity contract, which the current models now do locally.
   - Representation: geometry channels or the September 21 ablation, plus spell-opportunity globals.
     - This is a new v2 observation schema, needing a re-derived cache and a bounded local BC ablation within the 50,000-parameter / 1 MB caps.
     - Choose the variant by the structural-tie rate (47.9% now) and the recomputed ln(k).
   - Data/learning: teacher filtering, opportunity oversampling, a KL/entropy floor and an opportunity-capture diagnostic.
   - Scoring, an approved gate change:
     - intercept-aware defense and pressure-based punishment;
     - blue-side mirrors and per-category variants;
     - a held-out opportunity bank drawn fresh from test-split episodes.
     - Rebaseline the heuristic and v1, and record the before and after scores.
   - Do not lower floors, add handcrafted spell or placement overrides, or change the tie order.
2. Optional: repeat the warm-up check headed at DPR 2 (it shows windows on the display). Mobile and 120 Hz stay with the separate cost measurement. The implemented `src/ai` speed-ups are protected runtime changes for the accumulated-diff review (task 6) and fresh scaling provenance. Do not add a forced-PASS shortcut under learned delay.
3. Prepare the timing-only `c7g.4xlarge` packet from the validated harness, for separate approval. It needs exact launch/SSM/download/termination commands, a checksummed bundle, the current official price ceiling, ≤60-minute lifetime/storage bounds and verified cleanup. Cloud admission stays pending until the A$10/month account budget can accommodate it. Preserve existing-method p95 ≤5 ms.
4. Attribute historical league regression locally: same parent, production recipe vs fresh on-policy loop, equal updates, paired development evaluation, at least two runs/arm.
5. Re-scope September 21 BC-control/architecture-ablation plans; do not judge on held-out cross-entropy alone.
6. Review the entire accumulated learner/export/runtime/evaluator/doc/diagnostic diff (local branch `edger-v2-accumulated` against `main`, including both protected parity commits) before publication; obtain explicit push/PR approval and record full SHA/manifest hashes.
7. Prepare fresh BC/scaling provenance and a new immutable campaign prefix. Never resume/retarget failed recovery or bypass its protected-runtime guard.
8. After local prerequisites/review, seek approval for a bounded reference-host campaign pilot, then separately production learning/full evaluation. The pilot must first re-measure the parity ULP multiple (k = 4) on the reference host's PyTorch. Preserve smoke/production isolation, gates and cleanup; timing-only profiling is separate.
9. Consider manual promotion only with a matching passed full-evaluation marker and separate approval; open an unmerged review PR, preserving live v1 until accepted.
10. Standardize browser smoke: iCloud refetches can exceed its 120 s watchdog while a byte-identical outside-iCloud copy passes in about 8 s; its watchdog lacks group/KILL cleanup. Use verified outside-iCloud freeze gates and retained assertion diagnostics to investigate a recurrence. The original October 4 193/196 cause remains unconfirmed. Repository smoke and full-suite runs from `~/Developer/edge_royale` (outside iCloud) passed once on October 24; keep watching for a recurrence.

# Validation

October 25, 2026 (latest), option C, from `~/Developer/edge_royale`. Exact commands are in the [step 2 record](docs/EDGER_PARITY_CONTRACT_REVIEW.md#step-2-landed--october-25-2026).
- `npm test` passed 223/223 in 296 s (system Node v25.2.1). `node --test tests/edger-v2-parity.test.js` passed 14/14.
- `/usr/local/bin/python3 -m unittest tests.test_edger_training_streaming -k logit_scale` passed 2/2 (PyTorch 2.11.0).
- In `L`: `node contract-check.mjs contract-check.json <seven models>` matches the packet. `npm run edger:parity:v2` passes all seven models (`gate/summary.txt`). `mutations.log` shows that all four mutations are caught.
- `L/SHA256SUMS` (`8a8dfcb7…`) now covers 30 files, including the step 1 evidence below. `git diff --check` passes. Bot-bench and smoke were not rerun: no runtime or client code changed after the step 1 run below.

October 25, 2026 (latest), float64 pool, from `~/Developer/edge_royale`. `L`, `X` and `N` are as defined in this file.
- `npm test` passed 218/218 in 344 s (system Node v25.2.1). It ran alongside the two checks below, so its duration is not comparable.
- `npm run --silent bot:bench -- --opponents random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6` passed: random 1.000, aggressive 0.833, defender 1.000. The output is `cmp`-identical to `R/speedup/bench-after.out` (October 24).
- `$N landed-check.mjs landed-check.json 10 <name>=$X/models/<name>.json …` (seven models) in `L` reports `PROBLEMS: none`. `shasum -a 256 -c SHA256SUMS` in `X` passed 376/376 beforehand.
- `$N --test tests/edger-v2-policy.test.js` on a `git archive` copy of `a3e01e5` fails exactly the pool and golden tests; the decision-identity test passes there too.
- `L/SHA256SUMS` covered 10 files at that point (superseded above). `git diff --check` passes. `npm run smoke:browser` was not run: no client code changed, and live v1 does not use this file.

October 25, 2026. `X` is as above; `N` is the durable Node v20.20.2 (defined under October 8). Exact commands are in each doc's Reproduction section.

- Repository changes are docs-only, including the later approval record; `git diff --check` passes. `npm test`, smoke and bot-bench were not rerun, since no code changed (the October 24 runs stand).
- Task 1 inputs:
  - the learned models match the confirmation checksums, and the fixed models reproduce the September 28 audit probabilities;
  - cache `aab1f8e8…` is verified, and all 160 episodes pass their manifest checksums;
  - the replay reproduces 9,343/9,343 rows, sample weights and policy labels, and 210 Fireball / 701 Arrows / 1,478 PASS choices.
- Task 2:
  - the scratch V0 copy reproduces the shipped runtime bit for bit on every fixture;
  - the parent reproduces the September 27 result (47/56, `9.155e-05`);
  - real `edger-v2-training.py parity` ran with Python 3.11 / PyTorch 2.11.0.
- Task 3: `$N measure-warmup.mjs sites headless-15.json 15` covered 60 fresh pages with 0 page errors. `v1-warm` is byte-identical to the repository (`webGame.js` `1143352c…`).
- `shasum -a 256 -c SHA256SUMS` in `X` passes 376/376. The frozen stage, freeze `75dd33fe…` and `A`/`M`/`R` were not touched.

October 24, 2026. `A`, `M` and `R` are as above; `N` is the durable Node v20.20.2 defined under October 8 below. Exact commands are in the [review reproduction](docs/EDGER_RUNTIME_REVIEW.md#reproduction).

- `shasum -a 256 -c SHA256SUMS` in `A` passes 23/23. From `M`, `shasum -a 256 -c "$A/SHA256SUMS-measurement"` passes 6,117/6,117.
- `python3 -I summarize-measurement.py`, run from a copy in `R/resummary`, gives output `cmp`-identical to `A/measurement-summary.json` and `A/measurement-tables.md`.
- `python3 -I spotcheck.py` in `R` reports `PROBLEMS: none`. `$N check.mjs` in `R` shows the same order in all 11 locales.
- Speed-ups, from `~/Developer/edge_royale`:
  - `npm test` passed 216/216 in 309 s (system Node v25.2.1). The first run, before the pin update, failed only the four pin-guarded runtime-cost stage/freeze tests.
  - `npm run smoke:browser` passed (4 s).
  - `npm run bot:bench -- --opponents random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6` passed: random 1.000, aggressive 0.833, defender 1.000. Its output is byte-identical to the original-sort scratch copy.
  - Mutation controls caught a reversed comparator and a warm-up that steps its engine.
  - Node timings and logs are in `R/speedup/` (see `NOTES.md` there). `R/SHA256SUMS` (`c535f957…`) covers 23 files. `git diff --check` passes.

October 17, 2026 (local; UTC October 16). `A`, `M` and `N` are as above. Exact commands are in the [results reproduction](docs/EDGER_RUNTIME_COST_RESULTS.md#reproduction).

- From `A`: `python3 audit.py > audit.log` gave 4,880 checks and zero problems, with `audit.json` identical to October 13. `$N freeze-check.mjs` gave zero problems, closure `ecb846b0…`, output identical.
- Host check: `python3 host-check.py start`, then `sample` and `finish` 60 s apart (120.4 s). Pressure 1/1/1, swap 0/0, 10.92 GiB free; Spotlight exclusion and AC pass; sentinels removed.
- `python3 launch-measurement.py` ran `./measure.sh stage measurement full 10800` once from `M/out`: complete, exit 0, cleanup verified.
- `python3 summarize-measurement.py` produced the summary JSON/tables. The raw frame recount equals the in-page summaries (327,311 frames).
- `shasum -a 256 -c SHA256SUMS` in `A` passes 23/23. From `M`, `shasum -a 256 -c "$A/SHA256SUMS-measurement"` passes 6,117/6,117.
- Repository changes are docs-only; `git diff --check` passes. `npm test`, smoke and bot benchmarks were not rerun, since no code changed. The measurement used the frozen stage and its accepted gates.

October 8, 2026. `Q`, `M` as above; `N` = `~/edge_royale-runs/20261006-runtime-cost-successor.noindex/out/bin/node` (durable v20.20.2, `38de4fc4…`). Exact commands/results and limits are in the [freeze review](docs/EDGER_FREEZE_REVIEW.md).

- From `Q`: `python3 audit.py > audit.log` -> 4,880 checks, zero problems; verifies all 1,920 headed and 15 fresh-gate checksums, 607 staged/139 copied files, 47 shared sources, all 122 Node-equal matches and four banks. `$N freeze-check.mjs` -> zero problems, generated-page reproduction and binary/browser pins pass. `$N worker-controls.mjs > worker-controls.json` -> nine synthetic controls pass.
- From `M/test-copy`: `$N --test --test-name-pattern 'freeze:|complete path:|browser GC pairs need|windowed matches must end' tests/edger-v2-runtime-cost-browser.test.js > "$Q/targeted-tests.log" 2>&1` -> 11 passed, 30 skipped, zero failures, 6.641 s.
- From `Q`: `python3 host-check.py start`, `python3 host-check.py sample`, `python3 host-check.py finish` -> 94.4 s, Spotlight/disk pass; pressure/swap/power refuse host admission. Both owned sentinels removed. `Q/SHA256SUMS` binds review scripts/results.
- Documentation-only changes; `git diff --check` and direct edited-document whitespace/section checks pass. Full `npm test`, live smoke, headed validation, dry run, mutation suite and streaming/bot gates were not rerun: frozen full/targeted/live/validation/dry-run records were independently verified, no executable/gameplay change. No profiling, app closure/reboot, download, cloud action, staging or commit.
- Accepted October 6–7 [gates](docs/EDGER_RUNTIME_COST_PLAN.md#fresh-stage-and-pre-display-gates--october-6-2026) and [headed/dry-run/freeze commands](docs/EDGER_RUNTIME_COST_PLAN.md#headed-validation-dry-run-and-successor-freeze--october-7-2026): verified-copy `npm test` 213/213, targeted 66/66, live smoke OK; validation 122/122 in 2,828.0 s with cleanup; dry run 8/8 with complete pairs; freeze `75dd33fe…`. Earlier repair mutations detected 8/8 reversions. Earlier confirmation/streaming validation and exact commands remain in the replication/diagnosis records.

# Risks / Notes

- Headed runs take over the display in kiosk fullscreen: about 50 min of validation, and about 2 h for the frozen measurement. Any app switch or focus change makes the active rendered condition incomplete (frontmost-PID check). macOS can ignore a fullscreen request while the previous window is leaving its space; the worker repeats it up to 12 s.
- Stage checks assume an unchanged tree during validation; they do not protect against arbitrary concurrent parent-directory replacement between the server's component checks and file open. Admission/worker/server controls now refuse ordinary linked/special entries; any future harness change requires a freshly validated successor; the present reviewed stage is unchanged.
- Cloud budget (owner, October 3, 2026): at most A$10/month for the whole AWS account, GST included. In a budget with tax excluded, that is about US$5.98; including it, about US$6.50 (at 1.52). Fixed costs are about A$21/month before any Edger run:
  - Project B staging, about A$15: one public IPv4 address, 41 GiB EBS and four secrets. Its `t4g.small` is currently billed at $0 under a free offer.
  - An orphaned public IP, about A$6: Elastic IP `REDACTED-IP`, tagged `Redshift=true`, on requester-managed endpoint `REDACTED-VPC-ENDPOINT` in the default VPC, created July 13, 2025. No Redshift workgroup, namespace or cluster remains. Public IPv4 has been billed since the account's free tier lapsed in August 2026.
  - The Edger runner costs about A$1.31/h on-demand (`c7g.4xlarge`, plus 200 GiB gp3, IPv4 and GST). September's 42.5 h cost about A$56.
  - The checked-in launcher allows 24 hours (safety shutdown plus SSM timeout, about A$31), so the timing packet must enforce its own 60-minute lifetime, including setup and cleanup. Budget alerts lag by hours, and a launch-deny action does not stop a running runner.
  - Orphaned endpoint and IP (October 3), checked with free calls: the owning service is AWS-run (`Owner: amazon`, `ManagesVpcEndpoints: true`, endpoint owned by this account). Every Redshift Serverless and provisioned record type is empty, including endpoint grants as grantor and grantee. No RAM shares, Route 53 zones, references from the Project B repo, 90-day CloudTrail events or two-week PrivateLink metrics exist. Private DNS is off; Project B shares the default VPC.
    - No owning-service deletion path remains, so cleanup stopped as authorized. Both resources are unchanged; no EC2-level delete or disassociate was tried.
    - Billing support case **REDACTED-SUPPORT-CASE** was filed 2026-10-03 01:21Z (Billing › Charge Inquiry, General question, web contact). It asks AWS to remove the endpoint, its 3 managed ENIs and the EIP, preserve the default VPC and Project B, and consider a discretionary credit; it cites the earlier case 175656738400151 (August 2025), which was closed without removal. Evidence, the pre-cleanup baseline and the read-only check `verify-cleanup.py` are in `~/edge_royale-runs/20261003-orphaned-redshift-eip-support-case/`. Rerun the check after AWS replies: it must show `targets_gone` and `preserved_unchanged` both true. October 3 review: `shasum -a 256 -c SHA256SUMS` in that directory passed 5/5; saved JSON confirms the AWS-managed endpoint/EIP/ENI linkage. The empty Redshift/sharing/activity checks are reported findings, not independently rerun or captured in those four JSON files. The case was filed as recorded above with narrow resource scope and a discretionary credit request; describe CloudTrail findings as management-event history, not proof of absent traffic. No AWS calls, submission or cleanup occurred in this review; docs-only validation was `git diff --check`.
  - Recommendations not yet implemented, and not authorized: tear down Project B staging after reviewing its Terraform destruction plan; make the full corpus-health scan manual; add actual/forecast budget alerts; defer Spot.
  - Run experiments locally by default. Each Cost Explorer API call costs US$0.01; use the free Billing console instead.
- October 17 admission: after the repository move out of `~/Documents`, iCloud (`fileproviderd`/`bird`/`cloudd`) used 2–2.5 cores for about 3 h after boot, applying a stale Project B tree. `brctl status` dumps about 188k lines and itself loads `bird`, so sample `ps` instead. Disk read 10.9–12 GiB free during the session.
- Local measurement conditions (October 3): during browser validation, load rose from 2.1 to about 8 as Spotlight (`mds`, `mds_stores`, `mdworker_shared`) indexed thousands of new run files. Swap was 7.2–7.7 GiB of 8 GiB. Validation timings are therefore not cost evidence. Keep Spotlight off profiling run directories and confirm quiet load/swap before admission. Chrome Headless Shell (about 190 MiB, `chromium_headless_shell-1208`) and headed Chrome for Testing (333 MiB, `chromium-1208`) live in `~/Library/Caches/ms-playwright`. Browser smoke and headless stages need the shell; headed stages pin the full Chrome tree by hash. Do not reinstall or remove either without restaging.
- October 5 reserve snapshots: an earlier reading of 2.84 GiB (below the 3 GiB starting reserve) was followed this session by `df -k ~/edge_royale-runs` readings of 12.96 GiB (05:06Z), 14.95→14.63 GiB across the 333 MiB Chrome install, and 17.4–18.4 GiB during the runs. Only transient readings; recheck before any reserve-gated run.
- The data volume is nearly full: October 2 checks swung from 2.37 to 4.38 GiB free (below then above the cost plan's 3 GiB starting minimum), then read 4.14–4.19 GiB during the Node slice. October 3 read 3.48–3.88 GiB during the browser slice, then 7.66 GiB afterwards. September 29's 8.5 GiB is historical. The concurrent Project B rehearsal previously swung free space by GiB (a timing correlation, not a measured cause). Recheck before any reserve-gated run and never touch its files. The paired iPhone runs iOS 26.6.2 (23G90), which has no Xcode device-symbol folder yet; Xcode could copy several GiB (the removed 26.6 set was 5.7 GiB).
  - Cleanup beyond that needs approval. Reclaimable candidates:
    - `~/.npm/_cacache` (939 MiB)
    - `~/Library/Caches/Google` (991 MiB; close Chrome first)
    - `~/.cache/codex-runtimes` (2.2 GiB)
    - `~/.ollama` (2.1 GiB)
    - `~/Library/Caches/Project B Validation` (1.0 GiB, holds a lock)
    - `~/.expo`, `~/Library/Caches/ReactNative` and `~/Library/pnpm`
    - `xcrun simctl delete unavailable`, after a per-device review
  - Keep the `/private/tmp` Node copies.
  - During the run, macOS `ANECompilerService` and StorageManagement used about one core, and an unidentified load spike (1-minute load up to 99) hit at 04:32–04:38Z. Local timings are not deployment cost.
- iCloud:
  - The in-repo Node binary and bundle files turn `dataless` within minutes. That is eviction, not loss.
  - Run Node from outside iCloud: `~/edge_royale-runs/20260929T0346Z-cadence-confirmation/node-v20.20.2/bin/node` (SHA-256 `38de4fc4…`). The `/private/tmp/edger-confirmation-review-y_4hw1gg/node` copy no longer exists.
  - The repository's `node_modules/playwright*` files are evicted too, and a read pass does not keep them local. Use `~/edge_royale-runs/toolchains/playwright-1.58.2/` or a runtime-cost stage. October 4 full-suite supervisor failures coincided with a `dataless` process helper; isolated controls and the verified outside-iCloud full suite pass. A later repository run with the same files `dataless` passed 196/196, so eviction is plausible but unconfirmed. Keep this workflow limitation in the browser-validation standardization task.
  - `/private/tmp` does not survive a reboot. `~/edge_royale-runs/` and `~/edge_royale-recovery/tmp-scratch-2026-09-29/` are the durable, checksummed copies outside iCloud.
  - Avoid recursive scans of `artifacts/`. Check `reports/superseded/` after any file move.
- To detach a long run from an agent shell, fork before `setsid` (a direct `setsid` from a background job's group leader fails with EPERM). Six workers on the fanless M1 ran cleanly on AC, lid open, under `caffeinate -s -i`; lid-closed runs slept earlier.
- `evaluate` now requires `--seed-set`. Commands recorded in the 20260926/20260927 experiment runners predate this and will not rerun unchanged; their evidence is unaffected.
- The confirmation analysis verdict is a research rule, not a promotion gate. Confirmation results must not select models or controllers.
- The diagnostic learner skips `require_clean_git()` and records HEAD plus the tracked-diff hash. Exports are `diagnostic_only_not_promotable`; production training still needs a clean tree.
- No writes to failed campaigns/evidence. GitHub success is not workload success: SSM, exact completed markers and verified runner/volume cleanup are authoritative. No passing full-evaluation marker exists. Better diagnostic play satisfies no promotion gate by itself.
