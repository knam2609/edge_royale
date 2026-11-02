# Current State

- November 2, 2026: **proposal 4 is implemented locally**, after the report-only checkpoint `0aeceb1` on `edger-v2-accumulated`. With its bank repair it was committed locally on November 3 (not pushed). It adds intercept-aware defense, pressure-only punishment, 50 mirrored synthetic states and a required test-split Fireball capture gate. All original category floors remain unchanged. See the [implementation and rebaseline](docs/EDGER_TACTICAL_REVIEW.md#proposal-4-scoring-and-held-out-opportunities--november-2-2026).
- November 2, 2026 (latest): **the proposal 4 review found one defect, now repaired.** Bank snapshots (schema v1) dropped `spawn_sequence`, `effect_sequence` and `recent_combat_events`, which the v2 observation reads (globals 84, 85, 87). All 80 restored states therefore differed from the live game for v2 policies. Six v4 children changed 0–8 of 80 decisions, and one child's cluster captures fell from 10 to 4. v1 and the heuristic were unaffected. [Repair record](docs/EDGER_TACTICAL_REVIEW.md#review-repair-of-the-bank--november-2-2026).
  - Schema v2 snapshots carry the three fields. The builder rejects any snapshot whose legal actions, v2 observation or v1 features differ from the live engine's, and validation rejects v1 banks.
  - The rebuilt bank has the same 80 entries. It is frozen as logical hash `4f75fbc6…`; v1, the heuristic and the six children now decide identically on live and restored states, and the baselines are unchanged.
  - Two review notes were added to the docs: the blue mirrors differ from red in 4–8 center-column placements, a property of the existing grid, and capture uses decision-time positions.
  - November 3, 2026 owner decisions: keep 0.80/0.70, commit proposal 4 with the repair locally (done), then run a frozen six-run same-host variance pilot (task 1). On this bank the gate requires 22/27 lethal and 38/53 cluster captures; the heuristic passes cluster (40/53), but misses lethal (20/27). These are engineering acceptance targets, not statistically established strategic optima.
- The floor experiments are closed with the BC data recipe and KL options default-off. The strong targeted floor preserves Fireball but costs −0.160 primary against same-host controls. The frozen cross-host verdict remains `inconclusive`; same-host controls were a recorded post-analysis addendum. [Full record](docs/EDGER_TACTICAL_REVIEW.md#stronger-targeted-floor--november-2-2026).
- The current host is a Mac mini M6 (`Mac18,5`, 24 GB, macOS 27.2). Earlier M1 training does not reproduce bit for bit here; a same-host repeat did. Evaluation matched for the two fixed children tested across hosts (400 games). This does not establish universal portability or estimate same-host seed variance.
- Live v1 is unchanged (`895d5541b5650e620db69ccfe999833c05f93abcae08374710d79d0dd913c3aa`). V2 remains shadow-only, with observation v4 (spell globals; geometry dropped), the float64 pool and reviewed hybrid parity contract. No passing full-evaluation/promotion marker exists. Nothing has been pushed; the September recovery campaign remains failed and immutable.

# Source of Truth

- Product and workflow: `AGENTS.md`, [README](README.md), [bot spec](docs/BOT_LEVELS.md), [training](docs/EDGER_TRAINING.md), [roadmap](docs/IMPLEMENTATION_PLAN.md), [backlog](docs/SPRINT_BACKLOG.md).
- Bank repair (November 2): `~/edge_royale-runs/20261102-opportunity-bank-v2.noindex/` (`plan.md`, `FROZEN-plan.txt`, source copies, the schema v2 bank and its repeat, `BANK-FROZEN.txt`, `compare-structure`, `fidelity`, `v2-impact`, `baseline`, the preflight report, validation logs, `README.md` and `SHA256SUMS`). It supersedes the `Q4` bank below; `Q4` is unchanged.
- Current tactical evidence: `~/edge_royale-runs/20261102-proposal4.noindex/` (`plan.md`, coverage addendum, manifests, frozen bank, baseline, validation, source checksums and `README.md`). The 1,024-game collection uses clean `0aeceb1`; the unchanged 128-game prefix resumed. Only test episodes enter the bank; it shares no episodes with the earlier 160-episode subset.
- Floor/host evidence: `~/edge_royale-runs/20261102-targeted-floor-beta1.noindex/` (`plan.md`, `FROZEN.txt`, `analysis.md`, `host-check/`, `plan-m6.md`, `FROZEN-m6.txt`, `analysis-m6.md`, `README.md`, 7,069-file `SHA256SUMS`). Earlier experiment paths and exact commands remain in the [tactical review](docs/EDGER_TACTICAL_REVIEW.md).
- Detailed unresolved host, display, numerical, browser, cloud-budget and cleanup constraints are now in [local constraints](docs/EDGER_LOCAL_CONSTRAINTS.md). This preserves the prior handoff's unresolved facts while keeping this file short.
- Runtime methods/evidence: [plan](docs/EDGER_RUNTIME_COST_PLAN.md), [freeze review](docs/EDGER_FREEZE_REVIEW.md), [results](docs/EDGER_RUNTIME_COST_RESULTS.md), [acceptance/warm-up review](docs/EDGER_RUNTIME_REVIEW.md). Never edit or rerun into freeze `75dd33fe…`, the reviewed stage, or its spent measurement output.
- Learning/provenance: [parity](docs/EDGER_PARITY_CONTRACT_REVIEW.md), [cadence](docs/EDGER_CADENCE_REVIEW.md), [replication/confirmation](docs/EDGER_REPLICATION_REVIEW.md), [evaluation diagnosis](docs/EDGER_EVALUATION_DIAGNOSIS.md), [recovery closeout](docs/EDGER_RECOVERY_CLOSEOUT.md).

# What Works

- All 50 synthetic floors are reachable by an enumerated legal action. Blue mirrors have identical canonical observations, but 4–8 center-column placements per pair differ (the existing grid). Restored schema v2 bank snapshots reproduce legal actions, the v2 observation and v1 features for all 80 real states; the builder enforces this. Timing keeps its original five states.
- The bank has 80 states from 70 test episodes: 27 lethal (23 episodes), 53 cluster (50 episodes). Schema v2 logical hash `4f75fbc668f597de8e3dad965049453558ab60d016658fde102c751dd2a159c9` (superseding v1 `0b247247…`); rebuild is byte-identical.
- `heldout_fireball` distinguishes card choice from legal, correctly aimed capture, applies 0.80/0.70 lethal/cluster minima, and fails closed on missing classes/artifacts, corrupted checksums, bad provenance or duplicates. Promotion refuses old reports missing the gate. Production wiring freezes a test bank in `full-cache` before offline/league work; no cloud execution occurred.
- Chromium 1208 and FFmpeg 1011 are restored. Both browser trees match recorded pins and browser smoke passes. Native Node v20.20.2 remains first on bash PATH. Use `PYTHON=/usr/local/bin/python3` for the installed PyTorch/pyarrow interpreter.
- Deterministic simulation/replay, existing safety/scaling gates, cumulative corpus/cache/learner tooling and frozen-stage admission/cleanup remain covered by the linked records and current tests.

# Known Gaps

- **Candidate quality remains unresolved.** On the expanded synthetic suite, v1 is 0.522 versus heuristic 0.852 and fails spell/finishing/pocket floors. On the new real-state bank, v1 captures 8/27 lethal and 22/53 clusters; heuristic captures 20/27 and 40/53. Neither passes the new bank gate. Scores and corpus selection changed; no policy improved in this work.
- Eighty one-decision states are bounded local evidence. Interception is a geometric time proxy; capture uses current-state geometry without forecasting projectile travel or measuring strategic value. States within an episode are correlated. Production corpus coverage and cloud wiring remain unvalidated end to end.
- Same-host seed variance is unmeasured. Cross-host child shifts of −0.166 to +0.080 changed earlier three-run readings; evaluation-seed intervals omit training-run uncertainty. The shared-policy explanation is inferred. No more RL recipe comparison before task 2.
- V4 retains structural placement ties; geometry was dropped after the measured tradeoff. Spell-global RL gains remain a lean, not a replicated recipe conclusion. Opportunity diagnostics still decode a whole validation cache, and production V-trace has no KL option. [Detailed limits](docs/EDGER_LOCAL_CONSTRAINTS.md).
- Runtime acceptance remains desktop/60 Hz only on prior M1 evidence. Mobile, reference-host, 120 Hz, sustained thermals and headed warm-up confirmation are open. Reference-host parity k = 4 must be re-measured. Fragile-margin review remains manual; pool/runtime costs have not been re-certified. [Detailed limits](docs/EDGER_LOCAL_CONSTRAINTS.md).
- Historical league regression, September 27 predecessor provenance, and October 4 supervisor failures remain unresolved. Confirmation establishes research findings only and used a spent holdout; it does not repair predecessor provenance or clear promotion. [Details and durable evidence](docs/EDGER_LOCAL_CONSTRAINTS.md).

# Next Tasks

1. Before further tactical/campaign RL recipe comparisons, measure seed variance on one host (recommended pilot: six independently seeded old-recipe runs on the M6, roughly 25 minutes including evaluation). Freeze code/data hashes, parent selection, seed mapping, evaluation suite, analysis and budget first. Specify whether parents are fixed (RL-only variance) or independently trained (end-to-end recipe variance). Report every run and training-run spread; six runs are a pilot, not a precise variance estimate. Compare only same-host arms; do not use the frozen test bank to tune the recipe. Cross-host shifts are not an estimate of this variance.
2. Optional: repeat the warm-up check headed at DPR 2. Mobile/120 Hz require separate measurement. Keep the decision-preserving speed-ups protected for review and fresh provenance; do not add forced-PASS shortcuts.
3. Prepare the timing-only `c7g.4xlarge` packet for separate approval: exact launch/SSM/download/termination, verified bundle, current official price ceiling, ≤60-minute lifetime/storage and cleanup. Cloud admission remains pending the A$10/month whole-account budget. Keep existing-method p95 ≤5 ms.
4. Attribute historical league regression locally: same parent, production recipe versus fresh on-policy loop, equal updates, paired evaluation, ≥2 runs/arm, all on one host after task 1.
5. Re-scope September 21 BC-control/architecture-ablation plans; do not judge by held-out cross-entropy alone. Candidate work must satisfy both the new capture gate and match-quality gates.
6. Review the full accumulated diff against `main`, including protected runtime/parity commits and proposal 4, before publication. Obtain explicit push/PR approval and record full SHA/manifest hashes.
7. Prepare fresh BC/scaling provenance and a new immutable campaign prefix. Freeze the compatible test bank before candidate evaluation. Never resume/retarget failed recovery or bypass its protected-runtime guard.
8. After local prerequisites/review, seek approval for a bounded reference-host pilot, separately from production learning/full evaluation. Re-measure parity k on that PyTorch/BLAS; preserve smoke/production isolation, gates and cleanup. Timing-only profiling is separate.
9. Consider manual promotion only with a matching passed full-evaluation marker and separate approval; use an unmerged review PR and preserve live v1 until accepted.
10. Standardize browser smoke: retain assertion diagnostics and investigate any recurrence of iCloud/refetch/watchdog failures; add group/KILL cleanup to the 120 s watchdog. The current M6 install and smoke pass, but the original October 4 193/196 cause is unconfirmed. Preserve verified outside-iCloud freeze gates.

# Validation

November 3, 2026 decision review, from `~/Developer/edge_royale`; only this handoff changed.

- `node --test tests/edger-tactical-scoring.test.js tests/edger-training-pipeline.test.js`: 16/16. `shasum -a 256 -c SHA256SUMS` in `~/edge_royale-runs/20261102-opportunity-bank-v2.noindex/`: 22/22. `git diff --check`: pass.
- Full suite, bot benchmark and browser smoke were not rerun for this advice/docs-only update; their latest implementation/repair results remain below. No commit or training run was made.

November 2, 2026 (latest), the bank repair, Mac mini M6, native Node v20.20.2, from `~/Developer/edge_royale`; `QB` = `~/edge_royale-runs/20261102-opportunity-bank-v2.noindex`.

- `PYTHON=/usr/local/bin/python3 npm test`: 237/237 in 126 s (`QB/npm-test.log`). `node --test tests/edger-tactical-scoring.test.js tests/edger-training-pipeline.test.js`: 16/16 (`QB/tactical-tests.log`).
- The new mid-game snapshot test fails on `Q4`'s original module (`spawn_sequence`) and passes on the repair.
- `npm run edger:opportunity-bank -- --manifest ~/edge_royale-runs/20261102-proposal4.noindex/manifest-1024.json --out <QB>/opportunity-bank.json`, then the same into `opportunity-bank-repeat.json`: both exit 0, and the builder's live-snapshot check passes for all 80 entries. `cmp` shows them byte-identical. `BANK-FROZEN.txt` was written at 02:21:56Z, before any score.
- `python3 -I compare-structure.py`, `node fidelity.mjs`, `node v2-impact.mjs` and `node baseline.mjs` (in `QB`): same entries; 80/80 v2 observations, legal actions, heuristic and v1 actions; 0 differing decisions for six v4 children; baselines unchanged.
- `PYTHON=/usr/local/bin/python3 npm run edger:evaluate:v2 -- --candidate <Q4>/bootstrap-model.json --champion artifacts/edger-training/promoted/edger_policy_current.json --opportunity-bank <QB>/opportunity-bank.json --profile smoke --workers 1 --out <QB>/preflight-report.json`: exit 2, zero matches, bank `4f75fbc6…` bound, promotion false (as expected).
- `git diff --check`: pass. Bot-bench and smoke were not rerun: no live-bot, runtime or client code changed in the repair.

November 2, 2026, proposal 4 implementation, Mac mini M6, native Node v20.20.2, from `~/Developer/edge_royale`. Logs and exact collection/bank/pin/rebaseline commands are in `~/edge_royale-runs/20261102-proposal4.noindex/README.md`.

- `PYTHON=/usr/local/bin/python3 npm test`: 235/235; final log `npm-test-final.log`.
- `node --test tests/edger-tactical-scoring.test.js tests/edger-training-pipeline.test.js`: 14/14 (`tactical-tests-final.log`). Initial evaluator/promotion checks also pass; full suite covers the missing-bank preflight and legacy-report refusal.
- `npm run bot:bench -- --opponents random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6`: pass, 1.000 / 0.833 / 1.000.
- `npx --no-install playwright install chromium`: restored the pinned builds. Recorded pin verification finds no problems in either tree. `npm run smoke:browser`: pass (`browser-smoke.log`).
- `npm run edger:opportunity-bank -- --manifest ~/edge_royale-runs/20261102-proposal4.noindex/manifest-1024.json --out ~/edge_royale-runs/20261102-proposal4.noindex/opportunity-bank-repeat.json`: byte-identical to the frozen bank via `cmp`.
- `node ~/edge_royale-runs/20261102-proposal4.noindex/baseline.mjs`: rebaselines heuristic/v1, separates scorer-only and fixture/expansion changes, and verifies no episode overlap with the old subset.
- A full CLI smoke-profile evaluation with the frozen bank rejects the bootstrap before matches and binds the bank hash (`preflight-report.json`, expected exit 2).
- `git diff --check`: pass. Production-driver and bank-CLI syntax checks pass. No cloud end-to-end evaluation, new training or promotion was run; those require the remaining prerequisites and approval.

# Risks / Notes

- The new capture-rate requirements explicitly reuse the existing synthetic category numbers; they are new rate gates, not claims of metric equivalence or thresholds fitted to baselines. Both baselines remain rejected. Freeze/review future banks before candidate comparisons; never tune bank selection against candidate scores.
- The M6 changed earlier training outcomes despite identical rollouts, parent outputs and commands; chip-specific kernels are a hypothesis, not an isolated cause. Pin host, Node and Python/BLAS provenance for future experiments. Plain `npm test` uses Homebrew Python without torch/pyarrow and fails 11 tests here.
- Cloud budget, the AWS-managed orphan endpoint/EIP and support case, Project B/default-VPC preservation, historical disk/iCloud conditions, display ownership and cleanup limits remain unresolved in [local constraints](docs/EDGER_LOCAL_CONSTRAINTS.md). No AWS calls or cleanup were made in this work.
- No writes to prior frozen runs or failed campaigns. No push/PR, model/runtime promotion, cloud dispatch, paid service, or new learner run occurred. The only new commit is the original session-report docs checkpoint `0aeceb1`; proposal 4, its bank repair and the updated handoff remain reviewable in the working tree. The `Q4` v1 bank file is kept as evidence but is no longer valid input (schema v1 is rejected).
