# Edger Cumulative Training

## 1. Status and boundary

The old daily masked-PPO trainer has been removed. It restarted from bootstrap, retained no games, used a short one-tower arena, and could not learn useful state/action interactions.

Edger v2 is a shadow pipeline:

1. persistent full-match corpus
2. structured behavior cloning
3. one conservative offline advantage-weighted actor phase with a frozen behavior-value critic
4. fixed 1%/10%/100% data-scaling proof (it gates production league training, not promotion; owner, November 23, 2026)
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

### Full-grid troop placement

**Adopted (owner, November 13, 2026):** new Edger training and comparisons
use the full-grid action space, with reward v1 and no critic warm-up. Live
Edger keeps the legacy shortlist until a full-grid candidate passes
promotion. Since November 20, 2026 the tactical and held-out Fireball results
are reported, not gates ([gate review](EDGER_GATE_REVIEW.md)). Code defaults
are unchanged, so legacy checkpoints, caches and completed runs still
reproduce; branch new work with `initialize-full-grid`.

Full-grid v2 actors declare `edger_autoregressive_full_grid_v1`. The engine
supplies all legal troop tiles, and the placement head adds a learned
projection of the canonical row and column in [−1, +1] before its activation.
The projection adds 32 weights. Training, export and inference use the same
row-major tile indices.

To branch from an existing production-schema checkpoint with the new weights
initialized to zero, run:

```bash
python3 scripts/edger-v2-training.py initialize-full-grid \
  --checkpoint <legacy.pt> --out <full-grid.pt> --model-out <full-grid.json>
```

Pass the checkpoint and its matching model to `train-arm` or the existing
league workflow. Collect new games from the expanded actor. Episodes,
collections, checkpoints and derived Parquet caches identify the action space.
Production V-trace selects eligible rows with the checkpoint's action space.
Legacy corpora can still supply behavior-cloning data with their recorded
masks. Full-grid promotion timing includes action enumeration in the existing
5 ms p95 limit.

For opted-in player demonstrations, pass `--action-space-version
edger_autoregressive_full_grid_v1` to `edger:corpus:import`. This lets cache
preparation retain placements across the player's legal grid. Browser replays
supply demonstrations with unknown behavior probabilities for both sides.

### Decision-cadence diagnostic (local only, never promotable)

`scripts/edger-v2-cadence-experiment.mjs` (with `edger-v2-cadence-core.mjs`,
`edger-v2-cadence-worker.mjs` and `edger-v2-cadence-experiment.py`) compares
the shipped learned delay against a fixed one-tick cadence. It is not used by
the live bot, the promotion evaluator or production campaigns. The local
candidate campaign's selected run is its only promotable output (below).

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
- Critic warm-up (`train-arm --loss-mode critic_head`; the fifth comparison):
  trains only `value_head` and `value_stratum_embedding`, with the value loss
  alone on detached trunk features. The trunk and every actor head stay bit
  for bit unchanged, so the warm-up's exported actor is its parent's.
  `train-arm --initial-checkpoint <warm-up checkpoint>` starts a new arm from
  it, with fresh Adam. The parent stays the reference and plays iteration 0.
  The learner (`train-iteration --start-from-warmup`) refuses any warm-up that
  is not `critic_head`, or that differs from the arm in reward version, cadence
  or root parent. It also refuses any parameter outside the critic head that
  differs from the parent's. Checkpoints and learner metrics record the warm
  start (`warm_start`); without the flag, the update is unchanged.
