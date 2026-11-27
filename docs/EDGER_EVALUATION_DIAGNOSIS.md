# Edger full-evaluation diagnosis — September 11, 21 and 26, 2026

The September 4 recovery campaign remains failed and immutable. Local fixes
address stale V-trace targets, invalid tactical fixtures, unnecessary convolution
work, and the absence of an inexpensive evaluation preflight. They do **not**
make the failed candidate promotable or demonstrate learned improvement.

## Verified evidence

Campaign: `s3://edge-royale-edger-REDACTED-ACCOUNT-ID-ap-southeast-2/campaigns/20260904-v2-recovery`.
SHA: `0270d828686a3ef984b89c6043a46a1c306dc0e6`.
Recovery manifest SHA-256: `7fa8b2dc7918e864212a6be458d3ef6d27e56e1ba2e012bcd2fa07889026339a`.

Downloads used `aws s3api list-object-versions` and `get-object --version-id`.
Inventories contain one version per selected object and no delete markers.
Seven completed markers pass `assertCompletedStageMarker`; all 15 downloaded
stage-artifact bindings match marker byte counts and SHA-256. S3 SHA-256 and
metadata were independently checked where present. The log also matches its
version's single-part MD5 ETag. No S3 writes occurred.

Paths in this table are relative to the campaign prefix:

| Object | Exact version | SHA-256 |
| --- | --- | --- |
| `stages/league-production/candidate.json` | `6gLBFfKr0o9oe_D3COwa0AJimNZOLwtr` | `b057436961e5f8315946c8e8f1772675e8326e3c84daa0599fbcf70748c3c052` |
| `stages/league-production/candidate.pt` | `Pk7LH2S09zC6mdv_c7kSLZRBhrRrZlro` | `79a095afb0cea620c59e2aee96603954065666429185d6fd4caa7306c74b6e04` |
| `stages/league-production/league-report.json` | `AFrh4Vv5IWY9lyTB9U_Q6Ub6fsdiQnZX` | `26674625cd800ff73d21138430d7ac3a04cfe9092049f82bf6f317f1f8c17e93` |
| `stages/league-production/manifest.json` | `UconHIeviPPXMgm74n9iQgWnqA2J.B5P` | `3f0a5a7f10f06576989b7f8394c5b2e73da927d748de93a5cc12d365ef0f1762` |
| `status/attempts/full-evaluation-2026-09-06T02-33-00-530Z.json` | `F46Fyi4A9kW34SJxZXjNUR0i5Bs5msbq` | `e567a926d58ad2015da8693b190e5bd60cb8b4960a44105db5a3fa50296f38e9` |
| `logs/github-33972346707-1.log` | `j1_oPDJP2J3o6HuM0udTw0_rPB92sZeZ` | `882105bb5b89e5bcfc1ed58912049ce7f53cc1339f62d56af4e780c924b6fe2a` |
| `failed-stages/full-evaluation/2026-09-06T02-33-00-530Z/evaluation-report.json` | `AUshW7MJeC1qrbXa.X.S7fRAEo_qlP7s` | `adbdaf8549bd351009ed13b7ec183dd9268e3180f754dc01b0fd95f36e561ef6` |
| `failed-stages/full-evaluation/2026-09-06T02-33-00-530Z/throughput-report.json` | `jsdIBjo7qJ7fvCk5qhj5AdoAtvwnHKZ1` | `7c4b3db4e585232808f842eb12f313eeab49ecd21082638c003d6b0437241f87` |

The supplied log checksum had 63 characters; the independently verified full
checksum above adds the missing final `a`. The prior closeout also overlooked
`failed-stages`: the complete 11,300-match report survived there. It binds the
exact candidate checksum and campaign SHA. It has no passed completion marker.
`stages/full-evaluation/` and `ready-for-promotion/` remain empty.

[EDGER_RECOVERY_CLOSEOUT.md](EDGER_RECOVERY_CLOSEOUT.md) preserves the original
uncommitted closeout: all seven marker versions, cache and offline checksums,
prior runner/SSM/volume identifiers, validation, and predecessor-prefix risks.
GitHub run `33972346707` succeeded only as a detached control plane; terminal
SSM was failed/1 and the runner and encrypted root volume were deleted.

Local evidence and diagnostic scripts were in
`/tmp/edger-full-evaluation-closeout.Lma2Iw/`. **As of September 21 that
directory is empty**: system `/tmp` cleanup removed every file, along with the
`/tmp/node-v20.20.2-darwin-arm64` toolchain and the `/tmp/edger-native-python`
wrapper the September 11 validation used. The pinned S3 versions in the table
above remain the durable record and must be re-downloaded read-only if that
evidence is needed again. Temporary local files were never a substitute for
them.

## Gate findings

