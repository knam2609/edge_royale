# Edger Cumulative Training

## 1. Status and boundary

The old daily masked-PPO trainer has been removed. It restarted from bootstrap, retained no games, used a short one-tower arena, and could not learn useful state/action interactions.

Edger v2 is a shadow pipeline:

1. persistent full-match corpus
2. structured behavior cloning
3. one conservative offline advantage-weighted actor phase with a frozen behavior-value critic
4. fixed 1%/10%/100% data-scaling proof
5. exact-JavaScript snapshot-league IMPALA/V-trace campaigns
6. separate reviewed promotion after every v2 gate passes

The live browser model remains v1. The fixed deck, exact hidden opponent information, deterministic simulator, synchronous generated JavaScript runtime, and Edger-only product scope remain unchanged.

## 2. Authoritative data

### `edger_training_episode_v1`

An immutable episode contains:

- production seed
- exact 18×32 Royale arena descriptor
- all six initial tower entities
- initial hands and deck queues
- rules, simulator, replay, observation, action, and reward versions (the observation version is the one in force when episodes were first recorded; see below)
- blue/red policy and checkpoint IDs
- complete accepted action stream and sparse decision stream
- 1–200 tick next-decision delays
- behavior log-probabilities when known
- match result, final state hash, replay events, and replay checksum
- source (`simulator` or `opted_in_player`)
- SHA-256 content ID

The validator rejects identity fields. Browser exports are manual, contain no identity, and never upload automatically. The developer importer replays the file before creating an authoritative episode. Human samples can train BC and offline improvement; their unknown behavior probabilities make them ineligible for V-trace.

Raw objects are gzip-compressed and content-addressed:

```text
<store>/objects/sha256/<first-two-hex>/<episode-id>.edger-episode.json.gz
```

`<store>` may be a local directory or `s3://bucket/prefix`. S3 access uses the standard AWS CLI credential chain. Writes are idempotent by episode hash. Invalid or incompatible payloads go to the quarantine prefix.

Simulator collection precomputes immutable paired specifications before worker
threads start. A pair uses the same seed from blue and red; opponents rotate
equally through `edger_heuristic`, `random`, `aggressive`, and `defender`.
`--pair-offset` gives shards stable global pair indices. Results are always
sorted by global match index.

Every completed specification writes `edger_collection_receipt_v1` under a
SHA-256 specification key. A receipt is skipped only after the stored episode
checksum and full replay have been verified. Interrupted runs keep completed
episodes, resume without duplicates, and allow the 64-game pilot to remain part
of the 10,000-game corpus. `edger_collection_report_v1` records clean full-SHA
provenance, the spec checksum, timings, episode IDs, replay status, coverage,
deduplication/resumption, and failures.

### `edger_decision_sequence_v1`

Decision derivation replays the exact JavaScript simulator and records:

- relative-side observation
- legal card, placement, and delay masks
- selected action and delay
- versioned potential-shaped reward ([reward versions](EDGER_REWARD.md))
- behavior log-probability
- opponent stratum
- source and V-trace eligibility

Long waits are represented by deterministic `PASS` decisions at most every 200 ticks, not per-frame PASS labels.

### `edger_dataset_manifest_v1`

Manifests are immutable lists of object URIs and compressed checksums for one compatibility cohort. Episodes hold replays and decisions, never observations, so the cohort pins `edger_oracle_observation_v2`, the schema in force when the corpus was recorded (`EDGER_EPISODE_OBSERVATION_SCHEMA_VERSION`). Each cache derives observations afresh with the current builder and records that schema (`observation_schema_version` in the Parquet metadata and build report); BC, offline and V-trace refuse a cache built for another observation schema. The October 2026 moves to `edger_oracle_observation_v3` and then `edger_oracle_observation_v4` therefore re-derive caches but leave existing episodes, ids and manifest hashes valid. Whole games are split by `SHA-256 episode ID mod 100`:

- 0–79: train
- 80–89: validation
- 90–99: test

The split is stable across machines and worker counts. Disposable PyTorch caches use Parquet with Zstd compression. The default selected mix contains all simulator episodes and no more than 10% opted-in player episodes. Per-sample weights balance source, opponent stratum, and outcome.

Production cache building never materializes the corpus at once. Pass one
counts balancing strata; pass two replays one episode at a time and streams
decision rows into deterministic 256-row Parquet groups. BC and offline training
deterministically shuffle row groups and rows within each group, then consume
bounded batches. Evaluation uses stable batches. V-trace visits contiguous
episodes in source manifest order, refreshes targets using the current learner,
accumulates gradients in bounded microbatches, and steps once per episode.

## 3. Compact v2 policy

Schema: `edger_policy_model_v2`

Observation:

- `32×18×24` relative-side board: 24 entity and pending-effect channels
- 104 global features: 96 state summaries, plus 8 spell-opportunity inputs (for each enemy tower, whether its HP is at or below Fireball and Arrows tower damage; the most enemy troops one Fireball or Arrows cast could hit now, by the engine's impact rule at every cell centre). These are inputs, not overrides.
- schema `edger_oracle_observation_v4` (October 26, 2026; [tactical review](EDGER_TACTICAL_REVIEW.md#spell-globals-only-v4--october-26-2026) proposals 1–2). The October 25 v3 also had 7 static geometry board channels; the owner dropped them after the [RL comparison](EDGER_TACTICAL_REVIEW.md#rl-comparison--october-26-2026).
- full oracle elixir, hands, queues, phase, timing, tower/pocket state, motion, targeting, cooldown, and pending-effect state
- blue observations rotate 180 degrees so the acting side has one canonical orientation

Actor:

- one same-padded 16-channel `3×3` convolution and two 16-channel `1×1` convolutions
- `104→64` global encoder
- 64-wide fused state
- masked `PASS`/fixed-card head
- conditioned row-major `18×32` placement head
- conditioned 1–200 tick delay head
- stable production order: PASS, fixed deck, row-major `(y,x)`, ascending delay

The exported actor has 36,914 parameters (36,402 under the v2 observation) and must stay under 50,000 parameters and 1 MB. The opponent-stratum embedding and value head exist only in PyTorch checkpoints. V2 inference never calls the handcrafted prior.

Export writes each weight as the shortest decimal that reloads as the identical
trained float32, and refuses to emit an actor whose weights do not reload
exactly. Eight-decimal rounding is not lossless: it keeps decimal places rather
than significant digits, so it altered 53.5% of a real BC actor's weights, worst
case `1.29e-3` relative on `conv1`. The measured BC export grew about 3%, while the league export became smaller;
both stay inside the 1 MB cap. Other candidates must still satisfy the byte gate.

PyTorch dense weights are transposed into input-major generated-JS arrays. Golden fixtures require maximum logit error at or below `1e-5` and identical masked argmax; the candidate parity gate uses the hybrid tolerance below.

The runtime stores activations as float32 and accumulates dot products in
JavaScript numbers. The board mean pool also sums in float64 and rounds once to
float32 (since October 25, 2026); a float32 running sum over 576 cells was the
main JS-side deviation ([parity packet](EDGER_PARITY_CONTRACT_REVIEW.md)).
PyTorch can use different summation orders; exact agreement
is not guaranteed ([PyTorch numerical accuracy](https://docs.pytorch.org/docs/2.14/notes/numerical_accuracy.html)).
Float32 spacing is neither a minimum error nor a bound on accumulated error.
Large logits can match exactly, and small logits can still disagree. There is
no proven `83.886` cutoff for parity. Logit scale is a useful warning for local
experiments, not a gate. The gate (since October 25, 2026, [option C](EDGER_PARITY_CONTRACT_REVIEW.md#decision--october-25-2026))
requires every legal logit to satisfy `|js - pytorch| <= max(1e-5, 4 * ulp32(max(|js|, |pytorch|)))`
against PyTorch float32, masked logits to stay within `1e-5`, and identical
masked argmax and legal tie sets. Below magnitude 32 that is exactly `1e-5`.
The 4-ULP multiple was measured on one M1 with PyTorch 2.11.0 and must be
re-measured on the reference host before a campaign relies on it. On November
10, 2026 the owner kept the rule after five collapsed factorial children
exceeded it by 14–25% at legal-logit magnitudes of 173–376, with tie sets
agreeing; that re-measurement also assesses the rule for future campaigns
([factorial](EDGER_TACTICAL_REVIEW.md#fourth-comparison-factorial-decomposition-of-the-production-learner)). ULP
diagnostics alone do not prove runtime fidelity or candidate ill-conditioning.

## 4. Learning

Behavior cloning trains the factorized joint action loss and behavior-value critic over the entire compatible corpus. If league ratings exist, it then makes one 10× lower-learning-rate pass over winner-side samples from top-quartile policies.

Fireball opportunity rows ([tactical review](EDGER_TACTICAL_REVIEW.md) proposal 3) are read from the v4 spell globals and the legal card mask:
- lethal: Fireball is legal and some enemy tower is at or below Fireball tower damage (globals 96–98);
- cluster: otherwise, Fireball is legal and one cast could hit at least three enemy troops (global 102).

Two BC options act only on those rows. Both default off, and the defaults reproduce earlier BC checkpoints bit for bit.
- `--card-teacher-filter opportunity` gives the card target of `aggressive`, `defender` and `random` weight 0. Their placement and delay targets stay. Aggressive and defender never cast spells, and random casts at random.
- `--opportunity-oversample K` repeats every opportunity row K times per epoch, before the row-group shuffle.

BC metrics record the recipe and its row counts (`data_recipe`), and the held-out Fireball capture (`validation_opportunity_capture`). Capture is how often the masked card argmax (lowest index on ties, as at runtime) is Fireball on validation opportunity rows, with the mean Fireball probability alongside.

The critic:

- receives opponent stratum only in its training-only branch
- uses terminal `+1/0/−1`
- uses `edger_potential_reward_v1` crown/tower potential shaping (v2, which adds position terms, is opt-in for the cadence diagnostic only; see [EDGER_REWARD.md](EDGER_REWARD.md))
- discounts by `0.9997^Δtick`

Offline improvement freezes the BC reference and critic:

```text
A = G - Vβ
weight = clip(exp(A / 0.25), 0.1, 20)
```

The actor rolls back and stops if validation KL from BC exceeds `0.05` nats.

Every checkpoint is immutable and contains parent checkpoint ID, optimizer state, seeds, manifest hash, dataset checksum, Git commit, environment versions, and metrics. Later phases warm-start from an accepted v2 checkpoint.

### Decision-cadence diagnostic (local only, never promotable)

`scripts/edger-v2-cadence-experiment.mjs` (with `edger-v2-cadence-core.mjs`,
`edger-v2-cadence-worker.mjs` and `edger-v2-cadence-experiment.py`) compares
the shipped learned delay against a fixed one-tick cadence. It is not used by
the live bot, the promotion evaluator or campaigns.

- `learned`: card, placement, then a 1–200 tick delay, exactly as
  `selectEdgerV2PolicyDecision`.
- `fixed_one_tick`: the same card and placement heads reconsidered every tick.
  PASS stays available and is never overridden; the delay head is not
  evaluated; the delay is one tick with probability one.
- Sampled rollouts record per-head behaviour log-probabilities from the actual
  temperature-1 masked softmax. Fixed-cadence rows record delay index 0 and
  delay log-probability 0. Rewards use `edger_potential_reward_v1` over the
  actual decision intervals, identical to `deriveDecisionSequence`.
- The `learned` learner mode is the production V-trace update unchanged
  (bit-identical in `tests/test_edger_v2_cadence.py`). `fixed_one_tick` drops
  the delay term from the policy log-probability and entropy, so the delay head
  receives no gradient. Learned-mode trajectories must not be relabelled as
  fixed-cadence data.
- Attribution controls (`train-arm --loss-mode`, default `full`):
  `critic_only` removes both the policy loss and the actor entropy, so the
  actor moves only through value-loss gradients into the shared trunk;
  `value_detached` keeps the full actor loss but trains the value head on
  detached trunk features. The loss mode cannot change within an arm.
- Card KL floor (`train-arm --card-kl-coefficient β`, default 0; tactical
  proposal 3): adds β × KL(BC parent ‖ model) over the card head on every
  on-policy row. The forward direction keeps probability on cards the parent
  plays, encouraging retention of rare cards such as Fireball; argmax use can still collapse. β = 0 is the
  production update exactly. The coefficient cannot change within an arm, and
  `critic_only` rejects it. Learner metrics report the on-policy card KL to
  the parent (`conditional.card_kl_to_reference_given_choice`) at any β.
- Targeted floor (`train-arm --card-kl-rows opportunity`, default `all`;
  proposal 3 option 1): the same β × KL term, with the same per-row weight,
  only on Fireball opportunity rows (the classes above, read from each
  on-policy row's globals and card mask). Other rows get no KL term. `all` is
  the floor above, bit-identical to the October 27 arms. The row set cannot
  change within an arm. Learner metrics count the on-policy opportunity rows
  and their card KL (`conditional.opportunity_rows`,
  `conditional.card_kl_to_reference_given_opportunity`).
- `train-arm --heldout <v4 cache>` also measures held-out Fireball capture for
  the model and its parent after every iteration (see Learning above). A pooled
  capture rate below the parent's is a diagnostic failure: the arm records
  `capture_below_parent_iterations` and `capture_diagnostic`, and keeps
  training. The production `vtrace` learner has no card KL term yet.
  `heldout` reads the validation split once and reuses its batches for the
  loss, the KL and both captures; its report is byte-identical to the earlier
  four-read version. That is about 28 s per iteration on the 9,343-row subset,
  down from about 139 s, and it still decodes the whole file, so it does not
  scale to the production corpus as written.
- Measured local results are in the [tactical review](EDGER_TACTICAL_REVIEW.md#stronger-targeted-floor--november-2-2026). Each floor that kept Fireball also cost play (global β = 0.05, targeted β = 1), so both stay default-off.
- Training is bit-reproducible only on the same host. On November 2, 2026, an M6 reran an M1's arms with identical rollouts and parent outputs, but its first update already differed, and the children's scores moved by up to 0.17. JS evaluation of two fixed children matched across the tested hosts (400 games). Compare learner arms only against controls trained on the same host.
- Run-to-run spread is large. Six end-to-end old-recipe runs on the M6 (November 3, 2026) gave a child-primary SD of 0.118, versus a within-model evaluation-seed SE of about 0.015. All six completed cleanly; one barely improved on its parent and remains a valid outcome. The independent-training-run planning approximation targets effects around 0.36 at three runs per arm and 0.16 at ten; shared evaluation seeds alone do not estimate the spread of matched training differences. The owner rule of November 4, 2026 sizes every further RL recipe comparison. The mean is primary, with 12 runs per arm for effects around 0.15 and about 24 for 0.10. Poor runs are never removed by score, and the median is secondary. Sizing, failure handling and stopping are frozen before output. Normal-model power and SD intervals are provisional with six runs ([pilot and rule](EDGER_TACTICAL_REVIEW.md#comparison-rule--owner-decision-november-4-2026)).
- Rollout freshness matters at this scale. Twelve parents each trained two RL children with equal games, seeds, opponents and 384 updates (November 6, 2026, M6). Refreshing rollouts every 64 games beat learning from one 384-game parent rollout by 0.105 primary [0.057, 0.152]; B was lower in 10 of 12 pairs. The single rollout still improved the parent, but kept only 41% of the refreshed loop's gain (post hoc). The SD of the matched difference was 0.075, against an independence reference of 0.104 from these arms' marginal SDs (post hoc); the 0.167 reference uses the earlier pilot's SD. On November 6 the owner required refreshed rollouts in any future RL or league stage. Every 64 games is the tested baseline; the best frequency is unknown. The production learner path was tested later, as recorded below ([results](EDGER_TACTICAL_REVIEW.md#first-comparison-rollout-freshness-at-equal-updates)).
- At four times the updates, refreshed training still beats stale training. The same 12 parents trained again at 1,536 games and updates (November 6, 2026, M6). Refreshing every 64 games beat one 1,536-game parent rollout by 0.259 primary [0.113, 0.405], in all 12 pairs. The increase in the gap from 384 updates was inconclusive: 0.154 [−0.003, +0.311]. The refreshed children gained +0.245 over their parents (gain SD 0.064; final child-score SD 0.028). Whether the stale child regresses below its parent on average was inconclusive: −0.014 [−0.188, +0.160]. Post hoc, 4 of 12 stale children had degenerated to card and delay entropy near 0, a minimum delay at every decision and logits of 108–366, and 3 of 12 lost more than 0.15. No refreshed child did either. The production learner path was then compared on identical data (below) ([results and next step](EDGER_TACTICAL_REVIEW.md#second-comparison-staleness-at-four-times-the-updates)).
- The production learner path costs play quality on identical refreshed data (November 7, 2026, M6). Twelve parents' 1,536 refreshed games each went through `convert-collection`, `edger-dataset.mjs` and `vtrace`. The resulting children scored 0.098 below the `train-arm` children trained on the same games [0.036, 0.159], lower in 10 of 12 pairs and against every opponent. The frozen label is "train-arm better (|mean| < 0.15)".
  - The production children still improved their parents by 0.147, about 60% of `train-arm`'s gain. They made about 1,227 updates against 1,536, and their spread was about 3.5 times larger.
  - Three of 12 collapsed to minimum-delay PASS play, and no `train-arm` child did. The cost was the same without them (−0.099 over the other nine, post hoc).
  - The production path differs only by its train-split filter, episode-ID order and balancing weights. Balancing weights reached 8–30 in later caches.
  - Which of the three causes the cost was tested, and attribution is unresolved. A paired 2³ factorial on the same data (November 9, 2026, M6) left all three average effects inconclusive at this size. Four corner contrasts resolved a direction, each favoring the `train-arm` level with size unresolved: dropping episode-ID order from production, and adding any one behavior to `train-arm`. Five collapsed children failed parity, which blocked three labels.
  - On November 10 the owner deferred an episode-order change: a future campaign that needs the production learner first gets its own paired comparison on fresh parents and rollouts. Further attribution uses the `train-arm` learner, with the league opponent mix next ([third](EDGER_TACTICAL_REVIEW.md#third-comparison-production-learner-on-fixed-refreshed-data), [factorial](EDGER_TACTICAL_REVIEW.md#fourth-comparison-factorial-decomposition-of-the-production-learner)).
- `--decompose-every N` measures policy, value and entropy gradients
  separately (`torch.autograd.grad` on the same graph) on every Nth update,
  with their trunk cosine. The applied step is still the one combined backward
  pass (bit-identical, tested). Learner metrics also record the effective
  per-group parameter step and a `conditional` block: forced-PASS fraction
  (no legal card), card entropy and importance ratios on rows with a real card
  choice, and placement entropy on play rows. Row-weighted averages are
  diluted by PASS rows and should not be read as per-decision sharpness.
- `replicate-seeds --base <seed plan>` derives independent training seed plans
  (new training seeds and opponent schedule; the base development and probe
  seeds, so evaluations stay paired) and a reserved confirmation seed set,
  all disjoint from each other and the frozen suites. `--episodes-root` and
  `--prune-episodes` keep large trajectory bodies off the repository volume
  and delete them after a successful update; headers with body checksums stay
  in the arm directory.
- `evaluate --seed-set development|confirmation` is required. Development
  seeds come only from a base or per-run seed plan, confirmation seeds only
  from the replication plan; a mismatched file, missing set or too few seeds
  fails. The whole named set must be distinct and disjoint from the frozen
  suites, every other set in the plan and each `--exclude-seed-plans` file
  (pass the base plan for confirmation, since r0 trained on its seeds).
  Reports record the set, plan schema, excluded-plan checksums and exact seeds.
- Routine policy diagnostics (`edger_v2_policy_diagnostics_v1`, since
  November 6, 2026) are descriptive reporting for every RL child. They are not
  exclusion, stopping or promotion thresholds. Every `evaluate` and `collect`
  result counts them per game, and every summary pools them under
  `policy_diagnostics`. `diagnostics --evaluations <files> --out <file>` pools
  one model's opponent files and refuses files for different models or cadences,
  repeated opponents, or files that predate the diagnostics. Definitions,
  frozen before the production-learner comparison:
  - Population: every decision the candidate makes in the summarized games, each counted once. For a child, that means its deterministic development-seed evaluation games.
  - A choice decision has at least one legal non-PASS card. A PASS decision selects card index 0.
  - Card entropy (nats) is the temperature-1 masked softmax over the legal card actions, PASS included, on choice decisions only. Delay entropy (nats) covers the 200 legal delay bins, conditional on the selected card and placement. It covers every learned-cadence decision and is null for the fixed cadence. Both are computed in float64 from the runtime's own float32 logits.
  - The maximum legal logit is the largest |logit| over legal entries, reported per head. The card head covers every decision; the placement head covers the selected card's legal cells when a card is selected; the delay head covers the learned cadence only.
  - Pass fraction is reported over all decisions and over choice decisions. Chosen delay is the mean over decisions, plus the fraction of decisions that chose the 1-tick minimum.
  - Aggregation pools decision-weighted means and the population maximum, with p05/p50/p95 of per-game means.
  - These figures are not the parity report's `maximum_legal_logit_magnitude`, which is measured on parity fixtures.
- `convert-collection --collection <collection.json> [--headers <dir>]
  --store <dir> --manifest-out <file> [--report-out <file>]` (since November
  7, 2026) turns one train-arm collection into production
  `edger_training_episode_v1` episodes for `edger-dataset.mjs` and `vtrace`.
  Bodies may be pruned. It requires the collecting model's SHA-256 to equal
  the recorded one and replays every game from model, seed, side and opponent.
  Each regenerated body must equal its header's checksum, and the production
  `deriveDecisionSequence` must reproduce every cadence row exactly
  (observation, masks, action, delay, behavior log-probability, reward,
  return). Any failure leaves no manifest, only `<report>.failed`. The policy
  and collector labels (`edger_v2_cadence_conversion_v1`) are fixed in code,
  because the content-hashed episode IDs set the production split and
  order. Converting the same collection again gives the same IDs. The
  production path then differs from train-arm's learner only by its
  train-split filter, ID (hash) order and balancing weights
  ([comparison design](EDGER_TACTICAL_REVIEW.md#third-comparison-production-learner-on-fixed-refreshed-data)).
- Checkpoints use `edger_v2_cadence_diagnostic_checkpoint_v1`, which production
  `load_checkpoint` rejects, and exports are labelled
  `diagnostic_only_not_promotable`. The diagnostic learner records the dirty
  worktree diff hash instead of requiring a clean tree; it is not authoritative
  training.

## 5. Scaling and snapshot league

`npm run edger:dataset -- --scales-dir ...` produces immutable selected
manifests plus Parquet/Zstd caches for fixed 1%, 10%, and 100% subsets. Only
training episodes are reduced: 1% train is a subset of 10% train, which is a
subset of 100% train. Every scale contains the complete, byte-identical
validation and test episode ID lists.

`npm run edger:evaluate:scaling` emits
`edger_frozen_league_report_v1`. Every candidate plays 40 games each against
live v1, the frozen heuristic, random, aggressive, and defender. Every seed is
played from both sides; the reported score is the equally weighted mean of the
five matchups. Reports bind the candidate model and checkpoint checksums, frozen
suite checksum, illegal-action count, and replay checks.

`edger_data_scaling_report_v2` validates all three manifests, checkpoints,
models, and frozen reports before it passes only when:

- 100% held-out joint action loss improves over 10%
- 100% frozen-league score does not regress from 10%

Joint action loss is the unnormalized sum of card, conditional-placement, and
delay cross-entropies. Its absolute magnitude depends on legal-action entropy,
so the scaling proof uses relative held-out improvement instead of a fixed
absolute floor. Separate frozen-league and full-promotion gates enforce gameplay
quality. League training refuses to start without both scaling facts.

One-time `edger_scaling_recovery_v1` recovers exact versioned artifacts retained
from source SHA `f25a4880e65f0eed6eda8c3ecc33d42d2ad6af33`. It verifies source
ancestry, unchanged dataset/simulator/corpus derivation paths, legacy report's
sole failed `<0.10` gate, every S3 version and SHA-256, artifact bindings,
nested training sets, identical held-out sets, zero illegal actions, and replay
success. It regenerates v2 report with source checkpoint Git commit in every
scale entry. Source failure prefix is never rewritten.

Recovery campaign adds `full-cache` after scaling. It derives only
`edger_decisions_100pct.parquet` from exact recovered 100% manifest, then checks
manifest hash, 593,576 rows, `475,845 / 59,529 / 58,202`
train/validation/test counts, exact schema, Zstd compression, 256-row groups,
and logical content against replay-derived build stream. Parquet is durable only
in this stage; later stages download marker-bound checksum.

The recovery cache's canonical v2 persisted schema checksum is
`3623ade0a47e7b66b64f46581788b2dda46cee2b78b6b02c3ceeae34c11e2f5a`:
SHA-256 of canonical JSON for the ordered `{name, type, nullable}` field
descriptors read back from Parquet, excluding metadata. The first 256 production
rows and retained smoke caches reproduce this schema with PyArrow 17 and 21.
The previous inferred v1 schema stored integer/null behavior probabilities and
could not losslessly append fractional league probabilities. The September 4
full-evaluation attempt therefore stopped during league dataset preparation.
Its evidence stays under `campaigns/20260903-v2-recovery`; canonical-schema code
targets fresh `campaigns/20260904-v2-recovery` with a new reviewed SHA and
recovery-manifest checksum. Source artifact versions, checksums, and scaling
metrics remain unchanged.

The v2 schema fixes field order and types before the first row group, including
nullable float64 behavior probability and policy league rating. Build-time
logical hashing uses each bounded Arrow row group's normalized
values only after verifying value equality with the original replay-derived
rows. This accepts lossless JSON numeric representation changes (`0` to `0.0`)
but rejects truncation, dropped fields, or other value changes. Validation hashes
the independently read Parquet rows and still rejects schema, content, count,
split, metadata, compression, and row-group mismatches. The failed August raw
JSON content hash is diagnostic evidence, not an accepted cache checksum.
The full-cache stage runs `npm run test:edger-streaming` in the actual runner
environment before starting the expensive corpus scan, including the pinned
schema, lossless numeric conversion, corruption, and repeatability regressions.
The test launcher suppresses Python bytecode writes so this preflight preserves
the immutable checkout's clean-worktree invariant.

Production campaigns use 16–32 Node worker threads and pre-assign paired match specs, making rollout seeds and sides independent of worker count. The exact JavaScript simulator writes full verified episodes before the PyTorch learner runs.

League limits:

- frozen heuristic
- current champion
- up to seven promoted historical snapshots
- up to four non-dominated contenders

Opponent allocation:

- 40% current champion
- 20% heuristic
- 20% uniform historical
- 20% PFSP over history/contenders with `(1−score)²+0.05`

Every selected seed is played from both sides. Only simulator decisions with known behavior log-probabilities enter V-trace. Importance and trace coefficients are clipped at 1.

V-trace targets, clipped importance ratios, and gradients for an episode must
use the same learner parameters. Do not cache targets for an entire optimizer
epoch: negative advantages then continue penalizing actions after their current
probability has collapsed. Each episode now refreshes targets before its sole
optimizer update; microbatch losses are normalized by total eligible episode
rows. Non-finite losses or gradient norms abort without saving a candidate.
Every epoch records a pre-clip gradient-norm summary under
`metrics.vtrace.gradient_norms_per_epoch`: `updates`, `all_finite`,
`minimum`/`mean`/`maximum`, the `1.0` `clip_threshold` and `clipped_updates`.
This is observability for bounded comparisons, not an additional gate; the
existing `clip_grad_norm_(error_if_nonfinite=True)` abort is unchanged.
This follows the current-policy correction in
[IMPALA, section 4](https://proceedings.mlr.press/v80/espeholt18a.html).
The correction is not evidence of learned improvement; promotion still requires
all existing gates.

Every validation report records `maximum_legal_logit_magnitude`,
`logit_scale_warning`, and `logit_scale_warning_threshold`. The warning threshold
is approximately `83.886`, a two-roundoff estimate from `1e-5 / (2 * 2**-24)`.
It is advisory, neither a parity guarantee below it nor a rejection above it.
The previous uncommitted `parity_verifiable_logit_scale` name was misleading and
has been replaced. Do not add a training abort based on this estimate. Use
measured exported-model parity and held-out quality to select candidates; any
regularization or rollback rule needs bounded real-corpus evidence first.

League collection accepts `--base-manifest` and `--rollout-store`. The learner
manifest is the immutable 10,000-game base plus only the current command's
rollout. The 32-game smoke and 1,000-game production rollout use different
stores; smoke data is discarded from production lineage.

## 6. Scheduling

`.github/workflows/edger-corpus-health.yml` replaces daily training. It performs a deterministic canary, compatible-manifest rebuild, deduplication/health reporting, and trigger calculation.

`.github/workflows/edger-corpus-collect.yml` is the manual production collector.
It requires an externally supplied `s3://` `EDGER_CORPUS_STORE`, performs an S3
read/write preflight, and launches ten parallel 1,000-game shards at pair
offsets `0,500,…,4500`, with four workers per hosted runner. CI never falls back
to an ephemeral local corpus.

The aggregation job requires global indices `0…9999`, 5,000 paired seeds,
5,000 games from each Edger side, 2,500 games per frozen opponent, one Git
commit/specification cohort, unique episode IDs, zero failures, and complete
replay verification. `edger:corpus:validate --workers 16 --report ...`
independently checks every compressed checksum, schema, episode ID,
action/event stream, result, final hash, and replay.

AWS workflows request 12-hour OIDC sessions from a role whose
`MaxSessionDuration` is also 12 hours. This covers the exhaustive manifest,
replay, and remote-monitor steps without using stored access keys. Corpus
aggregation artifacts are copied to a run-specific S3 prefix even when a later
freeze gate fails; only a fully successful run publishes the canonical frozen
manifest.

A cumulative campaign becomes due when:

- compatible games grow by at least 20%, or
- at least 100,000 compatible games are new,

subject to a 14-day cooldown. A 30-day backstop triggers when any new data exists. State can live beside an S3 corpus.

`.github/workflows/edger-campaign.yml` uses GitHub OIDC to launch and monitor an
SSM-only on-demand `c7g.4xlarge`; heavy training/evaluation does not run on a
repository self-hosted runner. The `edge-royale-edger-campaign` CloudFormation
stack creates the retained bucket and runner controls in `ap-southeast-2`.
Dispatch requires `operation`, full reviewed `campaign_sha`, exact
`campaign_uri`, and `target_stage`. `run` accepts `full-cache`, `offline`, or
`full-evaluation`; `promote` stays separate.

The instance has 16 vCPU, 32 GiB RAM, encrypted 200 GiB gp3, no inbound ports
or key pair, instance-initiated termination, and a 24-hour safety shutdown.
The main-branch workflow dispatch commit supplies only the launcher control
plane and must contain the reviewed campaign SHA in its ancestry. The runner
then clones, checks out, verifies, and executes that exact campaign SHA.
The GitHub role can launch only `c7g.4xlarge` instances with IMDSv2, tagged
instance/encrypted-gp3 volume resources, an Amazon-owned AMI, and the stack's
exact subnet and security group. The primary network-interface permission is
separate because EC2 evaluates that untaggable resource independently during
`RunInstances`.
Amazon Linux 2023 Chromium dependencies are installed explicitly with `dnf`;
Playwright downloads only its pinned Chromium build and never invokes its
unsupported-distribution `apt-get` fallback.
The Python virtual environment lives at `/opt/edge_royale_venv`, outside the
immutable repository checkout, so bootstrap cannot trip the clean-worktree
pre-stage gate.
Every completed stage/object is immutable and bound to Git SHA plus recovery
manifest checksum. Resume downloads only matching stages; mismatched objects or
markers fail closed. Matching active runners are monitored, never duplicated.
GitHub polls five hours, then succeeds detached if runner remains active; a
terminated runner without target marker fails. Each attempt uses unique
`github-<run>-<attempt>` log, then instance and encrypted volume terminate.
Peak resident memory stays below 28 GiB and disk use below 160 GiB. Failed
stages leave live v1 unchanged. `promote` requires matching full-evaluation
marker, zero active runners, and exact candidate/report checksums; it opens but
never merges manual-review PR.

## 7. Commands

```bash
npm run edger:corpus:collect
npm run edger:collection:aggregate -- --report <shard.json> ... --out <aggregate.json>
npm run edger:corpus:import -- --file <manual-replay.json>
npm run edger:corpus:validate
npm run edger:corpus:manifest -- --out <manifest.json>
npm run edger:corpus:health -- --manifest <manifest.json> --report <health.json>
npm run edger:dataset -- --manifest <manifest.json> --out <cache.parquet>
npm run edger:train:bc -- --dataset <cache.parquet> --out <bc.pt>
npm run edger:train:offline -- --dataset <cache.parquet> --checkpoint <bc.pt> --out <offline.pt>
npm run edger:evaluate:scaling -- --candidate <candidate.json> --checkpoint <bc.pt> --out <frozen-report.json>
npm run edger:scaling:report -- <three-checkpoint-and-league arguments>
npm run edger:train:league -- <campaign arguments>
npm run edger:benchmark:throughput -- --candidate <candidate.json> --workers 16 --enforce
npm run edger:reference:v2 -- --champion <live-v1.json> --anchors <paths> --out <reference.json>
npm run edger:export:v2 -- --checkpoint <candidate.pt> --out <candidate.json>
npm run edger:generate:v2 -- --model <candidate.json> --out <candidate.js>
npm run edger:parity:v2 -- --model <candidate.json> --out <parity.json>
npm run edger:opportunity-bank -- --manifest <local-manifest.json> --out <frozen-bank.json>
npm run edger:evaluate:v2 -- --opportunity-bank <frozen-bank.json> <candidate/champion/anchor/reference/external-report arguments>
npm run edger:promote:v2 -- --model <candidate.json> --report <full-report.json>
npm run edger:campaign:remote -- launch
npm run edger:campaign:remote -- status
npm run edger:campaign:remote -- terminate
npm run edger:scaling:recover -- \
  --manifest artifacts/edger-training/recovery/edger_scaling_recovery_v1.json \
  --out-dir <temporary-directory> \
  --target-git-sha <full-reviewed-sha> \
  --campaign-uri s3://edge-royale-edger-REDACTED-ACCOUNT-ID-ap-southeast-2/campaigns/20260904-v2-recovery
```

## 8. Promotion gate

The corpus, BC, offline-improvement, scaling, league/V-trace, parity, large-sample evaluator, checksum-bound promotion, and campaign PR foundations are implemented. V2 remains shadow-only until a real full report passes:

- paired champion bootstrap bounds
- heuristic and anchor non-regression bounds
- weak-baseline floors
- frozen-league improvement/worst-anchor floors
- 10,000-match illegal-action and repeatability proof
- tactical, replay, determinism, full-suite, browser, and `p95 ≤ 5 ms` gates

Failed campaigns retain reports/checkpoints and never update the promoted artifact.

Parity, tactical feasibility/quality, held-out Fireball capture, and timing run before the match workers.
A failed preflight produces a rejected report with `generated_matches=0`,
`match_suite_skipped=true`, and failed/skipped match gates. The tactical suite
uses six-tower production arenas and complete fixed decks. Every category floor
must be reachable by an enumerated legal action; the spell-cluster fixture has
three targets so its unchanged 0.70 floor is achievable. Parity checks the
opening position plus mid-match states the candidate itself reaches. At each
state it tests PASS and every legal card, comparing legal placement logits and
conditioning delay on that card's JS-selected legal placement; PyTorch must
independently agree on masked argmax and on the exact legal tie set. Reports
include state/branch coverage, per-head errors and magnitudes, the worst
absolute error with its own coordinate's values and ULP spacing, the tolerance
rule, the count and worst ratio of coordinates over tolerance, and fragile
margins: a head whose PyTorch margin over the next distinct legal logit is
within twice the measured error. Fragile margins do not fail the gate; a
non-zero `fragile_margin_count` sets `review_required` and must be reviewed
before promotion. Malformed/non-finite outputs are rejected. Failure reasons
report measured errors, argmax or tie-set disagreement without inferring a root
cause from logit scale. The parity tolerance changed to the hybrid rule above on
October 25, 2026; the identical-argmax, quality, safety, and `p95 ≤ 5 ms`
thresholds are unchanged.

Proposal 4 (November 2, 2026) versions the synthetic bank as
`edger_tactical_scenarios_v2`: five states per category (tick, elixir and lane
variants), each mirrored by a 180-degree team rotation, for 50 decisions.
Defense requires an intercept in the threat's lane, between it and its target
tower, with deployment plus estimated closure preceding tower contact.
Punishment requires a troop in the front rows (canonical y 12.5–16.5) while
enemy elixir is at most 2; back-row and spell credit is zero. All five existing
category minimums and the strict aggregate improvement over the heuristic stay
unchanged. The defense base moves from the old center Giant to the actual
bridge lane, because interception was otherwise unreachable in the existing
placement action set. The timing gate keeps the original five input states.

`edger:opportunity-bank` reads only stable **test** shards from a checksummed
manifest, checks each episode's compressed checksum and full replay, and
retains the first opportunity per episode/actor/class. Lethal takes precedence
over cluster; Fireball must be legal. Labels use tower HP ≤ Fireball damage or
at least three enemy troop centers within a legal cast's radius, matching the
engine's current-state impact geometry. This does not forecast projectile
arrival or establish strategic value. The bank stores read-only inference
state snapshots, episode/replay checksums, the source manifest hash and a
logical bank checksum. No training command imports or consumes the bank.

Snapshots (schema `edger_fireball_opportunity_bank_v2`) carry every engine
field a decision reads, including the spawn and effect counters and the last
tick's combat events (v2 globals 84, 85 and 87). The builder proves each
snapshot before storing it: the restored engine's legal actions, v2
observation and v1 per-action features must equal the live replay engine's,
or the build fails. Validation requires exactly that field set and rejects
schema v1 banks, whose snapshots dropped those three fields.

V2 evaluation requires `--opportunity-bank <frozen-bank.json>`. The new
`heldout_fireball` preflight gate scores **correctly aimed, legal Fireballs**;
card choice is reported separately. It reuses the existing tower-finishing
0.80 and spell-value 0.70 numbers as the lethal and cluster capture-rate
minimums. These are explicit new capture gates, not recalibrated synthetic
score units or thresholds fitted to a baseline. Missing/invalid banks, empty
classes and failed capture prevent match dispatch and promotion. Reports bind
the bank's logical and file checksums; old reports without this gate cannot
promote. Freeze the source manifest, sampling rule and bank before evaluating
candidates; do not tune them against candidate scores. The production driver
builds the bank in `full-cache` before offline/league learning and passes that
same artifact to full evaluation. A new campaign still needs fresh compatible
scaling/provenance and separate approval.

See the [proposal 4 record](EDGER_TACTICAL_REVIEW.md#proposal-4-scoring-and-held-out-opportunities--november-2-2026)
for the before/after heuristic and live-v1 baselines, bank coverage and limits.

Failure reports are retained under `failed-stages/<stage>/<attempt>/`, separate
from passed `stages/` artifacts. See [the September diagnosis](EDGER_EVALUATION_DIAGNOSIS.md)
for exact versioned evidence and the approval-dependent next campaign plan.