- Collections record each game's `action_stream_hash` and `final_state_hash`.
  Collections of the same games under different rewards can then be compared
  apart from the `reward` and `discounted_return` arrays. Headers and bodies
  are unchanged.
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
- Playstyle diagnostics (`edger_v2_playstyle_diagnostics_v1`, since November
  11, 2026) describe how a candidate plays, for the reward comparison
  ([reward doc](EDGER_REWARD.md)). Like the policy diagnostics, they are not
  exclusion, stopping or promotion thresholds, and computing them changes no
  game: the tracker (`scripts/edger-playstyle-core.mjs`) only reads engine
  state. Every `evaluate` and `collect` result counts them per game under
  `stats.playstyle_diagnostics`, and every summary pools them under
  `playstyle_diagnostics`. The `diagnostics` report adds them as `playstyle`
  (pooled and per opponent). That field is null when every input predates the
  playstyle diagnostics, and the report is refused when only some inputs do.
  Definitions, set before the fifth comparison. The population is the candidate side of each game.
  - Wasted elixir: each tick that starts with the candidate at the 10-elixir cap loses that tick's regeneration: 1/56 elixir in normal time, 1/28 in double elixir, 1/20 in overtime. These are the ticks counted by `full_elixir_ticks`. Reported per game (mean, p05/p50/p95) and per minute of play.
  - Counter responses:
    - A threat is an opponent play of a troop in the frozen reward counter table: all six troops, no spells.
    - The response is the best class among the candidate's plays in the 100 ticks (5 s) after the threat, counting later ticks only: strong counter, partial counter, other card, or none.
    - Only the card is checked, not the lane: center cells split formations between lanes.
    - A threat whose window would run past the game's end is censored and left out.
    - Shares are reported overall, per threat card, and for threats where the candidate held a strong counter at the end of the threat's tick (at any elixir).
    - The response delay runs from the threat to the first strong or partial counter.
  - Giant plays into an answer: for each candidate Giant play, the opponent's hand and elixir in the state the candidate decided on. An affordable strong answer is Mini PEKKA, Goblins or Musketeer in hand with enough elixir. An affordable answer also counts Archers and Knight. The mean counter credit uses R's rule.
  - Checkpoints: the candidate's v2 potential parts at 60 s and 120 s (ticks 1200 and 2400, after the step, if the game is still in progress). These are Φ_v1, M (before the phase factor), T, R (weight 0, reported), S and the weighted position sum, each ours − theirs, in elixir units except Φ_v1. Reported as mean and p05/p50/p95, with the number of games still in progress. This is the checkpoint convention of the reward data checks.
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
- Snapshot league opponent mix (since November 15, 2026, for the [eighth comparison](EDGER_TACTICAL_REVIEW.md#eighth-comparison-snapshot-league-opponent-mix)). Training only; snapshot opponents never appear in the game. The comparison left the direction unresolved (+0.025 [−0.012, +0.062], [result](EDGER_TACTICAL_REVIEW.md#eighth-comparison-result)), so under its frozen decision the mix stays opt-in and the current mix stays the default.
  - `train-arm --opponent-mix plan|snapshot-league [--snapshot-every <k>]`. The default, `plan`, plays the seed plan's `training_opponents`, and its collections and headers are byte-for-byte unchanged.
  - In every cadence command, a plan's `edger` opponent is the retired v1 (`scripts/edger-harness-opponents.mjs`), the "live v1" of every recorded plan and of the candidate selection rule. Since the c3 promotion it no longer follows the live module (owner decision, November 28, 2026; [harness review](EDGER_HARNESS_REVIEW.md)). Corpus collection's Edger side is the same retired v1. A recipe against live c3 passes it with `--opponent-model`.
  - `snapshot-league` keeps each pair's allocation draw u from the plan's `opponent_schedule_seed`: live v1 for u < 0.4 and the heuristic for [0.4, 0.6), as the plan does. For u ≥ 0.6 it plays one of the arm's own pre-update actors, captured at iterations 0, k, 2k, … (snapshot 0 is the parent model) and eligible from the next iteration: uniformly for u in [0.6, 0.8), and by PFSP for [0.8, 1). An empty pool falls back to live v1, as `scripts/edger-league.mjs` does. At most seven snapshots.
  - The within-bucket draw is the first 48 bits of SHA-256(`edger_v2_snapshot_league_v1|<schedule seed>|<absolute pair index>`) / 2^48. The PFSP score is the learner's cumulative mean match point against the snapshot over completed earlier iterations, 0.5 when unplayed, with weight (1 − score)² + 0.05 fixed for the refresh.
  - Snapshots play deterministically, with their learned delay, over legal actions enumerated for their model, as the league worker plays models. Their games' headers add `opponent_stratum: edger` and the actor's SHA-256. The learner uses an explicit stratum and rejects one missing from the parent's vocabulary; every other header keeps the existing lookup.
  - Collections record the ordered pool with scores and weights and every pair's pick. Before a refresh is learned from, `train-arm` re-derives the pool and picks from the plan and the hash-verified earlier collections, and stops with an `instrument:` reason on any difference. Resuming (`--start-iteration`) rebuilds the pool from verified iterations, sets the interrupted iteration's outputs aside, and reproduces the uninterrupted picks, bodies and weights (tested). Exported actors embed the collection checksum, so actor SHA-256 values differ between runs; compare runs on picks, bodies and weights.
  - `convert-collection` refuses snapshot league collections.
  - `evaluate --opponent-model <file> [--opponent <label>]` plays a v2 model as the opponent (head-to-head), binding both actors' SHA-256 values and checking both sides' legality and repeatability.
- Fireball gap tooling (since November 19, 2026, for the [ninth comparison](EDGER_TACTICAL_REVIEW.md#ninth-comparison-fireball-capture-value-and-opportunity-weight)). It is diagnostic only. Every option is off by default; collections, headers, bodies, evaluations and the default learner command are unchanged (tested).
  - `scripts/edger-fireball-opportunity.mjs` holds the bank's capture and class rules (lethal first), shared with the evaluation-only bank, which re-exports them unchanged. It also has the learner's globals rule (`fireballOpportunityFromGlobals`). The two agree on all 50 tactical fixtures and on every decision of the tested games.
  - `fireball-branch --model <file> --evaluations <files> --out <file>` replays a model's own deterministic learned-cadence bot evaluations.
    - Each unforced game must reproduce its recorded hashes and point; otherwise it writes the report and exits nonzero.
    - Per class, the first decision of that class that did not already capture is replaced by a forced capturing Fireball (`decideForcedFireballCapture`): the placement head's best capturing cell, lowest index on ties, and the delay head's delay. The game is then replayed from the start.
    - The report has Δ match point, the replaced card, and an impact log from the engine's `spell_impact` event. A lethal cast landed if it hit an intended tower; a cluster cast, if it hit at least three intended troops.
  - `train-arm --opportunity-card-weight w --opportunity-card-weight-classes lethal|cluster|both` (defaults 1 and `both`) multiplies the card head's policy-gradient term by w on the Fireball opportunity rows of those classes, whatever card was sampled. Rows are classified by the targeted floor's globals rule.
    - w = 1 passes no flag to the learner and is the earlier update exactly.
    - The weight and classes cannot change within an arm.
    - Learner metrics report, per class: rows, Fireball rows, weighted rows, and the mean V-trace advantage on Fireball and other rows (`conditional.opportunity_by_class`).
  - `train-arm --fireball-aim-diagnostics` writes `iterN/fireball-aim.json`. Per episode and class, it counts the candidate's opportunity decisions, those that sampled Fireball, and those whose Fireball captured (bank rule). It also counts decisions where the globals rule disagrees with the engine rule. `collection.json` and the episode files stay byte for byte.
- Candidate campaign tooling (since November 23, 2026, for the [candidate campaign](EDGER_CANDIDATE_CAMPAIGN.md)). It adds a path for one selected run to become a candidate; every other output stays diagnostic.
  - `selection-seeds --label <label> --count 100 --final-evaluation-seed <seed> [--exclude-seed-plans <files>] [--exclude-seed-lists <json>] --out <file>` writes an `edger_v2_candidate_selection_seed_plan_v1` plan. Its labelled seeds avoid the frozen suites, every seed array in the excluded plans, every named extra list, and the match seeds of the campaign's final evaluation: the full schedule at that seed (`edgerV2EvaluationScheduleSeeds`, 5,650 seeds without anchors) and the live-v1 reference's 100 consecutive seeds (`edgerV2ReferenceMatchSeeds`). It records every exclusion file's SHA-256.
  - `evaluate --seed-set selection` plays only that set. It re-derives the final evaluation's seeds from the plan's evaluator seed and refuses any overlap, as well as the usual frozen-suite and cross-plan overlaps.
  - `edger-v2-cadence-experiment.py candidate-manifest --campaign-id <id> --runs <runs.json> --bc-dataset-sha256 <sha> --out <file>` writes `edger_v2_candidate_campaign_manifest_v1` once after training, from a clean checkout. For every run it records the lineage read from disk: the BC parent (checksum, seed, dataset, commit, data recipe), the full-grid initialization, the seed plan, the arm status and the chain of collection, checkpoint and model hashes. It also lists every way the run differs from the campaign commit and the measured recipe (`CANDIDATE_RECIPE`: learned cadence, `full` loss, reward v1, no card KL, no opportunity weight, no warm start, the plan mix, 24 × 32 pairs, torch seed 20260926, learning rate 0.001, full grid, default BC recipe). The checks cover each iteration's games against the plan's pairs and opponents, each checkpoint's input, collection and settings, clean provenance at the campaign commit, and each `model.json` against its checkpoint's export.
  - `export-candidate --manifest <file> --selection <file> --run <id> --out <file> --binding-out <file>` is the only command that labels a cadence checkpoint `shadow_candidate_unreviewed`. It requires a clean checkout at the manifest's commit, the measured recipe, an `edger_v2_candidate_selection_v1` file made on that manifest that selects this run, a valid manifest entry, and the run's files re-read from disk equal to the manifest. The export's weights must equal the selected run's final `model.json`, the model that played selection. `training.campaign` records the campaign ID, the manifest and selection hashes, the run, and the final and BC checkpoint hashes. The binding file (`edger_v2_candidate_export_binding_v1`) adds the export's SHA-256 and weights digest. Tests run the positive path on a two-iteration arm through the same functions with a smaller recipe; the command itself refuses it.
- `scripts/edger-qa-report.mjs --kind npm-test|browser-smoke --out <file> [-- <npm arguments>]` (since November 23, 2026) writes the driver's `edger_external_qa_report_v1` report locally. It runs the command itself and writes the report only if the command exits 0 and the checkout is clean, at the same commit, before and after. The production driver builds its reports with the same function.
- Checkpoints use `edger_v2_cadence_diagnostic_checkpoint_v1`, which production
  `load_checkpoint` rejects, and exports are labelled
  `diagnostic_only_not_promotable`, except a campaign's `export-candidate`
  output (above). The diagnostic learner records the dirty
  worktree diff hash instead of requiring a clean tree; it is not authoritative
  training. `edger:evaluate:v2 --profile full` and `edger:promote:v2` refuse
  that label (smoke-profile evaluation stays allowed).

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

With no `--league` file or `--historical-anchors`, both snapshot buckets fall back to the champion. The September campaign ran this way (396 champion and 104 heuristic pairs, reconstructed from its seed). The cadence `train-arm` schedule (`trainingOpponentSchedule`) has the same nominal 80% champion and 20% heuristic allocation on its own seed plans.

League rollouts record `edger` as the `opponent_stratum` of every model opponent (the champion, historical snapshots and contenders), the stratum the base corpus gives live Edger, and keep bot ids such as `edger_heuristic` (`scripts/edger-league-core.mjs`). Each opponent's policy and checkpoint ids stay in the episode's `policies` provenance, and the campaign report counts `opponent_strata`. `vtrace` refuses a cache with a stratum missing from the parent vocabulary rather than letting the row lookup fall back to index 0.

Before this repair (November 20, 2026), model opponents recorded their `policy_id`. Model ids such as `edger_policy_bootstrap_20260701` fell back to stratum index 0 (`aggressive` in the archived parent). The repair was validated on fresh rollout lineage (local only; `README.md` and `comparison.json` in `~/edge_royale-runs/20261120-league-labelling.noindex/`). Play, results and provenance were unchanged in all 64 games, and every cache row was equal apart from its labels. Every champion-game row resolved to `edger` instead of the fallback. The stratum enters both content-addressed episode IDs and the balancing key, so the label change moves episode IDs, splits and manifest order. It also merges the model-id balancing strata into the base's `edger` strata, which changes every sample weight. Rollouts from before and after the repair are therefore separate lineages: never merge them into one campaign. The September campaign remains historical evidence, and the contribution of the fallback to its regression remains untested. The [local snapshot comparison](EDGER_TACTICAL_REVIEW.md#eighth-comparison-snapshot-league-opponent-mix) used `train-arm` and the `edger` stratum; its direction was unresolved, and the current mix stays.

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
The workflows read the role ARN, corpus store and bucket name from repository
secrets (`EDGER_AWS_ROLE_ARN`, `EDGER_CORPUS_STORE`, `EDGER_S3_BUCKET`), not
variables, so Actions masks them in public logs; see `docs/HISTORY_REWRITE.md`.
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
stages leave live Edger unchanged. `promote` requires matching full-evaluation
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

The corpus, BC, offline-improvement, scaling, league/V-trace, parity, large-sample evaluator, checksum-bound promotion, and campaign PR foundations are implemented. The first passing full report is the [candidate campaign's](EDGER_CANDIDATE_CAMPAIGN.md#result-november-23-2026) (November 23, 2026). The owner approved promoting that candidate, c3, on November 25, 2026; it is live on `edger-v2-accumulated` since the owner accepted the review branch on November 26 and was proposed to `main` by pull request on November 28 ([record](EDGER_CANDIDATE_CAMPAIGN.md#owner-promotion-decision-november-25-2026)). Every later v2 model needs its own passing report and approval. The gates:

- paired champion bootstrap bounds
- heuristic and anchor non-regression bounds
- weak-baseline floors
- frozen-league improvement/worst-anchor floors
- 10,000-match illegal-action and repeatability proof
- replay, determinism, full-suite, browser, and `p95 ≤ 5 ms` gates
- `skill_report_inputs`: a feasible tactical suite and a valid frozen
  opportunity bank with both classes, so every report carries the reported
  measures below

Failed campaigns retain reports/checkpoints and never update the promoted artifact.

**Reported, not gates (owner, November 20, 2026; [gate review](EDGER_GATE_REVIEW.md)).**
Schema `edger_v2_evaluation_report_v2` keeps three measures in `reported`,
outside `gates`. None of them can pass or fail promotion.
- `tactical_scenarios`: the synthetic suite below, with `minimums_met` meaning every category minimum is met. Beating the heuristic's aggregate is shown as `improved_over_heuristic`; it is no longer part of any pass rule.
- `heldout_fireball`: the frozen bank's captures and card choices against the 0.80/0.70 minimums.
- `match_skills` (`edger_v2_match_skills_v1`, `scripts/edger-match-skills.mjs`): from the evaluator's own games, per group and pooled over every group except safety. It records the candidate's legal plays per card. At each candidate decision, PASS included, it records Fireball opportunities by class, Fireball choices and legal captures, using the shared opportunity rules. It also counts games with an opportunity and games with a capture. The tracker only reads engine state, and it is tested to leave every game unchanged. Other callers of the match worker, such as the champion reference, leave it off.

`edger:evaluate:v2` and `edger:promote:v2` print the reported measures. The
promote command refuses a report that lacks any of them, and every schema v1
report.

**Diagnostic exports never promote (owner, November 23, 2026).** Both commands
refuse a model whose `training.promotion_status` is
`diagnostic_only_not_promotable`
(`EDGER_V2_NON_PROMOTABLE_STATUSES` in `scripts/edger-v2-evaluation-core.mjs`).
The evaluator refuses under the full profile, before parity or any match; the
promote command refuses before reading the report. The report's artifact
checksum binds the exact model bytes, so relabelling a diagnostic export
breaks that match. The label check is a denylist: a model labelled
`shadow_candidate_unreviewed` is judged by its report alone. That is also the
default label of `edger:export:v2` and `initialize-full-grid` outputs. A
candidate campaign's export carries `training.campaign` and a binding file
(`export-candidate`, above), which the owner's promotion review checks; the
promote command does not. They inform the owner's separate promotion approval: a candidate may
promote without casting Fireball. The legacy v1 evaluator also reports its
tactical suite instead of gating on it.

Parity, timing and the reported-measure inputs run before the match workers.
A failed preflight produces a rejected report with `generated_matches=0`,
`match_suite_skipped=true`, and failed/skipped match gates. Tactical and
Fireball shortfalls never skip the match suite. The tactical suite
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
category minimums stay unchanged. The strict aggregate improvement over the
heuristic was kept until November 20, 2026, when it became reported only. The defense base moves from the old center Giant to the actual
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

V2 evaluation requires `--opportunity-bank <frozen-bank.json>`. The
`heldout_fireball` measure scores **correctly aimed, legal Fireballs**;
card choice is reported separately. It reuses the existing tower-finishing
0.80 and spell-value 0.70 numbers as the lethal and cluster capture-rate
minimums. These are not recalibrated synthetic score units or thresholds
fitted to a baseline. From November 2 to November 20, 2026 they were a
blocking gate; they are now reported only. Missing or invalid banks and empty
classes still fail `skill_report_inputs` and prevent match dispatch. A low
capture rate does neither. Reports bind the bank's logical and file
checksums. Freeze the source manifest, sampling rule and bank before evaluating
candidates; do not tune them against candidate scores. The production driver
builds the bank in `full-cache` before offline/league learning and passes that
same artifact to full evaluation. A new campaign still needs fresh compatible
scaling/provenance and separate approval.

See the [proposal 4 record](EDGER_TACTICAL_REVIEW.md#proposal-4-scoring-and-held-out-opportunities--november-2-2026)
for the before/after heuristic and live-v1 baselines, bank coverage and limits.

Failure reports are retained under `failed-stages/<stage>/<attempt>/`, separate
from passed `stages/` artifacts. See [the September diagnosis](EDGER_EVALUATION_DIAGNOSIS.md)
for exact versioned evidence and the approval-dependent next campaign plan.
