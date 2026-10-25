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
- rules, simulator, replay, observation, action, and reward versions
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
- versioned potential-shaped reward
- behavior log-probability
- opponent stratum
- source and V-trace eligibility

Long waits are represented by deterministic `PASS` decisions at most every 200 ticks, not per-frame PASS labels.

### `edger_dataset_manifest_v1`

Manifests are immutable lists of object URIs and compressed checksums for one compatibility cohort. Whole games are split by `SHA-256 episode ID mod 100`:

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

- `32×18×24` relative-side board
- 96 global features
- full oracle elixir, hands, queues, phase, timing, tower/pocket state, motion, targeting, cooldown, and pending-effect state
- blue observations rotate 180 degrees so the acting side has one canonical orientation

Actor:

- one same-padded 16-channel `3×3` convolution and two 16-channel `1×1` convolutions
- `96→64` global encoder
- 64-wide fused state
- masked `PASS`/fixed-card head
- conditioned row-major `18×32` placement head
- conditioned 1–200 tick delay head
- stable production order: PASS, fixed deck, row-major `(y,x)`, ascending delay

The exported actor has 36,402 parameters and must stay under 50,000 parameters and 1 MB. The opponent-stratum embedding and value head exist only in PyTorch checkpoints. V2 inference never calls the handcrafted prior.

Export writes each weight as the shortest decimal that reloads as the identical
trained float32, and refuses to emit an actor whose weights do not reload
exactly. Eight-decimal rounding is not lossless: it keeps decimal places rather
than significant digits, so it altered 53.5% of a real BC actor's weights, worst
case `1.29e-3` relative on `conv1`. The measured BC export grew about 3%, while the league export became smaller;
both stay inside the 1 MB cap. Other candidates must still satisfy the byte gate.

PyTorch dense weights are transposed into input-major generated-JS arrays. Golden fixtures require maximum logit error at or below `1e-5` and identical masked argmax.

The runtime stores activations as float32 and accumulates dot products in
JavaScript numbers. The board mean pool also sums in float64 and rounds once to
float32 (since October 25, 2026); a float32 running sum over 576 cells was the
main JS-side deviation ([parity packet](EDGER_PARITY_CONTRACT_REVIEW.md)).
PyTorch can use different summation orders; exact agreement
is not guaranteed ([PyTorch numerical accuracy](https://docs.pytorch.org/docs/2.14/notes/numerical_accuracy.html)).
Float32 spacing is neither a minimum error nor a bound on accumulated error.
Large logits can match exactly, and small logits can still disagree. There is
no proven `83.886` cutoff for parity. Logit scale is a useful warning for local
experiments; the unchanged measured `1e-5` error and identical masked argmax
remain the actual gate. ULP diagnostics alone do not prove runtime fidelity or
candidate ill-conditioning.

## 4. Learning

Behavior cloning trains the factorized joint action loss and behavior-value critic over the entire compatible corpus. If league ratings exist, it then makes one 10× lower-learning-rate pass over winner-side samples from top-quartile policies.

The critic:

- receives opponent stratum only in its training-only branch
- uses terminal `+1/0/−1`
- uses `edger_potential_reward_v1` crown/tower potential shaping
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
npm run edger:evaluate:v2 -- <candidate/champion/anchor/reference/external-report arguments>
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

Parity, tactical feasibility/quality, and timing run before the match workers.
A failed preflight produces a rejected report with `generated_matches=0`,
`match_suite_skipped=true`, and failed/skipped match gates. The tactical suite
uses six-tower production arenas and complete fixed decks. Every category floor
must be reachable by an enumerated legal action; the spell-cluster fixture has
three targets so its unchanged 0.70 floor is achievable. Parity checks the
opening position plus mid-match states the candidate itself reaches. At each
state it tests PASS and every legal card, comparing legal placement logits and
conditioning delay on that card's JS-selected legal placement; PyTorch must
independently agree on masked argmax. Reports include state/branch coverage,
per-head errors and magnitudes, and the worst absolute error with its own
coordinate's values and ULP spacing. Malformed/non-finite outputs are rejected.
Failure reasons report measured errors or argmax disagreement without inferring
a root cause from logit scale. The
absolute `1e-5`, identical argmax, quality, safety, and `p95 ≤ 5 ms` thresholds
are unchanged.

Failure reports are retained under `failed-stages/<stage>/<attempt>/`, separate
from passed `stages/` artifacts. See [the September diagnosis](EDGER_EVALUATION_DIAGNOSIS.md)
for exact versioned evidence and the approval-dependent next campaign plan.