| Failed gate | Immutable result | Diagnosis and current disposition |
| --- | --- | --- |
| PyTorch/JS parity | Maximum error **2464**, argmax agreement true | Measured numerical disagreement plus incomplete evaluator coverage. See [Parity review](#parity-evidence-and-review-corrections--september-21). ULP diagnostics alone do not establish runtime fidelity or candidate conditioning. Legal delay logits reach **467,956,320**. The September 11 exporter reproduced both historical JSON artifacts; generated-module contents matched the candidate. September 21 found separate lossy decimal serialization, so the corrected exporter now changes those bytes. The strict gate correctly rejects this artifact. |
| Champion | **237/800**, score **0.29625**, paired lower bound **0.26625** | Candidate quality regression. Whole seed pairs are resampled correctly; side-paired specs and winner scoring inspected. No scoring/bootstrap defect found. |
| Weak baselines | Random **1.0**, aggressive **0.13**, defender **0.90** | Failure is against aggressive, far below **0.65**. Targeted same-seed candidate/parent comparison reproduces the regression. |
| Tactical | Candidate **0.327**, heuristic **0.690** | Both evaluator defects and poor candidate actions. Two-target spell fixture maxed at **0.64**, below **0.70**. Two fixtures used the old non-grid two-tower arena; draw queues duplicated hand cards. These are fixed; candidate quality still fails. |
| Generated JS timing | p95 **5.5573 ms**, max **8.3111 ms** | Real reference-host failure under the existing methodology. Timing measures warmed selection/inference with legal actions pre-enumerated, separately from worker throughput. Skipping exact-zero convolution products removes unnecessary work without reordering nonzero sums. Cloud timing after the fix remains unverified. |

The cloud throughput precheck passed at **6.740519366512897 matches/s**, projected
**27.94047803927083 minutes**. Throughput is distinct from single-decision p95.

The September 21 bounded experiment re-measured the parity and tactical gates on
the exact offline/BC parent as well. **The parent fails both**: parity maximum
error `9.1552734375e-05` against the unchanged `1e-5` tolerance, and tactical
aggregate `0.000` against heuristic `0.873`. Neither gate was weakened to obtain
these numbers. See
[Bounded local experiment](#bounded-local-experiment--executed-september-21).

### Training defect and bounded reproduction

Offline accepted **zero** epochs: attempted KL **0.1802700719291246** exceeded
**0.05**, so its retained artifact preserves recovered BC behavior. Its validation
joint loss was **3.689103049452064**. League training increased joint loss to
**308,191,124.83338094**, dominated by delay loss **306,076,811.64929664**.

Previously, `run_vtrace` computed all targets and clipped importance ratios
before an epoch, then consumed them through about 11,318 optimizer updates.
The gradient kept a stale negative advantage even as the learner's probability
of that action approached zero. This violates the current-policy correction in
[IMPALA section 4](https://proceedings.mlr.press/v80/espeholt18a.html). Targets now
refresh immediately before each episode update. Microbatches accumulate a
trajectory-normalized gradient; parameters change only after the whole episode.
Non-finite losses/gradient norms stop without saving a candidate. No loss,
quality, parity, or promotion thresholds were relaxed.

A negative-advantage regression using the nine-card head checks
that current importance weighting attenuates the gradient as the action becomes
unlikely. Another regression verifies one update per episode, target refresh
after that update, and agreement between full-episode and microbatch gradients.

A separate local diagnostic fetched **18 exact-version, checksum-verified real
episodes**, independently replayed them, and derived **772 rows**. Twelve train
episodes provided **463 rows**; six held-out episodes provided **309 rows**.
Starting from the exact offline parent with learning rate `0.001`:

| Local diagnostic | Updates | Held-out joint loss | Maximum raw logit |
| --- | --- | --- | --- |
| Parent | 0 | 2.62565 | 643.799 |
| Former cached-target schedule | 15 | 3.10764 | 835.220 |
| Fresh episode schedule | 12 | 2.77535 | 570.839 |

This is a bounded correctness diagnostic, with uniform sample weights and
different update granularity. It is not the full balanced corpus, a campaign
retry, a controlled quality experiment, or learned-improvement evidence. No
candidate/checkpoint was saved from it. Learning rate, trajectory weighting,
and remaining tactical weaknesses still need local study.

### Gameplay and numerical diagnostics

Before edits, each candidate played the first **40 champion** and **40
aggressive** specifications from the full seed plan (`20260718`), with replay
verification on every match:

| Model | Champion score | Aggressive score |
| --- | --- | --- |
| Failed league candidate | 0.325 | 0.050 |
| Exact offline/BC parent | 0.575 | 0.875 |

All **160** matches had zero illegal actions and passed replay. These are
small diagnostic samples, not promotion confidence bounds.

The parent's original opening parity fixture passes at **1.9073486328125e-6**.
Expanded checks on 18 real mid-match states per model found maximum errors
**2688** (candidate) and **0.0001220703125** (parent), with no head argmax
mismatches across the 36 fixtures. Thus the parity limitation also exists before
the failed league update. It cannot be dismissed as export corruption or solved
by claiming the parent already satisfies comprehensive parity.

Convolution outputs and selected indices remain exactly identical on **12**
real candidate/parent opening fixtures across both sides and three seeds. A
separate dense-weight/sparse-input fixture matches the original `0270d828`
implementation byte-for-byte and is retained as a regression hash. Native Node
**20.20.2 arm64** matches the cloud Node version. Before optimization, local
legacy-fixture p95 was **4.09–4.35 ms**; after optimization initial runs were
roughly **0.95–1.80 ms**, including production-fixture preflight under load.
Final production-fixture runs measured p95 **1.0028 / 1.0489 / 1.2603 ms**.
These are local diagnostics, not reference-hardware certification.

## Parity evidence and review corrections — September 21

The initial September 21 diagnosis explained observed numerical differences but
claimed too much: `83.886` is not a mathematical parity cutoff, and the added
mid-match fixtures all forced PASS with placement cell zero. Both findings were
reproduced in the follow-up review before beginning new candidate training.

### Measured evidence and limits

The original 18-state checks on the local 100% BC smoke actor measured maximum
absolute error `1.1920928955078125e-7` at maximum legal magnitude `0.8166`.
Amplifying its final heads by 2,048 produced magnitude `1672.4` and error
`0.000244140625`; multiplying them by `6e8` produced magnitude `4.8996432e8`
and error `64`. These observations show sensitivity to scale. They do not
establish a universal error floor or bound for other actors or branches.

The pinned real candidate's subsequent **PASS-only** 19-fixture bank measured
magnitude `541,883,392`, maximum error `2752`, and identical argmax. Dividing
these unrelated global maxima gave the previously reported 43 ULP; this is not
a condition-number measurement. Its tactical score remained `0.37` versus
heuristic `0.873`, and local Node 25 arm64 p95 was `1.6355 / 1.6641 ms`.
These remain historical diagnostics, not results from the corrected branch bank
or reference-host certification. The eight pinned objects were re-downloaded
and checksummed in the preceding September 21 session; the follow-up review
made no new S3 reads or writes.

Float32 spacing describes representable numbers, not a minimum discrepancy
between implementations: they may produce exactly the same number. Accumulation
and cancellation can also produce errors exceeding a few output ULP. PyTorch
explicitly [does not guarantee identical results across summation orders and
platforms](https://docs.pytorch.org/docs/2.14/notes/numerical_accuracy.html).
A two-roundoff estimate `1e-5 / (2 * 2**-24)` gives `83.886`, but neither proves
that larger logits cannot pass nor that smaller logits will pass. The old JS
8-ULP feasibility label also used a different assumption from that estimate.

### Reproduced evaluator defects and corrections

- An otherwise zero-weight actor with PASS bias `1024` passes with **zero**
  maximum error. This disproves the proposed hard magnitude cutoff.
- A runtime/reference pair differing only in the first non-PASS card embedding
  passed the old bank with **zero** error, even when that discrepancy changes
  the branch's placement and delay logits by **1000**. Every old fixture had
  `forced_card_index=0` and exactly one legal placement cell.
- The bank now retains each PASS fixture and adds **every legal card branch**
  at that state, with the correct placement mask and delay conditioned on the
  JS-selected legal placement. Independent masked argmax comparison checks that
  PyTorch chooses the same placement. The existing three-seed state schedule
  remains; reports distinguish sampled states from branch fixtures.
- Reports retain absolute errors and magnitude diagnostics, add the precise
  worst-error coordinate and values, and compute ULP errors at each coordinate's
  own magnitude. They no longer infer a faithful runtime, an ill-conditioned
  candidate, or impossible parity from a magnitude/ULP threshold.
- Training now records `maximum_legal_logit_magnitude`, `logit_scale_warning`,
  and its advisory threshold. The misleading `parity_verifiable_logit_scale`
  field is removed. **Do not enforce `83.886` as a training-abort rule.**

The `1e-5` measured absolute-error gate, identical masked argmax and stable ties
are unchanged. The new regressions reproduce the two counterexamples above;
coverage is strictly expanded. The existing local 100% BC smoke actor passes
81 branch fixtures across 19 states, covering PASS plus all eight cards, with
maximum error `2.384185791015625e-7` and identical masked argmax. This is not
the campaign parent or evidence of playing strength. Full results are recorded
in `progress.md`.

**A separate export defect, now fixed.** `round_float` rounded weights to eight
decimal *places*, not significant digits. On the checked-in BC checkpoint that
altered **19,547 of 36,515** actor weights (**53.5%**), worst case **1.29e-3**
relative on `conv1.weight`; on the campaign league candidate it altered **8,069
of 36,402** (**22.2%**), worst case **1.147e-3** relative on `fusion.weight`.
The deployed JSON was not the trained model. Export now writes the shortest
decimal that reloads as the identical float32 and refuses to emit an actor that
does not reload exactly. Re-exports are byte-identical to the trained weights
(logit difference **0**, previously 1.49e-07). Size stays inside the 1 MB cap
either way: the BC actor grows **745,270 → 769,111** bytes, and the
larger-weighted league candidate shrinks **746,746 → 745,922**.
This did not cause any failed gate; it consumed part of the same ULP budget and
meant every v2 actor exported so far carried silent quantisation. Live v1 is a
v1-schema model and is unaffected. Re-exporting an old checkpoint no longer
reproduces its historical JSON bytes, so this change needs a new SHA and
campaign prefix like every other change here.

## Local implementation and validation

- V-trace: fresh targets and one accumulated optimizer step per episode; no whole-epoch target Parquet. Each epoch records a pre-clip gradient-norm summary (`updates`, `all_finite`, `minimum`/`mean`/`maximum`, `clip_threshold`, `clipped_updates`) so a bounded comparison can separate a diverging learner from a merely clipped one. `clip_grad_norm_(error_if_nonfinite=True)` remains the abort; the summary adds no gate.
- Tactical: six-tower production arenas, valid eight-card decks, three spell targets, and exhaustive legal-action feasibility checks. Minimums and heuristic-relative improvement remain mandatory.
- Evaluator: parity/shape/finiteness diagnostics and tactical/timing preflight run before match workers. Failures write a rejected report with explicit skipped match gates and zero generated matches.
- Runtime: skip multiplication by exact zero inside convolution. Same accumulation order, model weights, stable ties, and inference outputs.
- Parity: opening plus candidate-reached states, PASS and every legal card branch, coordinate-level ULP diagnostics, and measured-error/argmax failure reasons. Unchanged `1e-5`, argmax and tie behavior.
- Export: shortest float32-exact decimals plus a hard reload check, so a lossy actor export fails instead of shipping.
- Live v1, source recovery manifest, campaign launcher, and immutable S3 evidence remain unchanged.

Commands and final counts are recorded in `progress.md`. The preceding session's exact-candidate preflight was intentionally rejected with
zero generated matches; the corrected branch bank still needs a fresh run on
those pinned candidate/parent bytes before a candidate-quality experiment.
No 11,300-match suite or cloud workload was rerun. No browser/UI code changed;
browser smoke is not required for these local changes, and the immutable cloud
QA report remains historical evidence for the old SHA only.

## Architecture assessment — September 21

The current architecture has a real spatial bottleneck, but that does not
establish it as the cause of the failed campaign. The same architecture scored
`0.575` against the champion and `0.875` against aggressive before league
training, versus `0.325` and `0.050` afterward on the recorded 40-game-per-opponent
diagnostics. Those small samples do not prove promotion quality. Together with
the held-out loss increase from `3.689` to roughly `308 million`, they establish
a training-stage regression that an architecture-capacity hypothesis alone
does not explain. Fresh-target training still needs its controlled experiment.
The equal-patch constraint below holds for every choice of finite actor weights
on a fixed state/card. It is therefore a shared limitation of parent and
candidate, not a changed mechanism that alone explains their regression. This
does **not** prove architecture played no causal role: training can interact
with that limitation, and changes to cards, delays and trajectories can change
how often the policy encounters ambiguous placements.

Code-level findings (`scripts/edger-v2-training.py:192`,
`src/ai/v2/observation.js:77`, `src/ai/v2/policy.js:435`):

- The `3x3 -> 1x1 -> 1x1` stack has a `3x3` receptive field per spatial cell.
  The card head sees the whole board through a 16-value mean, with no explicit
  lane/depth bins. This is whole-board aggregation, not a whole-board relational
  encoder. The placement head retains the unpooled map, and delay receives the
  selected cell, so pooling does not discard every head's spatial information.
- Observations include target-relative vectors and tower signals. Thus saying
  all position information is lost is too strong. The 96 globals are privileged
  state summaries, not a teacher's tactical recommendations; they do not provide
  a per-lane troop layout or time-to-intercept summary. Live v1 separately uses
  the handcrafted action prior; v2 does not.
- Placement has no cell coordinates or static lane/river channels. For a fixed
  state/card, identical `3x3` input patches produce identical cell embeddings,
  placement logits, and selected-cell delay logits. This includes distinct legal
  empty locations. The shared global context cannot break that tie; masks only
  exclude illegal cells, and row-major ordering resolves remaining ties. Lane
  pooling alone would not repair this candidate-location ambiguity.

### Candidate locations and exploratory tie rates

The bot enumerates troop anchors rather than every engine-legal placement tile
(`src/ai/botRuntime.js:243`, `src/sim/placement.js:306`). With the production
arena's towers intact, red has four anchors per affordable troop card:
back-center `(9.5, 5.5)` and front-row `(3.5, 14.5)`, `(9.5, 14.5)`,
`(14.5, 14.5)`. Their row-major indices are `99`, `255`, `261`, `266`.
When all four share the maximum score, deterministic argmax selects `99`.
A partial maximum-score tie need not include that anchor. Destroyed enemy crown
towers unlock pocket/bridge-connector candidates, so four is not a universal
action-space size. A local production-engine probe verified four opening
Knight anchors and ten after unlocking red's left pocket, plus 576 spell cells
(`artifacts/edger-training/diagnostics/20260921-architecture-review/anchor-probe.mjs`).
Spells enumerate all `576` cells. The troop constraint belongs to bot action
enumeration, not to the player's engine placement rules.

All 24 board channels describe entities or pending effects; there is no explicit
river/bridge/half-board channel. Tower locations and roles, global tower state,
and action masks still provide some implicit geometry. The limitation is an
inability to express a learned preference **between tied neighborhoods**, not
an inability to prefer a lane in every possible state.

A user-supplied scratchpad probe reports eight random-play seeds, sampling red
every 15 ticks with the BC smoke actor whose checksum starts `c3f6d549`:

| Reported measurement | Troop decisions | Spell decisions |
| --- | --- | --- |
| Sample count | 59 | 21 |
| Mean legal cells | 4 | 576 |
| All legal input patches byte-identical | 45/59 (76%) | 0/21 |
| Argmax resolved by a maximum-score tie | 50/59 (85%) | 1/21 |
| Distinct chosen cells | 3 | 13 |

The report also places 50/59 troop choices at back-center and none at
front-center. These are supplied exploratory measurements, not independently
reproduced corpus results: exact seeds, script and state traces have not been
provided to this repository. Keep input-patch equality (weight-independent)
separate from logit/argmax ties (which can also arise from learned weights).
Both have now been recomputed on the pinned real corpus; see
[Measured corpus results](#no-training-corpus-analysis--measured-september-21).
**The exploratory 76% and 85% rates did not reproduce.** Measured real-corpus
rates are 42.4% structural and 45.2% parent-argmax over 7,865 non-PASS rows.

A local Node `25.2.1` structural probe confirmed this with BC smoke actor
`edger_v2_bc_987226cab148f1d3`, SHA-256
`c3f6d54988b82b3cfae099bf4c4affb25a4fbfb8aef66b2bf17140e3e9295d49`:
four enumerated legal empty-neighborhood Knight cells shared the exact placement
logit `0.8285971283912659`. Locations `(9.5, 5.5)` and `(14.5, 14.5)` also had
identical complete delay-logit vectors. The script and captured result are under
ignored `artifacts/edger-training/diagnostics/20260921-architecture-review/`.
This probes a structural constraint; it is not campaign-parent quality,
PyTorch/JS parity, or reference-host certification.

After establishing a stable learner control, a bounded BC architecture ablation
is justified: current actor versus normalized coordinate channels plus pooling
over four depth bands and two lateral regions; evaluate a larger receptive
field separately. With all other widths fixed, replacing both `1x1` layers by
`3x3` yields `40,498` actor parameters and a `7x7` receptive field. Adding two
coordinate channels plus replacing the global mean with `4x2` regional pooling
yields `43,858`; combining both changes yields `47,954`. These are arithmetic
estimates, not implemented/exported models. JSON size, measured parity and
reference-host timing still require validation. Preserve full-resolution
placement scoring when considering striding or pooling.

Use identical corpus splits, seeds and update budgets; compare held-out losses
per head, positional tactical cases, then paired gameplay. This assessment
does not authorize a new campaign or replace the existing local learning
experiment. No architecture variant has demonstrated a quality improvement.

### No-training corpus analysis — measured September 21

This analysis ran on the pinned real-corpus subset before any optimizer update.
The method below is unchanged; the measurements follow it.

Method. Use the real-corpus subset pinned in step 1 below, preserving original
whole-episode splits and leaving test episodes untouched. Record checksums and
the analysis command/script with the result. For each non-PASS row, use its
**recorded selected card and stored legal-placement mask**, not a newly selected
model card or an assumption of four candidates. Read the float32 board exactly
as the learner does; group legal cells by identical ordered, zero-padded
`3x3x24` input patches. Verify patch equality after hashing rather than trusting
hash equality alone.

Let `k_i` be the size of the group containing the recorded target placement.
Every member receives the same logit, so the target probability is at most
`1/k_i`. The resulting per-row placement cross-entropy obeys:

```text
placement_loss_i >= ln(k_i)
```

This is derived from the [cross-entropy definition](https://docs.pytorch.org/docs/2.14/generated/torch.nn.CrossEntropyLoss.html),
not the empirical entropy of teacher choices. Four identical legal patches
force uniform placement probabilities and `ln(4) = 1.3862943611` nats even if
the teacher always chooses back-center and its empirical selection entropy is
zero. Argmax can still match that teacher because of the tie-break. The average
of these per-row bounds is a certified lower bound, not necessarily the full
network's attainable optimum: shared weights and other representation
constraints can impose additional loss.

Report separately for train/validation, troop/spell, actor side, card, phase,
board density and pocket availability:

- All-legal-patches-identical rate, any nontrivial patch-group rate, and the
  target's group-size distribution. Separate these from exact maximum-logit tie
  rates for the pinned parent/candidate and observed location preferences.
- `sum(non_PASS ln(k_i)) / N`, where `N` includes PASS rows, to match the
  **unweighted all-row** `placement_loss` in `evaluate_loss_parquet`. PASS adds
  zero placement loss. Also report a non-PASS-only mean with its own denominator.
- If reporting the BC sample-weighted contribution, use
  `sum(non_PASS sample_weight_i * ln(k_i)) / N`, matching the learner's mean
  reduction; do not substitute division by the sum of sample weights or compare
  it directly to the unweighted validation metric.

Measure actual placement loss alongside this bound for each architecture using
the same rows. More context or coordinates can split old groups, so recompute
the applicable bound for each variant; subtracting the old architecture's bound
from every model would be misleading. These checks contextualize an ablation;
they do not establish tactical quality, promote a model, or waive any gate.

#### Measured results

Subset: **128 train and 32 validation** episodes drawn from the pinned corpus
manifest version `MGEjYZi4FbSGJr4uWNnvc.J6wRt5EvQB`, original whole-episode
splits preserved, **zero test episodes touched**. Sixteen train and four
validation episodes per `(opponent, Edger side)` cell over the four opponent
policies and both sides, accepted in ascending `episode_id` order from the
first 384 train and 192 validation shards; outcome was reported, never selected
on. Every compressed episode matched its manifest checksum. Derived cache:
**9,343 rows** (7,375 train, 1,968 validation), canonical schema
`3623ade0a47e7b66b64f46581788b2dda46cee2b78b6b02c3ceeae34c11e2f5a`,
cache SHA-256 `aab1f8e8fc137b9f016438b37372290a3cd574e629b48c134e6a1869e26ffe7f`.
Balance strata are recomputed over this subset, so its sample weights are not
the production-corpus weights.

Structural patch ties over **7,865 non-PASS rows** (3,185 of which have a unique
target patch):

| Measurement | All | Train | Validation |
| --- | --- | --- | --- |
| Non-PASS rows | 7,865 | 6,185 | 1,680 |
| PASS rows | 1,478 | 1,190 | 288 |
| All legal patches identical | **42.39%** | 43.19% | 39.46% |
| Any nontrivial patch group | **99.92%** | 99.90% | 100% |
| `sum(ln k) / all rows` | 1.09128 | 1.10480 | **1.04060** |
| `sum(ln k) / non-PASS rows` | 1.29635 | 1.31736 | **1.21899** |
| `sum(weight x ln k) / all rows` | 1.16365 | 1.12820 | **1.29651** |

The legal-cell histogram has exactly four values: **4** (3,245 rows, intact
towers), **10** (3,127 rows, a pocket unlocked), **16** (582 rows) and **576**
(911 spell rows). No row had a single legal cell, so the four-candidate
assumption would have been wrong for well over half the troop rows.

Stratified all-legal-patches-identical rates, mean target-group size `k` and
mean `ln(k)` over non-PASS rows:

| Stratum | Rows | Identical | Mean `k` | Mean `ln k` |
| --- | --- | --- | --- | --- |
| troop | 6,954 | 47.94% | 4.75 | 1.1339 |
| spell | 911 | 0.00% | 209.83 | 2.5361 |
| actor blue | 3,927 | 42.25% | 27.74 | 1.2791 |
| actor red | 3,938 | 42.53% | 29.27 | 1.3136 |
| phase normal | 4,227 | 54.53% | 38.35 | 1.5848 |
| phase double | 2,488 | 29.02% | 21.45 | 1.1373 |
| phase overtime | 1,150 | 26.70% | 7.58 | 0.5802 |
| pockets intact | 3,711 | 52.95% | 37.04 | 1.2052 |
| pockets unlocked | 4,154 | 32.96% | 20.88 | 1.3778 |
| density 0-6 | 3,222 | 53.45% | 27.48 | 1.5766 |
| density 7-10 | 4,414 | 35.43% | 29.35 | 1.1123 |
| density 11-14 | 229 | 20.96% | 26.62 | 0.9013 |
| card giant | 291 | 62.89% | 4.05 | 1.1567 |
| card musketeer | 1,070 | 52.90% | 5.19 | 1.2379 |
| card mini_pekka | 1,088 | 51.56% | 5.13 | 1.2310 |
| card knight | 1,475 | 49.49% | 4.93 | 1.1769 |
| card archers | 1,504 | 46.21% | 4.72 | 1.1062 |
| card goblins | 1,526 | 39.25% | 4.17 | 0.9732 |
| card arrows | 701 | 0.00% | 188.58 | 2.2800 |
| card fireball | 210 | 0.00% | 280.78 | 3.3910 |

Spells never have all 576 patches identical, but their mean tied group is still
large: an empty board region gives hundreds of identical `3x3` patches, which is
why the spell `ln(k)` contribution dominates. Every full-board patch group was
confirmed by exact array equality after hashing; no digest collision was
accepted as a tie.

Model-dependent maximum-logit ties are separate and much less stable than the
structural rate:

| Model | Argmax tie rate | Mean tied cells | Argmax equals recorded target | Distinct chosen cells |
| --- | --- | --- | --- | --- |
| Offline/BC parent | 45.21% | 4.22 | 33.27% | 139 |
| Failed league candidate | **99.05%** | **63.08** | 1.44% | 18 |

The candidate's placement head is effectively degenerate: on 99% of non-PASS
rows its maximum legal placement logit is shared by an average of 63 cells, and
its selection agrees with the teacher on 1.4% of rows. The parent's 45% tie rate
is close to its 42% structural rate, so most of the parent's ties are forced by
the representation, while the candidate's are not.

**The earlier exploratory 76% structural and 85% argmax rates did not
reproduce.** They came from eight random-play seeds with the BC smoke actor and
should not be cited as corpus rates.

Measured placement loss against the bound, on the same validation rows and the
same all-row denominator: parent **1.41744** versus bound **1.04060**, so the
certified structural floor accounts for about **73%** of the parent's placement
loss and roughly 29% of its **3.56610** joint loss. That is a lower bound on the
current representation only; it is not the network's attainable optimum, and a
variant with coordinates or richer context would need its own recomputed bound.

## Bounded local experiment — executed September 21

The controlled candidate-quality experiment specified above has now run. It
followed the same five steps: read-only recovery, a frozen subset with the
no-training analysis first, an unchanged-parent control plus two fresh-target
V-trace arms, then the corrected gates. Evidence, exact commands and raw reports
are under ignored
`artifacts/edger-training/experiments/20260921-bounded-learner/`
(see its `README.md`). No commit, push, cloud dispatch, campaign mutation,
promotion or live-v1 change occurred; every S3 access was a read by exact
version id.

`scripts/edger-v2-training.py` refuses to train from a dirty worktree, so the
working tree was mirrored byte-for-byte into an isolated scratch git repository
**outside this repository** and committed there. The real repository was never
committed to, and all pre-existing uncommitted work is preserved. Working-tree
diff against `0270d828`:
`d2275bedda02dfecb957919a662a2864ec6252f26c03291408f66156ee4b9417`.

### Recovered artifacts

| Artifact | S3 key under the campaign prefix | Version | SHA-256 |
| --- | --- | --- | --- |
| Offline/BC parent checkpoint | `stages/offline/shadow-parent.pt` | `0hCV6RsfYoLvqdmxYnLDp4AskTc_CliX` | `f166e527b4d3e7e18ebb3846a42d483661578b7a83662cc21445d4896f9368af` |
| Offline/BC parent export | `stages/offline/shadow-parent.json` | `9mK7FURZskZPZELAgBrZm8rz0uQUiF8K` | `73b33da42532e879a9ca1e059ecd8c84ccb6baa7f8f9ebef500de240a2819d4d` |
| Failed league candidate checkpoint | `stages/league-production/candidate.pt` | `Pk7LH2S09zC6mdv_c7kSLZRBhrRrZlro` | `79a095afb0cea620c59e2aee96603954065666429185d6fd4caa7306c74b6e04` |
| Failed league candidate export | `stages/league-production/candidate.json` | `6gLBFfKr0o9oe_D3COwa0AJimNZOLwtr` | `b057436961e5f8315946c8e8f1772675e8326e3c84daa0599fbcf70748c3c052` |
| Corpus manifest | `corpus/manifest.json` | `MGEjYZi4FbSGJr4uWNnvc.J6wRt5EvQB` | `bf85a0c3eca5eaeb008bfd818b3b0e726a820f671bc49a15f0b6c89e568c048d` |

Both candidate pins reproduce the version ids and checksums already recorded
above. The parent's bytes match the `offline` completion marker exactly, which
also records `validation_kl_from_bc = 0` and zero accepted epochs. The local BC
smoke actor was **not** substituted for either artifact.

Lossless re-exports were generated from both checkpoints and are recorded under
separate hashes: parent `2e576955579672c500c7c761b76dd4aca0032acd1cbcfd0bf018304a921fe14f`
(760,553 bytes) and candidate
`2eaf74989c0a12039a7d37ac3c6b2f8bc1a9d7e6887ae423ba9b491e6dee329f`
(745,922 bytes). They differ from the historical exports in **11,174 of 36,402**
parent weights and **8,069 of 36,402** candidate weights at float32, confirming
the earlier quantisation finding on these exact artifacts.

### Corrected branch-aware parity — both historical actors fail

| Model | Passed | Maximum error | Maximum legal magnitude | Argmax agreement | States / fixtures |
| --- | --- | --- | --- | --- | --- |
| Offline/BC parent, historical export | **no** | `9.1552734375e-05` | `473.9105529785156` | true | 19 / 56 |
| Offline/BC parent, lossless re-export | **no** | `9.1552734375e-05` | `473.9105529785156` | true | 19 / 56 |
| League candidate, historical export | **no** | `2752` | `541883392` | true | 19 / 54 |
| League candidate, lossless re-export | **no** | `2752` | `541883392` | true | 19 / 54 |

Tolerance stays `1e-5`; nothing was weakened. Every fixture covers PASS plus all
eight cards. The parent's worst coordinate is a placement logit
`365.4051513671875` (JS) versus `365.4052429199219` (PyTorch), 3 ULP at its own
magnitude; the candidate's is a delay logit `-541883392` versus `-541880640`,
43 ULP. **The exact offline/BC parent — the campaign's accepted starting point —
does not pass the corrected gate.** The lossless export changed weights without
changing either measured maximum, so export quantisation is not the cause; the
disagreement is genuine PyTorch/JS accumulation.

### Control versus arms

Frozen before the first update: seed `20260718`, batch size `32`,
`value_loss_weight 0.5`, `entropy_bonus 0.001`, `rho`/`c` clipped at `1`, CPU,
episode order = source manifest order restricted to `split=train`, targets
refreshed before each episode update, one optimizer step per episode. Held-out
episodes were never used for updates. Each arm used the full cap: **128 episode
updates per epoch, three epochs, 384 updates per arm and 768 in total.**

Held-out (32-episode, 1,968-row) validation:

| Arm | Updates | Joint | Card | Placement | Delay | Value | KL from parent | Tactical | Max legal logit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Control, unchanged parent | 0 | **3.56610** | 0.3576 | 1.4174 | 1.79105 | 0.43900 | 0 | **0.000** | 754.59 |
| Fresh V-trace `1e-3` | 128 | 5.61360 | 1.5379 | 1.4426 | 2.63313 | 0.77277 | 2.08806 | 0.361 | 692.02 |
| Fresh V-trace `1e-3` | 256 | 8.32596 | 1.9796 | 1.4660 | 4.88038 | 1.06927 | 4.52311 | 0.390 | 651.84 |
| Fresh V-trace `1e-3` | 384 | 13.16064 | 2.8471 | 1.5080 | 8.80548 | 1.06077 | 9.25302 | 0.390 | 726.26 |
| Fresh V-trace `1e-4` | 128 | 3.68159 | 0.4377 | 1.4204 | 1.82353 | 0.44013 | 0.08482 | 0.221 | 734.15 |
| Fresh V-trace `1e-4` | 256 | 3.94358 | 0.5905 | 1.4267 | 1.92644 | 0.53194 | 0.27190 | 0.221 | 743.15 |
| Fresh V-trace `1e-4` | 384 | 4.19909 | 0.7585 | 1.4315 | 2.00904 | 0.63949 | 0.48656 | 0.221 | 763.19 |

Every epoch produced finite losses, finite legal logits and finite gradient
norms; the trainer now records a per-epoch pre-clip gradient-norm summary.
Observed per-epoch maxima ranged `0.8376`–`10.0986` with means `0.032`–`0.192`
and at most four of 128 updates above the `1.0` clip threshold, so neither arm
diverged numerically. Maximum legal logit magnitude stayed near the parent's
`754.59` throughout and is reported as advisory only; **no `83.886` cutoff was
introduced or enforced**. Checkpoint and export SHA-256 values for all six
trained checkpoints are in `reports/bounded-experiment-results.json`.

Both arms regressed monotonically on held-out joint loss and the stop rule fired
for both at the third epoch. **Corrected fresh-target V-trace did not preserve
parent behavior at either learning rate.** The freshness fix is still a real
correction: the same `1e-3` setting that previously produced joint loss
`308,191,124.83` after one stale-target epoch now stays at `5.61`. That is a
difference in kind - no blow-up - not a matched comparison: the league run used
about 11,318 updates over 362,149 train samples, this epoch used 128 updates
over 5,104. The direction of travel is unchanged either way.

The decomposition is the useful part. The damage is concentrated in the **card**
head (`0.358` to `2.847`) and the **delay** head (`1.791` to `8.805`). The
**placement** head barely moves (`1.4174` to `1.5080`) and stays near its
certified `1.0406` structural floor in every arm. The shared-patch limitation
therefore constrains the placement head in both control and arms, and is not
what this training stage is damaging.

Held-out cross-entropy against the behavior policy is not the V-trace objective,
so divergence from it is not by itself proof of worse play. The tactical column
moves the other way: the parent scores `0.000` and every trained model scores
higher. Both directions are consistent with one reading — this learner moves the
policy away from the behavior distribution, and the existing held-out metric
cannot tell useful movement from harmful movement.

### No candidate qualified for gameplay diagnostics

| Model | Parity | Tactical (heuristic `0.873`) | Local p95 |
| --- | --- | --- | --- |
| Offline/BC parent | fail `9.16e-05` | **0.000** | 0.9572 ms |
| League candidate | fail `2752` | 0.370 | 1.0317 ms |
| `1e-3` epoch 1 / 2 / 3 | fail `7.63e-05` / `1.22e-04` / `1.53e-04` | 0.361 / 0.390 / 0.390 | 0.93 / 0.96 / 0.94 ms |
| `1e-4` epoch 1 / 2 / 3 | fail `1.22e-04` / `1.22e-04` / `1.83e-04` | 0.221 / 0.221 / 0.221 | 1.02 / 0.97 / 0.96 ms |

Every model failed both the corrected parity gate and the tactical gate, so
**no side-paired champion/aggressive diagnostics were run**, per the rule that
only models clearing both may proceed. The full 11,300-match suite was not run.
Local p95 figures are diagnostics on darwin arm64, not `c7g.4xlarge`
certification.

The parent's `0.000` tactical aggregate is new information and the most
important unresolved item here. It scores zero in all five categories: it
chooses the `PASS` action on the defense fixture, where the heuristic plays
`musketeer` at `(9.5, 14.5)`, and answers the spell-cluster fixture by playing
`giant` at back-center `(9.5, 5.5)`. It reproduces identically from the historical export
and from the lossless re-export, and the same suite reproduces the previously
recorded `0.37` for the league candidate, so the suite is behaving consistently.
Either the parent is genuinely inert on single-decision fixtures while still
winning 0.575/0.875 in the recorded 40-game diagnostics, or the fixtures
misrepresent what this parent does in a real match. That must be resolved before
the tactical gate is used to select between candidates.

### What this rules in and out

- A shared representation limit constrains the placement head of parent and
  candidates alike and is close to saturated there. It does **not** explain the
  parent-to-league regression, which lives in the card and delay heads. This
  does not exclude architecture/training interactions: a policy that cannot
  express placement preferences may push its objective through the heads it can
  move.
- Stale V-trace targets were a real defect and their correction removes the
  `3e8` blow-up, but correctness alone does not produce a better policy.
- Neither learning rate gives a stable learner control on this corpus, so the
  planned BC ablation of coordinates plus regional pooling **is not yet
  unblocked**: it was conditioned on first establishing such a control.

### One recommended next experiment

Run a bounded **behaviour-cloning control** on the identical frozen subset,
splits, seed and budget: warm-start from the same offline/BC parent and take
384 BC updates on the train split only, then evaluate with exactly the same
held-out losses, KL, gradient norms, parity bank and tactical suite. BC descends
the metric that is currently regressing, so it separates two hypotheses that the
V-trace arms confound — whether the learner is broken, or whether held-out
cross-entropy simply disagrees with the V-trace objective. If BC lowers held-out
loss while the tactical aggregate stays at the parent's `0.000`, the tactical
fixtures are the thing to fix next; if BC also fails to move held-out loss, the
defect is in the shared data or optimisation path rather than in V-trace. Do not
start the architecture ablation until one of those two readings is established.

## Decision-cadence experiment — executed September 26

Local diagnostic, explicitly authorised to run development matches despite the
known preflight failures. Nothing here is promotable; no gate, live-v1 file,
campaign or S3 object changed. Evidence, commands and every match record:
ignored `artifacts/edger-training/experiments/20260926-cadence-diagnostic/`
(`README.md`, `reports/`). Budget, seeds, contrasts, decision rules and stop
rules were frozen in `reports/frozen-plan.json` before any match ran.

Question: live v1 reconsiders every tick; v2 chooses card, placement and a
1–200 tick wait. Is that learned wait what keeps v2 from beating v1, and,
separately, does RL improve or damage the policy once timing is fixed?

Setup: one parent for every condition — `shadow-parent.pt` (SHA-256
`f166e527…68af`) and its lossless export (bit-identical actor). The fixed
one-tick cadence reuses the same card and placement heads every tick; PASS stays
available and is never overridden; the delay head is not evaluated. Paired
development seeds (hash-derived, disjoint from every frozen suite, training and
probe seed) with the candidate on both sides; 200 pairs (400 games) against v1,
100 pairs against aggressive; deterministic argmax choices. Uncertainty is a
10,000-resample paired bootstrap over seed pairs plus an exact sign test.

### Timing without training

| Parent vs v1 | W-D-L | Score [95%] | Decisions/game | PASS share | Deployments/game | Full-elixir ticks/game |
| --- | --- | --- | --- | --- | --- | --- |
| Learned delay | 208-0-192 | 0.520 [0.470, 0.568] | 36.9 | 15.6% | 31.2 | 26.8 |
| Fixed one tick | 204-4-192 | 0.515 [0.466, 0.564] | 4,282.9 | 99.0% | 41.9 | 0.0 |

The parent's learned waits have median 84 ticks (p05 16, p95 200; after a play
median 112). Fixed cadence spends every elixir tick, deploys 34% more, casts
arrows 4.5× as often and giant 60% less often, and plays longer matches, but
does not score better: C1 = −0.005 [−0.064, +0.054], 56/54/90 pairs
better/worse/tied, sign p 0.92. Against aggressive it is worse: 0.875 → 0.775,
C1 = −0.100 [−0.165, −0.035], p 0.012. The rounded historical export gives
action streams identical to the lossless export in all 400 games.

### Controlled learning comparison

Both arms start from `parent.pt` with production V-trace settings (Adam
`1e-3`, microbatch 32, value weight 0.5, entropy 0.001, clip 1.0, ρ/c clip 1,
temperature 1, unchanged reward) and the same refresh protocol: 6 iterations ×
64 fresh games from the current policy, one optimizer update per episode with
targets recomputed before each update. Same training seeds, sides and opponent
schedule (production league allocation without snapshots: 154 v1 / 38
heuristic pairs). The learned arm is the unchanged production update; the fixed
arm drops the delay term from log-probability and entropy (delay head drift
exactly 0.0).

| Arm | Games / updates | Env ticks | Decision rows | Play rows | Learner s | Rollout worker s | Arm wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RL-learned | 384 / 384 | 1.20 M | 21,262 | 8,815 | 12.5 | 724 | 11.8 min |
| RL-fixed | 384 / 384 | 1.31 M | 1,309,405 | 11,014 | 1,062 | 2,255 | 36.4 min |

Learning dynamics (first → last iteration):

- RL-learned: behaviour drifts off-policy within each iteration — ratio p05
  0.05–0.55, 38–49% of ratios clipped, the delay head carrying the largest log
  ratios. Pre-clip gradient norm mean 1.2 → 2.1 with 24 → 46 of 64 updates
  clipped; critic explained variance 0.20 → 0.33. Card entropy collapses
  0.20 → 0.03 nats, placement 1.17 → 0.54, delay rises 2.68 → 3.13 (peak 4.09).
- RL-fixed: per-tick head entropies are small (card 0.007, placement
  0.017–0.019) because ~99% of rows are PASS and placement entropy is zero on
  PASS rows. Conditional on a card play, placement entropy is 2.29 → 1.95 nats,
  not near-deterministic. Raw card/placement gradient norms are about `1e-3`
  against critic 0.6–1.5, but these are combined-loss norms, and Adam rescales
  small gradients: the card head drifted more than the trunk (relative L2 0.123
  vs 0.076). Neither shows what caused the gain
  ([review](EDGER_CADENCE_REVIEW.md)). Ratios are essentially 1 (0.3–0.6%
  clipped). Critic explained variance −0.23 → 0.39. The unused delay head's
  entropy still rises 2.89 → 4.33 through trunk drift.
- Advantage std 0.31–0.46 (learned) and 0.27–0.54 (fixed), roughly symmetric.
- Held-out imitation loss on the September 21 validation split worsens in both
  (joint 3.566 → 7.481 learned, → 4.799 fixed; card 0.358 → 1.158 / 0.476,
  placement 1.417 → 1.509 / 1.520, delay 1.791 → 4.814 / 2.802), and
  temperature-1 sampled rollouts score poorly (0.28–0.44 learned, 0.05–0.28
  fixed) even as deterministic play improves.
- Drift at the end: relative L2 trunk 0.069 / 0.076, card head 0.063 / 0.123,
  placement 0.012 / 0.013; probe card-argmax agreement with the parent 0.911
  (learned states) / 0.961 (fixed states), placement agreement 0.794 / 0.847.

### What improved

| vs v1, 200 seed pairs | W-D-L | Score [95%] | Decisions/game | Median wait |
| --- | --- | --- | --- | --- |
| Parent, learned | 208-0-192 | 0.520 [0.470, 0.568] | 36.9 | 84 |
| Parent, fixed | 204-4-192 | 0.515 [0.466, 0.564] | 4,282.9 | 1 |
| RL-learned, learned | 239-0-161 | 0.598 [0.550, 0.645] | 66.4 | 39 |
| RL-fixed, fixed | 303-0-97 | **0.758 [0.715, 0.800]** | 4,103.9 | 1 |
| RL-learned weights, fixed *(suppl.)* | 311-0-89 | 0.778 [0.735, 0.818] | 3,608.3 | 1 |
| RL-fixed weights, learned *(suppl.)* | 55-0-345 | 0.138 [0.105, 0.170] | 17.9 | 200 |

| Paired contrast vs v1 | Mean [95%] | Better/worse/tied | Sign p |
| --- | --- | --- | --- |
| C1 timing, parent fixed − learned | −0.005 [−0.064, +0.054] | 56/54/90 | 0.92 |
| **C2 RL with timing fixed** | **+0.243 [+0.183, +0.303]** | 101/22/77 | <1e-4 |
| C3 RL with learned timing | +0.078 [+0.013, +0.143] | 68/45/87 | 0.038 |
| C4 trained fixed − trained learned | +0.160 [+0.098, +0.220] | 88/31/81 | <1e-4 |
| RL-learned weights: fixed − learned cadence *(suppl.)* | +0.180 [+0.125, +0.233] | 85/23/92 | <1e-4 |

The C2 gain holds on both sides (blue 0.548 → 0.800, red 0.483 → 0.715) and
recovers against aggressive, which neither arm trained against: 0.775 → 0.880,
C2 = +0.105 [+0.040, +0.165], p 0.003. That baseline is the parent already
weakened by fixed cadence; against the original learned-cadence parent (0.875)
the trained fixed pipeline gains only +0.005 [−0.050, +0.060]. The learned arm
is flat against aggressive (0.875 → 0.855, C3 = −0.020 [−0.085, +0.045]).

Pre-registered secondary pair at lr `1e-4` (run because the primary phase 2
took 49 minutes; v1 only): RL-learned `0.541` [0.494, 0.590], C3 `+0.021`
[−0.039, +0.081]; RL-fixed `0.600` [0.553, 0.649], C2 **`+0.085`
[+0.031, +0.140]**, sign p 0.011; C4 `+0.059` [−0.003, +0.121]. Drift was small
(held-out KL from parent 0.133 / 0.233; card-argmax agreement ≥ 0.967) and
held-out loss barely moved (joint 3.761 / 3.567 versus parent 3.566), so the
fixed-cadence gain appears at both learning rates and without imitation-loss
damage at the lower one.

Unchanged preflight gates, reported separately: parent, RL-learned and
RL-fixed all fail parity (`9.16e-5`, `1.83e-4`, `9.16e-5` versus `1e-5`, argmax
agreement retained) and the tactical gate (`0.000`, `0.370`, `0.370` versus
heuristic `0.873`); local p95 0.89–0.94 ms. No model is promotable.

### Reading

Under the frozen mapping (timing judged on the untrained parent, RL damage on
C2) neither "timing is a major bottleneck" nor "RL damages competence" is met,
so the literal label is *inconclusive*. The measured evidence is more specific
than that label:

- Every-tick evaluation produced no detectable improvement for the offline
  parent against v1 (C1 −0.005 [−0.064, +0.054]; the interval still admits
  about a five-point benefit) and was worse against aggressive. This is not an
  equivalence result, and intermediate or event-triggered cadences were not
  tested.
- RL with fresh on-policy trajectories and correct behaviour probabilities did
  not damage competence at timing fixed — it produced the largest gain measured
  (+0.243 vs v1). Worse held-out imitation loss and weak sampled rollouts
  coexisted with better deterministic play.
- Training cadence and evaluation cadence are confounded in C4. At matched
  every-tick evaluation, learned-delay training minus fixed-cadence training is
  +0.020 [−0.035, +0.075]: no demonstrated advantage for the ~85× more
  expensive every-tick training. Every-tick evaluation helped the
  learned-trained weights (+0.180) far more than the parent (exploratory
  interaction +0.185 [+0.101, +0.265]). RL also shortened the learned delay
  (median 84 → 39).
- A plausible, untested hypothesis for the historical league regression is what
  that path trained on (a frozen-parent rollout merged with legacy rows whose
  behaviour probabilities were recorded as 1, sparse reconstructed delay
  labels, one epoch). Data freshness, coverage and update history also differ;
  no attribution experiment has run.

These readings follow the September 27
[conclusion review](EDGER_CADENCE_REVIEW.md), whose exploratory contrasts were
independently reproduced with the experiment's own bootstrap code.

Limits: one training seed per arm (two learning rates), one opponent mix
(80% v1), 384 games per arm, local hardware; intervals cover evaluation seeds,
not training-run variation. Critic- versus actor-driven contributions are not
identified: recorded gradient norms mix the loss terms. Fixed cadence costs
about 116× the parent's inference calls per game (0.83 ms per decision single-core on
this M1, so about 3.5 s of inference per 4,300-tick match) and 85× the learner
time per update. Timings measured while the machine throttled or slept (fixed
evaluation 5.65–13.4 ms per decision at 7 workers) are not cost estimates.

## Cadence replication — executed September 27

September 28 review: [replication review and next experiment](EDGER_REPLICATION_REVIEW.md)
reproduces the saved contrasts and scopes the actor-mechanism conclusion to
the fixed-cadence controls. It also records a freeze-timestamp inconsistency
to reconcile before publication; original experiment evidence is unchanged.

Follow-up recommended by the [conclusion review](EDGER_CADENCE_REVIEW.md).
Local, diagnostic-only; frozen plan, seeds, commands, per-match records and
analysis under ignored
`artifacts/edger-training/experiments/20260927-cadence-replication/`
(`reports/frozen-plan.json` written before any match; `scripts/analyze.mjs`
written and dry-run on the existing r0 data before any new result existed).

Design:
- **Runs.** r0 is the September 26 lr `1e-3` pair, reused by checksum. r1 and
  r2 are new, identical in settings (6 × 64 fresh on-policy games, Adam
  `1e-3`, production V-trace), with new training seeds and opponent schedules.
- **Arms per new run.** Learned/full; fixed/full; fixed critic-only (policy
  loss and actor entropy off); fixed value-detached (value head on detached
  trunk features).
- **Evaluation.** Every checkpoint on the September 26 development seeds, so
  every contrast is paired: v1 200 pairs, aggressive and heuristic 100 pairs
  each. Main arms under both cadences; controls under fixed cadence only.
- **Execution.** 44 new evaluation files, all three tiers, 7.01 h of the 11 h
  cap. No stop rule fired and no illegal action occurred. 200 confirmation
  seeds are reserved and unplayed.

Scores (candidate points, both sides):

| Checkpoint @ evaluation cadence | vs v1 (r0 / r1 / r2) | vs aggressive | vs heuristic |
| --- | --- | --- | --- |
| Parent @ learned | 0.520 | 0.875 | 0.660 |
| Parent @ every tick | 0.515 | 0.775 | 0.615 |
| Learned-trained @ learned | 0.598 / 0.782 / 0.598 | 0.855 / 0.925 / 0.880 | 0.825 / 0.875 / 0.825 |
| **Learned-trained @ every tick** | **0.777 / 0.824 / 0.795** | **0.930 / 0.960 / 0.950** | **0.925 / 0.935 / 0.890** |
| Fixed-trained @ every tick | 0.757 / 0.690 / 0.724 | 0.880 / 0.920 / 0.920 | 0.845 / 0.830 / 0.855 |
| Critic-only @ every tick (r1 / r2) | 0.130 / 0.465 | 0.270 / 0.630 | 0.215 / 0.585 |
| Value-detached @ every tick (r1 / r2) | 0.650 / 0.805 | 0.885 / 0.940 | 0.785 / 0.910 |

Pre-registered paired contrasts vs v1 (mean [95% bootstrap]; label rule:
"replicated" only if every run's interval excludes zero on the same side):

| Contrast | r0 | r1 | r2 | Run-averaged | Label |
| --- | --- | --- | --- | --- | --- |
| E1 fixed-trained − parent, both every tick | +0.242 [+0.182, +0.302] | +0.175 [+0.115, +0.236] | +0.209 [+0.154, +0.264] | +0.209 | replicated positive |
| E2 learned-trained − parent, both learned | +0.077 [+0.013, +0.142] | +0.263 [+0.203, +0.323] | +0.077 [+0.013, +0.145] | +0.139 | replicated positive |
| E3 learned-trained − fixed-trained, both every tick | +0.020 [−0.035, +0.075] | +0.134 [+0.084, +0.182] | +0.071 [+0.020, +0.125] | +0.075 [+0.041, +0.110] | not established |
| E4 learned-trained: every tick − learned | +0.180 [+0.125, +0.233] | +0.041 [−0.011, +0.095] | +0.198 [+0.145, +0.250] | +0.140 | not established |
| E4i E4 − parent's cadence effect | +0.185 [+0.101, +0.265] | +0.046 [−0.033, +0.128] | +0.203 [+0.122, +0.280] | +0.145 | not established |
| E5 critic-only − parent, every tick | – | −0.385 [−0.443, −0.328] | −0.050 [−0.117, +0.020] | −0.217 | not established |
| E6 fixed-trained − critic-only | – | +0.560 [+0.510, +0.610] | +0.259 [+0.198, +0.319] | +0.409 | replicated positive |
| E7 value-detached − parent | – | +0.135 [+0.074, +0.198] | +0.290 [+0.231, +0.349] | +0.212 | replicated positive |
| E8 fixed-trained − value-detached | – | +0.040 [−0.020, +0.100] | −0.081 [−0.140, −0.025] | −0.021 | not established |
| P1 learned-trained @ every tick − original parent @ learned | +0.258 | +0.304 | +0.275 | +0.279 [+0.230, +0.329] | replicated positive |

Secondary opponents (reported, not decision-driving):
- **Against the original learned-cadence parent,** learned-trained @ every
  tick is replicated positive against aggressive (+0.055 / +0.085 / +0.075)
  and heuristic (+0.265 / +0.275 / +0.230). Fixed-trained @ every tick is not
  established against aggressive (+0.005 / +0.045 / +0.045), confirming the
  review's point that its aggressive gain is recovery from the cadence switch.
- **E3 on the secondary opponents** is not established by the rule (aggressive
  +0.050 / +0.040 / +0.030; heuristic +0.080 / +0.105 / +0.035), but every
  point estimate on every opponent is positive. The run-averaged intervals
  exclude zero.
- **E4i is replicated positive** against aggressive and heuristic.
- **E5 is replicated negative** against aggressive.

Learning dynamics (conditional metrics, measured-before-update decomposition on
every 8th update):
- Fixed-cadence rows are 97.7–98.7% forced PASS (no legal card) in the
  fixed/full arms and 87.9–99.1% across all fixed arms. On rows with a real
  choice, the fixed/full arms' card entropy rises 0.30–0.34 → 0.56–0.62 nats,
  and placement entropy on play rows falls 2.3–2.4 → 1.7–1.8.
- In fixed/full arms the raw policy gradient reaching the trunk is
  0.0016–0.0067 per update against 0.08–0.61 for the value loss, with
  near-orthogonal directions (cosine −0.09 to +0.06). In learned arms the two
  are comparable (0.36–2.04 versus 0.16–0.57). Under Adam the fixed arms'
  card-head step per update (0.0039–0.0067) still matches the learned arms'
  (0.0031–0.0059). Raw norms are not update sizes.
- **Critic-only arms** move only the trunk and value head (actor-head drift
  exactly 0). Card entropy on choice rows doubles to about 0.6 and placement
  entropy rises to about 3.0 nats: the actor degrades as the trunk follows the
  critic.
- **Value-detached arms** sharpen card choice to 0.004–0.014 nats with critic
  explained variance near or below zero, and reach the highest sampled
  rollout scores (0.47–0.67).
- Held-out imitation loss worsens in every arm (final joint 5.1–8.3 versus
  parent 3.566), again not tracking gameplay.

Unchanged preflight on all eight new final models: parity fails
(`3.05e-05`–`3.05e-04`, argmax agreement retained), tactical 0.22–0.39 versus
heuristic 0.873, local p95 0.91–0.95 ms. Nothing is promotable.

### Reading

- **RL from fresh on-policy trajectories reliably improves this parent.** The
  gain appears under either training cadence and in all three runs against v1
  and heuristic. The historical league regression is therefore not an
  inherent property of V-trace on this parent; its cause remains unattributed.
- **Every-tick training has not justified its cost.** At matched every-tick
  evaluation, learned-delay training is never worse: all nine point estimates
  across three runs and three opponents are positive, and the run-averaged
  interval against v1 is +0.075 [+0.041, +0.110]. The pre-registered rule
  still labels this "no demonstrated difference" because r0 alone is not
  detected. Equivalence within ±0.05 is not shown.
- **Evaluation cadence matters for trained weights.** Every-tick evaluation
  of the learned-trained weights has the highest mean score of any condition
  on every opponent (vs v1 0.799, aggressive 0.947, heuristic 0.917). It is
  replicated positive against the original parent on all three opponents (vs
  v1 +0.279 run-averaged). How much it adds over the trained model's own
  learned delay varies by run (+0.180 / +0.041 / +0.198). Where the learned
  delay was already strong (r1, median wait 16 ticks), the gain was not
  detected.
- **The gain is actor-driven.** Critic-only training does not reproduce it
  and can destroy play (r1 −0.385). Actor terms are necessary (E6 replicated).
  Keeping value gradients out of the trunk preserves the gain (E7
  replicated), and critic trunk shaping adds nothing detectable (E8: +0.040,
  then −0.081). The September 26 critic-driven hypothesis is not supported.
- **Training-run variation is large** relative to evaluation-seed intervals:
  E2 +0.077 / +0.263 / +0.077; critic-only 0.130 versus 0.465;
  value-detached 0.650 versus 0.805. Single-run contrasts should not select
  designs.

Limits: three runs of one parent at one learning rate and budget; 80% v1
training opponents; local hardware. Every-tick inference makes about 3,600–4,100
policy calls per match, 25–60× the trained learned-delay models and about 110×
the parent (local p95 < 1 ms per call). A
runtime cadence change is a product decision needing explicit approval,
tests, timing on the reference host and unchanged gates. The reserved
confirmation seeds have not been played; use them before any design choice
is treated as confirmed. *(September 29: the frozen confirmation matrix ran
on those seeds and supports every-tick inference for the learned-trained
checkpoints. It clears no gate; see [the confirmation run](EDGER_REPLICATION_REVIEW.md#confirmation-run--september-29-03450646-utc-13451646-aest).)*

## Tactical-suite audit — September 27

September 28 review found errors in the audit helper's auxiliary
`best_play_if_forced` card decoding and placement-mask construction. Do not
use those original fields. The immediate actions, aggregate scores and
horizon probes below use production selectors and are unaffected; see
[the review](EDGER_REPLICATION_REVIEW.md).

Repaired the same day in ignored
`artifacts/edger-training/experiments/20260928-tactical-audit-repair/`
(original files unchanged). Its decoding reproduces the production selector
and gate action for every model and fixture, and every forced placement
decodes to a legal action. All gate, horizon, PASS and aggregate values below
are identical. Two corrections to the reading: forced Fireball and Arrows
already target maximum-scoring cells in both spell fixtures, so the spell
weakness is card choice (Fireball probability ≤0.015), not targeting. And in
86 of 105 forced troop plays all legal placement logits are exactly equal, so
the back-center `(9.5, 5.5)` placement comes from lowest-index tie-breaking
rather than a model preference. *(October 25: the cause is now established.
84 of the 86 ties have identical all-zero 3×3 input patches, and the
corpus-level Fireball causes are measured; see the
[tactical review](EDGER_TACTICAL_REVIEW.md).)*

Read-only audit of the five preflight fixtures (`SCENARIO_FIXTURES` in
`scripts/edger-evaluation-core.mjs`, now exported without behaviour change).
Script and output: ignored
`artifacts/edger-training/experiments/20260927-tactical-audit/`. The gate,
floors and heuristic comparison are unchanged.

| Fixture (floor) | Heuristic | Live v1 | v2 parent | v2 RL-learned r0 | v2 RL-fixed r0 |
| --- | --- | --- | --- | --- | --- |
| defense_giant_lane (0.70) | musketeer bridge 1.105 | musketeer bridge 1.105 | PASS 0 (P 0.42) | mini_pekka bridge 1.25 | mini_pekka back-center 1.25 |
| spell_cluster_value (0.70) | fireball 0.96 | giant 0 | giant back-center 0 | giant back-center 0 | giant back-center 0 |
| finish_low_tower (0.80) | fireball lethal 1.15 | giant 0 | giant back-center 0 | giant back-center 0 | giant back-center 0 |
| punish_low_elixir (0.55) | giant bridge 1.15 | giant bridge 1.15 | PASS 0 (P 0.47) | mini_pekka back-center 0.60 | mini_pekka back-center 0.60 |
| captured_left_pocket (0.55) | giant right bridge 0 | giant right bridge 0 | musketeer back-center 0 | giant back-center 0 | giant back-center 0 |
| **Aggregate** | **0.873** | **0.451** | **0.000** | **0.370** | **0.370** |

- The suite does not rank gameplay strength: shipped v1 scores 0.451 and would
  itself fail the spell-value and tower-finishing floors. Both RL checkpoints
  score 0.758–0.778 against v1 at every-tick evaluation but only 0.370 here.
- Two fixtures score leniently. `scoreDefense` checks only lane x and y ≤ 16,
  and `scoreElixirPunishment` gives a troop 0.35 plus a card bonus. Back-center
  (9.5, 5.5) plays far from the threat therefore pass. That accounts for the
  RL models' whole 0.370.
- The spell fixtures expose a real v2 weakness: no v2 model casts the lethal
  or cluster fireball; all deploy giant at back-center. No policy, including
  the heuristic, takes the captured pocket. The four r1/r2 replication
  checkpoints repeat the pattern exactly: aggregate 0.37–0.39, giant at
  back-center in both spell fixtures (`audit-r1r2.json`).
- Timing is not the explanation for the trained models: their PASS
  probabilities are 0.05–0.30 and they act at the first tick. The parent's two
  PASSes cost it defense and punishment. At every-tick cadence it defends 20
  ticks later, and would pass defense, though with a back-center musketeer.

Reading: the fixtures are valid probes of individual skills (spell use in
particular). As a promotion ranking they are coarse (five single decisions)
and lenient in two categories, and v1 does not pass them. Changing floors,
scorers or the heuristic comparison is a gate change needing explicit review;
none was made.

## Parity-failure isolation — September 27

Read-only layer-by-layer isolation of the parent's corrected-parity failure
(`9.1552734375e-05`). Tools and output: ignored
`artifacts/edger-training/experiments/20260927-parity-isolation/`. A NumPy
emulation of the generated-JS arithmetic reproduces the real JS logits bit for
bit on all 56 fixtures × 3 heads, then each layer is compared with PyTorch
float32 and with a float64 evaluation of the same float32 weights.

| Runtime compared with PyTorch float32 (tolerance `1e-5`) | Max abs difference | Fixtures over tolerance (of 56) |
| --- | --- | --- |
| Real generated JS | `9.155e-05` | 47 |
| JS arithmetic, weights rounded to float32 | `9.155e-05` | 46 |
| … plus an exact mean pool | `9.155e-05` | 40 |
| **Exact float64 evaluation of the same weights** | **`7.599e-05`** | **45** |

- Only the placement head fails. Card and delay stay within `1.5e-06` and
  `3.9e-06` in every variant. The parent's worst-cell legal placement logits
  are 246–467 (median 322), where one float32 ULP is `1.5e-05`–`3.05e-05`,
  already above the tolerance. The failing fixture differs by 3 ULP at
  |logit| ≈ 433.
- No JS layer is the root cause. An exact evaluation fails on 45 of 56
  fixtures because PyTorch float32 itself rounds the placement scorer (and the
  layers feeding it) by up to 2.5 ULP. At these magnitudes the gate can pass
  only by bit-matching PyTorch's implementation-defined float32 accumulation
  order.
- Two JS runtime deviations are real but secondary:
  - Exported weights are shortest float32 decimals. None of the 36,402 parses
    to its exact float32 value as a double. JS dense layers and conv biases
    use those doubles, while conv kernels are rounded into a `Float32Array`.
  - `meanPool` accumulates sequentially in float32, up to 26 ULP from exact,
    versus 2.4 for PyTorch.

  Removing both reduces over-tolerance fixtures only from 47 to 40.
- The same holds for all six RL checkpoints of the cadence replication (r0–r2,
  both arms), with emulation again bit-exact. Placement is the failing head in
  every model; the float64 reference fails on 32–56 fixtures. Learned-trained
  models push the largest placement logits to 619–742; fixed-trained models
  reach 146–188. For the fixed-trained models the JS float32 mean pool is the
  dominant JS-side error: real JS reaches 5.3e-05 to 9.2e-05, and an exact
  pool reduces that to 3.05e-05, near the float64 reference.

Reading: this is a mismatch between an absolute `1e-5` logit tolerance and
placement logits in the hundreds, not an implementation bug. The tolerance
stays unchanged. Options for explicit review:
- ULP-scaled or relative parity;
- a float64 PyTorch reference;
- bounding placement logit scale in training;
- float64 mean pooling and `Math.fround` weight loading in the runtime.

Any runtime or gate change needs its own approval, tests and new provenance.
*(October 25: these options are measured on all seven models in the
[parity-contract review packet](EDGER_PARITY_CONTRACT_REVIEW.md). The float64
mean pool and the hybrid `max(1e-5, 4 ULP)` tolerance landed the same day.)*

## Exact next cloud plan — not authorized or dispatch-ready

*(November 20, 2026: the owner made the tactical scenarios and held-out
Fireball bank reported measures rather than promotion gates, and dropped the
heuristic-improvement rule. Read "tactical floors/heuristic improvement" and
"tactical feasibility/quality" below in that light; see the
[gate review](EDGER_GATE_REVIEW.md).)*

1. **Finish local prerequisites first.** Use the corrected branch-aware parity gate and the bounded local experiment above. Keep the parity contract (since October 25, 2026: `max(1e-5, 4 ULP)` with identical argmax and tie sets), deterministic ties, tactical floors/heuristic improvement and quality gates unchanged. Logit magnitude is advisory; the failed candidate and parent have measured parity failures, not mathematical proof that every large-logit model must fail. No currently tested candidate qualifies for promotion.
2. **Prepare a new provenance path for review.** Proposed fresh prefix: `s3://edge-royale-edger-REDACTED-ACCOUNT-ID-ap-southeast-2/campaigns/20260911-v2-gate-fixes`. It has not been created or reserved. The current launcher/recovery validator hard-codes the old recovery target, and `src/ai/v2` is a protected recovery path. This change therefore cannot simply retarget and resume recovery. Prepare fresh BC/scaling from the unchanged frozen corpus under the new code; retain the unchanged canonical cache schema and lossless-content checks. A separate provenance design would need explicit review; do not remove or bypass protected-path checks.
3. **Obtain explicit approval to commit/publish the reviewed local work and campaign preparation.** Record the resulting full SHA and new manifest checksums. Neither exists yet; no fabricated SHA can make a dispatch command valid. Verify clean checkout, launcher ancestry, empty new prefix, credentials/limits, and zero matching active runners.
4. **Request explicit approval for a bounded cloud pilot on the reference `c7g.4xlarge`.** Use the new SHA/prefix, the same frozen corpus and fixed 1%/10%/100% held-out sets, fresh scaling evidence, and an isolated 32-game rollout. Check fresh-target training diagnostics, export byte binding, expanded parity, tactical feasibility/quality, and 100-sample/10-warmup p95 ≤5 ms before authorizing production learning. Keep pilot rollout out of production lineage and verify runner/volume cleanup.
5. **Only after the pilot passes, request explicit approval for production learning and full evaluation.** Produce the 1,000-game production rollout from the reviewed accepted parent and unchanged base corpus. Require strict candidate preflight, current-SHA `npm test`/browser reports, the existing 32-match throughput precheck (`16` workers, `11300` target matches, `180` minute ceiling), then the unchanged full suite: 800 champion, 200 heuristic, 100 per weak baseline, 10,000 repeatability matches, 100 replay checks, and 10,000 bootstrap resamples. Add historical anchors only when real reviewed snapshots exist.
6. **Close out from authoritative results.** Verify SSM exit status, exact report/candidate checksums, immutable completed marker, all gates and `promotion.passed`, no active runner, encrypted volume deletion, and unchanged live v1. On failure retain versioned reports under the new attempt's `failed-stages`; never overwrite old evidence.
7. **Promotion is a later, separate approval.** Only a matching passed marker can support the manual promotion operation and an unmerged review PR. Commit, push, merge, cloud dispatch, and promotion remain unauthorized in this session.
