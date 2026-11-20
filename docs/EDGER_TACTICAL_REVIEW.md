# Edger v2 tactical investigation — October 25, 2026

This covers Next Task 1 after the [runtime review](EDGER_RUNTIME_REVIEW.md):
Fireball card choice (logits, masks, corpus and teacher frequencies) and the
exact troop-placement ties found by the September 28
[tactical audit](EDGER_EVALUATION_DIAGNOSIS.md#tactical-suite-audit--september-27).

The original October 25 investigation was read-only. No gate, floor, scorer,
fixture, model, observation or runtime changed in that investigation, and nothing here selects a model or clears a gate. The owner approved
the [proposals](#proposals--approved-october-25) on
October 25. Proposals 1–2 were implemented, ablated and compared under RL later (see
[below](#proposals-12-observation-v3-and-bc-ablation--october-2526-2026)),
and proposal 3 followed ([below](#proposal-3-data-and-learning-on-v4--october-27-2026)),
with its option 1, a [targeted floor](#option-1-targeted-floor--october-30-2026), on October 30;
those changes and the November 2 proposal 4 implementation are recorded in
separate sections below.

- `X` = `~/edge_royale-runs/20261025-tactical-parity-warmup.noindex/`. Scripts and outputs are in `X/tactical/`; models are in `X/models/`; the corpus subset is in `X/corpus/`.

## Inputs

- **Models.** Seven models were probed.
  - The parent `2e576955…` and the learned-trained r0/r1/r2 (`dfc76358…`, `07accf40…`, `2852f7c4…`) match the confirmation evidence checksums.
  - The fixed-trained r0/r1/r2 (`47ab0f70…`, `2bd195aa…`, `236581c1…`) were copied from the iCloud training archive. Their fixture probabilities reproduce the September 28 audit.
- **Corpus.** The frozen September 21 subset: 160 whole episodes (128 train, 32 validation), with cache `aab1f8e8…` re-verified.
  - Replaying all 160 episodes reproduces the cache exactly: 9,343 rows, and every sample weight and policy label matches the Parquet file.
  - It also reproduces the recorded card counts: 210 Fireball, 701 Arrows and 1,478 PASS.
  - Episodes are Edger (live v1, `edger_policy_bootstrap_20260701`) against one of four opponents. Both sides' decisions are rows, so the BC teacher is a mixture of five policies.

## Fireball card choice

**Masks and targeting are not the cause.** Fireball is legal in both spell
fixtures and in 3,038 corpus rows. Forced Fireball already lands on a
maximum-scoring cell, as shown on September 28.

**The card head prefers Giant by a wide margin.** The table shows the logit of
Fireball minus the best other legal card (always Giant here).

| Model | `spell_cluster_value` | `finish_low_tower` | P(Fireball), lethal fixture |
|---|---|---|---|
| Parent | −5.32 | −4.16 | 0.0105 |
| Learned r0/r1/r2 | −10.02 / −9.60 / −9.97 | −8.96 / −8.84 / −9.02 | 0.0001 |
| Fixed r0/r1/r2 | −5.59 / −5.00 / −6.41 | −4.55 / −3.57 / −4.97 | 0.0032–0.0148 |

The card-head bias accounts for at most 0.44 of these margins. The rest comes
from 10–23 active fused units, so this is state-driven, not a fixed prior
against Fireball.

**The models have no notion of "lethal".** `finish_low_tower` was rerun with
the low tower's HP set to values from full (3,052) down to 20. The heuristic
switches to Fireball exactly at the lethal threshold (207). No model shows any
step there:

- P(Fireball) changes smoothly and never exceeds 0.016.
- Across the whole sweep, the margin improves by 1.4–1.9 logits for the learned-trained models and 0.8–1.0 for the fixed-trained ones; the parent's gets 0.1 worse.

The low-HP signal enters only through global features 51 and 95 (tower HP ratio
and enemy tower HP). Injecting it into the board (one cell of channel 7) moves
the margin by at most 0.02 logits, because the card head sees the board only
through a 576-cell mean.

**Clusters barely register.** Growing the cluster from 0 to 5 troops raises the
margin by about 1.5 logits for the parent and 1.5–1.9 for the learned-trained
models, but it stays below −4.6. The heuristic switches to Fireball at 3 troops.

### What the teachers did

Each row was classified by deterministic checks matching the fixture scorers:
- *lethal*: Fireball is legal and some enemy tower has HP ≤ 207;
- *cluster*: otherwise, the best legal Fireball cell scores ≥ 0.70 on `scoreSpellValue`;
- *none*: neither.

| Teacher | BC weight | Lethal: Fireball cast | Cluster: Fireball cast | No opportunity: cast | Casts hitting nothing |
|---|---|---|---|---|---|
| Edger (live v1) | 77.8% | 22/29 (76%) | 10/31 (32%) | 0/1,161 | 0/32 |
| Heuristic | 12.8% | 7/7 | 20/20 | 42/417 (10%) | 0/69 |
| Aggressive | 4.2% | 0/23 | 0/133 | 0/290 | — |
| Defender | 2.8% | 0/33 | 0/205 | 0/520 | — |
| Random | 2.3% | none seen | 27/34 | 82/135 | 91/109 |

- Opportunities are rare: 92 lethal rows (1.0%) and 423 cluster rows (4.5%).
- The weighted BC target in lethal rows is Fireball **61.6%**; in cluster rows it is **28.3%**.
  - Aggressive and defender never cast Fireball, yet they hold 18.5% of the lethal-row weight and 50.9% of the cluster-row weight.
- Live v1 does take lethal Fireballs in real play (76%), even though it plays Giant in the synthetic `finish_low_tower` fixture. That is a fixture-realism point, not a reason to lower a floor.

### What the models learned

These are mean P(Fireball) over the corpus rows (all 9,343 rows were scored).

| Model | Lethal rows | Cluster rows | No-opportunity rows | Lethal ÷ none | Rows where Fireball is argmax |
|---|---|---|---|---|---|
| Parent | 0.111 | 0.136 | 0.058 | 1.92 | 198 |
| Learned r0 | 0.0003 | 0.0012 | 0.0003 | 0.91 | 0 |
| Learned r1 | 0.0004 | 0.0017 | 0.0004 | 0.95 | 0 |
| Learned r2 | 0.0036 | 0.0159 | 0.0051 | 0.70 | 14 |
| Fixed r0/r1/r2 | 0.041–0.050 | 0.024–0.040 | 0.023–0.031 | 1.59–1.82 | 5–12 |

### Reading

The weakness has three stacked causes. None of them is a mask, targeting or
PASS problem.

1. **Representation.**
   - "Lethal" is a threshold on one scalar (tower HP ratio ≤ 0.068) that reaches the card head only through two global features.
   - Cluster value reaches it only through a whole-board mean, with no local maximum or count.
   - The models respond smoothly and weakly to both.
2. **Data.**
   - Opportunity states are 1–5% of rows.
   - Their BC target is diluted by teachers that never cast Fireball, plus random's wasted casts.
   - Even so, the parent reaches only 0.11 of the 0.62 Fireball target in lethal rows (argmax 7.6%), so it under-fits these rare states.
3. **RL suppression.**
   - Learned-cadence RL cut mean P(Fireball) by roughly 80–370× for r0/r1 and 8–31× for r2, across all three state classes.
   - It also erased the parent's weak conditioning: lethal ÷ none falls from 1.92 to 0.70–0.95.
   - This fits a picture where the RL penalty for low-value casts in common states carries over to rare lethal states the network cannot tell apart. That mechanism is inferred; the RL training logs were not examined.

## Troop-placement ties

**Cause established: the representation, not learned weights.** In the five
fixtures, 86 of 105 forced troop plays have all legal placement logits exactly
equal. This reproduces the September 28 audit.

- **84 of the 86 are structural.** Every legal cell has a byte-identical, all-zero 3×3×24 input patch, so its spatial embedding is identical.
- **2 are learned ties.** These are the Knight in `defense_giant_lane` for the parent and r0-fixed. They have two distinct patches, but the placement scorer's ReLU clips the difference.

The mechanism:
- `conv1` is 3×3, and `conv2`/`conv3` are 1×1, so a cell's embedding depends only on its 3×3 neighbourhood.
- The observation has no coordinate or static-geometry channels.
- An empty neighbourhood therefore yields the same embedding everywhere, and so the same placement logit and delay, for any weights.
- `maskedArgmax` keeps the lowest index. In the canonical row-major frame that is the actor's own back-center `(9.5, 5.5)` (index 99), the earliest legal row.

**In the corpus.** 3,334 of 6,954 troop rows (47.9%) have identical patches at
every legal cell; this reproduces the September 21 troop rate.

- Every model ties exactly on all 3,334.
- Each model has a further 159–354 argmax ties at the maximum without identical patches, which are learned ties.

**The tie-break picks the cell teachers avoid.** In the 3,334 structural rows,
teachers chose:
- back-center 30 times (0.9%);
- the front row (y = 14.5) 3,061 times;
- the bridge cells 216 times (rows 15–16 in lanes x = 3.5 and 14.5, legal once a pocket is unlocked).

All seven models pick the teacher's cell on **1.5%** of structural rows, against
60.6–62.7% of the other troop rows. Edger v2's back-center deployments are a
tie-break artifact that the network cannot express a preference against.

## Proposals — approved October 25

**Owner decision, October 25, 2026.** All four proposals are approved as
written, including the scoring gate change in proposal 4. Proposals 1 and 2 were
implemented as observation schema v3 and committed locally as a checkpoint. After the
[BC ablation](#proposals-12-observation-v3-and-bc-ablation--october-2526-2026) the owner chose a bounded local RL
comparison (October 26). It [reported](#rl-comparison--october-26-2026) inconclusive by its frozen rule,
and the owner then chose spell globals only: proposal 2 lands as
[observation schema v4](#spell-globals-only-v4--october-26-2026), and proposal 1's geometry is dropped. Proposal 3 is implemented as default-off learner options and tested in a [local experiment](#proposal-3-data-and-learning-on-v4--october-27-2026) (October 27), and the owner's option 1, a [targeted floor](#option-1-targeted-floor--october-30-2026), followed (October 30). Proposal 4 is implemented locally in the [November 2 scoring record](#proposal-4-scoring-and-held-out-opportunities--november-2-2026). Each lands as its own change, with its own tests and fresh provenance.
None lowers a floor or adds a handcrafted spell or placement override. The
approval does not cover pushing, cloud actions or promotion.

Notes for implementation:
- **Order.** Land the approved [parity decision](EDGER_PARITY_CONTRACT_REVIEW.md#decision--october-25-2026) first: no current model passed the old `1e-5`, so new models could not have passed parity either. It landed on October 25, and all seven local models now pass.
- **Schema.** Proposals 1 and 2 need a new v2 observation schema. Existing v2 models and caches will not load under it, so each needs a re-derived cache and a bounded local BC ablation. Live v1 runs `src/ai/mlPolicy.js` and is unaffected. Stay within the 50,000-parameter and 1 MB actor caps.
- **Choosing the proposal 1 variant.** Choose between static geometry and the September 21 ablation by the measured structural-tie rate (47.9% of troop rows now) and the recomputed ln(k) bound.
- **Gate change.** Proposal 4 changes a gate. Rebaseline the heuristic and v1 under the new scorers and bank, and record the before and after scores.

1. **Placement representation.**
   - Add static geometry to the board: normalized row/column, own/enemy half, bridge/river cells and lane.
   - Alternatively, run the September 21 ablation: coordinate channels plus 4×2 regional pooling, and separately 3×3 `conv2`/`conv3` for a 7×7 receptive field.
   - Either is an observation-schema change that needs a re-derived cache.
   - Recompute the ln(k) bound per variant; the structural rate, now 47.9% of troop rows, is the number to drive down.
   - The lowest-index tie rule stays part of the parity contract. Changing the tie order instead would be a handcrafted placement rule and is not proposed.
2. **Card representation.** Add global input features, deterministic from engine state:
   - per enemy tower, whether HP ≤ the Fireball or Arrows tower damage;
   - the best legal Fireball and Arrows troop-hit counts.

   These are inputs, not overrides; the policy still decides.
3. **Data and learning.**
   - Zero-weight or drop card targets from teachers that never cast spells (aggressive, defender) and from random, at least in opportunity states. Otherwise use the existing advantage weighting.
   - Oversample opportunity states.
   - In RL, add a KL-to-BC or entropy floor so that rare, valuable actions cannot collapse.
   - Track opportunity capture on held-out corpus states during training, and treat a fall below the parent as a diagnostic failure.
4. **Broader defense and punishment scoring** (a gate change for explicit review).
   - **Defense.** Score only plays that can intercept: same lane as the threat, and between the threat and the tower it is heading for, with time-to-contact checked. The `(9.5, 5.5)` play against a bridge Giant should then score 0, where it now scores 1.25.
   - **Punishment.** Drop the flat 0.35 credit for any troop. Require bridge or front-row pressure while the opponent's elixir is short.
   - **More states.** Mirror every fixture to the blue side to check canonicalization, and add 3–5 variants per category (tick, elixir, lane), so that no category rests on one synthetic decision.
   - **Corpus-derived bank.** Add a held-out bank of real states from test-split episodes, which training never reads, labelled by the deterministic opportunity checks above. Score capture rate. The 160-episode subset alone has 92 lethal and 423 cluster rows, but those are training and validation rows, so the bank must be drawn fresh.
   - Rebaseline the heuristic and v1 under any new scorer. Floors are not lowered.

## Proposals 1–2: observation v3 and BC ablation — October 25–26, 2026

**Status (October 26): spell globals only, as [observation schema v4](#spell-globals-only-v4--october-26-2026).**
v3 below was committed locally as a checkpoint (`e8cf6b9`). The approved
selection criterion and BC-stage play disagreed, so the owner first chose
option 3 below, a bounded local RL comparison. After the
[comparison](#rl-comparison--october-26-2026) the owner chose its option 1:
keep the eight spell globals and drop the geometry channels. Proposal 1's
criterion is therefore not met; the structural ties remain.
Live v1 is unaffected. Evidence is in `V` = `~/edge_royale-runs/20261025-observation-v3.noindex/`
(`summary.md`, `teacher-placement.txt`, `README.md`, `SHA256SUMS`).

**What changed in v3** (`src/ai/v2/observation.js`, schema `edger_oracle_observation_v3`, superseded by [v4](#spell-globals-only-v4--october-26-2026)):
- Board `32×18×31`. Channels 24–30 are static geometry in the actor's canonical frame: normalized row and column, own half, enemy half, unpathable river, bridge, and lane (−1 left, +1 right). Both sides see identical geometry.
- Globals 96–103 are spell opportunities, inputs only: per enemy tower, HP ≤ Fireball and ≤ Arrows tower damage, and the most enemy troops one Fireball or Arrows cast could hit now. Hits use the engine's impact rule (troop centre within the spell radius) at every cell centre, which is stricter than the fixture scorers' radius-plus-entity-radius check.
- The actor grows from 36,402 to 37,922 parameters (797,830 bytes exported), within both caps.
- Episodes hold replays, never observations, so the episode compatibility cohort stays pinned to `edger_oracle_observation_v2` (`EDGER_EPISODE_OBSERVATION_SCHEMA_VERSION`). Existing episodes, ids and manifest hashes stay valid. Caches record `observation_schema_version`, and BC, offline and V-trace refuse a cache built for another schema.
- No tie order, floor, scorer, fixture or gate changed. Existing v2 models do not load under v3.

**Ablation.** The frozen September 21 160-episode subset, re-derived four ways
from one local manifest (`089274c8…`): the v2 observation, full v3, geometry
only (`v3g`) and spell globals only (`v3s`). The v3 cache equals the v2 cache
on channels 0–23 and globals 0–95 in all 9,343 rows. Each arm ran the identical
6-epoch BC recipe with seeds 20260718–20260720. Each model then got held-out
imitation checks, the evaluator preflight, and side-paired learned-cadence
games: 48 pairs against the heuristic and 16 pairs each against aggressive and
defender, all on development seeds.

- **Structural ties and ln(k).** v3 has 0 structurally tied troop rows and an ln(k) bound of 0 in both splits; the v2 cache has 48.8% (train) and 44.7% (validation), with ln(k) 1.32 and 1.22 per non-PASS row. On this criterion geometry is the best possible.
- **Imitation and tactics.** Geometry lowers validation placement loss from 1.53–1.56 to 1.26–1.31 and raises the tactical aggregate from 0.36–0.39 to 0.45–0.60. Spell globals alone change neither.
- **Fireball.** Spell globals barely move it under BC. P(Fireball) in lethal states rises from 0.05–0.09 to 0.09–0.14, and Across the six spell-global models, Fireball is the argmax once in 108 lethal model-rows (18 validation lethal rows each). Teachers cast in only 17% of validation lethal states, so imitation cannot make Fireball the argmax there; this needs proposal 3.
- **Play.** Geometry costs about 0.3 points against the heuristic. Mean points per arm across seeds: v2 0.632, v3s 0.576, v3 0.333, v3g 0.323. Every geometry model (0.25–0.48) scores below every non-geometry model (0.55–0.73), a complete separation with chance odds of 1 in 924. Against aggressive the drop is smaller and noisier (0.71 vs 0.56 mean); defender is near 1.0 for every arm. All 12 models pass the new parity contract (worst 0.29 of tolerance), with zero illegal attempts.

**Why geometry loses games.** The geometry models place 79–88% of troops on the
front row (y = 14.5) and almost none on the back rows. The v2 models put
45–52% on back-center (index 99) or the other back rows: that is the
lowest-index tie-break, which no strong teacher uses. Live v1 places 90% of its
corpus troops on the front row and the heuristic 93%; only random uses the back
rows (20%). So the geometry models imitate the strongest teachers faithfully,
while the v2 models' accidental back-row play beats imperfect imitation of
front-row play against the heuristic. Two inferences follow, neither
measured: any tie-free variant, including the September 21 coordinate
ablation, should learn the same front-row target, and teacher filtering
(proposal 3) does not change that target.

**Options for the owner** (option 3 chosen, October 26):
1. Land v3 as approved and accept the BC-stage regression. The policy can now express a placement preference, so RL may rediscover back-row play where it pays. That is unmeasured, and the next parent starts weaker.
2. Land spell globals only, with no geometry channels. This keeps the v2 level of BC play but also keeps the structural ties, against the approved criterion, and the spell globals showed no measurable BC benefit on their own.
3. Hold both and first run a bounded local RL comparison from the v2 and v3 BC parents. That is a larger experiment than the approved BC ablation.

The PyTorch held-out argmax overstates structural matches for the tied-board arms (v2 and v3s: 0.05–0.39),
because floating-point noise breaks exact ties differently from runtime.
Runtime's lowest-index rule matches the teacher on 11 of 663 validation
structural rows (1.7%), in line with the 1.5% above.

### RL comparison — October 26, 2026

**Result: inconclusive by the frozen rule; the owner chose option 1 below.** Evidence is in
`W` = `~/edge_royale-runs/20261026-observation-rl-comparison.noindex/`
(`plan.md`, `FROZEN.txt`, `analysis.md`, `posthoc.md`, `README.md`,
`SHA256SUMS` over 3,814 files).

**Method**, frozen in `W/plan.md` before launch:
- Parents: the v2, v3 and spell-only (`v3s`) BC models from the ablation above, one run per BC seed (r0–r2 = 20260718–20260720). Geometry-only was not carried forward. Each arm ran from its schema's code mirror.
- Recipe: the September 26–27 learned/full arm, unchanged: `train-arm --cadence learned --iterations 6 --pairs-per-iteration 32 --learning-rate 0.001 --loss-mode full`. That is 384 fresh on-policy games per arm with production V-trace, against 78–81% live v1 and otherwise the heuristic.
- Evaluation: all 9 parents and 9 children, deterministic, learned cadence, on identical development seeds and sides: 200 pairs against live v1 and 100 pairs each against the heuristic and aggressive. Live v1 replaced defender, which scored near 1.0 for every BC arm. A model's primary score is the equal-weight mean over the three opponents.
- Label rule:
  - `v3 recovers` if the run-averaged primary D3 = child v3 − child v2 is ≥ −0.02.
  - `v3 still worse` if D3 is below that and negative in every run. Then recommend spell globals only if Ds = child v3s − child v2 is ≥ −0.02, else v2.
  - `inconclusive` otherwise.

**Run.** UTC October 25, 15:32–17:07 (1 h 35 min of the 8 h cap).
- All 9 arms completed six iterations, and all 54 evaluations exited 0.
- Every evaluation had zero illegal attempts, passed its repeat checks, and used the same seeds as every other model.
- Every child passes parity (worst 0.381 of tolerance).

Primary scores:

| Schema | Parents r0 / r1 / r2 | Children r0 / r1 / r2 | Mean RL gain |
|---|---|---|---|
| v2 | 0.541 / 0.652 / 0.517 | 0.677 / 0.815 / 0.494 | +0.092 |
| v3 | 0.299 / 0.474 / 0.384 | 0.617 / 0.537 / 0.505 | +0.167 |
| v3s | 0.557 / 0.642 / 0.557 | 0.832 / 0.822 / 0.795 | +0.231 |

Intervals below are 95% bootstraps over evaluation seeds.
- **D3 = −0.109 [−0.138, −0.080] run-averaged; per run −0.061, −0.278, +0.011.**
  - r2 is a tie ([−0.037, +0.059]), not a v3 win, but it alone makes the label inconclusive.
  - RL narrowed the BC gap (parent v3 − parent v2 = −0.184) without closing it.
- **Ds = +0.154 [+0.131, +0.178] run-averaged; per run +0.155, +0.007, +0.300.**
  - It is positive against every opponent: v1 +0.202, heuristic +0.120, aggressive +0.140.
  - At BC the same contrast is +0.015 [−0.008, +0.038] (post-hoc).
- **Across training runs** (post-hoc t over three runs), neither contrast is established: D3 [−0.48, +0.26], Ds [−0.21, +0.52].
  - Only the spell-only RL gain is ([+0.11, +0.35]).
  - The spell-only children span 0.037, the v2 children 0.321. The v2-r2 child lost 0.023 to its parent, while its sampled training score rose from 0.17 to 0.28.
- **Placement** (8-pair check): RL from v3 did not bring back back-row play.
  - v3 children place 0% of troops on the back rows and 75–85% on the front row.
  - v2 and spell-only children place 45–60% on the back rows and 27–32% on the front row.
- **Spells.** Every child casts 0.00 Fireballs per game except v2-r2 (0.65).
  - Arrows run from 0.04 to 6.23 per game; v3 children cast the fewest (≤ 0.80).
  - Spell globals improved RL play without visibly changing Fireball use. The mechanism is unmeasured.
- **Tactical aggregate**: v3 children 0.39–0.46, the other children 0.37–0.39.

**Reading.**
- Geometry costs play at BC (−0.18 here, about −0.3 in the BC ablation). Six RL iterations recover neither the score, on average, nor the placement.
- Spell globals are neutral at BC and give the best and most consistent children after RL. Three training runs cannot separate that from the v2 children's run-to-run spread.

**Options for the owner** (option 1 chosen, October 26):
1. **Spell globals only** (recommended):
   - Drop the geometry channels and keep the eight spell globals. The board returns to 24 channels under a new schema name, with a re-derived cache and re-pinned tests.
   - The structural ties remain, so proposal 1's criterion is not met. The +0.15 is a lean, not an established effect.
   - Proposal 3 needs its own RL comparison, which can carry a v2 control.
2. **Spell globals only, confirmed first**: a second frozen comparison of v2 against the real spell-only schema, with more training runs (for example six). That is about 1–2 h locally.
3. **Keep v3 as committed.** After RL it is worse on average and keeps front-row placement.
4. **Revert to v2.** This discards spell globals, which are neutral at BC and lean positive under RL.

### Spell globals only (v4) — October 26, 2026

**What changed** (`src/ai/v2/observation.js`, schema `edger_oracle_observation_v4`):
- The board returns to the v2 `32×18×24`. The globals stay at 104, with the eight spell-opportunity inputs at 96–103 exactly as in v3. v3's geometry channels and their code are removed.
- The actor has 36,914 parameters (776,652 bytes exported).
- Caches record `edger_oracle_observation_v4`, so BC, offline and V-trace refuse v2 and v3 caches. The episode cohort stays pinned to `edger_oracle_observation_v2`.
- Tests:
  - The geometry test is removed; the spell-globals test stays.
  - The golden logits (`87ab23d5…`, which a copy without the zero-product skip reproduces) and the seeded model's bank and match pins are re-captured. The corpus test pins the v4 dimensions.
  - The runtime-cost fixture seeds return to 11/17, so that file is identical to `3496c92`.
  - The cadence tests' default seed moves from 7 to 8: under v4, seed 7 plays no card in the first 400 states.

**Evidence** in `Y` = `~/edge_royale-runs/20261026-observation-v4.noindex/` (see its `README.md`):
- **Cache.** The v4 cache of the 160-episode subset was built from the same manifest. In all 9,343 rows it equals:
  - the spell-only cache with its all-zero geometry channels removed;
  - full v3 on board channels 0–23 and all 104 globals;
  - the v2 cache on the whole board and globals 0–95.

  Every other column equals an arm64 Node rebuild of the spell-only cache. The October 25 caches were built under the x86_64 Node v25. Against them, 32 rewards and 278 discounted returns differ by at most 2.2×10⁻¹⁶, because `PER_TICK_GAMMA ** deltaTicks` rounds differently in the two Node builds (see Limits).
- **The tested models carry over exactly.** Deleting conv1's input channels 24–30 turns the six spell-only models (3 BC parents, 3 RL children) into v4 models. Under the v4 code they reproduce the spell-only code exactly:
  - every parity-bank logit, bit for bit (333 fixtures);
  - 144 full matches (2 seeds × 2 sides × v1, heuristic and aggressive × deterministic and sampled), with identical decisions, log probabilities and hashes (12,258 decisions);
  - a negative control (the geometry-on v3 code) differs on the bank and in all 24 of its matches.

  The converted children pass real-PyTorch parity under v4 and reproduce the RL comparison's tactical and game results exactly. The spell-only rows of the RL comparison therefore describe v4 models.
- **Fresh BC.** A v4 BC model (seed 20260718, the ablation recipe) trains, exports and passes parity: worst 0.191 of tolerance, identical tie sets and no fragile margins. It scores 0.656 in the 16-pair heuristic check with zero illegal attempts. The spell-only model of the same seed also scores 0.656, but it is a different model: only 2 of the 32 games are identical.

## Proposal 3: data and learning on v4 — October 27, 2026

**Status: implemented locally as default-off options (committed locally as
`20a9c9e`, October 30). The frozen local experiment labels it `proposal 3
costs play`, after a recorded post-cap continuation. The owner chose option 1,
the [targeted floor](#option-1-targeted-floor--october-30-2026) (October 30).** Evidence is in `P` = `~/edge_royale-runs/20261027-proposal3.noindex/`
(`plan.md`, `FROZEN.txt`, `analysis.md`, `posthoc.md`, `README.md`, `SHA256SUMS`).

**What changed** (`scripts/edger-v2-training.py`, `scripts/edger-v2-cadence-experiment.py` and `.mjs`; see [training](EDGER_TRAINING.md#4-learning)):
- **Opportunity classes** come from the v4 spell globals and the legal card mask, so the cache is unchanged.
  - Lethal means Fireball is legal and some enemy tower is at or below its tower damage. That matches this review's 92 lethal rows exactly.
  - Cluster means Fireball is legal and one cast could hit at least 3 enemy troops, by the engine's impact rule. That gives 404 rows, a strict subset of the 423 found by the scorer-based check above.
  - On the subset, the train split has 74 lethal and 320 cluster rows, and the validation split 18 and 84.
- **Teacher filter** (BC `--card-teacher-filter opportunity`): in opportunity rows, the card targets of aggressive, defender and random get weight 0; their placement and delay targets stay.
  - In train lethal rows, the weighted Fireball target rises from 52% to 66%.
  - In train cluster rows, it rises from 28% to 55%.
- **Oversampling** (BC `--opportunity-oversample K`): every opportunity row appears K times per epoch.
- **KL floor** (RL `train-arm --card-kl-coefficient β`): β × KL(BC parent ‖ model) over the card head on every on-policy row.
- **Capture diagnostic** (`train-arm --heldout`): after every iteration, the held-out Fireball capture rate is recorded for the model and its parent. Capture below the parent's is flagged as a diagnostic failure; it does not stop the arm.
- **Defaults are unchanged.** A default BC run under the new code reproduces the October 26 v4 BC checkpoint bit for bit (24/24 tensors, `P/repro/compare.json`).
  - That v4 baseline captures 0 of 102 held-out opportunities, with mean P(Fireball) 0.13.
  - The production `vtrace` learner has no KL term yet.

**Experiment** (frozen in `P/plan.md` before any output):
- BC: four recipes × three seeds. The recipes are `b0` (baseline), `bf` (filter), `bo` (oversample ×4) and `bfo` (both).
- RL: parents `b0` and `bfo` × β ∈ {0, 0.05} × three runs, with the October 26 learned/full recipe.
- Evaluation: all 24 models on the October 26 protocol.
- Advisory label: `proposal 3 helps` needs the full proposal (`bfo` with KL) to be within −0.02 of the old recipe's primary score, to capture more held-out opportunities, and to pass the capture diagnostic in every run.

**Run.** UTC October 26, 14:44–21:23.
- Every BC run, all 12 arms (six iterations each) and all 72 evaluations exited 0. No game had an illegal attempt, every evaluation passed its repeat checks, and all 24 models pass parity (worst 0.381 of tolerance).
- The held-out check costs about 2 minutes per iteration (it reads the cache four times), so arms took 17–18 minutes instead of about 3.
- The runner stopped at its frozen 6 h cap at 20:44:56Z, before 7 of the 72 evaluations and all of the children's secondary checks. Its frozen analysis is in `P/analysis-at-cap.md`; it is labelled inconclusive because of the missing outputs.
- `P/post-cap.sh` finished the rest with unchanged commands. It was written and hashed at 19:17Z, before any score was read (`P/POSTCAP.txt`). That is a deviation from the plan's "stop and report partial results"; the contrast that drives the label uses only children, which were all evaluated before the cap.

**BC: the data recipe works.** Held-out capture of the 102 opportunities, per seed:

| Recipe | Capture (lethal of 18 / cluster of 84) | Fireballs per evaluation game | Parent primary, mean of runs |
|---|---|---|---|
| `b0` | 0 / 0 in every seed | 0.00 | 0.497 |
| `bf` | 1/3, 0/2, 1/1 | 0.06–0.25 | 0.511 |
| `bo` | 9/6, 7/3, 7/4 | 0.14–0.25 | 0.529 |
| `bfo` | 13/18, 10/14, 12/16 (24–30%) | 0.83–1.60 | 0.471 |

- `bfo` minus `b0` primary is −0.025 [−0.052, +0.002]; `bf` is +0.014 and `bo` +0.033 [+0.006, +0.059].
- By this review's scorer-based labels, `bfo` makes Fireball the argmax in 56–72% of validation lethal rows (b0: 0%). The card-argmax match with teachers falls from 0.82 to 0.78–0.80.
- Oversampling drives lethal capture, and the filter adds cluster capture.

**RL without the KL floor erases it.** All three `bfo-k0` arms end with 0 held-out capture and 0 Fireballs per game; the parents' mean P(Fireball) of 0.24–0.29 falls to 0.005–0.019. They also score −0.045 [−0.065, −0.025] against `b0-k0`.

**The KL floor keeps some Fireball but costs play.** At β = 0.05 the on-policy card KL to the parent stays at 0.03–0.07 nats, against 0.35–0.84 without it. That holds every card choice near the weaker BC parent, not only rare ones.

| Children, mean of runs | Primary | Final held-out capture | Fireballs per game |
|---|---|---|---|
| `b0-k0` (old recipe) | 0.845 | 0 | 0.00 |
| `b0-kl` | 0.730 | 0 | 0.00 |
| `bfo-k0` | 0.800 | 0 | 0.00 |
| `bfo-kl` (full proposal) | 0.741 | 0.108 (0.137, 0.176, 0.010) | 0.24 (0.19, 0.41, 0.08) |

- `P` = child(`bfo-kl`) − child(`b0-k0`) is −0.104 [−0.126, −0.082] run-averaged; per run −0.013, −0.216 and −0.083. The KL term alone costs −0.115 [−0.136, −0.093] on `b0` parents.
- RL gains with the floor are +0.234 (`b0`) and +0.270 (`bfo`), against +0.348 and +0.328 without it.
- The `bfo-kl` children are the first v4 children that cast Fireball in evaluation. All three still fail the capture diagnostic: capture falls below the parent's in every iteration.
- Tactical aggregates are 0.37–0.39 for every child, and placement is unchanged (36–54% back rows).
- Post hoc: the old-recipe children from fresh v4 parents (0.819, 0.884, 0.832) are in line with the October 26 spell-only children (0.832, 0.822, 0.795).

**Frozen label: `proposal 3 costs play`.** `P` is below −0.02 and negative in every run.

**Options for the owner:**
1. **Targeted floor** (recommended):
   - Keep the BC data recipe and apply the card KL only on opportunity rows (the same globals), so ordinary card choices learn freely.
   - This tests whether the floor's play cost comes from anchoring ordinary states.
   - It is one bounded local comparison, `bfo` parents × 3 runs, with this run's `bfo-k0` children as the control. That is about 1.5 h, or less with a faster held-out check.
2. **Smaller global β** (for example 0.01): the same trade-off, probably smaller in both directions.
3. **Stop at BC.** Keep the options (default off) and move to proposal 4. Its corpus-derived opportunity bank would then measure Fireball capture in the gate.
4. **Revert proposal 3.** Not recommended: the options are default-off, bit-identical at default, and tested.

### Option 1: targeted floor — October 30, 2026

**Status: implemented locally as a default-off option; the frozen local
experiment is labelled `inconclusive`. On November 2 the owner had it
committed locally (`5aff157`) and chose option 1 below, the [stronger targeted
floor](#stronger-targeted-floor--november-2-2026). On the new M6 host, this
section's "costs no play" reading does not replicate.**
Evidence is in `T` = `~/edge_royale-runs/20261030-targeted-floor.noindex/`
(`plan.md`, `FROZEN.txt`, `analysis.md`, `README.md`, `SHA256SUMS`).

**What changed** (see [training](EDGER_TRAINING.md#4-learning)):
- `train-arm --card-kl-rows opportunity` applies the card KL floor only on Fireball opportunity rows, with the same per-row weight (β divided by the episode's rows). Other rows get no KL term. The default `all` is the October 27 floor.
- Learner metrics count on-policy opportunity rows and their card KL to the parent.
- `heldout` reads the validation split once instead of four times. Its report is byte-identical, in 28 s instead of 139 s, so an arm takes 6–8 minutes instead of 17–18.
- **Reproduction:** iteration 0 of `P`'s `bfo-kl-r0` and `bfo-k0-r0`, rerun under the new code, matches `P`'s checkpoints (24/24 tensors, optimizer state) and held-out reports exactly (`T/repro/compare.json`). So `P`'s children are valid controls and were not rerun.

**Experiment** (frozen in `T/plan.md` before any output):
- Arms: `bfo-klo-r0/r1/r2`, the `bfo` parents with β = 0.05 on opportunity rows only, otherwise `P`'s recipe and seed plans.
- Evaluation: `P`'s protocol. The analysis checks `P`'s files against `P/SHA256SUMS` and reuses `P`'s bootstrap draws, so `P`'s contrasts reproduce exactly.
- Labels: as in `P`, with the full proposal now `PT` = child(`bfo-klo`) − child(`b0-k0`). One label was added, `targeted floor keeps play, capture below parent`, because every `P` arm with a `bfo` parent failed the capture diagnostic.

**Run.** UTC October 29, 14:33–15:13 (40 min, cap 2 h).
- All three arms completed six iterations, and every step exited 0.
- No game had an illegal attempt, and every evaluation was deterministic.
- All three children pass parity (worst 0.381 of tolerance).

**The targeted floor costs no play, but it does not keep Fireball.**

| Children, mean of runs | Primary | Final held-out capture | Final mean P(FB) | Fireballs per game |
|---|---|---|---|---|
| `b0-k0` (old recipe) | 0.845 | 0 | 0.005–0.019 | 0.00 |
| `bfo-k0` (no floor) | 0.800 | 0 | 0.005–0.019 | 0.00 |
| `bfo-kl` (global floor) | 0.741 | 0.108 | 0.143–0.223 | 0.24 |
| `bfo-klo` (targeted floor) | 0.800 | 0.013 (0.020, 0.000, 0.020) | 0.090–0.125 | 0.02 (0.01, 0.04, 0.01) |

- **Play:** the targeted floor's cost against no floor is +0.001 [−0.021, +0.021]; the global floor's was −0.059 [−0.082, −0.037]. Targeted minus global is +0.059 [+0.038, +0.082], positive in every run.
- **Against the old recipe:** `PT` is −0.044 [−0.065, −0.024] run-averaged; per run +0.050, −0.154 and −0.029.
  - That is about `P`'s data-under-RL cost, child(`bfo-k0`) − child(`b0-k0`) = −0.045. So the remaining gap is the `bfo` recipe's cost under RL, not the floor's.
- **Fireball:** held-out capture falls from the parents' 24–30% to 0–2% by iteration 5, and every arm fails the capture diagnostic. The children keep more Fireball probability than without a floor, but it is rarely the argmax.
- **Why the floor is weak:** opportunity rows are only 1.0%, 7.0% and 3.2% of each arm's on-policy rows (87–228 per iteration).
  - On those rows the card KL to the parent rises from 0.06–0.18 to 0.22–0.58 nats over six iterations, above its rise over all choice rows (0.03–0.10 to 0.10–0.43).
  - The global floor held the choice-row card KL at 0.02–0.07. The shared trunk and card head move with the ordinary rows, and β = 0.05 on 1–7% of rows does not hold them back.
- Tactical aggregates are 0.37–0.39, and back-row placement is 44–50%, as in `P`.

**Frozen label: `inconclusive`.**
- Run-averaged `PT` is below −0.02, but not negative in every run (r0 is +0.050).
- The capture gain is 0.013 against 0, and all three arms fail the capture diagnostic.

**Reading.** The October 27 floor's play cost did not appear when the floor was
restricted to opportunity rows. But at this β the restricted floor hardly
anchors anything, so this run cannot tell whether holding Fireball on
opportunity rows alone would cost play.

**Options for the owner:**
1. **Stronger targeted floor** (recommended):
   - The same comparison with β = 1 on opportunity rows (20× per row).
   - Given the measured 1–7% share, that puts 0.2–1.4× the global floor's total KL weight on opportunity rows alone.
   - It is one bounded local comparison, 3 arms against these controls, about 40 min. It tests whether holding the opportunity rows costs play.
2. **Stop at BC** and move to proposal 4, keeping the options default-off.
3. **Keep the old recipe** for RL (`b0-k0` children remain the best-scoring) and record Fireball capture as unresolved.

### Stronger targeted floor — November 2, 2026

**Status: done locally. Frozen label, against the earlier host's controls:
`inconclusive`. With same-host controls (a recorded addendum): `strong floor
keeps Fireball, costs play`. The floor line is closed with default-off options;
the already approved proposal 4 follows below.** Evidence is
in `S` = `~/edge_royale-runs/20261102-targeted-floor-beta1.noindex/`
(`plan.md`, `FROZEN.txt`, `analysis.md`, `host-check/`, `plan-m6.md`,
`FROZEN-m6.txt`, `analysis-m6.md`, `README.md`, `SHA256SUMS`).

**Experiment** (frozen in `S/plan.md` before any output):
- Arms `bfo-klo1-r0/r1/r2`: `T`'s recipe with `--card-kl-coefficient 1` (20× per row) on opportunity rows. The code is `5aff157`, whose `scripts/`, `src/` and `tests/` are byte-identical to `T`'s mirror.
- The label-driving contrast is `F` = child(`bfo-klo1`) − child(`bfo-k0`), the floor's cost against no floor. `P`'s criterion against the old recipe (`PS`) is reported but no longer drives the label, because it also carries the `bfo` data recipe's cost under RL.
- `Capture kept` means a mean final held-out capture of at least 0.10, set before the run from `P`'s and `T`'s results.

**Run.** UTC November 1, 23:54 to November 2, 00:05 (10.6 min, cap 2 h).
- Every step exited 0, no game had an illegal attempt, and every evaluation was deterministic.
- All three children pass parity (worst 0.381 of tolerance).

**The host changed.** The run took a quarter of `T`'s time because the local host is now a Mac mini with an Apple M6 (`Mac18,5`, macOS 27.2). The October 5 and 17 records name an M1 MacBook Air. `P` and `T` did not record their host, but their identical work ran 4.8–5.6× slower. Node v20.20.2 and PyTorch 2.11.0 (Accelerate BLAS) are unchanged. The post-hoc check (`S/host-check/`) found:
- **JS evaluation matched across the tested hosts.** Two existing children, 200 games each against the heuristic, reproduce every action stream, final state, tick and point; only timing fields differ.
- **PyTorch training is deterministic on the M6, but not across hosts.**
  - A full rerun of `bfo-klo1-r0` on the M6 reproduces all six iterations: 24/24 tensors, optimizer state and held-out reports.
  - Iteration 0 of `T`'s `bfo-klo-r0` and `P`'s `bfo-k0-r0` on the M6 has identical rollouts and identical parent held-out outputs. After one update, 0/24 tensors are equal (max |diff| 0.011, against a max update of 0.033).
  - This is attributed, by elimination, to chip-specific float kernels; it was not traced.
- So the frozen comparison set M6 children against M1 controls. An addendum (`S/plan-m6.md`) reran all 12 control arms on the M6 with unchanged commands, and applied the same contrasts and label rule.
  - It was written after `analysis.md` was read, and frozen before any of its own output.
  - It ran UTC 00:14–00:57 (43 min), and every step exited 0.

**The strong floor keeps Fireball and costs play.**

| Children, mean of runs | Primary, M1 controls | Primary, M6 | Final held-out capture, M6 | Fireballs per game, M6 |
|---|---|---|---|---|
| `b0-k0` (old recipe) | 0.845 | 0.783 | 0 | 0.00 |
| `bfo-k0` (no floor) | 0.800 | 0.810 | 0 | 0.00 |
| `bfo-kl` (global floor) | 0.741 | 0.714 | 0.088 | 0.35 |
| `bfo-klo` (targeted, β = 0.05) | 0.800 | 0.727 | 0.065 | 0.19 |
| `bfo-klo1` (targeted, β = 1; M6 only) | — | 0.649 | 0.239 (0.176, 0.333, 0.206) | 1.03 (0.50, 1.29, 1.29) |

- **`F` against the M1 controls (frozen):** −0.150 [−0.174, −0.128]; per run +0.010, −0.283 and −0.178. The label is `inconclusive` because r0 is not negative.
- **`F` against the M6 controls:** −0.160 [−0.183, −0.138]; per run −0.070, −0.177 and −0.234. The label is `strong floor keeps Fireball, costs play`.
- **Other contrasts, M6:**
  - against the β = 0.05 targeted floor, −0.077 [−0.101, −0.054];
  - against the global floor, −0.065 [−0.089, −0.041];
  - `PS`, against the old recipe, −0.133 [−0.156, −0.110] (−0.195 against M1).
- **RL gain over the `bfo` parents:** +0.178 [+0.151, +0.205] (per run +0.390, −0.001 and +0.145). `P`'s children without a floor gained about +0.33.
- **Inferred explanation for the play cost:** at β = 1, the card KL to the parent stays at 0.02–0.04 nats on opportunity rows and reaches only 0.04–0.12 on all choice rows. For the M6 β = 0.05 arms the choice-row figure is 0.13–0.53.
  - The card head and trunk are shared, so holding 3–10% of choice rows holds the whole card policy near the weaker BC parent. That is what the global floor did.
- The children cast Fireball about as often as their parents (0.83–1.60 per game). Tactical aggregates are 0.37–0.39, and back-row placement is 46–51%, as before.

**Host variation is as large as the effects measured.** Each M6 control child was compared with the M1 child that has the same parent, seeds and command.
- Per child, the difference ranges from −0.166 to +0.080 primary, and 7 of the 12 intervals exclude zero. For three-run means it ranges from −0.073 to +0.010.
- Two earlier readings do not replicate on the M6:
  - the `bfo` data recipe's cost under RL: `P` −0.045 [−0.065, −0.025], M6 +0.027 [+0.004, +0.050];
  - the β = 0.05 targeted floor's freedom from cost: `T` +0.001 [−0.021, +0.021], M6 −0.083 [−0.106, −0.060].
- The global floor's cost does replicate: `P` −0.059, M6 −0.096.
- The observed cross-host differences at the first update can grow into six-iteration score differences as large as these comparisons' effects. The kernel cause was not isolated, and this is not an estimate of same-host seed variance. With three runs, intervals over evaluation seeds alone omit training-run uncertainty. This applies to every RL comparison in this review.

**Reading.**
- The strong targeted floor keeps Fireball on both control sets: capture 0.18–0.33, about one cast per game.
- It costs about 0.15 primary against no floor, about twice the largest host shift of a three-run mean.
- Under the current scoring, keeping Fireball through a floor is not worth its cost. Whether Fireball has value the scoring does not see is proposal 4's question.

**Follow-up options at the handoff (proposal 4 now implemented below):**
1. **End the floor line and move to proposal 4** (followed).
   - Keep the BC data recipe and both floors default-off, and use the old recipe for RL.
   - Proposal 4's held-out opportunity bank then measures Fireball capture in the gate.
2. **Measure training-run variance first.** For example, 6 or more runs of the old recipe on the M6, at about 2.5 min an arm. This sizes any further RL comparison, including a learner recipe for the campaign.
3. **Tune β between 0.05 and 1.** Not recommended: the trade-off looks continuous, and three runs cannot resolve it against noise at host scale.

## Proposal 4: scoring and held-out opportunities — November 2, 2026

**Status: implemented locally, after the report-only checkpoint `0aeceb1`. A
review on November 2 found that bank snapshots dropped three v2 observation
inputs; the bank was repaired, rebuilt and re-frozen as schema v2 ([review
repair](#review-repair-of-the-bank--november-2-2026)). On November 3 the owner
kept the 0.80/0.70 capture minimums and had the change committed locally with
its repair (not pushed).**
This follows the October 25 approval. The floor line ends with the experimental options
remaining default-off. No new training, policy weights, runtime controller,
cloud action, publication or promotion is part of this change.

Evidence: `Q4` = `~/edge_royale-runs/20261102-proposal4.noindex/` (see its
`README.md`). `plan.md` was hashed before the scorer edits or baseline output.
`before-scenarios.json` preserves the old five-state result. The source is
`0aeceb1`, after `5aff157` with docs only; collection uses a clean clone at
that commit. `source.patch` and `source-checksums.txt` bind the implementation.

### Changes and feasibility

- **Defense:** a troop that targets units must deploy in the threat's lane,
  within 2.5 tiles laterally and between the threat and its target tower.
  Deployment plus estimated closure must precede tower contact, using the
  engine's tower surface distance and troop/card stats. A locked tower is used
  when present; otherwise the nearest living own tower is the proxy target.
  The old `(9.5, 5.5)` Mini P.E.K.K.A scores 0, previously 1.25.
- **Punishment:** only troops in canonical rows 12.5–16.5 with opponent elixir
  at most 2 earn credit. The flat troop bonus and spell credit are removed.
  A Giant at `(9.5, 5.5)` now scores 0, previously 0.70.
- **Expansion:** five states per category, each with a 180-degree blue-side
  team mirror: 50 states under `edger_tactical_scenarios_v2`. Four variants
  change tick, own elixir and lane; punishment also varies enemy elixir.
  The pocket scorer follows the captured lane for mirrored variants.
  The mirrors rotate the state, but not the placement grid exactly: both
  teams use absolute x = 9.5 as the center column, which is 8.5 in red's frame
  for blue. So each blue state has 4–8 center-column placements that differ
  from its red twin's. This is a property of the existing action set, not of
  this change; the mirror test scores red's rotated actions without requiring
  them to be legal for blue.
- **Feasibility repair:** strict interception made the old central Giant at
  `(9,13.5)` unreachable from the existing policy placement set (bridge/front
  row or back row). It moves to the actual bridge at `(3.5,15.5)`; this is a
  fixture change, separately reported below, not a floor relaxation.
  Every one of the 50 states has a legal action reaching its category floor.
- The five category minimums and strict aggregate improvement over the
  heuristic are unchanged. Timing retains the exact original five input
  states, including the old defense position, so quality expansion does not
  redefine the p95 method.

### Bank provenance and new capture gate

The frozen initial collection was 128 full production games, seed 20261102,
paired sides, four opponents and four workers. It yielded only eight test
episodes and eight opportunity states. Before reading any baseline scores,
`coverage-addendum.md` fixed an extension to exactly 1,024 games with unchanged
commands/seed/opponents. It resumed all 128 matching receipts, with no failures.
This coverage-driven extension and the defense feasibility repair are recorded
deviations from `plan.md`.

`edger:opportunity-bank` verifies the source manifest, reads only its stable
**test** shards, checks compressed episode checksums and full replay equality,
and keeps the first opportunity per episode/actor/class. Lethal takes
precedence; Fireball must be legal. Labels use the engine's center-radius rule,
not the synthetic scorer's radius-plus-body allowance, applied to positions at
decision time: the cast delay and projectile travel are ignored (see the limits
below). Each read-only snapshot is checked against the live replay engine as
it is built: legal actions, the v2 observation and v1 per-action features must
match exactly. A rebuild is byte-identical.
There is no overlap with the 160-episode training/validation subset.

- Collection: 1,024 episodes, 70 test episodes.
- Bank: **80 states**, 27 lethal from 23 episodes and 53 cluster from 50
  episodes. Red/blue opportunities come from real decisions, not augmentation.
- Logical bank SHA-256 (schema v2, `QB` below):
  `4f75fbc668f597de8e3dad965049453558ab60d016658fde102c751dd2a159c9`. It
  supersedes `Q4`'s schema v1 bank `0b247247…`, which validation now rejects.
- `QB/BANK-FROZEN.txt` binds the file before `QB/baseline.mjs` reads its
  scores, as `Q4/BANK-FROZEN.txt` did for the v1 bank.

The new `heldout_fireball` preflight gate requires a supplied frozen bank.
It reports Fireball card choices separately from **legal, correctly aimed
capture**. Lethal capture must be ≥0.80, cluster capture ≥0.70: the existing
synthetic category numbers, now explicitly used as capture-rate minimums.
These new rate requirements are not fitted to baseline performance or
claimed equivalent to the old synthetic score units. Missing/empty classes,
invalid checksums/provenance, duplicate entries and failed capture reject
before match workers. Promotion requires this gate, so old reports cannot
pass by omitting it. The production driver freezes its corpus test bank in
`full-cache` and passes that artifact to evaluation; existing failed campaigns
remain immutable.

### Rebaseline

The implementation does not change either baseline policy. Separating scorer
changes, the defense fixture repair and bank expansion avoids interpreting a
changed aggregate as policy improvement (`baseline.json`).

| Synthetic suite | Live v1 | Heuristic |
|---|---:|---:|
| Old five states, old scorers | 0.451 | 0.873 |
| Same old states/actions, new scorers | 0.200 | 0.622 |
| Five base states with repaired defense | 0.430 | 0.852 |
| Expanded 50-state bank | 0.522 | 0.852 |

Both fail the synthetic gate: v1 is below the spell, finishing and pocket
minimums, while the heuristic has zero pocket credit and cannot improve over
itself. V1's finishing score is 0.460 across variants: it takes the lethal
spell on the right-lane variants but misses the left-lane ones.

| Held-out class | Minimum | Live v1, aimed / choices / states | Heuristic, aimed / choices / states |
|---|---:|---:|---:|
| Lethal | 0.80 | 8 / 10 / 27 (29.6% capture) | 20 / 25 / 27 (74.1%) |
| Cluster | 0.70 | 22 / 25 / 53 (41.5%) | 40 / 44 / 53 (75.5%) |

The capture counts above are identical on the v1 and v2 banks (`QB/baseline.json`).

**Neither baseline passes the new bank gate.** The heuristic misses the lethal
minimum, and v1 misses both. The evidence is a local gate baseline, not a model
selection result. No learning consumes this test bank. Future learner-recipe
comparisons first need same-host seed-variance sizing; these cross-host
experiments do not estimate that variance.

### Review repair of the bank — November 2, 2026

Evidence: `QB` = `~/edge_royale-runs/20261102-opportunity-bank-v2.noindex/`
(`plan.md`, `README.md`, `SHA256SUMS`). `Q4` is unchanged.

- **Defect.** Schema v1 snapshots kept the entities, cards, elixir, pending
  effects and clock, but not `spawn_sequence`, `effect_sequence` or
  `recent_combat_events`. The v2 observation reads them as globals 84, 85 and
  87. On every one of the 80 bank states, the restored v2 observation differed
  from the live replay engine: to a v2 policy, a late-game state looked like
  the start of a match on those inputs. The board, the legal actions, the heuristic and
  live v1 matched, so the baselines above were unaffected. The earlier
  snapshot test used only synthetic fixtures, whose counters are initial.
- **Impact on v2 models.** Six v4 children (`P`'s three old-recipe children
  and the three β = 1 children) changed 0–8 of 80 decisions on restored
  states. The β = 1 r2 child's cluster captures fell from 10 (live) to 4
  (restored).
- **Repair** (`scripts/edger-opportunity-bank.mjs`, schema v2). Snapshots
  carry and restore the three fields. The builder rejects any snapshot whose
  restored legal actions, v2 observation or v1 per-action features differ from
  the live engine's. Validation requires exactly the snapshot field set and
  rejects v1 banks. New tests round-trip a mid-game production state (combat
  events, spawns and an effect) and reject a state missing a field; the
  mid-game test fails on `Q4`'s original module.
- **Rebuild** from `Q4/manifest-1024.json`: the same 80 entries in the same
  order, with every old state field unchanged and only the three fields
  added. A second build is byte-identical. Live and restored states now agree
  on all 80 v2 observations, legal actions and heuristic and v1 actions, and
  the six children make identical decisions on both (`QB/fidelity.json`,
  `QB/v2-impact.json`). The baselines are unchanged, and the preflight smoke
  binds the new hash and rejects before any match (`QB/preflight-report.json`).

### Validation and limits

- `PYTHON=/usr/local/bin/python3 npm test`: 235/235 on the implementation
  (`Q4/npm-test-final.log`), and 237/237 after the bank repair (`QB/npm-test.log`).
- `node --test tests/edger-tactical-scoring.test.js tests/edger-training-pipeline.test.js`:
  14/14, then 16/16 after the repair (`QB/tactical-tests.log`); covers
  counterexamples, deployment timing, all mirror observations, snapshot
  reconstruction (synthetic and mid-game), aim/choice, split exclusion and
  rejection controls.
- `npm run bot:bench -- --opponents random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6`:
  pass, win rates 1.000 / 0.833 / 1.000.
- `npx --no-install playwright install chromium` restored Chromium 1208 and
  FFmpeg 1011. Both browser trees match the recorded pins (`browser-pin-check.jsonl`).
  `npm run smoke:browser` passes.
- A full CLI smoke evaluation using the frozen bank rejects the bootstrap
  before any match and binds the correct bank hash (`Q4/preflight-report.json`;
  for the v2 bank, `QB/preflight-report.json`).
- `npm run edger:opportunity-bank -- --manifest <Q4/manifest-1024.json> --out <QB/opportunity-bank-repeat.json>`
  reproduces the frozen v2 bank byte for byte. Exact commands are in `Q4/README.md` and `QB/README.md`.
- These are deterministic one-decision geometric probes. Interception does
  not roll combat forward; capture does not forecast projectile travel or
  measure Fireball's strategic value. Eighty states are a bounded local bank,
  not a production corpus or a precise uncertainty estimate. Correlated
  states from the same episode are not independent samples.
- The explicit bank artifact is required for full evaluation. The production
  wiring is syntax/full-suite checked locally; no cloud end-to-end run or
  candidate promotion was attempted. Fresh scaling/provenance and the
  accumulated-diff review remain prerequisites.

## Same-host training-run variance — November 3, 2026

**Status: done locally (owner decision, November 3), before any further RL
recipe comparison.** Evidence: `VP` =
`~/edge_royale-runs/20261103-variance-pilot.noindex/` (`plan.md`, `FROZEN.txt`,
`analysis.md`, `posthoc.md`, `README.md`, `SHA256SUMS`). Diagnostic only.

**Design** (frozen in `VP/plan.md` before any output). Six end-to-end runs of
the old recipe on the M6, at code `16e36b4`.
- Run rN trains its own BC parent (default recipe, seed 20260718+N, 6 epochs) and then its RL child, using `P`'s unchanged `b0-k0` command with `seed-plan-rN.json`.
- r0–r2 use `P`'s plans. r3–r5 come from the same generator, which also reproduces r1 and r2 byte for byte. The six training seed sets are disjoint from each other and from the evaluation seeds.
- The torch seed is shared, as in every earlier design. Fixed-parent (RL-only) variance is not separated.
- Every parent and child is evaluated on the same development seeds, with `P`'s commands.

**Run.** UTC November 2, 14:27–15:13 (45.6 min, cap 2 h).
- All 54 steps exited 0, no game had an illegal attempt, and every evaluation was deterministic.
- All six children pass parity (worst 0.381 of tolerance).

| Run | Parent primary | Child primary [95% over evaluation seeds] | RL gain |
|---|---|---|---|
| r0 | 0.487 | 0.803 [0.775, 0.830] | +0.317 |
| r1 | 0.645 | 0.733 [0.701, 0.763] | +0.087 |
| r2 | 0.408 | 0.742 [0.712, 0.773] | +0.334 |
| r3 | 0.425 | 0.829 [0.804, 0.853] | +0.404 |
| r4 | 0.488 | 0.507 [0.471, 0.543] | +0.018 |
| r5 | 0.561 | 0.797 [0.768, 0.825] | +0.237 |

- **Spread.** The child primary has mean 0.735 and SD 0.118 (normal-model 95% interval for the SD 0.074–0.289), with a range of 0.507–0.829. The run-level SD is about 8× one child's evaluation-seed SE of 0.015; this compares standard deviations, not variances.
  - The parent primary has SD 0.088, and the RL gain SD 0.151.
  - The sample parent–child correlation is r = −0.05. These six runs show no predictive relationship; they do not establish that parent quality is irrelevant.
- **Shape** (post hoc, `VP/posthoc.md`). Five runs lie within 0.733–0.829 (SD 0.042, close to earlier three-run spreads). r4 barely improved on its parent.
  - r4's card policy drifted furthest from its parent (card KL 0.89, against 0.14–0.51), and it deploys less in evaluation.
  - Its sampled training scores did not single it out.
  - r4 completed cleanly and passed parity. It is a valid low-scoring result, not an engineering failure. Six observations do not establish heavy tails, a separate failure mode or its frequency.
- **Sizing** (frozen approximation). With s = 0.118, the normal/equal-variance planning model gives approximate differences for α = 0.05 and 80% power of:
  - 0.36 with 3 runs per arm;
  - 0.21 with 6;
  - 0.16 with 10.
  - At the SD's upper 95% bound these become 0.88, 0.52 and 0.38.
  - The formula is `s·sqrt(2/n)` with `2n−2` degrees of freedom: it assumes independent training runs across arms. Shared evaluation seeds do not establish a reduction from matching training runs. A matched design instead uses the SD of run-level differences and `n−1` degrees of freedom ([NIST paired observations](https://www.itl.nist.gov/div898/handbook/prc/section3/prc311.htm)).
  - The SD interval assumes approximately normal run outcomes and is sensitive to non-normality ([NIST SD confidence limits](https://itl.nist.gov/div898/software/dataplot/refman1/auxillar/sdconfli.htm)). Neither it nor the sizing table guarantees coverage or power for a mixture with occasional poor outcomes.
- **Reading.** Every recipe effect measured in this review (0.03–0.16) is below the three-run model's 80%-power target. Earlier three-run contrasts remain leans, including the β = 1 floor's −0.16; this is not evidence of equivalence or a hard detection limit. The pilot does not estimate the SD of matched recipe differences.

### Comparison rule — owner decision, November 4, 2026

The owner adopted this rule on November 4, 2026, from the advice of the same
day. It governs every further RL recipe comparison.

Prefer more runs with the mean as primary, rather than switching to the median
to reduce the influence of r4. A low-scoring but valid run is part of recipe
reliability. The median answers a different question about the typical run;
report it as a secondary diagnostic alongside every run, SD and range.

- **Default:** 12 runs per arm for a comparison targeting effects around 0.15. At the pilot SD, independent-run normal-model calculations give an 80%-power difference of 0.141; 24 runs give 0.097 and 90 give 0.050. The exact minimum counts for effects 0.15/0.10/0.05 are 11/23/89, rounded up here for planning. These remain estimates from six runs, not power guarantees. Do not pursue 0.03–0.05 recipe gains with a small comparison at this spread.
- **Design:** freeze the minimum meaningful effect, run count, host/code/data, training and evaluation seeds, primary statistic, uncertainty calculation, failure handling and stopping rule before output. Use the same evaluation seeds. For RL-only changes, match both arms on each independently chosen BC parent and training plan; analyze the mean of paired run differences, with uncertainty over training replicates. Twelve such pairs have a modeled target of 0.148 if cross-arm covariance is zero; actual paired spread is unmeasured. Do not claim a measured pairing benefit. BC-changing recipes need separate end-to-end parents and an appropriate design.
- **Completed poor runs:** retain them in the primary mean, including an outcome like r4. No score-based exclusions, replacements or early stopping. Engineering-invalid outcomes must all be reported; an invalid policy blocks a favorable recipe conclusion rather than disappearing from the denominator. Any infrastructure retry rule must be frozen and use identical settings and seeds.
- **Cheap screening:** fewer runs may guide exploration, but cannot settle these small effects. Choose the statistic and practical decision threshold in advance; do not expand or stop a comparison after inspecting its recipe difference without a valid sequential plan.
- **Six-arm follow-up: skipped.** Six starts from one BC parent measure only variance conditional on that parent, not a BC-versus-RL variance decomposition. Repeats across multiple parents are needed to investigate both components. Revisit only if conditional RL variance becomes the immediate question.
- **Docs:** the pilot and advice were committed separately as docs-only `6e0b6a8`.
- **After the first matched comparison (November 6):** the owner kept the 12-pair default. The measured matched SD (0.075) comes from one design and one scale ([decision](#first-comparison-rollout-freshness-at-equal-updates)).

Read-only recalculation: `~/edge_royale-runs/20261104-variance-decision.noindex/`
(`decision.py`, `analysis.json`, `SHA256SUMS`). It reads the frozen evaluations;
the pilot files, frozen analysis and post-hoc split are unchanged. On November 4
the table's SD (0.118) and the 12/24/90 sizing figures were recomputed again
from the evaluations' child primaries and matched.

### First comparison: rollout freshness at equal updates

**Status: done locally (owner-approved November 6, 2026).** Evidence: `FR` =
`~/edge_royale-runs/20261106-rollout-freshness.noindex/` (`plan.md`,
`FROZEN.txt`, `analysis.md`, `posthoc.md`, `README.md`, `SHA256SUMS`).
Diagnostic only. This is the first comparison under the rule above, and the
first step of the historical league-regression attribution. The design below
is as approved; results follow it.

**Question.** Does learning from a single parent rollout score worse than the
on-policy loop that refreshes its rollouts every 64 games? The comparison
holds games, seeds, opponents and optimizer updates equal. The production
league stage learns from one rollout per command, while the `train-arm` loop
reliably improved the parent (cadence replication). This comparison isolates
that one difference. It does not test:
- the production learner code path or base-corpus mix;
- league opponents or the historical scale of about 11,318 updates;
- the historical legacy rows with behavior probability 1, which current code excludes from V-trace.

**Design.** RL-only and matched by parent.
- Host and code: the M6 and toolchain of the pilot, using a clean clone at `6e0b6a8` or later. The run used `d345a49`, whose `src/`, `scripts/` and `tests/` are identical to the pilot's `16e36b4`. BC, `train-arm`, export and evaluation code are unchanged since `5aff157`. The cache is `Y/v4/subset-decisions.parquet`.
- Twelve pairs, r6–r17. Each trains a new BC parent (seed 20260718+N, 6 epochs, default recipe), then two RL children from it:
  - **A (refreshed):** the pilot's `b0-k0` command (`--iterations 6 --pairs-per-iteration 32`).
  - **B (single rollout):** the same command with `--iterations 1 --pairs-per-iteration 192`.
- Both arms play training pairs 0–191 of `seed-plan-rN.json` in the same order, against the same opponents. Each makes 384 one-episode Adam updates with torch seed 20260926. The learner draws no random numbers.
- The arms should share their first 64 games, which the parent collects in both. They differ only in which policy collects games 65–384. A check on the shared prefix verifies this; it is not part of the estimate.
- Seeds: generate `replicate-seeds --replicates r1 r2 … r17` from the pilot's `seed-plan-r0.json`. Opponent schedules depend on list position. r1–r5 must reproduce the pilot's plans byte for byte. r6–r17 are then disjoint from every earlier training seed and from the development, probe and confirmation sets.
- Evaluation: the parent and both children, using the pilot's commands. That is learned cadence, deterministic, on the development seeds: 200 pairs against live v1 and 100 each against the heuristic and aggressive. `V/js-eval.mjs` checks each child's parity.

**Analysis.**
- **Primary statistic.** For each pair, d = B child primary − A child primary, where the primary score is as in the pilot. The estimate is the mean of the 12 values of d, with a two-sided 95% t interval (11 df) over pairs. The minimum meaningful effect is 0.15.
- **Labels.** If the interval excludes 0, the label states the direction and whether |mean d| ≥ 0.15. If it lies wholly inside ±0.15, the label is "within ±0.15". Otherwise it is "inconclusive at this size". There are no other labels.
- **Secondary.** Every pair, the median of d and the SD of d, which is the first measured spread of matched differences and feeds later sizing. Also per-opponent differences, each child's RL gain over its parent, the spread of arm A against the pilot, and Fireball capture diagnostics.
- **Sample size and stopping.** n = 12 is fixed. The analysis runs once, after all 24 children are evaluated. Progress checks read only counts, timings, exit codes and stop reasons.
- **Failures.** Settings never change. One infrastructure retry uses the identical command and seeds, frozen in `run.sh`. Every engineering-invalid outcome is reported: illegal attempts, nondeterministic evaluation, failed parity or learner aborts. An invalid child in either arm blocks a conclusion that favors that arm.

**Before freezing.**
- Run a 2-pair `--iterations 1` plumbing smoke on throwaway seeds outside the evaluation sets.
- Verify the regenerated r1–r5 plans.
- Hash `plan.md`, `run.sh` and `analyze.py` into `FROZEN.txt` before any output.

**Cost.** The pilot's step timings were BC about 3 min, an RL arm about 2.4 min and three evaluations of a model about 1 min. A pair therefore takes about 12 min, and the comparison about 2.5 h. The cap is 4 h. The run is local only and the rollouts total about 22 MB per arm.

**What it decides.**
- If refreshed rollouts are better by at least 0.15, any production league stage needs iterated rollouts at this update scale before a campaign.
- If the result is within ±0.15, rollout freshness at this scale does not explain the regression. The next attribution step is the production learner path on fixed data, then opponent mix and update scale.
- "Inconclusive at this size" is reported as such, without a follow-up decided after seeing it.

**Preflight and run.**
- The regenerated r1–r5 plans equalled the pilot's byte for byte. All 19 training seed sets (r0–r17 and the smoke set) were pairwise disjoint and disjoint from the evaluation sets.
- The 2-game smoke from the pilot's `b0-s20260718` passed: pair 0's episode bodies and first two updates were identical across the two arm shapes. `FROZEN.txt` was written at 2026-11-05T23:51:06Z UTC, before any output, and covers 20 files.
- The runner took 2 h 14 min (23:51–02:05 UTC) with one launch. All 168 steps succeeded on the first attempt.
- All 24 children completed, with zero illegal attempts, deterministic evaluations and parity passes (worst 0.572 of tolerance).
- In every pair, the first 64 episode bodies and the first 64 update gradient norms were identical across arms.

| Pair | Parent | A (refreshed) | B (single rollout) | d = B − A |
|---|---|---|---|---|
| r6 | 0.619 | 0.822 | 0.708 | −0.113 |
| r7 | 0.634 | 0.768 | 0.783 | +0.015 |
| r8 | 0.572 | 0.802 | 0.744 | −0.058 |
| r9 | 0.562 | 0.657 | 0.582 | −0.075 |
| r10 | 0.523 | 0.674 | 0.497 | −0.177 |
| r11 | 0.563 | 0.768 | 0.665 | −0.103 |
| r12 | 0.554 | 0.821 | 0.645 | −0.175 |
| r13 | 0.454 | 0.800 | 0.575 | −0.225 |
| r14 | 0.541 | 0.685 | 0.557 | −0.128 |
| r15 | 0.668 | 0.782 | 0.624 | −0.158 |
| r16 | 0.661 | 0.727 | 0.744 | +0.018 |
| r17 | 0.550 | 0.740 | 0.663 | −0.077 |

**Results** (frozen analysis, `FR/analysis.md`).
- **Primary:** mean d = **−0.105**, 95% t interval [−0.152, −0.057]. Frozen label: **"refreshed better (|mean d| < 0.15)"**.
- B scored below A in 10 of 12 pairs. The median d is −0.108.
- Every opponent's interval excludes 0: v1 −0.120 [−0.186, −0.054], heuristic −0.125 [−0.171, −0.079], aggressive −0.069 [−0.115, −0.023].
- **Spread.** The SD of d is 0.075 [95% chi-square 0.053, 0.127], the first measured spread of a matched RL difference. Independent arms at the earlier pilot SD would give s·√2 = 0.167; that is a planning reference, not an unmatched-arm measurement from this comparison.
- Arm A's 12 children have mean 0.754 and SD 0.057 [0.041, 0.097]; arm B's have mean 0.649 and SD 0.087. One child's evaluation-seed SE averages 0.015.
- **Fireball:** no child captured a held-out Fireball opportunity. Both arms lowered the mean Fireball probability from the parent's 0.07–0.12, B further (0.000–0.022) than A (0.006–0.050).
- The capture diagnostic is "failed" for r13 and r17 in both arms, because those parents captured 0.010 and every child 0.

**Post hoc** (`FR/posthoc.md`, written after the analysis was read).
- A's RL gain over the parent averaged +0.179 [+0.129, +0.228] and was positive in all 12 pairs.
- B's gain averaged +0.074 [+0.031, +0.117], with two pairs negative. B's mean gain is 41% of A's.
- Matched pairs needed for 80% power:
  - At the measured SD of d (0.075): 5 for 0.15, 7 for 0.10 and 20 for 0.05.
  - At its upper 95% bound (0.127): 8, 15 and 53.

**Reading.**
- At equal games, seeds, opponents and updates, refreshing the rollouts every 64 games beat learning from one parent rollout. The point estimate is below the pre-set 0.15 effect. The interval's far end (−0.152) does not exclude it.
- The result falls between the pre-set decision branches: at least 0.15, within ±0.15, or inconclusive. Its consequence is therefore an owner decision, not an automatic rule (made November 6, below).
- The single rollout still improved the parent at this scale. Staleness cost more than half of the RL gain, but did not reproduce the historical regression.
- Whether staleness compounds with more updates per rollout is an untested hypothesis. The production stage made about 11,318 updates from one rollout.
- A further post-hoc, read-only calculation from the 72 child evaluations gives √(s_A² + s_B²) = 0.104 under independence, using this comparison's own marginal SDs. The paired SD of 0.075 is about 28% lower, with A–B correlation 0.524. Comparing it with the earlier pilot's 0.167 reference also includes differences between experiments; the full reduction cannot be attributed to matching. Another recipe's matched spread may differ.
- Twelve more runs of the A recipe produced no r4-like outlier. This neither establishes nor rules out the frequency of such runs.
- Wall time per arm favored B: about 1.1 min against 2.6 min, because one large collection batches better across workers.

**Owner decision, November 6, 2026.** Made from the decision review of the
same day. The frozen label stands unchanged.
- **Refreshed rollouts are required** in any future RL or league stage design. This is an engineering decision on the evidence: the 0.105 advantage is clear within this experiment, but the interval does not settle whether it reaches 0.15. Refreshing every 64 games is the tested baseline; the best refresh frequency is unknown.
- **Next attribution step: longer stretches without refreshing.** Test whether staleness at a larger scale causes regression. Use matched parents, equal total games and updates, and the same learner and opponents. Measure both the refreshed-against-stale gap and each child's change from its parent. Freeze the scale, cost cap and consequences before launch.
- **The rule's 12-pair default stays.** Eight pairs is a calculation for detecting 0.15 in this design only, whereas this comparison found about 0.10. At the paired SD's upper bound, 0.10 needs about 15 pairs, and the spread at larger scale is unknown.
- This comparison advances the training diagnosis only. No child captured a held-out Fireball opportunity, and candidate quality remains unresolved.
- The results were committed as their own docs-only checkpoint (`bb39dea`).

### Second comparison: staleness at four times the updates

**Status: done locally (owner-approved November 6, 2026).** Evidence:
`SS` = `~/edge_royale-runs/20261106-staleness-scale.noindex/` (`plan.md`,
`FROZEN.txt`, `analysis.md`, `posthoc.md`, `README.md`, `SHA256SUMS`).
Diagnostic only. This is the attribution step the owner chose above. The design
below is as approved.

**Question.** Does a stretch without refreshing four times as long make the
stale child regress below its parent? And how far does it fall behind the
refreshed loop at equal games and updates? The historical production stage
made about 11,318 updates from one rollout. The first comparison tested 384.
This one tests 1,536: four times the first comparison's scale, and still about
a seventh of the historical one.

**Design.** RL-only and matched by parent, otherwise as in the first comparison.
- **Host and code:** the same M6 and toolchain, with a clean clone at `bb39dea` or a later docs-only commit. Its `src/`, `scripts/`, `tests/` and `package.json` are identical to `d345a49`'s.
- **Parents:** the first comparison's twelve BC parents `b0-s20260724`–`b0-s20260735` (r6–r17). They are byte-copied from `FR` and checked against `FR/SHA256SUMS`. No new BC training. Matching the parents makes the two scales comparable within each parent.
- **Seeds:** `replicate-seeds --replicates r1 … r17 --training 768` from the same `seed-plan-r0.json`. A scratchpad trial on November 6 showed that every extended plan's first 192 training seeds and opponents equal the existing r1–r17 plans byte for byte. All 13,056 training seeds were distinct and disjoint from the evaluation seeds. The extended r6–r17 plans are used; r1–r5 serve only as the check.
- **Arms.** Each parent trains two children, with 1,536 games and 1,536 one-episode Adam updates each:
  - **A′ (refreshed):** `--iterations 24 --pairs-per-iteration 32`, refreshing every 64 games, the tested baseline.
  - **B′ (single rollout):** `--iterations 1 --pairs-per-iteration 768`.
  - Every other `train-arm` setting matches the first comparison's `run.sh`, including torch seed 20260926, held-out cache and `--budget-minutes 150`.
- **Built-in reproduction checks.** These are not part of the estimate:
  - A′'s first six iterations should replay `FR`'s A child exactly. The learner reads no iteration count, and seeds and opponents are prefix-equal. The check compares all 384 episode bodies and gradient norms.
  - A′ and B′ should share their first 64 games and updates.
  - Each parent is re-evaluated and should equal its `FR` evaluation.
- **Evaluation:** parent, A′ and B′, with the first comparison's commands and development seeds, plus `V/js-eval.mjs` parity for each child.

**Analysis.**
- **Primary 1 (regression):** g′ = B′ child primary − parent primary, per pair. Report the mean of 12 values with a two-sided 95% t interval (11 df).
- **Primary 2 (gap):** d′ = B′ − A′, analyzed the same way.
- **Labels** are the first comparison's rule, applied to each primary with minimum meaningful effect 0.15:
  - If the interval excludes 0: the direction ("stale child regressed/improved" for g′; "refreshed/single rollout better" for d′), and whether |mean| ≥ 0.15.
  - Otherwise "within ±0.15" if the interval lies inside ±0.15.
  - Otherwise "inconclusive at this size".
  - The two primaries are labelled separately, without multiplicity adjustment.
- **Secondary, pre-registered:**
  - Scale trend per parent: d′ − d and g′ − g_B. Here d and g_B are `FR`'s frozen 384-update values, read-only. Report means with t intervals.
  - A′'s gain over the parent, and over `FR`'s A child.
  - Every pair, the median and SD of each primary, per-opponent differences and Fireball capture diagnostics.
- **Sample size and stopping:** n = 12, fixed (owner rule). The analysis runs once, after all 24 children are evaluated. Progress checks read only counts, timings, exit codes and stop reasons.
- **Failures:** settings never change, and there is one identical infrastructure retry. Every engineering-invalid outcome is reported. A non-finite learner stop is a recipe outcome, because the historical stale run diverged; it is reported per arm.
  - A missing or invalid B′ child blocks "stale child improved" and any d′ label favoring B′.
  - A missing or invalid A′ child blocks any d′ label favoring A′.

**Before freezing.**
- Run a short plumbing smoke on a throwaway `smoke` replicate generated with `--training 768`: 3 × 1 pair against 1 × 3 pairs from one parent.
- Verify the parent copies and the plan prefixes.
- Hash `plan.md`, `run.sh` and `analyze.py` into `FROZEN.txt` before any output.

**Cost.** Estimated from the first comparison's measured steps (a refreshed iteration about 26 s, the single 384-game arm about 62 s, and evaluation plus parity about 92 s per child):
- about 10.5 min for A′, 4 min for B′, 3 min for the child evaluations and 1.3 min for the parent re-evaluation;
- so about 19 min per pair and 3.7 h in all.

The cap is 6 h, after which no new step starts. The run is local only, about 0.5 GB with episode bodies pruned; 85 GiB is free.

**What it decides.** Fixed before output.
- **"Stale child regressed":** staleness alone reproduces a regression at 1,536 updates with the current learner. Record it as an attribution of the historical regression. The production-learner and opponent steps then test only whether they add to it.
- **"Stale child improved":** staleness up to 1,536 updates does not reproduce the regression, and the next step is the production learner path on fixed data. A larger stale stretch is considered only as a separately approved design. Its motivation would be the pre-registered scale trend, not a follow-up chosen from this result.
- **Within ±0.15 or inconclusive:** reported as such, with no follow-up decided after seeing it.
- **d′:** every label keeps the refresh requirement. d′ records the cost of staleness at this scale.

**Preflight and run.**
- `SS/vrepo` is a clean clone at `51e5969`. The twelve parents were byte-copied from `FR` and match `FR/SHA256SUMS`.
- The extended plans were regenerated in `SS`, with the same result as the scratchpad trial (`SS/seeds-check.txt`). Every first-192 prefix equals the `VP`/`FR` plan, and the 19 training sets and 3 evaluation sets are pairwise disjoint.
- The smoke from the pilot's `b0-s20260718` passed. Both shapes completed, and pair 0's two bodies and first two updates were identical; pairs 1–2 shared seeds and opponents but not bodies (`SS/smoke/smoke-check.txt`).
- `analyze.py` was dry-run on synthetic inputs built from `FR`'s files, covering the complete, regressed, blocked, incomplete and reproduction-mismatch paths. With `FR`'s children substituted, it reproduced `FR`'s +0.074 and −0.105.
- `FROZEN.txt` was written at 2026-11-06T03:52:32Z UTC, before any output, and covers 46 files. The runner was launched at 03:52:59Z with `nohup caffeinate -is bash run.sh > runner.out 2>&1`.
- An unrelated `gridcast` backtest shared the host (about 2.6 of 12 cores at launch). This affects wall time, not results.
- The runner took 4 h 25 min (03:52:59–08:17:43 UTC) with one launch, inside the 6 h cap. All 156 steps succeeded on the first attempt, and `FROZEN.txt` re-verified 46/46 before the analysis ran once.
- All 24 arms completed with zero illegal attempts and deterministic evaluations. Two B′ children (r12, r13) failed parity: their worst tolerance ratios were 2.40 and 1.34, with maximum legal logits of 366 and 327. These are engineering-invalid outcomes and stay in the means. They would block any label favoring B′; neither label does.
- **Every reproduction check passed.**
  - A′'s first six iterations replayed `FR`'s A child exactly in all 12 pairs: 384/384 episode bodies, 384/384 gradient norms and equal iteration-5 weights.
  - A′ and B′ shared 64/64 bodies and updates.
  - Every parent re-evaluation equalled `FR`'s, game by game (points, action streams and final states).

| Pair | Parent | A′ (refreshed) | B′ (single rollout) | g′ = B′ − parent | d′ = B′ − A′ | d at 384 |
|---|---|---|---|---|---|---|
| r6 | 0.619 | 0.872 | 0.641 | +0.022 | −0.231 | −0.113 |
| r7 | 0.634 | 0.854 | 0.843 | +0.209 | −0.011 | +0.015 |
| r8 | 0.572 | 0.808 | 0.790 | +0.218 | −0.018 | −0.058 |
| r9 | 0.562 | 0.818 | 0.655 | +0.093 | −0.163 | −0.075 |
| r10 | 0.523 | 0.836 | 0.691 | +0.167 | −0.145 | −0.177 |
| r11 | 0.563 | 0.799 | 0.193 | −0.370 | −0.605 | −0.103 |
| r12 | 0.554 | 0.823 | 0.589 | +0.035 | −0.235 | −0.175 |
| r13 | 0.454 | 0.823 | 0.748 | +0.294 | −0.074 | −0.225 |
| r14 | 0.541 | 0.774 | 0.513 | −0.028 | −0.260 | −0.128 |
| r15 | 0.668 | 0.783 | 0.201 | −0.468 | −0.582 | −0.158 |
| r16 | 0.661 | 0.832 | 0.174 | −0.487 | −0.657 | +0.018 |
| r17 | 0.550 | 0.820 | 0.694 | +0.144 | −0.126 | −0.077 |

**Results** (frozen analysis, `SS/analysis.md`).
- **g′ (stale child against parent):** mean −0.014, 95% t interval [−0.188, +0.160]. Frozen label: **"inconclusive at this size"**. The median is +0.064; g′ was positive in 8 of 12 pairs, with SD 0.274 [0.194, 0.466].
- **d′ (stale against refreshed):** mean −0.259 [−0.405, −0.113]. Frozen label: **"refreshed better (|mean| ≥ 0.15)"**.
  - B′ was below A′ in all 12 pairs; the median is −0.197 and the SD 0.229.
  - Every opponent's interval excludes 0: v1 −0.264, heuristic −0.289, aggressive −0.224.
- **Scale trend** (pre-registered secondary): d′ − d = −0.154 [−0.311, +0.003] and g′ − g_B = −0.088 [−0.251, +0.075]. Both lean toward staleness costing more at 1,536 updates; neither interval excludes 0.
- **The refreshed loop kept improving and stayed tight.**
  - A′ gained +0.245 [+0.204, +0.285] over its parents, positive in 12 of 12. The SD of these paired gains is 0.064; the 0.028 below describes final child scores.
  - It beat `FR`'s 384-update A child by +0.066 [+0.030, +0.102], also 12 of 12.
  - Its 12 children have mean 0.820 and SD 0.028.
  - B′'s children have mean 0.561 and SD 0.240 (range 0.174–0.843).
- **Fireball:** no A′ child captured a held-out opportunity. One B′ child did: r16, at 0.176 with mean P(Fireball) 0.326. That is the same child whose score collapsed, so it is not a tactical gain.

**Post hoc** (`SS/posthoc.md`, written after the analysis was read; descriptive only).
- **Children more than 0.15 below their parent:**
  - B′: 3 of 12 (r11, r15, r16).
  - None of the 12 A′ children, nor of `FR`'s 12 A or 12 B children.
  - Without those three, the mean g′ of the other nine is +0.128. The frozen rule retains them.
- **Degeneration in four B′ children** (r11, r12, r13, r15):
  - Delay and card entropy fell to 0.00–0.01 by the last 64 updates.
  - They choose the minimum 1-tick delay at every decision: about 4,000 decisions per game, 99% of them passes, against 27–34 for parents and 62–458 for refreshed children.
  - Maximum legal logits reached 108–366. Every other child stays at or below 42.
  - Shared-trunk drift from the parent was 0.40–0.88, against 0.20–0.29 for the other B′ children.
  - Two of these four still scored above their parents, so the play score alone understates the damage.
  - r16 collapsed differently: delay 6.9 and Fireball probability up. No refreshed child shows either pattern.
- These are the heads the historical league damage concentrated in (card and delay; [evaluation diagnosis](EDGER_EVALUATION_DIAGNOSIS.md#training-defect-and-bounded-reproduction)). This is a resemblance noticed after the result, not a tested mechanism.

**Reading** (by the branches fixed before output).
- **g′ is "inconclusive at this size".** The fixed branch supplies no follow-up; the separate review decision below leaves this label unchanged. The mean-based test at 12 pairs cannot separate "usually improves, sometimes collapses" from no change: the spread of g′ quadrupled from 0.068 at 384 updates to 0.274.
- **d′ is "refreshed better (|mean| ≥ 0.15)".** The refresh requirement stands. At 1,536 updates, staleness cost 0.259 primary on average and never helped in any pair. The magnitude label describes the observed mean; the interval supports an advantage of 0.113–0.405, so it does not establish a minimum advantage of 0.15.
- Whether stale learning at the historical scale (about 11,318 updates) regresses on average remains untested. That stale rollouts at 1,536 updates can degenerate a policy (4 of 12 here) is a post-hoc observation and a hypothesis for any later design, not a finding.

**Next-step decision — November 6, 2026 review (after output).**
- Prepare the production learner path comparison on fixed data (task 4) next. Refreshed rollouts are already required, so testing the learner used by the future pipeline takes priority over resolving mean stale-child regression. This is a separate engineering priority decision; it changes neither frozen label nor the approved analysis.
- Isolate the learner path: both arms must consume the same frozen, ordered data collected with refreshed policies. Independently recollecting each arm's games would mix learner and data effects. Freeze the collection schedule, data conversion checks, update budget, matched parents, seeds, same-host provenance, sample size, failure handling, stopping rule and cost cap before comparison output. Keep the league opponent mix and base-corpus changes for separate attribution steps.
- Include routine diagnostics for every future RL child: card/delay choice entropy, decisions per game and maximum legal logit, alongside pass fraction and chosen delay. Define the observation population, masks, entropy units, aggregation and logit heads before the next run. Add reporting in a separate code checkpoint with appropriate tests; these are descriptive measures, with no new exclusion, stopping or promotion threshold inferred from this result.
- Keep stale-batch breakdown as a hypothesis. Any dedicated comparison needs a separately frozen breakdown endpoint and design; do not extend these 12 pairs after inspecting g′.
- Checkpoint these results as a local docs-only commit. The next comparison still needs a concrete reviewed design before launch; publication and promotion retain their separate approval requirements.

### Routine policy diagnostics — November 6, 2026

**Status: implemented as its own code checkpoint**, before the production-learner
comparison, as the review above required. The schema is
`edger_v2_policy_diagnostics_v1`, in `scripts/edger-v2-cadence-core.mjs` and
`scripts/edger-v2-cadence-experiment.mjs`. The measures are descriptive only:
nothing excludes, stops or promotes a run on them, and no threshold was fitted
to the staleness results.

**Definitions** (frozen before any comparison output; details in
[training](EDGER_TRAINING.md#decision-cadence-diagnostic-local-only-never-promotable)).
- **Population:** every decision a child makes in its deterministic development-seed evaluation games, each counted once. The `diagnostics` command pools a child's three opponent files and also reports each opponent separately.
- **Choice decision:** at least one non-PASS card is legal. **PASS decision:** the card head selects index 0.
- **Card entropy:** nats, over the legal card actions, on choice decisions only.
- **Delay entropy:** nats, over the 200 legal delays, given the selected card and placement, on every learned-cadence decision.
- **Maximum legal logit:** the largest |logit| over legal entries per head. Placement counts only when a card is selected. This differs from the parity report's fixture-based `maximum_legal_logit_magnitude`.
- **Also reported:** decisions per game, PASS fraction over all and over choice decisions, mean chosen delay and the fraction of decisions at the 1-tick minimum.
- **Aggregation:** decision-weighted means and the population maximum, with p05/p50/p95 of per-game means.

**Checks.**
- Five new tests cover:
  - the entropy and logit definitions on hand-built inputs;
  - recomputation from the runtime's own logits;
  - unchanged decisions;
  - per-game counts against the existing statistics;
  - pooling, and the command's refusal of mixed models, repeated opponents and files that predate the diagnostics.
- `PYTHON=/usr/local/bin/python3 npm test`: 242/242.
- Trajectories and evaluations are unchanged (read-only checks against `FR`):
  - Regenerating A-r6's first collection from its parent gave 64/64 bodies identical to the recorded headers.
  - Re-evaluating `FR`'s A-r6 child against aggressive and the heuristic (100 pairs each) gave 400/400 identical games and identical non-timing statistics.
- Code sanity check, not a re-analysis: on 20 aggressive games of `SS`'s degenerate B′ r12 child, the measures register the known pattern. Card entropy was about 5e−11 nats, delay entropy about 6e−67, every decision used the 1-tick minimum and the maximum legal logit was 387.

### Third comparison: production learner on fixed refreshed data

**Status: done November 7, 2026. Frozen label: "train-arm better (|mean| <
0.15)"**, d_P −0.098 [−0.159, −0.036]; see "Results" below. The design was
approved by delegated owner decision: the owner asked the agent to choose the
three options. Preflight, freeze and launch are recorded under "Preflight and
run" below. This is task 4 as the review above chose it. The design follows the comparison
rule and the earlier two comparisons; its outcome branches are fixed here,
before any output.

**Approved choices.**

- **Scale: 1,536 games per parent**, corresponding to T's 1,536 updates. This is closer to the historical scale at similar estimated cost; the first-384-game comparison remains secondary. P keeps its production train-split filter, so it makes about 1,230 updates. Do not add epochs to equalize update counts.
- **Production behaviors: all three together.** Test the path the production learner actually uses. Decomposing split filtering, hash order and balancing weights would be a separately designed comparison if this bundle costs play quality.
- **T controls: reuse `SS`'s refreshed A′ children and re-evaluate them.** Checksum-verified regeneration establishes the shared data, and game-by-game re-evaluation checks compatibility. Retraining would add cost without changing the intended comparison.

Keep the 12 pairs, 0.15 threshold, frozen failure rules and 5-hour local cap.
The approved sequence is the design checkpoint, converter checkpoint with
tests, smoke, synthetic analysis dry run, freeze, then launch after those
checks pass.

**Question.** Given the same fixed rollouts collected by refreshed policies,
does the production learner path produce children as good as the `train-arm`
learner? The production path converts games to corpus episodes, builds the
cache with `edger-dataset.mjs` and trains with `edger-v2-training.py vtrace`.
The comparison isolates the learner path. It does not test league opponents,
the base-corpus mix or the historical scale.

**What differs in the production path.** Code reading, plus a scratchpad
prototype on November 6. The prototype converted `SS`'s A-r6 iteration 0 (64
games collected by parent `b0-s20260724`), using a clean clone at `b4a0c78`:
- **Conversion is exact.** Each game was replayed from its recorded collecting model, and all 64 bodies equalled the SHA-256 in `SS`'s headers. The production derivation (`deriveDecisionSequence`) then reproduced every cadence row exactly. This covers observation, masks, selected action, delay, behavior log-probability, reward and return.
- **The update math is identical.** With three production behaviors neutralized, production `train_vtrace_episode` on the converted Parquet rows reproduced `SS`'s A-r6 iteration-0 weights bit for bit, including all 64 gradient norms. The neutralization used every split, sample weight 1 and play order.
- **The production path differs only in those three behaviors:**
  1. **Split filter.** `vtrace` trains only on episodes whose ID hash falls in the train split: 54 of 64 here, about 80% in expectation.
  2. **Hash order.** Manifests sort episodes by ID, so updates run in content-hash order, not play order.
  3. **Balancing weights.** `edger-dataset.mjs` weights each row's policy loss by source × opponent × outcome stratum, from 0.35 to 3.24 here; the value loss is unweighted. `train-arm` uses weight 1.
- **Each behavior matters on its own.** Relative to the `train-arm` weights after one iteration, each behavior alone moved them by 2.8–5.4% (relative L2), and all three together by 5.7%. The real `vtrace` command reproduced the emulation of all three together exactly.
- **Episode IDs depend on the converted content,** including the policy and collector labels. The converter therefore fixes those labels before output, because they determine the split and order.
- **Cost per 64-game iteration,** single-threaded: conversion 44 s, cache 16 s and `vtrace` 13 s; about 0.9 MB on disk.

**Design.** RL-only, matched by parent and by data.
- **Host and code:** the M6 and toolchain of the earlier comparisons. Use a clean clone at the approved commit, which adds a reviewed converter checkpoint (below). The `train-arm` learner is unchanged since `5aff157`. The collector gained only diagnostics (`a8127c1`), and run-time checks verify every regenerated game.
- **Parents:** the twelve BC parents r6–r17, byte-copied from `FR` and checked against `FR/SHA256SUMS`. No new BC training.
- **Data:** `SS`'s A′ rollouts, 24 iterations × 64 games = 1,536 games per parent. Each iteration was collected by that iteration's refreshed A′ policy. The bodies were pruned, so each game is regenerated from `SS`'s recorded iteration model and seed plan and must equal its `SS` header checksum. No new seeds or collection policies are used.
- **Arm T (`train-arm`):** `SS`'s A′ child, which consumed exactly these games in play order with weight 1, in 1,536 updates. It is not retrained. It is re-evaluated with the new code for its diagnostics and must reproduce `SS`'s evaluation game by game.
- **Arm P (production learner):** for each iteration k = 0…23:
  - convert that iteration's 64 games to `edger_training_episode_v1`;
  - build the manifest and the cache with production `edger-dataset.mjs --max-player-fraction 0`, with no base corpus;
  - run production `vtrace --epochs 1 --batch-size 32 --seed 20260926` from P's previous checkpoint. Iteration 0 starts from the BC parent with fresh Adam; later iterations restore the Adam state, as `train-arm` does.
- **Update budget:** whatever the production path takes from identical data, which is one epoch over each iteration's train-split episodes. That is about 1,230 updates instead of 1,536, and this difference is part of what is tested.
- **Exports:** P's final checkpoint and its iteration-5 checkpoint are exported with the cadence `export`, which labels them `diagnostic_only_not_promotable`.
- **Built-in checks** (not part of the estimate):
  - every regenerated body equals its `SS` header checksum (18,432 games);
  - every collecting model equals the SHA-256 in its `SS` collection;
  - the production derivation reproduces every cadence row exactly;
  - each cache's row count equals its iteration's cadence rows;
  - for every parent, the neutralized iteration 0 reproduces `SS`'s A′ iteration-0 weights bit for bit;
  - re-evaluations of the parents and T children equal `SS` game by game.
- **Evaluation:** the parent, T and P are evaluated with the earlier commands and development seeds (200 pairs against live v1, 100 each against the heuristic and aggressive). Each also gets `V/js-eval.mjs` parity, routine diagnostics (`diagnostics`) and held-out Fireball capture.

**Analysis.**
- **Primary statistic:** d_P = P child primary − T child primary, per parent. Report the mean of the 12 values with a two-sided 95% t interval (11 df). The minimum meaningful effect is 0.15.
- **Labels:** the earlier rule.
  - If the interval excludes 0: the direction ("train-arm better" or "production better"), and whether |mean| ≥ 0.15.
  - Otherwise "within ±0.15" if the interval lies inside ±0.15.
  - Otherwise "inconclusive at this size".
- **Secondary, pre-registered:**
  - g_P = P − parent, with a t interval.
  - Shorter-run check: d_P384 = P after iteration 5 − `FR`'s A child. Both paths receive the same first 384 games, because A′ replays A exactly; P retains its train-split filter.
  - Per-opponent d_P, the median and SD of d_P, and every pair.
  - P's update count and sample-weight range per parent.
  - Routine diagnostics for every model (descriptive), and Fireball capture.
- **Sample size and stopping:** n = 12, fixed. The analysis runs once, after all P children are evaluated. Progress checks read only counts, timings, exit codes and stop reasons.
- **Failures:** settings never change, and there is one identical-settings infrastructure retry. Every engineering-invalid outcome is reported.
  - A failed conversion check stops that parent's P arm before any training.
  - A non-finite learner stop is a recipe outcome.
  - A missing or invalid P child blocks "production better" and "within ±0.15".
  - The T children are already valid (12 of 12 parity passes in `SS`).

**What it decides.** Fixed before output.
- **"Train-arm better" (either magnitude):** on identical refreshed data, the production learner path costs play quality. Further attribution steps use the `train-arm` learner. Aligning the production path, or decomposing the three behaviors, becomes a separately designed step.
- **"Within ±0.15" or "production better":** on the 1,536-game refreshed dataset, the production learner path does not account for a play-quality loss of 0.15 in this comparison. The next attribution step is the league opponent mix.
- **"Inconclusive at this size":** reported as such, with no follow-up chosen after seeing it.
- Every label keeps the refresh requirement. No child is a promotion candidate.

**Before freezing (approval recorded above).**
- **Code checkpoint (done November 7):** `convert-collection` in `scripts/edger-v2-cadence-experiment.mjs` implements the prototype, with tests. It regenerates each game, verifies the model and header checksums, writes the production episodes, checks the derivation, and writes the manifest and a conversion report. Its fixed collector label (`edger_v2_cadence_conversion_v1`) differs from the prototype's, so episode IDs and splits differ from the prototype's (`SS` A-r6 iteration 0: 47/7/10 instead of 54/4/6). It still converted 64/64 games with 0 row mismatches. Tests: two new cases in `tests/edger-v2-cadence.test.js`. `PYTHON=/usr/local/bin/python3 npm test`: 244/244.
- **Smoke:** iterations 0–1 of P for one parent in scratch directories, plus the neutralized check, an export and a 2-pair evaluation (done; below).
- **Dry run:** `analyze.py` on synthetic inputs, covering the complete, blocked, incomplete and reproduction-mismatch paths (done; below).
- **Freeze:** hash `plan.md`, `run.sh`, `analyze.py` and the check scripts into `FROZEN.txt` before any output (done; below).

**Cost.** Prototype timings, with conversions and caches running 7-wide and the
twelve learner chains in parallel:
- about 3.5 CPU-hours of conversion, 1.3 of caches and 1.0 of `vtrace`;
- about 1.2 hours of evaluation for 48 models with 7 workers;
- about 2.5 hours in total.

The cap is 5 hours, after which no new step starts. The run is local only and
uses about 0.3 GB.

**Preflight and run.** The run directory is `PR` =
`~/edge_royale-runs/20261107-production-learner.noindex`. It holds a clean
clone `vrepo` at `f09fccf` and the twelve parents byte-copied from `FR`
(`parents-check.sums`, 25/25 with the evaluation seed plan). It also holds the
frozen `plan.md`, which restates this design with exact commands, failure rules
and the analysis, plus `run.sh`, `analyze.py`, and the step scripts
`data_job.py`, `p_arm.py` and `neutral.py`.
- **Smoke** (`PR/smoke/smoke-check.txt`, not evidence), on parent r6, using the frozen step scripts:
  - **Data, iterations 0–1:** passed with 0 row mismatches, and the cache rows (1,890 and 3,819) equalled the conversions.
  - **Neutralized check:** passed bit for bit, with 64/64 gradient norms.
  - **`vtrace` iterations 0–1:** 47 and 50 updates, equal to the train-split episodes, with Adam fresh at iteration 0 and restored at iteration 1.
  - **Real `vtrace` against emulation:** iteration 0 equals production `train_vtrace_episode` over the train split in hash order with cache weights, bit for bit.
  - **Exports and evaluations:** the export and held-out capture ran; a 2-pair evaluation, diagnostics and js-eval parity of the smoke model passed, with 0 illegal attempts.
  - **Re-evaluation:** 2-pair re-evaluations of T and the parent reproduced `SS`'s first two pairs game by game.
  - **Clone:** stayed clean throughout.
- **Iteration-1 balancing weights:** sample weights reached 7.83, so the 0.35–3.24 range above describes iteration 0 only.
- **Dry run** (`PR/dryrun/`): synthetic inputs from `SS` and `FR` files covered the complete, blocked, missing-child, within, incomplete and reproduction-mismatch paths. With `SS`'s B′ children standing in for P, it reproduced `SS`'s published d′ −0.259 [−0.405, −0.113] and g′ −0.014 [−0.188, +0.160].
- **Freeze and launch:** `SS` (38,908) and `FR` (10,217) `SHA256SUMS` passed in full. `FROZEN.txt` (36 hashes, including the parents, the evaluation seed plan, `js-eval.mjs`, the held-out cache and both runs' `SHA256SUMS`) was written at 2026-11-06T14:44:17Z, before any comparison output. `nohup caffeinate -is bash run.sh > runner.out 2>&1` started at 14:44:22Z.
- **Shared host:** an unrelated `gridcast` process used about 2.5 cores during the run, so wall times are not cost evidence.
- **Run:** one launch from 14:44:22Z to 18:24:42Z UTC (3 h 40 min; data 79 min, learners 57 min, evaluation 84 min). Every step succeeded on the first attempt: 288 data steps, 12 P arms, 144 evaluations, 48 parity and 48 diagnostics runs. There were no nonzero exits and the cap was not reached. One parent's caches (r15, 387,595 rows) made its chain the slowest.
- **Analysis and archive:** `FROZEN.txt` re-verified 36/36, then `/usr/local/bin/python3 -I analyze.py > analysis.md` ran once. `PR/SHA256SUMS` covers 22,257 files (846 MB, mostly per-iteration checkpoints and caches). Afterwards `SS` (38,908) and `FR` (10,217) `SHA256SUMS` still passed.

**Results** (`PR/analysis.md`; primary = equal-weighted mean points against v1, the heuristic and aggressive).
- **Primary, frozen label "train-arm better (|mean| < 0.15)":** d_P = P − T = **−0.098 [−0.159, −0.036]** (12 pairs, 11 df). P was below T in 10 of 12 pairs, and every opponent's interval excludes 0: v1 −0.117, heuristic −0.112, aggressive −0.063. The d_P SD was 0.096 [0.068, 0.163], with median −0.096 and range −0.280 to +0.046. No child was invalid; every P and T child passed parity.
- **Pre-set decision:** on identical refreshed data, the production learner path costs play quality. Further attribution steps use the `train-arm` learner. Aligning the production path, or decomposing its three behaviors, becomes a separately designed step. The refresh requirement stands; no child is a promotion candidate. The magnitude label concerns the observed mean; the interval does not exclude a cost of 0.15.
- **Secondary:**
  - **Gain over the parent:** g_P = P − parent was +0.147 [+0.079, +0.216] (positive in 11 of 12), against T's re-evaluated +0.245 [+0.204, +0.285]. The production path kept about 60% of the `train-arm` gain.
  - **Shorter-run check:** d_P384 = P after iteration 5 − `FR`'s A child was −0.088 [−0.165, −0.011], so the cost was already present after the first 384 games.
  - **Child scores:** mean P 0.722 (SD 0.097) against T 0.820 (SD 0.028), and P5 0.666 against `FR` A 0.754. P's spread is about 3.5 times T's.
  - **Update counts:** P made 1,209–1,240 updates (mean 1,227) against T's 1,536.
  - **Balancing weights:** these are recomputed for each 64-game cache, and their per-parent maxima ran from 8.2 to 29.6 (iteration 0's 0.35–3.24 was not typical).
  - **Fireball:** held-out capture was 0 for nearly every model, parents included. Mean P(Fireball) was lower for P than T in 9 of 12 pairs; this is descriptive only.
- **Routine diagnostics (descriptive):**
  - **Collapsed children:** three P children (r14, r16, r17) collapsed to the pattern seen in `SS`'s stale children. They chose the 1-tick minimum at 98–100% of decisions and played 2,476–4,235 decisions per game, with PASS at 0.985–0.990. Two of them also had maximum legal logits of 114 and 129.
  - **Other children:** a fourth (r10) made 983 decisions per game without minimum delays. No T child exceeded a 1-tick fraction of 0.003 or a logit of 39.7.
- **Reproduction checks (all passed; not part of the estimate):**
  - **Data:** 18,432/18,432 games were regenerated with bodies equal to `SS`'s headers and collecting models equal to `SS`'s recorded SHA-256. There were 0 row differences, every cache's rows equalled its cadence rows, and 0 `SS` input files differed from `SS/SHA256SUMS`.
  - **Neutralized iteration 0:** bit-identical for 12/12 parents, with 64/64 gradient norms each.
  - **Re-evaluations:** the parents and T reproduced `SS` game by game for 24/24 models.
- **Post hoc** (`PR/posthoc.py`, `posthoc.md`, written after the analysis; no label changes):
  - The collapsed children do not account for the mean cost: the other nine average d_P −0.099. The cost is broad, not driven by a few failures.
  - Collapse does not map onto score: r14 collapsed with d_P −0.019, while r12 (−0.280) and r8 (−0.224) did not collapse.
  - Validation logits crossed `vtrace`'s 83.9 warning only in r14 (from iteration 14) and r17 (iteration 22).
  - Which production behavior (split filter, hash order or balancing weights) causes the cost was not separable here, because the three were tested together by design. The fourth comparison (below) tested them separately; attribution is unresolved. The resemblance to `SS`'s stale collapse and the large rare-stratum weights are hypotheses, not mechanisms.

### Fourth comparison: factorial decomposition of the production learner

**Status: proposed November 8, 2026; approved November 9 with revised outcome
rules, clarified the same day; frozen, run and analysed November 9 (results
below); owner decisions November 10.** On
November 8 the owner chose option (a) of the next-step decision: decompose the
production path's three behaviors on the same fixed refreshed data, and defer
the league opponent mix (task 4) until after this ablation. The owner asked to
keep `train-arm` as the reference and full production as the comparison. If the
run budget permits, the design should be a paired 2³ factorial that separates
the three behaviors' effects from their interactions. The estimated cost below
(about 4.7 local hours) is in line with the earlier comparisons, so this design
is the full factorial. Its outcome branches are fixed here, before any output.

**Owner decisions, November 9, 2026.** All three proposed choices are
approved. The outcome rules are revised before freezing.

1. **Full 2³ factorial, with both corners checked through iteration 23:** all eight cells on all 12 parents (about 4.7 h, cap 8 h).
   - The three cells that each drop one behavior from P show what removing it from production does. The full factorial also shows whether a behavior's effect differs at the other factors' levels.
   - Checking the corners only through iteration 5 would save about 36 minutes, which is small against the 8-hour cap. Full checks verify that the runner reproduces the checkpoints behind the reused T and P scores.
   - Training only the three drop-one cells was rejected, because it cannot separate interactions.
2. **Minimum meaningful effect 0.05,** instead of the rule's default 0.15. It is the threshold for judging practical size, not direction.
   - 0.05 is about half the measured d_P (−0.098). At 0.15, every behavior would probably fall below the threshold, whether it carries all of the cost or none.
   - The quoted 91% power is to exclude 0 when the true effect is 0.05, under the equal-variance planning model. At the SD's upper bound it is about 49% (sizing below).
   - To establish a cost of at least 0.05, the interval's upper endpoint must be below −0.05. An observed mean beyond −0.05 is not enough.
3. **Pointwise labels guide attribution.** Labels come from unadjusted 95% intervals, as in the earlier comparisons. Bonferroni-adjusted intervals over the seven effects are reported beside them, so readers can tell an individual signal from a conclusion supported across the set.
   - Pointwise labels fit this step. It reuses the parents and data that revealed the gap, and every branch keeps `train-arm` for the league opponent comparison.
   - Labelling from the adjusted intervals would lower the power to exclude 0 at a true 0.05 from about 0.91 to 0.63 at the measured spread (0.49 to 0.18 at the upper bound).
   - Any proposed production change is a separate decision, based on the relevant recipe comparison.
4. **Direction, practical size and recipe choice are separate** (labels and decisions below).
   - The proposed rules required a production change for any cost whose interval excluded 0. An estimate of −0.02 [−0.03, −0.01] would have triggered that, although the whole interval lies inside ±0.05.
   - A small average effect can also hide a substantial effect at the production corner. Concrete recipe changes are therefore assessed from pre-specified corner contrasts, even when the interaction intervals include 0.
5. **Clarifications, also November 9,** before the design commit:
   - attribution statements describe the average effect only, and the drop-one contrast answers what happens at the production corner;
   - a missing required score makes every contrast that uses it incomplete, with no labels;
   - the smoke and the synthetic dry run are the go/no-go for freeze and launch.
   - The owner accepted that the corner contrasts may be inconclusive: the seven factorial effects still answer the attribution question that justifies the run.

**Question.** On the third comparison's fixed refreshed data, how much of the
production path's cost does each of its three behaviors cause, and do they
interact?

**Factors.** Each has two levels: 0 is `train-arm`'s and 1 is production's.
Everything else is as in the third comparison.
- **S, split filter.** 0 trains on all 64 episodes of each iteration. 1 trains only on the train split, as `vtrace` does: about 80%, or 1,209–1,240 updates instead of 1,536.
- **O, episode order.** 0 uses play order (the conversion report's match index), as `train-arm` does. 1 uses episode-ID order, as the production manifest and cache do.
- **W, balancing weights.** 0 weights every row 1. 1 applies the cache's `sample_weight` to the policy loss.
  - The value loss is unweighted at both levels.
  - Each cache's weights average exactly 1 over all its rows, all splits included, but not over the train split alone (0.83 in r6's iteration 10).
- **Cells** are written in S O W order. `000` is T (`SS`'s A′ child), and `111` is P (`PR`'s P child). The six new cells are `100`, `010`, `001`, `110`, `101` and `011`.

**Feasibility.** A prototype ran on November 8 in `PF0` =
`~/edge_royale-runs/20261108-production-factorial-prototype.noindex/`. It is not
evidence: no intermediate cell was trained and no checkpoint was kept.
- **Runner.** A run-directory script calls production `train_vtrace_episode` from `PR`'s clean clone at `f09fccf`, one episode at a time, with the three behaviors as switches.
  - Like `run_vtrace`, each iteration reseeds, restores Adam from the previous checkpoint with the learning rate reset, and writes a checkpoint.
  - It reads each cache in 256-row groups, as production does.
- **Both corners reproduce exactly** for parent r6, iterations 0–2:
  - `111` equalled `PR`'s P checkpoints bit for bit (weights and Adam state), with the same update counts.
  - `000` equalled `SS`'s A′ checkpoints bit for bit, and all 64 per-update gradient norms of each iteration matched.
- **Largest cache** (r15 iteration 11, 33,712 rows): starting from P's iteration-10 checkpoint, `111` reproduced P's iteration 11 bit for bit. A rerun of real `vtrace` did too.
- **Cost of that iteration** (one process each, lightly loaded host): the runner took 109 s, with a 1.7 GB peak; real `vtrace` took 206 s and 2.1 GB. The same step took 402 s in `PR`'s run, alongside 11 other chains and an unrelated process.

**Design.** RL-only, matched by parent and by data.
- **Host and code:** the M6 and toolchain of the earlier comparisons.
  - Use a clean clone at the approved design commit, whose `src/`, `scripts/`, `tests/` and `package.json` equal `f09fccf`'s.
  - There are no repository code changes. The runner (`cell.py`) and the checks are frozen run-directory scripts, like `PR`'s `neutral.py`.
- **Parents:** the twelve BC parents r6–r17, byte-copied from `FR` and checked against `FR/SHA256SUMS`.
- **Data:** `PR`'s 288 caches and conversion reports (24 iterations × 12 parents, 1,536 games per parent).
  - They are read in place and verified against `PR/SHA256SUMS` before launch and after the analysis.
  - No game is regenerated or collected.
- **Chains:** 8 cells × 12 parents = 96 chains of 24 iterations, with `PR`'s settings: seed 20260926, learning rate 1e-3, 32-row microbatches, value-loss weight 0.5, entropy bonus 0.001 and gradient clip 1.0. Iteration 0 starts from the BC parent with fresh Adam.
- **Corner check (the instrument):** after every iteration, 0 through 23, `000` must equal `SS`'s A′ checkpoint (weights, Adam state and per-update gradient norms), and `111` must equal `PR`'s P checkpoint (weights and Adam state).
  - A mismatch stops new steps. The analysis then reports an instrument failure and issues no labels.
  - If all 24 final corner checkpoints are identical, the corner children are T and P themselves. `PR`'s evaluations of T, P and the parents are then reused after a checksum check, not rerun.
- **New children:** each of the 72 final checkpoints is:
  - exported with the cadence `export` (`diagnostic_only_not_promotable`) and given held-out Fireball capture;
  - evaluated with `PR`'s commands and development seeds: 200 pairs against live v1, and 100 each against the heuristic and aggressive;
  - checked with `V/js-eval.mjs` parity and routine diagnostics.

**Analysis.**
- **Score:** each child's primary, as before: the equal-weighted mean points against v1, the heuristic and aggressive.
- **Primary: the seven factorial effects.** Per parent, each effect is ¼ Σ ±y over the eight cells, with the standard 2³ signs and the production level as +.
  - A main effect, such as S's, is the mean of the four cells with S at production minus the mean of the four at `train-arm`.
  - A two-factor interaction, such as SW, is half the difference between W's effect with S at production and with S at `train-arm`, averaged over O. A negative SW means that each behavior's production level costs more, or helps less, when the other is also at production. The three-factor SOW follows the same pattern.
  - Each effect is reported as its mean over the 12 parents, with a two-sided 95% t interval (11 df).
- **Primary: six corner contrasts,** for recipe choice. Each is a per-parent difference of two cells, reported as its mean with a two-sided 95% t interval (11 df).
  - Dropping one behavior from P: `111` − `011` (S), `111` − `101` (O) and `111` − `110` (W).
  - Adding one behavior to T: `100` − `000` (S), `010` − `000` (O) and `001` − `000` (W).
  - As for the effects, each is the production level minus the `train-arm` level, so a negative value means the production level scores lower.
- **P − T as a built-in check:** per parent, d_P = E_S + E_O + E_W + E_SOW exactly, because the two-factor interactions cancel between the corners. This is an identity, not a separate test; the analysis checks it against `PR`'s frozen d_P values.
- **Labels.** Each of the seven effects and six corner contrasts gets a direction label and a size label from its unadjusted 95% interval (decision 3). The minimum meaningful effect is 0.05 (decision 2).
  - **Direction,** from the interval against 0:
    - for main effects and corner contrasts, "production level better" (interval above 0), "train-arm level better" (below 0) or "direction unresolved" (interval contains 0);
    - for interactions, "positive interaction", "negative interaction" or "direction unresolved".
  - **Size,** from the interval against ±0.05:
    - "at least 0.05" if the lower endpoint is above +0.05 or the upper endpoint is below −0.05;
    - "below 0.05" if both endpoints lie strictly between −0.05 and +0.05;
    - "size unresolved" otherwise.
  - The observed mean is reported as the estimate. It does not set a size label on its own.
  - For example, −0.02 [−0.03, −0.01] is "train-arm level better, below 0.05". −0.08 [−0.12, −0.04] is "train-arm level better, size unresolved".
  - **Across the set:** each factorial effect's two labels are also computed from its Bonferroni-adjusted simultaneous interval over the seven effects (t = 3.295). Each label is reported as "holds across the set" or "individual signal only". The corner contrasts are not adjusted.
- **Secondary, pre-registered:**
  - Every parent's eight scores; each cell's mean, SD, median and range; per-opponent effects; each cell's gain over the parent.
  - Update counts and sample-weight ranges per cell.
  - Routine diagnostics per child (descriptive). These include the number of children per cell whose pooled 1-tick fraction is at least 0.9. That threshold separates `PR`'s three collapsed P children (0.98–1.00) from every T child (at most 0.003); it was chosen after seeing `PR` and is descriptive only.
  - Held-out Fireball capture.
- **Sample size and stopping:**
  - n = 12 parents, fixed by the data.
  - The analysis runs once, after every new child is evaluated or after the cap stops the run.
  - Progress checks read only counts, timings, exit codes, stop reasons and corner-check results.
- **Failures:** settings never change. A failed step gets one identical retry, resuming from its last completed iteration, which is bit-identical by construction.
  - A non-finite learner stop is a recipe outcome. The final model is then the last good checkpoint, or the parent if there is none.
  - Every engineering-invalid outcome is reported: illegal attempts, a nondeterministic evaluation or a parity failure.
  - Such a child blocks the "below 0.05" label of every contrast that uses its cell (every factorial effect uses all eight cells). It also blocks any direction or "at least 0.05" label whose higher-scoring side includes its cell.
  - **Missing scores:** a required score is the primary score of one cell for one parent: the 72 new children's evaluations and the 24 reused corner scores.
    - If any required score is absent after the retry or the cap, every contrast that uses that cell is marked "incomplete" and gets no labels. Every factorial effect uses all eight cells, so a single missing score makes all seven effects incomplete.
    - The planned analysis is the 12-parent one. Partial results over the parents with complete scores may be reported only in a separate section, marked partial, with means and ranges but no intervals or labels.

**Sizing** (planning model, not a power guarantee).
- `PR`'s d_P is a difference of two cells, with SD 0.096 [0.068, 0.163].
- If each cell's deviation within a parent were independent, with equal variance, a factorial effect's SD would be half that: 0.048 [0.034, 0.082].
- At 12 parents, using the noncentral t with two-sided α = 0.05, this gives:

| Contrast | Interval half-width | 80% power to exclude 0 at | Power to exclude 0 at a true 0.05 | Power for "at least 0.05" at a true 0.098 | Chance of "below 0.05" at a true 0 |
|---|---|---|---|---|---|
| Factorial effect, unadjusted | 0.030 (0.052) | 0.043 (0.072) | 0.91 (0.49) | 0.88 (0.46) | 0.81 (0.13) |
| Factorial effect, Bonferroni over 7 | 0.046 (0.078) | 0.059 (0.100) | 0.63 (0.18) | 0.58 (0.17) | 0.35 (0.01) |
| Corner contrast, unadjusted | 0.061 (0.104) | 0.085 (0.145) | 0.38 (0.16) | 0.35 (0.15) | 0.04 (0.00) |

Values in parentheses use the SD's upper bound. A true 0.098 is a behavior that
carries all of d_P. The last column was simulated (400,000 draws per cell); the
others use the noncentral t.
- The equal-variance assumption is optimistic. P's children varied more than T's (SD 0.097 against 0.028), and any parent-by-behavior interaction adds spread.
- The corner contrasts are much less precise than the factorial effects. At the measured spread their interval is wider than ±0.05, so "below 0.05" is out of reach unless their observed spread is smaller. A drop-one contrast that carries all of d_P would exclude 0 with power about 0.90 (0.48 at the upper bound).
- The intervals themselves use each contrast's own observed spread, so they do not depend on this model.

**Cost** (estimate).
- **Learners:** `PR`'s twelve P chains took 390 chain-minutes under load.
  - Scale that by the runner's measured speed (about 0.53 of real `vtrace`), and by 1.25 for chains that train on every split.
  - The 96 chains then need about 31 chain-hours: about 2.6 hours on 12 parallel slots.
- **Evaluation:** evaluation, parity, diagnostics and held-out capture for the 72 new children, scaled from `PR`, take about 2.1 hours.
- **Total:** about 4.7 hours. The cap is 8 hours, after which no new step starts.
- **Storage:** local only, about 1.3 GB, mostly per-iteration checkpoints; 76 GiB is free.

**What it decides.** Fixed before output. The comparison attributes the cost;
it does not choose a recipe.
- **Attribution, from each behavior's main effect.** Each statement concerns the average effect over the other two behaviors' levels on this data. What happens at the production corner is answered by the drop-one contrast (below).
  - "Train-arm level better, at least 0.05": the average effect is a cost of at least 0.05.
  - "Train-arm level better, size unresolved": the average effect is a cost; whether it reaches 0.05 is unresolved at this size.
  - "Train-arm level better, below 0.05": the average effect is a cost within ±0.05.
  - "Production level better", at any size: the average effect is favorable.
  - "Direction unresolved, below 0.05": the average effect is within ±0.05.
  - "Direction unresolved, size unresolved": inconclusive at this size. It is reported as such, with no follow-up chosen after seeing it.
- **Interactions:** an interaction with a resolved direction means that the behaviors involved are attributed jointly, from the corner contrasts and cell means, not from their main effects alone. An unresolved interaction is not evidence that the behaviors are additive.
- **Production corner:** each drop-one contrast is reported with its labels, whatever the interaction labels say, because a small average effect can hide a substantial effect at the production corner. When a behavior's main effect and its drop-one contrast are labelled differently, both are reported. The drop-one contrast describes what removing that behavior from production did on this data.
- **Recipe choice is outside this comparison:** no outcome changes the production learner by itself.
  - Any proposed production change is a separate owner decision, based on the relevant recipe comparison. Removing one behavior from production rests on its drop-one contrast; adding one to `train-arm` rests on its add-one contrast.
  - Any replacement, such as capped weights, needs its own tested design.
  - If S were removed, the purpose of the held-out splits (validation and the test bank) would have to be met another way, again by a separate design.
- **Across the set:** the report states which factorial-effect labels hold under the Bonferroni intervals. A label that holds only pointwise is described as an individual signal.
- **Every outcome:**
  - Further attribution keeps the `train-arm` learner, and the league opponent mix (task 4) follows this comparison.
  - The refresh requirement stands, and no child is a promotion candidate.

**Limits** (known before output).
- There is one dataset per parent, at one scale (1,536 games). Base-corpus mixes, league data and longer runs are untested.
- The learner draws no random numbers, so each cell is a deterministic function of its parent and data. The parent is the replicate; a cell has no spread of its own.
- The corners are already known, and the identity reproduces d_P from them. The new information is how d_P divides among the behaviors. These are the parents and data whose cost prompted this step, so the effects' sum inherits any selection in d_P.
- S drops a hash-selected fifth of each iteration's games. It does not separate "fewer updates" from "which games are dropped".
- W tests the production weights only. Their size depends on the stratum counts of each 64-game cache.
- Thirteen contrasts get pointwise labels. If the seven effects were independent and none were real, at least one spurious direction label among them would have about a 30% chance; the six corner contrasts add more. The Bonferroni intervals cover the seven effects only.
- The corner contrasts are imprecise (half-width about 0.061 at the measured spread), so many may stay "size unresolved".

**Before freezing.**
1. Commit the approved design as a docs-only checkpoint.
2. Set up the run directory `PF`, with a clean clone and the parent copies.
3. Smoke: run all eight cells for iterations 0–1 on parent r6, with the corner checks.
   - No intermediate cell is evaluated.
   - One corner export gets a 2-pair evaluation.
4. Dry-run `analyze.py` on synthetic inputs. Cover:
   - the complete, blocked, missing-score (incomplete), instrument-failure and identity-mismatch paths;
   - every direction and size label state, and the across-the-set labels;
   - a drop-one contrast labelled differently from its main effect.
5. **Go/no-go for freeze and launch.** All of the following are required; any failure stops before the freeze.
   - Both smoke corners match bit for bit at iterations 0–1.
   - The corner export's evaluation passes: deterministic, with zero illegal attempts, and passing parity.
   - The dry run gives the expected labels and failure handling on every synthetic path.
6. Hash `plan.md`, `run.sh`, `analyze.py`, `cell.py`, the check scripts, the parents and `PR/SHA256SUMS` into `FROZEN.txt` before any output.
7. Launch.

**Preflight, freeze and launch (November 9, 2026).** The run directory is `PF` =
`~/edge_royale-runs/20261109-production-factorial.noindex`, with a clean clone
at `a03fd12` and parents copied from `FR` (25/25 against `FR/SHA256SUMS`).
- **Smoke** (`PF/smoke/smoke-check.txt`, not evidence):
  - All eight cells ran on r6 for iterations 0–1. Intermediate cells trained only; none was exported or evaluated.
  - Both corners matched bit for bit at both iterations: weights, Adam state and every gradient norm for `000`; weights, Adam state, update counts and gradient-norm extremes for `111`.
  - The `111` export passed a 2-pair evaluation against each opponent (deterministic, zero illegal attempts), diagnostics and parity (worst ratio 0.191). Its aggressive games equal `PR`'s smoke P model's, game by game.
  - Resuming in a new process reproduced the iteration-1 checkpoint byte for byte, and a present `INSTRUMENT_FAILURE` file stopped a chain before training.
  - Peak memory was 0.85–0.99 GB per chain.
  - The first attempt found two runner bugs, both fixed before the passing smoke: a relative `--root` broke the export path, and the runner's checkpoints lacked the `checkpoint_id` that `export` needs. Neither bug touched model or Adam state.
- **Dry run** (`PF/dryrun/check.txt`, not evidence): `analyze.py` was compared with an independent recomputation that uses the textbook effect definitions. It ran on nine synthetic scenarios built around `PR`'s real corner evaluations, and all nine passed:
  - three complete scenarios, plus blocked, missing-score, capped, instrument-failure, identity-mismatch and not-finished;
  - all eight direction-and-size states, all three interaction directions and both across-the-set outcomes;
  - blocking, incomplete contrasts with partial results, a non-finite learner stop and a drop-one contrast labelled differently from its main effect.
- **Go/no-go:** every criterion held. Before the freeze, `shasum -a 256 -c SHA256SUMS` passed in `PR` (22,257/22,257), `SS` (38,908/38,908) and `FR` (10,217/10,217).
- **Freeze and launch:** `FROZEN.txt` was written at 2026-11-09T03:03:14Z UTC and holds 41 hashes, covering the plan, the runner, the analysis, the preflight scripts, the parents and the three runs' `SHA256SUMS`. `nohup caffeinate -is bash run.sh > runner.out 2>&1` started at 03:03:22Z.
- **Run:** one launch, from 03:03:22Z to 08:20:00Z UTC (5 h 17 min; learners 2 h 46 min, evaluation 2 h 31 min).
  - All 96 chains completed 24 iterations on the first pass, with no non-finite stop.
  - All 216 evaluations, 72 parity runs and 72 diagnostics runs succeeded on the first attempt. There were no nonzero exits, the cap was not reached, and the clone stayed clean.
- **Instrument:** all 576 corner iterations (24 chains × 24) matched bit for bit.
  - `000` matched `SS`'s A′ in weights, Adam state, every gradient norm and the update count.
  - `111` matched `PR`'s P in weights, Adam state, the update count and the gradient-norm extremes.
  - `PR`'s T, P and parent evaluations were therefore reused.
- **Analysis and archive:**
  - `FROZEN.txt` re-verified 41/41, then `/usr/local/bin/python3 -I analyze.py --json analysis.json > analysis.md` ran once.
  - Afterwards, `SHA256SUMS` still passed in `PR` (22,257), `SS` (38,908) and `FR` (10,217); the logs are in `PF/postcheck/`.
  - `PF/SHA256SUMS` covers 8,741 files: every file except `vrepo/.git` (2.3 GB, mostly per-iteration checkpoints and the dry run's synthetic copies).

**Results** (`PF/analysis.md`; the primary score is the equal-weighted mean
points against v1, the heuristic and aggressive; 12 parents, 11 df). All 96
required scores were present, and all 13 contrasts were labelled.

- **Engineering-invalid children:** five new children failed parity, so the pre-set rule marks them engineering-invalid. They keep their scores and block labels as specified.
  - The five are `c011-r8`, `c110-r9`, `c010-r13`, `c110-r13` and `c010-r15`. Their worst tolerance ratios were 1.144–1.250 against the approved contract, max(1e-5, 4 float32 ULP).
  - The largest logit differences were 3.1e-5–6.1e-5, at legal-logit magnitudes of 173–376. Tie sets agreed and no margin was fragile on any fixture.
  - All five look collapsed in the diagnostics: PASS on 0.975–0.990 of decisions, 1,181–4,297 decisions per game and maximum legal logits of 189–399. All are in cells with O at production.
  - No other engineering check failed for any child.
- **Primary: the seven factorial effects** (production level minus `train-arm` level). Blocked labels show the label they replaced. The across-the-set column is "—" wherever the pointwise label is unresolved or blocked.

| Effect | Mean [95% t] | Direction | Size | Bonferroni interval (t = 3.295) | Across the set |
|---|---|---|---|---|---|
| S | +0.015 [−0.028, +0.059] | direction unresolved | size unresolved | [−0.050, +0.081] | — |
| O | −0.028 [−0.063, +0.006] | direction unresolved | size unresolved | [−0.080, +0.024] | — |
| W | −0.037 [−0.080, +0.006] | direction unresolved | size unresolved | [−0.102, +0.027] | — |
| SO | +0.019 [−0.023, +0.060] | direction unresolved | size unresolved | [−0.044, +0.081] | — |
| SW | +0.005 [−0.032, +0.041] | direction unresolved | blocked (was "below 0.05"): invalid children in `010`, `110`, `011` | [−0.050, +0.060] | — |
| OW | +0.014 [−0.008, +0.036] | direction unresolved | blocked (was "below 0.05"): invalid children in `010`, `110`, `011` | [−0.018, +0.046] | — |
| SOW | −0.047 [−0.077, −0.017] | blocked (was "negative interaction"): invalid children in `110` and `011`, on the higher-scoring side | size unresolved | [−0.092, −0.002] | — |

- **Primary: corner contrasts** (unadjusted). None of these labels was blocked. No resolved label had an invalid child on its higher-scoring side, and no contrast was "below 0.05".

| Contrast | Mean [95% t] | Direction | Size |
|---|---|---|---|
| drop S from P (`111` − `011`) | −0.009 [−0.112, +0.095] | direction unresolved | size unresolved |
| drop O from P (`111` − `101`) | −0.043 [−0.085, −0.001] | train-arm level better | size unresolved |
| drop W from P (`111` − `110`) | −0.066 [−0.137, +0.006] | direction unresolved | size unresolved |
| add S to T (`100` − `000`) | −0.055 [−0.104, −0.006] | train-arm level better | size unresolved |
| add O to T (`010` − `000`) | −0.108 [−0.175, −0.042] | train-arm level better | size unresolved |
| add W to T (`001` − `000`) | −0.103 [−0.157, −0.050] | train-arm level better | size unresolved (upper endpoint −0.0497) |

- **Pre-set decisions:**
  - **Attribution (average effects):** S, O and W are each "direction unresolved, size unresolved", which is inconclusive at this size. No follow-up is chosen after seeing it.
  - **Interactions:** no interaction has a direction label. SO, SW and OW are unresolved, and SOW's label is blocked, so the joint-attribution rule does not apply. The unresolved and blocked interactions are not evidence that the behaviors are additive.
  - **Production corner:** dropping O from P is "train-arm level better, size unresolved". On this data, P with play order (`101`) scored 0.043 [0.001, 0.085] higher than P with episode-ID order. Dropping S or W was inconclusive.
  - **Listed disagreement:** O's main effect is "direction unresolved", while its drop-one contrast is "train-arm level better".
  - **Recipe choice** is outside this comparison. Removing O from production would rest on the drop-O contrast and is a separate owner decision. No production learner change follows from this result by itself.
  - **Across the set:** no factorial-effect label holds across the set. Every unblocked label is unresolved, so there is nothing to qualify. SOW's Bonferroni interval excludes 0, but its direction label is blocked.
  - **Every outcome:** further attribution keeps the `train-arm` learner, and the league opponent mix (task 4) follows. The refresh requirement stands, and no child is a promotion candidate.
- **Secondary:**
  - **Cell means (SD):**

    | Cell | `000` (T) | `100` | `010` | `110` | `001` | `101` | `011` | `111` (P) |
    |---|---|---|---|---|---|---|---|---|
    | Mean | 0.820 | 0.765 | 0.712 | 0.788 | 0.717 | 0.766 | 0.731 | 0.722 |
    | SD | 0.028 | 0.077 | 0.114 | 0.065 | 0.091 | 0.067 | 0.119 | 0.097 |

    Every cell gained over its parent, by +0.137 to +0.245, with every interval above 0. Every new cell's SD was 2.3–4.3 times T's.
  - **Per-opponent effects (descriptive):** SOW's interval excluded 0 against every opponent, and W's against v1 (−0.054 [−0.102, −0.006]). Every other per-opponent interval included 0.
  - **Updates and weights:** cells with S at production made 1,209–1,240 updates per parent (mean 1,227), and the others 1,536. Cells with W at production had sample weights of 0.32–29.63.
  - **Children with a pooled 1-tick fraction of at least 0.9:**
    - `010`: two (r9, r15);
    - `110`: two (r9, r15);
    - `111`: three (r14, r16, r17), the same children as in `PR`;
    - every other cell: none.
  - **Fireball:** held-out capture was 0 for every model except two r17 children, `c010` (0.069) and `c110` (0.010), and the r13 and r17 parents (0.010 each).
- **Reproduction checks (all passed; not part of the estimate):**
  - 2,304/2,304 iterations trained on caches that matched `PR/SHA256SUMS`.
  - The identity E_S + E_O + E_W + E_SOW = P − T held exactly for 12/12 parents, and P − T matched `PR`'s frozen d_P within 0.0005 for 12/12.
- **Post hoc, descriptive** (written after the analysis; no label changes):
  - O and W added alone to T each cost about as much as all three together: −0.108 and −0.103, against P − T −0.098. S added alone cost −0.055.
  - Every two-behavior cell scored at least as high as each one-behavior cell inside it: `110` 0.788, `101` 0.766 and `011` 0.731, against `100` 0.765, `010` 0.712 and `001` 0.717.
  - These cell means suggest a hypothesis: the costs overlap rather than add. No label supports it, because the only interaction that would have had a resolved direction (SOW) is blocked. Which behavior causes the cost was tested; attribution is unresolved.
  - The five parity failures sit in the collapsed tail: they exceed the 4-ULP contract at logit magnitudes above 170, with tie sets agreeing. Whether the parity contract should cover such magnitudes differently was an owner question (decided November 10, below); it changes no label here.

**Owner decisions, November 10, 2026.** No label changes.

1. **League opponent mix: design work approved.** It is the next comparison under the frozen rule ("Every outcome", above).
   - Keep the `train-arm` learner, refreshed rollouts, matched parents and seeds, equal updates and the same evaluation. Vary only the training opponent mix.
   - The owner reviews the design before authorizing the run.
2. **Episode order: deferred.** Restoring play order at the production corner gained +0.043 [0.001, 0.085] (drop O from P, with the sign reversed).
   - That resolves direction under the frozen pointwise rule, while leaving practical size unresolved. No production learner change follows now.
   - If a future campaign needs the production learner, run a separate paired comparison on fresh parents and rollouts, holding the split filter and weights fixed.
3. **Parity: keep the 4-ULP rule,** max(1e-5, 4 float32 ULP).
   - The tolerance already scales with logit magnitude.
   - All five failures came from near-always-PASS policies (PASS on at least 0.975 of decisions), and move agreement (identical legal tie sets) held on every checked fixture, 53–54 per child.
   - The reference-host re-measurement of k, already required before a campaign relies on it, assesses the rule for future campaigns.
   - The three frozen labels stay blocked: SW's and OW's "below 0.05" and SOW's "negative interaction".
4. **Record:** the preflight, launch, results and these decisions are committed as one docs-only results commit.

**Owner decision, later on November 10, 2026: reward work first.** The training reward gets a position-aware version before any more learner comparisons ([reward design](EDGER_REWARD.md)).
- The league opponent mix design (decision 1) is **parked** until the reward comparison is done. It will then run under whichever reward that comparison favors.
- The reward v2 comparison follows the same frozen rule. The owner reviews its design before any run.

### Fifth comparison: reward v2 against v1

**Status: proposed November 11, 2026, and approved by the owner the same day
with revisions (below). The code checkpoint is `7101186`. The run was frozen,
run and analyzed the same day in `~/edge_royale-runs/20261111-reward-v2.noindex`
([results](#fifth-comparison-reward-v2-against-v1), at the end of this
section): direction unresolved, so v1 is kept.** This is the
comparison the reward work leads to
([remaining steps](EDGER_REWARD.md#remaining-steps-before-v2-trains)). The
outcome branches are fixed here, before any output. The league opponent mix
stays parked until this comparison is done.

**Question.** With the `train-arm` learner and refreshed rollouts, does
training on the frozen reward v2 give better children than v1, at equal games,
seeds, opponents and updates? Children are judged on match results only, as
always. The comparison does not test the production learner, league opponents
or the historical scale.

**Owner decisions, November 11, 2026.** All four proposed choices are
approved. The smoke and the rule for carrying v2 forward are tightened, and two
corrections are made before the design commit.

1. **Warm-up: the critic head only, on 256 parent games, one update per game.**
   - Only the value head and its opponent-stratum embedding learn. The shared trunk and every actor head stay bit for bit the parent's. Both arms then start RL from the same actor and differ only in their critic, and A1 against `SS`'s A′ is a clean check of the v1 warm-up.
   - Both arms need the warm-up. BC fitted the parent's critic to v1 returns of teacher games, not to the parent's own games under either reward.
   - Games: pairs 0–127 of new warm-up seed plans `w6`–`w17` (below), played by the parent. Settings: learning rate 1e-3 with its own Adam, value-loss weight 0.5, torch seed 20260926. The RL phase then starts with fresh Adam, as it does from a BC parent.
   - The size is a planning choice, not tuned on comparison output: 256 single-episode updates equal four refreshed iterations.
   - **Revision:** the smoke scores the parent's critic and the warmed critics on the same held-out parent games, each against its own reward's returns. The smoke's first RL batch is played by the parent and serves as that holdout. The read-only critic diagnostic reports residual variance alongside mean squared error, to separate reduced variance from corrected bias.
   - Rejected alternative: the existing `critic_only` mode, where value gradients also move the shared trunk, so the actor would change during the warm-up, differently in each arm.
2. **Minimum meaningful effect 0.05, with the factorial's two labels** (direction judged against 0, size against ±0.05), instead of the rule's default 0.15 with one label.
   - The interval can resolve a direction while leaving practical size uncertain.
   - `SS`'s A′ children averaged 0.820, so a gain of 0.15 would put children near 0.97.
   - At the closest measured spread (0.096), power to resolve the direction of a true 0.05 gain is only 0.38 (sizing below). An inconclusive result is a plausible outcome.
3. **Evaluations after iteration 5** (384 updates), about 40 minutes more, because faster learning is a plausible benefit of shaping. They are secondary: the 1,536-update result decides the reward.
4. **"Direction unresolved" keeps v1 for the league design.** **Revision:** v2 is carried into the league comparison only if the valid final interval is above 0 *and* the estimated gain is at least 0.05. That makes 0.05 a practical decision threshold, while the size label still requires the whole interval to clear it. If v2 qualifies, its critic warm-up is carried forward too.
5. **Corrections before the commit:**
   - Clipped traces preserve the cancellation when the critic shifts by the same potential (math, below). The earlier draft listed cut traces as a separate channel; they are not.
   - The game-identity checks compare the two reward-derived arrays, `reward` and `discounted_return`, separately. Every other array, and the action-stream and final-state hashes, must match, including at RL iteration 0. Matching headers and results alone could miss trajectory drift.

**What the learner's math predicts.** This is reasoning written before any
output; it changes no rule.
- v2 adds terms to Φ only, and they are 0 at game end. Under v2, a decision's discounted return is therefore its v1 return minus Φx(now) = (f(phase)·M + T + S)/75, taken at that decision.
- Shift the critic by the same −Φx, and the V-trace recursion ([Espeholt et al., 2018](https://proceedings.mlr.press/v80/espeholt18a.html)) gives identical actor advantages and value targets shifted by exactly −Φx, even where importance ratios are clipped.
  - Checked on November 11 against the local `vtrace_recursion`: 2,000 random episodes with 31,064 clipped rows. The largest advantage difference was 1.1e-15.
  - This is the known equivalence of potential-based shaping to a different starting value function. Subtracting a function of the state alone also leaves the expected policy gradient unchanged.
- v2 can therefore act only through two channels:
  - **how closely the learned critic tracks that shift.** Its error enters the advantages directly, and counts for more where clipped traces bootstrap from it. Φx may explain part of the return the critic misses, which lowers the advantages' variance, or it may add variance where it explains nothing.
  - **the shared trunk,** which the value loss trains toward the shifted targets during RL.
- Both are open in this learner. Across `SS`'s 288 A′ iterations:
  - the critic explained a median 0.36 of its target variance (10th–90th percentile 0.16–0.54);
  - a median 10% of rows had an importance ratio below 0.5 (1–33%).
- The data checks showed that Φ_v2 predicts the winner better than Φ_v1, not better than a learned critic. The read-only critic diagnostic (secondary, below) measures that directly.
- A null result would not show that the terms carry no information. A positive one would not show which channel carried the effect.

**Design.** RL-only, matched by parent.
- **Host and code:** the M6 and toolchain of the earlier comparisons. Use a clean clone at the commit with the reviewed code checkpoint (below). With default settings, collection and `train-arm` must reproduce `SS` exactly; the preflight checks this.
- **Parents:** `FR`'s twelve BC parents r6–r17 (`b0-s20260724`–`b0-s20260735`), byte-copied and checked against `FR/SHA256SUMS`.
- **Seeds:** one command, `replicate-seeds --replicates r1 … r17 w6 … w17 smoke smoke-w --training 768`, from `seed-plan-r0.json`.
  - RL games use the r6–r17 plans, which must equal `SS`'s files byte for byte.
  - Warm-up games use pairs 0–127 of the `w6`–`w17` plans. Replicates appended after r17 leave r1–r17 unchanged, and their seeds are derived excluding every r-plan seed.
  - The preflight also checks the warm-up seeds against the evaluation and confirmation sets, and against the `RC`, `RC2` and duel seeds.
  - `smoke` (RL games) and `smoke-w` (warm-up games) are throwaway plans for the smoke only.
- **Arms.** Each parent trains two children. Each child plays 1,536 RL games and makes 1,536 one-episode Adam updates, with exactly `SS`'s A′ command: `--iterations 24 --pairs-per-iteration 32`, learning rate 1e-3, torch seed 20260926, the held-out cache and a 150-minute budget. The differences are:
  - **A1 (reward v1)** starts from its v1 warm-up.
  - **A2 (reward v2)** starts from its v2 warm-up and uses `--reward edger_potential_reward_v2` in both the warm-up and RL.
  - Each warm-up is its own arm: `train-arm --loss-mode critic_head --iterations 4 --pairs-per-iteration 32` on `seed-plan-wN.json`, from the BC parent and with that arm's reward. Warm-up bodies are kept, not pruned.
  - The RL arm starts from the warm-up's final checkpoint (`--initial-checkpoint`). The BC parent stays the reference for drift and held-out capture, and plays iteration 0.
  - A1 thus differs from `SS`'s A′ only in its starting critic, and A2 differs from A1 only in the reward.
- **Built-in checks** (not part of the estimate):
  - **Actor identity:** after each warm-up, every parameter outside the value head and its embedding is bit-identical to the parent's, and so is the exported actor. Otherwise that parent stops before RL.
  - **Game identity:** two collections that should hold the same games must match in every body array except `reward` and `discounted_return`, and in each game's action-stream and final-state hashes. The two reward-derived arrays are compared separately: within one reward they must match too, and across rewards their differences are reported.
  - The game-identity check applies to the two warm-ups of each parent, from their kept bodies, and to A1's and A2's RL iteration 0.
  - The RL bodies are pruned after each update, so the runner regenerates both arms' iteration 0 with `collect`: the parent's model, the same seeds and the arm's reward. Each regenerated header must equal the arm's own, then the bodies are compared.
  - A1's iteration-0 headers must also equal `SS`'s A′ iteration-0 headers, body checksums included.
  - Any game-identity failure is an instrument failure: no new step starts, and the analysis issues no labels.
  - Re-evaluations of the parents and of `SS`'s A′ children must equal `SS`'s game by game. They also give those models playstyle diagnostics.
- **Evaluation:** the parent, A′, and A1 and A2 (final and after iteration 5), with the earlier commands and development seeds: 200 pairs against live v1, and 100 each against the heuristic and aggressive. Each new final child also gets `V/js-eval.mjs` parity under the kept 4-ULP rule, routine and playstyle diagnostics, and held-out Fireball capture.

**Code checkpoint** (reviewed, with tests, before the smoke).
- A `critic_head` loss mode in the cadence learner: value loss only, with the fused features detached, so gradients reach only `value_head` and `value_stratum_embedding`. Tests: every other parameter is bit-identical after an iteration, and the exported actor equals the parent's.
- `train-arm --initial-checkpoint <file>`: start the arm's weights from a finished `critic_head` arm, with fresh Adam. It refuses a different reward version or parent, any other loss mode, or an actor that differs from the parent's. Without the flag, behavior is unchanged (tested).
- Collections record each game's `action_stream_hash` and `final_state_hash`. The worker already computes both; collections dropped them. Headers and bodies are unchanged.
- Nothing changes in the reward, the games played, evaluation or the production path.

**Analysis.**
- **Score:** each child's primary, as before: the equal-weighted mean points against v1, the heuristic and aggressive.
- **Primary:** d_2 = A2 − A1 after 1,536 updates, per parent. Report the mean of the 12 values with a two-sided 95% t interval (11 df).
- **Labels** (decision 2), from that interval:
  - direction: "v2 better" (interval above 0), "v1 better" (below 0) or "direction unresolved";
  - size: "at least 0.05" (lower endpoint above +0.05, or upper endpoint below −0.05), "below 0.05" (both endpoints strictly inside ±0.05) or "size unresolved";
  - the observed mean is the estimate. It sets no label on its own, but enters the carry-forward rule (decision 4).
- **Secondary, pre-registered:**
  - Each arm's gain over the parent (g_1 and g_2), and the warm-up's effect under v1, w = A1 − A′, with A′ reused read-only. Each gets a t interval and no label.
  - d_2 after iteration 5 (decision 3), with a t interval. It does not enter the decision.
  - Per-opponent d_2, the median and SD of d_2, and every pair.
  - **Read-only critic diagnostic,** a frozen run-directory script:
    - the parent's critic on each parent's 256 warm-up games;
    - the parent's critic and each warmed critic on the regenerated RL iteration-0 games, which are held out from the warm-up and played by the parent;
    - each critic scored against both v1 and v2 returns on the same games. It reports mean squared error, mean residual and residual variance (MSE = mean residual² + residual variance), which separates corrected bias from reduced variance.
  - Critic fit per arm, from the learner metrics: the critic's error against its targets, explained variance, the advantage distribution and the importance ratios, in every warm-up and RL iteration.
  - Playstyle diagnostics per child (descriptive): wasted elixir, counter responses within 5 s, Giant plays into an affordable answer, and M/T/R/S at 60 s and 120 s. R is reported, but has weight 0 in A2's reward.
  - Routine policy diagnostics, including the number of children per arm with a pooled 1-tick fraction of at least 0.9 (the factorial's descriptive threshold). Held-out Fireball capture.
- **Sample size and stopping:** n = 12, fixed. The analysis runs once, after every child is evaluated or after the cap stops the run. Progress checks read only counts, timings, exit codes, stop reasons and the built-in checks.
- **Failures,** as in the factorial:
  - Settings never change. A failed step gets one identical retry, resuming from its last completed iteration.
  - A non-finite learner stop is a recipe outcome. The final model is then the last good checkpoint, or the parent's actor if there is none.
  - Every engineering-invalid outcome is reported: illegal attempts, a nondeterministic evaluation or a parity failure. An invalid A2 child blocks "v2 better" and "below 0.05"; an invalid A1 child blocks "v1 better" and "below 0.05".
  - A missing score makes d_2 incomplete, with no labels. Results over the parents with complete scores may be reported only in a separate section, marked partial, with means and ranges but no intervals or labels.

**Sizing** (planning model, not a power guarantee). The spread of a difference
between two refreshed arms has not been measured. Reference values:
- 0.040: A′'s child-score SD (0.028) × √2, as if the two arms were independent. This is optimistic.
- 0.075: `FR`'s matched d.
- 0.096 [0.068, 0.163]: `PR`'s d_P, the closest design (two learners on refreshed data at 1,536 updates).

| SD of d_2 | Interval half-width | 80% power to exclude 0 at | Power to exclude 0 at a true 0.05 | at a true 0.10 |
|---|---|---|---|---|
| 0.040 | 0.025 | 0.036 | 0.98 | 1.00 |
| 0.075 | 0.048 | 0.067 | 0.56 | 0.99 |
| 0.096 | 0.061 | 0.085 | 0.38 | 0.91 |
| 0.163 | 0.104 | 0.145 | 0.16 | 0.49 |

These use the noncentral t with 12 pairs and two-sided α = 0.05. "Below 0.05"
needs the whole interval inside ±0.05, which is within reach only at the
lower spreads.

**Cost** (estimate, from `SS`'s run log).
- An A′-like RL arm took about 11.5 minutes. A warm-up arm should take about 2 minutes, and evaluating one model, with parity, about 1.2 minutes.
- Per parent: two warm-ups (4 minutes), two RL arms (23 minutes), four new and two repeat evaluations (about 7 minutes), and the regenerated iteration 0 with the critic diagnostic (about 1 minute). That is about 35 minutes per parent, or 7 hours for twelve, running one arm at a time.
- Running each parent's two arms side by side, with 6 workers each, should cut this to about 4.5–5 hours. That is a runner choice, allowed only if the smoke shows that the worker count changes no body.
- The cap is 9 hours, after which no new step starts. The run is local only, about 1 GB: RL bodies are pruned, while the warm-up bodies and the regenerated iteration 0 are kept.

**What it decides.** Fixed before output; the 1,536-update result decides.
- **v2 is carried forward** only if d_2's interval is above 0 (the label "v2 better", not blocked) *and* the mean is at least +0.05. The parked league opponent mix design then runs under v2, with this design's critic-head warm-up.
- **Otherwise v1 is kept.** This covers "v2 better" with a mean below 0.05, "direction unresolved" and "v1 better". The league design then runs under v1, as the earlier comparisons did, without a warm-up. v2 stays opt-in. A "v1 better" result leaves it unused, and any new reward becomes a new version with its own data check.
- **An incomplete result or an instrument failure carries nothing forward.** v1 stays, and any repair or rerun is an owner decision.
- Size labels are reported in every case. The carry-forward rule uses the mean; the "at least 0.05" label still needs the whole interval to clear 0.05.
- Inconclusive results are reported as such, with no extension or follow-up chosen after seeing them.
- Making v2 the code default, or teaching the production path (`convert-collection`) to accept v2, are separate owner decisions.
- **Every outcome:** the refresh requirement stands, `train-arm` stays the learner, and no child is a promotion candidate. A null or negative result tests the terms' learning value through this learner only. It does not retract their measured winner prediction.

**Before freezing.** These are the go/no-go for freeze and launch.
- The code checkpoint, with tests, and `npm test`.
- With the new code and default settings, `SS`'s A′-r6 iteration 0 replays exactly: 64 headers and bodies, 64 gradient norms and the weights.
- A smoke on the pilot's parent `b0-s20260718` and the `smoke` and `smoke-w` plans, which are never part of the comparison:
  - a full four-iteration warm-up on `smoke-w` and one RL iteration on `smoke`, for each reward;
  - the actor-identity and game-identity checks, including regenerating RL iteration 0, and the worker-count check;
  - the held-out critic check: on the smoke's RL iteration-0 games, score the parent's critic and each warmed critic against its own reward's returns, reporting MSE, mean residual and residual variance. If the warmed v2 critic's MSE is not below the parent critic's on the same games, the agent returns to the owner before freezing.
- Verify the parent copies, the regenerated plans and the seed disjointness.
- Dry-run `analyze.py` on synthetic inputs built from `SS` and `PR` files. Cover the carried-forward, kept-v1 (mean below 0.05), blocked, incomplete and instrument-failure paths.
- Hash `plan.md`, `run.sh`, `analyze.py` and every other frozen script into `FROZEN.txt` before any output.

**Results (November 11, 2026).** Frozen analysis in `RV` =
`~/edge_royale-runs/20261111-reward-v2.noindex` (`analysis.md`,
`analysis.json`; `RV/SHA256SUMS` covers the run).

- **Run.**
  - Clone `7101186`, frozen at 05:26:43Z (`FROZEN.txt`, 66 files). It ran from 05:26:56Z to 09:41:29Z (4 h 15 min) with one launch, each parent's two arms side by side.
  - All 492 steps succeeded on the first attempt; nothing was retried, capped or stopped.
  - All 204 built-in checks passed:
    - 108 game-identity and `SS`-reproduction checks. A1's iteration-0 games equal `SS`'s A′ games for every parent;
    - 72 re-evaluations equal to `SS` game by game;
    - 24 actor-identity checks.
  - No child was engineering-invalid, no score was missing, and parity passed for all 24 children.
- **Preflight** (`RV/plan.md`).
  - The smoke's held-out critic gate passed: on the v2 returns, the warmed v2 critic's MSE was 0.432 against the parent's 0.447.
  - `plan.md` also records the choices it adds to this text. Example: a re-evaluation that differs from `SS` is an instrument failure.
- **Primary:** d_2 = A2 − A1 = **+0.036, 95% t interval [−0.004, +0.076]** (SD 0.063, n = 12).
  - Labels: **direction unresolved**, **size unresolved**. A2 was above A1 in 8 of 12 pairs; median +0.026, range −0.082 to +0.148.
  - **Decision (frozen): v1 is kept for the league opponent mix design, without a warm-up; v2 stays opt-in.**
- **Secondary** (pre-registered; no labels):
  - gain over the parent: A1 +0.226 [+0.180, +0.271], A2 +0.262 [+0.227, +0.297];
  - warm-up effect under v1, w = A1 − A′: −0.019 [−0.043, +0.004];
  - d_2 after iteration 5: +0.038 [−0.007, +0.084];
  - per opponent: live v1 +0.045 [−0.014, +0.105], heuristic +0.044 [+0.008, +0.079], aggressive +0.019 [−0.020, +0.059]. These three intervals are unadjusted.
- **Critic diagnostic** (read-only, means over parents; MSE / mean residual / residual variance):
  - On the held-out RL iteration-0 games, the warmed critics did worse than the parent's.
    - Against v2 returns: parent 0.549 / −0.045 / 0.539; warmed v2 0.615 / +0.277 / 0.525.
    - Against v1 returns: parent 0.560 / −0.045 / 0.550; warmed v1 0.629 / +0.280 / 0.537.
    - Each warmed critic's MSE was below the parent's in only 3 of 12 parents.
  - The warm-ups lowered residual variance slightly but added a bias of about +0.28, so they underpredicted held-out returns.
  - On its own 256 warm-up games, the parent's critic had mean residual −0.026. Its explained variance against those returns was about 0 (−0.02 for v1, −0.18 for v2 at warm-up iteration 0).
  - The warm-up's error before each update rose across its four iterations (median MSE 0.58 at iteration 0, 0.66 over iterations 0–3, under v1).
  - The smoke, on one non-comparison parent, did not show this.
  - Both arms used the same warm-up procedure, so d_2 still compares the two rewards under matched conditions. But the warm-up did not deliver the critic tracking the design relied on for v2's first channel.
- **Critic fit in RL** (learner metrics, medians):
  - MSE against returns: A2 0.764, A1 0.720.
  - Explained variance against V-trace targets: A2 0.272, A1 0.317.
  - Importance ratios below 0.5: about 0.10 in both arms.
- **Playstyle** (descriptive): A2's children played differently from A1's:
  - they kept more material and threat at 60 s, closer to the parent (M +1.42 against +1.07, T +0.60 against +0.37; parent +1.58 and +0.74);
  - they made fewer decisions per game (243 against 357), with higher delay entropy (1.19 against 0.86) and fewer 1-tick delays (0.002 against 0.070);
  - they played fewer Giants into an affordable answer (0.57 against 0.70), and had a lower strong-counter share (0.17 against 0.21).
  - No child reached the 0.9 1-tick threshold. Wasted elixir averaged 0.000 per minute in both arms, against the parent's 0.222.
  - Held-out Fireball capture was 0 for every child, as for `SS`'s A′.
- **What it does not show.**
  - The unresolved direction does not show that v2's terms carry no learning value: the interval reaches +0.076, and the design's power at a true 0.05 was about 0.38.
  - It does not retract v2's measured winner prediction.
  - Under the comparison rule, no extension or follow-up is chosen from this output. Any further use of v2, or of a critic warm-up, needs its own owner decision and design.

### Sixth comparison: full-grid troop placement

**Status: run November 12, 2026 without a design reviewed in advance; the
owner approved it after the fact on November 13, 2026, and adopted full-grid
placement for training the same day** (after the seventh comparison below).
Its plan, runner and analysis were frozen in the run directory before any
comparison games.

November 12, 2026. The control used the four-cell shortlist. The full-grid
arm scored all engine-legal tiles for the chosen troop and learned a
32-weight coordinate projection in its placement head. The two arms used
the same 12 starting policies, reward v1, no critic warm-up and 384 games
and updates per child. Rollouts refreshed every 64 games. The code snapshot,
inputs, analysis and plan were frozen before the comparison in
`~/edge_royale-runs/20261112-full-grid.noindex/`.

- **Match results.** The equal-weight mean against live Edger, the heuristic
  and aggressive was 0.754 for the control and 0.796 for full-grid. The mean
  paired gain was **+0.041**, with a 95% t interval of **[−0.011, +0.093]**.
  Full-grid led in 8/12 pairs. The median gain was +0.013. Direction and size
  remain unresolved. The largest descriptive gain was against live Edger
  (+0.108).
- **Placement diagnostics.** Exact ties for best placement appeared in
  207/250 control troop fixtures and 0/243 full-grid troop fixtures. Those
  fixtures include states reached by each model. On shared held-out
  scenarios, both arms averaged 1.000 for defense. Full-grid hit 50/96 support
  positions and the control hit 33/96 under the geometric support check.
- **Run and compatibility.** All 24 children completed, passed
  JavaScript/PyTorch parity and passed the sampled legality and repeatability
  checks. All 12 control actors reproduced the earlier freshness run's
  final weights. The frozen comparison finished in 27 min 5 s.
- **Promotion preflight.** On this host all 12 full-grid children met the
  5 ms p95 timing limit, at 0.874–1.289 ms including action enumeration.
  All 12 failed the tactical and held-out Fireball gates. Each captured
  zero opportunities in the Fireball bank. The diagnostic children stopped
  at preflight. Reports are in `promotion-preflight/` under the run directory.

### Seventh comparison: reward v2 against v1 under full-grid placement

**Status: requested by the owner on November 13, 2026, then frozen, run and
analyzed the same day** in `FV` =
`~/edge_royale-runs/20261113-full-grid-reward.noindex/` (`plan.md`, `run.py`,
`analysis.json`, `posthoc.md`, `README.md`, `SHA256SUMS`). The fifth
comparison tested v2 only on the four-cell shortlist, where most tank-support
positions were out of reach. This comparison asks whether v2 helps once every
legal troop tile is available.

- **Design (frozen before output).**
  - F1 is the sixth comparison's full-grid arm, unchanged. F2 differs only in
    `--reward edger_potential_reward_v2`.
  - Both use the 12 `FR` parents r6–r17 and the sixth's 36 inputs, byte for
    byte. Training is learned cadence, 384 games and updates (six refreshes of
    32 mirrored pairs), Adam 0.001 and torch seed 20260926, with no critic
    warm-up. Source is `7101186` plus the uncommitted full-grid working tree.
  - The evaluation is the sixth's: 50 development pairs against each of live
    Edger, the heuristic and aggressive, scored by the equal-weight mean.
  - Primary: d = F2 − F1, with a 95% t interval over 12 parents. Labels set
    direction against 0 and size against ±0.05.
  - **Rule:** v2 becomes the full-grid reward only if the interval is above 0
    and the mean is at least 0.05. Otherwise v1 stays.
  - Planning SDs of 0.072–0.082 gave about 0.5–0.6 power to resolve
    direction at a true +0.05.
- **Run.** Frozen at 14:16:32Z (129 files). The run took 14:16:36Z–14:44:18Z
  in one launch with no failures, and `FROZEN.txt` verifies after it. All 24
  children completed without a collapse or non-finite stop. Every child
  passed parity, and each parent's two arms played identical iteration-0
  games (64/64 action-stream and final-state hashes).
- **Primary:** d = F2 − F1 = **+0.056, 95% t interval [−0.027, +0.138]**
  (SD 0.130, n = 12).
  - Labels: **direction unresolved**, **size unresolved**. F2 was above F1 in
    8 of 12 pairs. The median was +0.075, with a range of −0.187 (r16) to
    +0.273 (r10).
  - **Decision (frozen): v1 stays the full-grid reward.**
  - The spread was about 1.6–1.8 times the planning SDs, so the interval is
    wider than planned.
- **Secondary** (no labels; per-opponent intervals unadjusted):
  - arm means: F1 0.796, F2 0.851;
  - per opponent: live Edger +0.065 [−0.051, +0.181], heuristic +0.063
    [−0.037, +0.163], aggressive +0.039 [−0.011, +0.089];
  - geometric support hits: F1 50/96, F2 66/96. Placement ties were 0 in
    both arms (243 and 229 fixtures), and defense was 1.000 in both;
  - timing p95 was 1.12–2.94 ms. The current `evaluateTiming` includes
    full-grid enumeration, and two children were timed at once on the host;
  - playstyle at 60 s, means over opponents: F2 kept more material (1.75
    against 1.47) and threat (0.76 against 0.60). The support term was near 0
    in both (0.024). F2 made more decisions per game (138 against 97) and
    fewer Giant plays (0.49 against 0.74).
- **F1 reproduction.** The frozen byte-identity check reported 0/12. That is
  because `model_id`, `checkpoint_id` and `dataset_checksum` embed the arm
  name. After the output, a comparison of `weights` found all 12 F1 models
  identical to the sixth's full-grid children. All 12 F1 per-opponent scores
  also equal the sixth's (`posthoc.md`).
- **What it does not show.**
  - The unresolved direction does not show that v2 has no value under
    full-grid; the interval reaches +0.138.
  - The near-zero support term at 60 s means this run barely exercised v2's
    tank-support channel. The children play Giant less than once per game, so the gain in
    support hits is not evidence that S worked.
  - Under the comparison rule, no extension or follow-up is chosen from this
    output.

### Eighth comparison: snapshot league opponent mix

**Status: design approved with revisions on November 15, 2026, then
implemented, frozen, run once and analyzed the same day. Frozen decision: the
current mix stays** ([result](#eighth-comparison-result)). The run is in `SL` =
`~/edge_royale-runs/20261115-snapshot-league.noindex/` (`plan.md`,
`FROZEN.txt`, `analysis.md`, `analysis.json`, `README.md`, `SHA256SUMS`;
[preflight](#eighth-comparison-preflight-and-launch)). The owner approved
design work on the league opponent mix on November 10. On November 13 it resumed under
full-grid placement and reward v1, without a warm-up. On November 15, after
the code reading below, the owner chose to test the snapshot league.

**September allocation and critic label** (code reading, November 15).
- The historical league stage ran `edger:train:league` with the live champion and no `--league` file or `--historical-anchors` (`scripts/edger-production-campaign.mjs` at `0270d82`). Both snapshot buckets were empty and `selectOpponent` fell back to the champion. Replaying the historical scheduler at seed `20260718` gives 396 champion and 104 heuristic pairs (79.2% and 20.8%).
- `train-arm` implements the same nominal allocation with empty buckets in `trainingOpponentSchedule`. Over the r6–r17 plans the heuristic share is 19.9% (1,837 of 9,216 pairs). The paths use different seed schedules.
- Live v1 plays the same way in both paths: `selectEdgerAction` on `edger_policy_current.json`, deciding every tick.
- This rules out exposure to snapshots as an explanation for the historical regression. The small difference in realized proportions comes from the different draws. The allocation question closes without a training run.
- **The league used the wrong opponent label for value estimation.**
  - The league worker records the opponent's `policy_id` as its stratum. For the champion that is the model id `edger_policy_bootstrap_20260701`. `train-arm` uses `edger`.
  - The parent's vocabulary is `{aggressive: 0, defender: 1, edger: 2, edger_heuristic: 3, random: 4}`. This was read from copies of the archived `parent.pt` and the league `candidate.pt` (`79a095af…`). The learner maps an unknown stratum to index 0.
  - The code and schedule imply that 792 of the collected games had the model-id label. Rows with that label resolve to the aggressive embedding. This is inferred from the code and checkpoint vocabulary. The archived rows were not inspected.
  - The label enters the value head, and those values affect the policy gradients through V-trace advantages. Its contribution to the regression is untested. The production fix is a separate change for fresh campaigns. See [training contract](EDGER_TRAINING.md#5-scaling-and-snapshot-league).
  - The fix landed on November 20, 2026 for fresh rollouts: model opponents record `edger`, and `vtrace` refuses strata missing from the parent vocabulary ([training contract](EDGER_TRAINING.md#5-scaling-and-snapshot-league)).

**Question.** Does filling the league's snapshot buckets with the learner's
own earlier policies give better children than the current champion and
heuristic mix? The comparison holds games, seeds, sides and updates equal, with
the `train-arm` learner, refreshed rollouts, full-grid placement and reward v1.
The result informs the next league-stage design. Match points determine the
decision.

**Approved choices.**
1. **Scale: 1,536 updates** (24 refreshes of 32 mirrored pairs), with an evaluation after iteration 5 as a secondary.
   - Twenty-four refreshes give the pool time to reach six snapshots. The first six control iterations reproduce the sixth comparison's full-grid reference.
2. **Snapshots: the arm's own pre-update actor at the start of iterations 0, 4, 8, 12, 16 and 20.** Snapshot 0 is the initialized full-grid parent. Snapshot 4 is the actor after iterations 0–3. A snapshot captured at iteration k first becomes eligible at k + 1. The pool is empty at iteration 0, so both snapshot buckets use live v1 and the heuristic bucket stays as scheduled. Uniform and PFSP both use the same pool, in ascending capture order.
3. **PFSP score:** the learner's cumulative mean match point against each snapshot (win 1, draw 0.5, loss 0), across both sides and both snapshot buckets. Use only games from completed prior iterations. Unplayed snapshots start at 0.5. Apply (1 − score)² + 0.05 and fix the weights for the entire next refresh.
4. **Snapshot play:** deterministic, with the snapshot's own learned delay, on the full grid. Use the production league worker's policy selector and legal-action enumeration. The learner keeps sampling at temperature 1.
5. **Critic stratum for snapshot games: `edger`,** the existing stratum for a learned policy with hidden information. Production's fallback (index 0, aggressive) would mislabel them. A new vocabulary entry would change the critic's shape and need an initialization rule.
6. **Extra secondary evaluations,** each on the same 50 mirrored development pairs as the primary. Evaluate both final children against defender and each B child against its paired A child at learned cadence. Both are descriptive and outside the carry-forward decision.

**Design.** RL-only, matched by parent.
- **Host and code:** the M6, with a clean clone at the reviewed code checkpoint (below). With default settings, `train-arm` must reproduce the sixth comparison's full-grid arm (preflight).
- **Parents and inputs:** `FR`'s parents r6–r17, through `initialize-full-grid` as in the sixth and seventh comparisons. The sixth's 36 inputs are used byte for byte; its 768-pair plans equal `SS`'s.
- **Arms.** Each parent trains two children:
  - **A (current mix):** the seventh's F1 command with `--iterations 24`. That is learned cadence, 32 mirrored pairs per refresh, Adam 0.001, torch seed 20260926, reward v1, no warm-up and pruned bodies.
  - **B (snapshot league):** identical except `--opponent-mix snapshot-league`.
- **How B's opponents are drawn.**
  - Each pair keeps the allocation draw u that already sets the control's schedule. The draws come from the plan's `opponent_schedule_seed`, and they re-derive all 12 plans exactly (9,216 of 9,216 pairs).
  - Both arms play live v1 for u < 0.4 and the heuristic for u in [0.4, 0.6).
  - For u ≥ 0.6, A plays live v1. B plays a snapshot: uniform over the pool for u in [0.6, 0.8), and by PFSP for u in [0.8, 1).
  - Choices within a bucket use a separate deterministic draw keyed by the plan's schedule seed and the absolute pair index. Freeze the exact draw derivation and use the same selection for both sides.
  - The planned bucket shares across r6–r17 are 0.407, 0.199, 0.201 and 0.193. Including iteration 0's fallback, B is scheduled to play snapshots in 3,462 of 9,216 pairs (37.6% overall, 39.2% after iteration 0) and live v1 in 42.5%, compared with A's 80.1%.
- Both arms play the same seeds, sides and order, with one update per episode and 1,536 scheduled updates per arm.
- **Built-in checks.** Verify each identity check at its iteration boundary and verify the recorded opponent selections before accepting each completed refresh. A mismatch is an instrument failure. Stop scheduling new steps when detected and issue no labels.
  - B's iteration 0 must equal A's: 64 of 64 episode ids, headers, action-stream hashes and final-state hashes.
  - A's weights after iteration 5 must equal the sixth comparison's full-grid child weights, compared on `weights` as `FV/posthoc.md` did.
  - B's collection records each pair's bucket, selected opponent and, for snapshot games, the snapshot iteration and actor SHA-256. Record the ordered eligible pool and frozen PFSP weights per refresh. Re-derive all picks from the frozen seed plan and verified prior collections, including the fallback. A retry rebuilds the pool and scores from hash-verified completed iterations and reproduces the same picks, bodies and weights as an uninterrupted run.
- **Evaluation:** the sixth's. Each model plays 50 development pairs (100 games) against live v1, the heuristic and aggressive, at learned cadence, and its score is the equal-weight mean.
  - Final models of both arms, plus both arms after iteration 5 (secondary). The initialized full-grid parent plays the same primary suite once per pair for the descriptive gain over the parent.
  - Each final child also gets the sixth's unchanged `diagnostics.mjs` (parity, timing, defense, support positions, placement ties), the playstyle and policy diagnostics, and the two extra evaluations in choice 6.
  - Complete the final primary evaluations and parity across all pairs before spending remaining run time on the separate descriptive evaluations.

**Code checkpoint** (reviewed, with tests, before the smoke). Training tooling
only.
- `train-arm --opponent-mix plan|snapshot-league`. `plan` is the existing default. `snapshot-league` implements the pool, PFSP and collection records above.
- Model opponents in the cadence match core use deterministic `selectEdgerV2PolicyDecision`, full-grid enumeration and the model's own delay. A snapshot game's header keeps the snapshot id as `opponent` and adds `opponent_stratum`. The learner rejects an explicit stratum missing from the parent vocabulary. Legacy headers continue to use `opponent` and their existing lookup. Other headers stay byte-identical, and `convert-collection` rejects snapshot collections until it supports their replay and metadata.
- `evaluate --opponent-model <file>` for head-to-head. Bind both actor hashes and both mirrored sides, and check model-opponent legality and repeatability as well as the candidate's.
- Tests:
  - the default schedule and collections are unchanged;
  - the allocation draws re-derive the schedule;
  - the empty pool falls back to live v1;
  - PFSP picks are deterministic and match a hand computation;
  - resuming a snapshot arm preserves opponent picks and learner weights;
  - snapshot opponents make only legal actions and replay identically;
  - snapshot games use the `edger` stratum.

**Analysis.**
- **Primary:** d = B − A after 1,536 updates, per parent. Report the mean of the 12 values with a two-sided 95% t interval (11 df).
- **Labels,** as in the fifth to seventh comparisons:
  - direction: "snapshot league better" (interval above 0), "current mix better" (below 0) or "direction unresolved";
  - size: "at least 0.05" if the lower bound is ≥ +0.05 or the upper bound is ≤ −0.05, "below 0.05" if both endpoints lie strictly within (−0.05, +0.05), otherwise "size unresolved". Use unrounded values.
- **Secondary** (pre-registered, no labels):
  - d after iteration 5;
  - per-opponent d, with unadjusted intervals;
  - each arm's gain over the parent, the median and SD of d, and all 12 pairs;
  - the paired B − A defender difference and B's head-to-head match point against A, each with a 95% t interval over parents;
  - B's realized opponent shares and PFSP weights by iteration;
  - the diagnostics and playstyle results, including the number of children per arm with a pooled 1-tick fraction of at least 0.9.
- **Sample size and stopping:** n = 12, fixed. The analysis runs once after completion, the cap or an instrument failure. Progress checks read only counts, timings, exit codes, stop reasons and the built-in checks.
- **Failures,** as in the fifth comparison:
  - Settings never change. An infrastructure failure gets one retry with identical settings, resuming from its last completed iteration.
  - A collapse (the current zero-successful-deployments stop) or non-finite stop is a recipe outcome, scored with the last good actor or the initialized parent if none. Record the actual update count. Missing iteration-5 secondary scores are reported separately.
  - An engineering-invalid child (illegal attempts, a nondeterministic evaluation or a parity failure) blocks its arm's favorable direction and size labels and blocks "below 0.05" for the comparison.
  - A missing required primary score makes the result incomplete, with no labels. An unavailable descriptive score does not by itself block the primary.

**Sizing** (planning model, not a power guarantee). The closest measured
spreads of a matched difference are:
- 0.063: the fifth comparison (two rewards, 1,536 updates);
- 0.082: the sixth (two action spaces, 384 updates);
- 0.096: `PR`'s d_P (two learners on the same 1,536 refreshed games);
- 0.130: the seventh (two rewards, full-grid, 384 updates).
A change of training opponents may spread more than a change of reward.

| SD of d | Interval half-width | 80% power to exclude 0 at | Power to exclude 0 at a true 0.05 | at a true 0.10 |
|---|---|---|---|---|
| 0.063 | 0.040 | 0.056 | 0.71 | 1.00 |
| 0.082 | 0.052 | 0.073 | 0.49 | 0.97 |
| 0.096 | 0.061 | 0.085 | 0.38 | 0.91 |
| 0.130 | 0.083 | 0.116 | 0.23 | 0.68 |

These use the noncentral t with 12 pairs and two-sided α = 0.05. An unresolved
direction is a plausible outcome. At a true gain of +0.05, the chance of
also clearing the mean gate is about 35–42% at SD 0.096–0.082, before any
engineering failures. At the latest observed SD of 0.130, it is about 23%.

**Cost** (estimate, from `FV`'s run).
- A full-grid iteration took about 13 seconds with two arms side by side: 9–11 seconds of collection and 2–4.5 seconds of learning, growing over the run. An A arm should take about 6–8 minutes.
- Snapshot games add a second model's inference, so a B arm may take 8–10 minutes.
- Budget for 26 seconds per child for the primary and diagnostics based on `FV`, plus the two iteration-5 suites, one parent suite, two defender evaluations and one head-to-head per pair. Use the smoke to check the cost of the model-opponent path.
- That is about 12 minutes per parent with the arms side by side, or about 2.5 hours for twelve. Enforce the five-hour wall-clock cap from launch across training, retries and evaluations. Stop active work at the deadline and retain verified completed outputs for analysis.
- The run is local only, about 1.1 GB with pruned bodies.

**What it decides.** Fixed before output.
- **Carry snapshots into the next league-stage design** only if d's direction label is "snapshot league better" after validity checks and the unrounded mean is at least +0.05. The next design starts from snapshots every 256 updates, PFSP from prior training games and the `edger` stratum. Production adoption has its own decision and requires the separate league labelling fix.
- **Otherwise the current mix stays**, which is production's default with empty buckets. The snapshot mix stays opt-in in `train-arm`. After "current mix better", a future campaign does not pass snapshots to the league without a new design.
- **An incomplete result or an instrument failure leaves the current mix in use and gives no labels.**
- **Every outcome:** the refresh requirement stands, `train-arm` stays the learner, and the children are local diagnostics. Report size labels for complete, instrument-valid results. The 12-pair sample and stopping rules are fixed before output.

**What it does not test.**
- Snapshots from other runs, promoted history or contenders.
- Scales beyond 1,536 updates, and the production learner.
- The historical stratum fallback.

The primary weights live v1 at one third. Use the per-opponent results to read
any tradeoff as its training share falls from 80.1% in A to 42.5% in B.

**Before freezing.** These are the go/no-go for freeze and launch.
- The code checkpoint, with tests, and `PYTHON=/usr/local/bin/python3 npm test -- --test-concurrency=2` on this host.
- With default settings, A-r6's first six iterations reproduce the sixth comparison's full-grid r6 child weights.
- A smoke on the pilot parent `b0-s20260718` with a throwaway `smoke` plan, never part of the comparison. B runs six iterations of four pairs, with a snapshot every two iterations so the pool fills. It checks:
  - iteration-0 identity;
  - the re-derivation of every pick;
  - snapshot legality and repeatability;
  - that the worker count changes no body;
  - that an interrupted run resumed with a nonempty pool reproduces an uninterrupted run;
  - one head-to-head evaluation.
- A dry run of the analysis on synthetic inputs covering every label, the blocked, incomplete and instrument-failure paths, and the carry-forward rule.
- Hash the plan, runner, analysis code, diagnostics, source snapshot, reference weight digests and inputs into `FROZEN.txt` before the comparison produces output.

#### Eighth comparison preflight and launch

November 15, 2026 (UTC times below are November 14). Every go/no-go item
passed; `SL/plan.md` restates the design and records the runner's choices.
- **Code checkpoint** (working tree, uncommitted): `PYTHON=/usr/local/bin/python3 npm test -- --test-concurrency=2` passed 268/268, with seven new Node tests and one new Python test covering the listed cases. `SL/source` is `4bb1ec9` plus `SL/source.patch`, equal to that tree.
- **Control reproduction:** from the frozen source, A-r6 for six iterations reproduced the sixth comparison's full-grid r6 weights after iteration 5. All 384 games equal `FV`'s F1-r6. `initial.json` differs from `FV`'s only in the recorded platform string (macOS 27.2 → 27.2.1).
- **Smoke** (not evidence; pilot parent `b0-s20260718`, throwaway `smoke` plan, six iterations of four pairs, a snapshot every two):
  - Two runs: S1 used 6 workers, and its B arm was SIGKILLed inside iteration 4 and resumed by the runner's retry. S2 used 3 workers, uninterrupted. All six iterations of both arms matched in picks, pools, games, bodies and weights.
  - Iteration-0 identity held, and every pick re-derived independently in Python. Every bucket and the empty-pool fallback were exercised, and the 22 snapshot games made no illegal attempt. Final scores were equal across worker counts, both children passed parity, and the head-to-head bound both actors and passed its repeat check.
  - A tamper check accepted an untouched copy and rejected a swapped pick, a PFSP weight changed by 1e-9 and a swapped actor.
- **Analysis dry run:** 12 of 12 synthetic cases gave the expected labels and decisions: every label, three blocked paths, the carry rule, incomplete, instrument failure and a missing boundary check.
- **Runner choices** (`SL/plan.md`):
  - Identity across separate runs is judged on picks, games, bodies and weights. Exported actors embed the collection checksum, which records wall time, so actor SHA-256 values bind only their own run. This is also why `FV`'s byte check reported 0/12.
  - An evaluation refused for illegal attempts or nondeterminism marks its child engineering-invalid and leaves its primary score missing, so the result is incomplete.
  - The cap kills active steps at five hours from launch.
- **Freeze and launch:** `FROZEN.txt` (133 files) was written at 15:20:48Z, and `EDGER_FROZEN_NODE="$(command -v node)" caffeinate -is /usr/local/bin/python3 -I -u run.py` launched once at 15:21:01Z. An unrelated `gridcast` process shared the host, so wall times and timing p95 are not cost evidence.

#### Eighth comparison result

November 15, 2026 (UTC times below are November 14). `SL/analysis.md` and
`SL/analysis.json` hold the frozen analysis, read once after the run.
- **Run.** One launch, 15:21:01Z–17:26:31Z (2 h 5 min), exit 0, with no retries and well inside the cap. `FROZEN.txt` verifies after the run.
  - Every built-in check passed for all 12 parents: iteration-0 identity (64/64 games), A's iteration-5 weights equal to the sixth's full-grid child, A's plan opponents in 24/24 iterations, and B's picks re-derived in 24/24 iterations.
  - All 24 children completed 1,536 updates with no collapse or non-finite stop. All passed parity and made no illegal attempts, so no child was engineering-invalid.
- **Primary:** d = B − A = **+0.025, 95% t interval [−0.012, +0.062]** (SD 0.058, n = 12).
  - Labels: **direction unresolved**, **size unresolved**. B was above A in 9 of 12 parents. The median was +0.025, with a range of −0.093 (r15) to +0.130 (r14).
  - **Decision (frozen): the current mix stays.** Snapshots are not carried into the next league-stage design, and the snapshot mix stays opt-in in `train-arm`.
  - The SD was below every planning value (0.063–0.130). The interval's upper end, +0.062, is above +0.05, so it does not exclude a gain the size the rule required.
- **Secondary** (no labels; per-opponent intervals unadjusted):
  - arm means: A 0.851, B 0.876. Gain over the parent: A +0.199 [+0.176, +0.223], B +0.224 [+0.175, +0.273];
  - per opponent: live Edger +0.013 [−0.050, +0.075], heuristic +0.018 [−0.038, +0.073], aggressive +0.044 [+0.012, +0.077];
  - after iteration 5: +0.053 [−0.014, +0.120];
  - defender: every child of both arms scored 1.000, so the paired difference is 0;
  - head-to-head: B's match point against A was 0.522 [0.422, 0.622], ranging from 0.30 (r15) to 0.90 (r14);
  - B's realized opponents: live v1 42.5%, heuristic 19.9% and snapshots 37.6% of 9,216 pairs, as planned;
  - PFSP pools (means over parents): the sampling learner scored below 0.5 against every snapshot it had played. Against snapshot 0 its cumulative mean rose from 0.17 (iteration 2) to 0.35 (iteration 23). Against later snapshots it ended at 0.24–0.41, so the final mean weights were 0.48–0.63 and PFSP stayed close to uniform;
  - diagnostics: parity 12/12 in both arms, defense 1.000, placement ties 0 (240 and 229 fixtures), support hits 36 and 35, timing p95 1.28–2.94 ms (A) and 1.21–2.93 ms (B) on a shared host;
  - playstyle at 60 s (means over children and opponents): material 1.47 against 1.45, threat 0.64 against 0.60, support 0.041 against 0.035. B made more decisions per game (645 against 279; higher in 9 of 12 parents) and fewer Giant plays (0.09 against 0.17);
  - children with a pooled 1-tick fraction ≥ 0.9: A 0, B 1 (B-r14, 0.993). B-r14 also had the largest d and head-to-head point.
- **What it does not show.**
  - The unresolved direction does not show that snapshots have no value. The interval reaches +0.062. It also does not show harm, since the lower bound is −0.012.
  - The aggressive interval above 0 is an unadjusted secondary, not a label.
  - Whether snapshot opponents push children toward faster decisions is untested. B-r14 is one child, and the decisions-per-game difference is descriptive.
  - Under the comparison rule, no extension or follow-up is chosen from this output.

### Ninth comparison: Fireball capture value and opportunity weight

**Status: proposed November 17, 2026; revised November 19 to adopt the design
review the owner passed on; approved by the owner on November 19 with 24
Stage 2 pairs (decisions at the end of this section). Implemented,
preflighted, frozen and Stage 1 run on November 19. Frozen decision: no class
is "capture better", so Stage 2 did not run. The owner reviewed the result on
November 20 and closed the comparison as recorded
([result](#ninth-comparison-stage-1-result)).** After
the eighth comparison the owner chose the Fireball gap as the next experiment
(November 17). The aim is a full-grid model that can pass promotion.

**Where things stand** (read from existing outputs, November 17).
- **No full-grid child captures.** The sixth comparison's 12 full-grid children captured 0 of the 80 bank opportunities and scored 0 on the spell-value and tower-finishing scenarios. The eighth's 12 A children (the current recipe, 1,536 updates) cast no Fireball in any of their 3,600 primary evaluation games, while scoring 0.74–0.98 against each opponent.
- **Fireball is necessary for promotion but not sufficient.** The same 12 sixth-comparison children also miss the elixir-punishment minimum (0.55) in 8 of 12, and the pocket-pressure minimum (0.55) in 11 of 12 (scores 0.12–0.69). Defense passes for all 12.
- **RL meets opportunities and moves away from the parent on them.** In the eighth's A arms, Fireball opportunity rows were 3.5–9.7% of the rows with a real card choice (3,016–5,102 rows per arm over 24 iterations). The card KL to the parent on those rows was 0.04–0.18 nats in iteration 0 and 0.47–2.59 in iteration 23.
- **Few Fireball examples late in training.** The same arms' rollouts sampled 608 Fireballs in iteration 0's 768 games and 205 in the final six iterations' 4,608 games. Those six iterations had 11,498 opportunity rows. Even if every late Fireball fell on an opportunity row, at most 1.8% of those rows sampled it. The counts cover every sampled Fireball, aimed or not.
- **Earlier work** ([proposal 3](#proposal-3-data-and-learning-on-v4--october-27-2026) to the [stronger floor](#stronger-targeted-floor--november-2-2026); four-cell placement, 384 updates, three runs per arm):
  - The v4 spell globals give the card head exact lethal and cluster inputs.
  - The `bfo` BC recipe raised validation capture from 0 to 24–30%. RL without a floor erased it within six iterations.
  - Every floor that kept Fireball cost play. The global β = 0.05 floor cost about 0.06–0.10. The targeted β = 1 floor cost 0.160 against no floor on the M6, with capture 0.239. The inferred mechanism is that the floors held the shared card head near a weaker parent.
- **The baselines miss the gate too.** The heuristic captures 20 of 27 lethal (0.741, against a minimum of 0.80) and 40 of 53 cluster opportunities. Live v1 captures 8 of 27 and 22 of 53.
- **Not yet measured: whether capture wins games for these children.** The bank scores one decision and ignores cast delay and travel. A tower at 207 HP with troops on it may fall anyway, and Fireball costs 4 elixir. If capture has no match value, RL is right to drop it, and any recipe that keeps it should cost play.

**Question.** In two stages:
1. Does casting a capturing Fireball at an opportunity raise the current children's match points? Evaluation only.
2. For the classes where it does, does giving those opportunity rows more weight in the card head's policy loss let RL learn capture while costing less than 0.05 in match score?

Both stages' designs, analyses and decisions are frozen before Stage 1 produces any output. That includes the rule that picks Stage 2's weighted classes from Stage 1's labels.

#### Stage 1: capture value (evaluation only)

- **Models:** the eighth's 12 final A children, verified against `SL/SHA256SUMS`.
- **Games:** each child's primary suite from the eighth: 50 development pairs against live v1, the heuristic and aggressive, at learned cadence, deterministic (300 games per child). An unforced rerun must reproduce `SL`'s action-stream and final-state hashes for all 3,600 games. A mismatch is an instrument failure.
- **Branch points:** in each game, the child's first decision at a lethal opportunity, and separately its first decision at a cluster opportunity. Classes use the bank's rule at decision time (`classifyFireballOpportunity`, lethal first). A decision whose own action already captures is counted and not branched.
- **Forced action:** Fireball at the capturing cell that the child's own placement head ranks highest (lowest index on ties, as at runtime), with the delay the child's delay head picks for that card and cell. The branch replays the game from the start with only that decision replaced, so both games are identical up to the branch tick. The opponent's random draws come from the same generator state, but they can diverge once the games do.
- **Outcome per branch:** Δ = the child's match point in the forced game minus its point in the own game (win 1, draw 0.5, loss 0). Descriptive: crowns and towers taken by each side, the own action that was replaced (PASS, a troop card or Arrows) and the class.
- **Impact log per forced cast** (descriptive). The intended targets are the entities that made the decision an opportunity, fixed at the branch tick. For lethal, they are the enemy towers within the cast radius whose HP is at most Fireball's tower damage. For cluster, they are the enemy troops within the radius. The log reads the engine's `spell_impact` event (`impacted_entity_ids`) and records:
  - the impact tick;
  - which intended targets were hit;
  - all enemy entities hit;
  - whether each intended tower fell to the impact.

  A lethal cast **landed** if at least one intended tower was hit. A cluster cast landed if at least three intended troops were hit. Report the landing rate per class and per child, and Δ separately for landed and missed casts.
- **Statistic, per class:** each child's mean Δ over its branches, then the mean over children with at least one branch, with a two-sided 95% t interval (n − 1 df). Also report every child, the branch counts, the median and the pooled per-branch mean.
- **Full-suite change, per class** (reported, no labels): each child's mean Δ over all 300 games, counting games without a branch of that class as 0, then the mean over the 12 children with a t interval. This is the suite-score change from capturing at the first opportunity of that class.
- **Labels, per class:** "capture better" (interval above 0), "own action better" (interval below 0) or "unresolved".
- **Decision** (fixed before output; the frozen analysis writes Stage 2's classes to a file that the frozen Stage 2 runner reads):
  - Stage 2 weights exactly the classes labeled "capture better": lethal only, cluster only, or both. It launches after its preflight, with no further design.
  - If neither class is "capture better", Stage 2 does not run.
    - If both classes are "own action better", capture costs these children match points, and the gate question goes back to the owner with this evidence.
    - Otherwise stop and review with the owner.
  - An instrument failure or a missing child stops the stage with no labels.
- **Limits:**
  - The test is one forced cast, using the current children's aim and their follow-up play. They never learned to play after a Fireball, and a policy trained to cast it could gain more or less. A negative result justifies a review of the gate, not a verdict on Fireball.
  - It covers one deviation per game, deterministic play and the three primary opponents only.
  - It does not test the bank's own states.
- **Rough size** (a planning guess, not a measurement): branch counts are unknown until the run. In the bank's source games, 23 of 70 test episodes had a lethal opportunity and 50 had a cluster one. With a branch-level SD near 0.5 and 60 or more branches per child, the interval half-width would be about 0.05–0.07 per class.
- **Cost:** about 3,600 unforced and at most 7,200 forced games, roughly 20–30 minutes at the eighth's evaluation rate.

#### Stage 2: opportunity weight (RL only, matched by parent)

- **Treatment:** `train-arm --opportunity-card-weight w --opportunity-card-weight-classes lethal|cluster|both` multiplies the card head's policy-loss term by w on the Fireball opportunity rows of the chosen classes. The classes are the ones Stage 1 picked.
  - Rows are classified as in the targeted floor, from each on-policy row's globals and card mask, using the bank's rule (lethal first).
  - The weight scales whichever card was sampled on the row: Fireball, Arrows, a troop or PASS.
  - The placement, delay, value and entropy terms are unchanged, and w = 1 reproduces today's update bit for bit.
- **Why this treatment:**
  - The floors held the card head near the BC parent. The weight follows the measured advantage instead, so if capture loses games, the arm learns that faster too.
  - Extra exploration in rollouts would add Fireball samples, but V-trace scales each sample's advantage by min(1, π/μ). For an action sampled more often than the target policy plays it, the expected contribution to the update stays the on-policy one. Exploration adds samples, not pull.
  - The `bfo` BC recipe changes the parents, and the comparison rule then requires separate end-to-end parents. It can follow if the weight works.
- **w = 10, one diagnostic dose.** At the eighth's 3.5–9.7% share, the opportunity rows of both classes would then carry about 0.4–1.1 times the card-head weight of all other choice rows combined. With one class weighted, the weighted rows carry less.
- **Parents and inputs:** `FR`'s parents r6–r17 through `initialize-full-grid`, with the sixth's 36 inputs byte for byte. With 24 pairs, the 12 extra parents are added as described under sample size below.
- **Arms:**
  - **A (control):** the eighth's A command: current mix, full-grid placement, reward v1, no warm-up, 24 refreshes of 32 mirrored pairs (1,536 updates).
  - **B:** identical, plus `--opportunity-card-weight 10` and Stage 1's classes.
- **Built-in checks:** B's iteration-0 games equal A's (64 of 64 action-stream and final-state hashes). Each A child on r6–r17 has final weights equal to the eighth's A child for the same parent. A mismatch is an instrument failure.
- **Sampling and aim diagnostics** (both arms, every iteration, per class, descriptive). They show whether a flat result had useful examples to learn from.
  - Counts: opportunity rows, rows that sampled Fireball, and rows that sampled Fireball at a capturing cell.
  - The learner's mean V-trace advantage on the Fireball and non-Fireball rows.
  - Aim is checked at collection with the bank's capture rule and written to a separate file per iteration, so collections stay byte for byte.
- **Evaluation:**
  - The final children of both arms, plus both arms after iteration 5 (secondary), on the eighth's primary suite.
  - The promotion preflight, as in the sixth comparison, for the final children and the initialized parents: tactical scenarios, timing, and bank capture on `QB`'s frozen bank.
  - The sixth's `diagnostics.mjs`, the playstyle and policy diagnostics, and Fireballs per game. These are descriptive; only the two endpoints below are labeled.
- **Endpoints** (n = the number of pairs, n − 1 df):
  - **Match (primary):** d = B − A in the primary score: the mean over pairs, with a two-sided 95% t interval and the eighth's direction and size labels. Against the −0.05 margin, d is:
    - "within margin" if its lower bound is above −0.05;
    - "beyond margin" if its upper bound is below −0.05;
    - otherwise "cost unresolved".
  - **Capture (required to carry):** c = B − A in bank capture on `QB`'s frozen bank, per parent, for the weighted class (with both weighted, lethal and cluster rates count equally). It is reported with a t interval and the labels "weight better", "control better" or "direction unresolved". Each class is also reported separately, including an unweighted one.
- **Decision** (fixed before output; 12 pairs are a screen):
  - **Carry the weight into further Fireball research** only if d is "within margin" and c is "weight better", after validity checks. Carrying means the next design may start from the weight; it does not become a default.
  - If c is "weight better" and d is "cost unresolved", do not carry it. The play cost is unresolved at this sample, and a larger follow-up needs its own design.
  - If d is "beyond margin", do not carry it, and report the trade-off.
  - Otherwise the weight stays opt-in and off by default.
  - **Every outcome:** no child is a promotion candidate, and gate passes are descriptive only. The refresh requirement, the `train-arm` learner and the current mix stand.
- **Failures,** as in the eighth:
  - An infrastructure failure gets one retry with identical settings.
  - A collapse or non-finite stop is a recipe outcome, scored with the last good actor.
  - An engineering-invalid child blocks the carry decision and the favorable labels.
  - A missing primary score or capture makes the result incomplete.
- **Sizing** (noncentral t, two-sided α = 0.05). The A children are expected to capture nothing, so a consistent B capture resolves its direction; its spread is unknown. The match margin is the harder part. The table gives the half-width of d's interval and the chance that d is "within margin":

| SD of d | 12 pairs: half-width | true d = 0 | true d = −0.02 | 24 pairs: half-width | true d = 0 | true d = −0.02 |
|---|---|---|---|---|---|---|
| 0.058 (eighth) | 0.037 | 0.78 | 0.37 | 0.024 | 0.98 | 0.68 |
| 0.082 (sixth) | 0.052 | 0.49 | 0.21 | 0.035 | 0.82 | 0.40 |
| 0.130 (seventh) | 0.083 | 0.23 | 0.11 | 0.055 | 0.44 | 0.19 |

  With 12 pairs at the sixth's spread, a weight that costs no play is "within margin" only about half the time.
- **Sample size (the owner sets it before launch):**
  - **12 pairs (default):** `FR`'s r6–r17.
  - **24 pairs:** `FR`'s 12, plus 12 new end-to-end BC parents trained with `FR`'s BC command. They use seeds 20260736–20260747, about 3 minutes each on this host.
    - Each new parent gets a training plan r18–r29 from the same generator, disjoint from every existing training and evaluation set. Each is initialized the same way.
    - The reproduction check against the eighth covers r6–r17 only.
  - Stage 1's population is the eighth's 12 children either way.
- **Cost:** two arms like the eighth's A arm (no model opponents), about 6–8 minutes each with the arms side by side.
  - 12 pairs: roughly 1.5–2 hours with evaluations, under a five-hour cap.
  - 24 pairs: roughly 3.5–4.5 hours including the new parents, under a ten-hour cap.

  The run is local only.

#### Before freezing (go/no-go)

- A code checkpoint with tests, and `PYTHON=/usr/local/bin/python3 npm test -- --test-concurrency=2` on this host. The tests cover:
  - byte-identical collections and evaluations by default;
  - the forced-decision replay and the aim restriction to capturing cells;
  - the impact log on constructed lethal and cluster states, including a miss;
  - bit identity at w = 1, and that only the chosen classes' opportunity rows are reweighted;
  - that the learner's row classes match the collection-side classes on every row of a smoke collection;
  - that the aim diagnostics leave collections byte for byte.
- A Stage 1 smoke on a model outside its population (the sixth comparison's full-grid r6 child), using a few pairs.
- For Stage 2, A-r6 must reproduce the eighth's A-r6 final weights. A B smoke runs on the pilot parent `b0-s20260718` with a throwaway plan, once per class setting.
- Dry runs of both analyses on synthetic inputs, covering every label, every Stage 2 class selection, and the margin and carry paths.
- One `FROZEN.txt` binds both stages' plans, runners, analyses, the source snapshot and the inputs before Stage 1 produces output. With 24 pairs, the new parents' BC and plan steps are part of the frozen runner.

**What it does not test.** The `bfo` parents, the production learner, scales
beyond 1,536 updates, Arrows, the elixir-punishment and pocket scenarios, and
the capture value of the bank's own states.

**Decisions (November 19 review, adopted in this revision).**
1. **Stage 1 first,** with its stop rules. Stage 2 weights only the classes where capture resolves a match-point gain. Stage 1 also logs whether each forced cast landed, and reports the full-suite change.
2. **w = 10,** a single diagnostic dose, with sampling and aim diagnostics per weighted class.
3. **Match score stays primary,** with the −0.05 margin. Carrying the weight forward also requires capture to improve in the weighted class. This replaces the November 17 proposal, in which capture decided and match was only a guard.

**Owner decision, November 19:** approved for implementation, with **24 Stage 2
pairs**.

**Implementation and preflight (November 19; not evidence).** Run directory
`FG` = `~/edge_royale-runs/20261119-fireball-gap.noindex/`. `plan.md` restates
the rules with this run's settings.
- **Tooling** is in the [training doc](EDGER_TRAINING.md#decision-cadence-diagnostic-local-only-never-promotable): `fireball-branch`, `--opportunity-card-weight` with classes, and `--fireball-aim-diagnostics`. Every option is off by default.
- **Tests:** `PYTHON=/usr/local/bin/python3 npm test -- --test-concurrency=2` gave 278/278, including 10 new tests in `tests/edger-fireball-gap.test.js` and 3 new learner tests.
- **Source:** the base commit `5644331` plus `source.patch`. All 89 code files equal the working tree.
- **BC:** BC requires a clean Git checkout, so the new parents train in `bcrepo`, a clean clone of `5644331`. The patch does not touch `scripts/edger-v2-training.py`. Retraining `b0-s20260724` there gave `FR`'s weights exactly (24/24 tensors; only the checkpoint ID, environment and commit differ).
- **Plans:** one `replicate-seeds` call (r1–r17, w6–w17, smoke, smoke-w, r18–r29; `--training 768`).
  - It reproduces 308 earlier 768-seed plans byte for byte. The one that differs is `SS`'s own smoke plan, which came from another order.
  - r18–r29's 9,216 training seeds are disjoint from all 24,408 earlier seeds.
  - The sixth's 36 inputs match `SL/SHA256SUMS`.
- **A-r6 reproduction:** the full 24-iteration control from the frozen source, with aim diagnostics on, ended on exactly the eighth's A-r6 final weights.
  - Its aim file and the learner agreed on every class count in 1,536/1,536 episodes, with 0 engine/globals disagreements.
- **Promotion preflight:** `preflight.mjs` reproduced the sixth's gates for its full-grid r6 child, once run from the source directory. The parity check calls the Python learner by a relative path.
- **Smokes** (`smoke/`, models and parents outside the comparison):
  - **Stage 1:** `stage1.py` on the sixth's full-grid r6 child, 2 pairs per opponent. All 12 unforced games reproduced, branches and impacts were logged, and with one child the analysis gave "unresolved", with no launch.
  - **Stage 2:** `run.py` on the pilot parent `b0-s20260718` and the throwaway smoke plan (6 iterations × 4 pairs), once per class setting (lethal, cluster, both). The "both" run also trained a throwaway BC parent in `bcrepo` and ran its pair.
  - Every run passed iteration-0 identity and the plan checks, with 0 aim/learner mismatches.
  - B weighted only the chosen class's rows, and A weighted none. A's children were identical across the runs.
  - The evaluations, preflights and analysis completed, and `source/` and `bcrepo` were unchanged afterwards.
- **Analysis dry runs** on synthetic inputs gave the expected decision in all 18 cases (`dryrun/`):
  - Stage 1: lethal only, cluster only, both, both own-action-better, mixed, one child, identity failure, missing child.
  - Stage 2: carry, cost unresolved, beyond margin, flat capture, blocked, instrument, reference failure, incomplete, lethal only.
- **Pre-freeze exposure.** During implementation, a try-out of `fireball-branch` ran on **A-r6**, one of Stage 1's 12 children, instead of a model outside the population. Its summary was seen once:
  - lethal: 60 branches, mean Δ +0.017, 51 landed;
  - cluster: 129 branches, mean Δ +0.062, 78 landed;
  - all 300 unforced games reproduced.

  The output is kept in `FG/pre-freeze-exposure/` (SHA-256 `7e681f78…`). No rule changed after it. On November 19 the owner decided to proceed with this disclosure, with all 12 children. The frozen A-r6 result has the same games as the exposed file; only the run label differs.

#### Ninth comparison Stage 1 result

`FG` was frozen on November 19 (`FROZEN.txt`, 200 files) before any comparison output.
- **Run:** `stage1.py` ran once, in 413 s, and exited 0, with no retry, cap or instrument failure. `shasum -a 256 -c FROZEN.txt` passes after the run, and `FG/SHA256SUMS` covers 2,930 files.
- **Reproduction:** all 12 children completed, and all 3,600 unforced games reproduced the eighth's recorded hashes and points. No child's own action captured any opportunity, so every opportunity was branched.

| Class | Per-branch Δ, mean over 12 children [95% t] | Label | Full-suite change [95% t] (no label) | Branches | Landed |
|---|---|---|---|---|---|
| lethal | +0.029 [−0.001, +0.060], SD 0.048 | unresolved | +0.005 [−0.001, +0.011] | 676 | 86% |
| cluster | +0.022 [−0.021, +0.064], SD 0.067 | unresolved | +0.014 [−0.005, +0.033] | 1,764 | 62% |

**Frozen decision: no class is "capture better", so Stage 2 does not run;
stop and review with the owner.** Neither class is "own action better"
either, so the gate question is not returned as a cost. Under the comparison
rule, no extension or follow-up is chosen from this output.

Descriptive (no labels):
- Lethal: of 676 branches, the forced cast raised the match point in 50, lowered it in 32 and left it unchanged in 594.
  - 96 games ended before the Fireball landed, and each of the other 580 casts destroyed its tower.
  - The children's own games already scored 0.74–0.98 against each opponent.
- Cluster: of 1,764 branches, 211 gained and 161 lost. Landed casts averaged Δ +0.055 and missed ones −0.015.
- Per-child means ranged from −0.061 to +0.123 (lethal) and from −0.144 to +0.127 (cluster).
- The replaced own cards were mostly Mini PEKKA (334 lethal, 1,045 cluster) and Musketeer (292, 570).
- Limits, as designed: this is one forced cast per game, with the current children's aim and follow-up play, deterministic, against the three primary opponents.

**Owner decision, November 20:** the comparison is closed as recorded, with
no follow-up chosen from this output. The prepared Stage 2 stays frozen and
unlaunched, and the opportunity weight stays opt-in and unmeasured. Work
returns to the queue, starting with the league labelling repair
([training contract](EDGER_TRAINING.md#5-scaling-and-snapshot-league)).

## Limits

- The corpus is a 160-episode subset, not the production corpus.
- All models here (the seven reviewed, the 12 ablation models, the 9 RL children, and the v4 conversions and BC model) are local, non-promotable diagnostics.
- The RL comparison has three training runs of six iterations per schema, and its frozen intervals cover evaluation seeds only.
- JavaScript does not specify `**` or `Math.hypot` as correctly rounded. Cache rewards (`**`) differ in the last bits between Node v25 x86_64 and Node v20 arm64. The sim's `Math.hypot` agreed: every observation in the subset was identical under both. Other JavaScript engines are untested.
- Opportunity checks mirror the fixture scorers (Fireball radius plus entity radius, value ≥ 0.70, tower HP ≤ 207). They are not a strategic optimum.
- The RL suppression mechanism is inferred from model outputs, not traced through training.
- Proposal 3 tested one KL coefficient (0.05) and one oversampling factor (4), on the same subset, development seeds and three training runs. Its held-out capture uses 102 validation rows (18 lethal).
- The post-cap continuation is a recorded deviation from the proposal 3 plan; the frozen label at the cap was inconclusive only because outputs were missing.
- Option 1 tested one coefficient (0.05) and one row mask, with `P`'s parents, seeds and controls; the controls were trained on October 26–27 under code shown to reproduce them.
- The β = 1 follow-up tested one more coefficient on the same mask. Its same-host controls come from an addendum written after the frozen analysis was read; that addendum changed only the controls' host.
- Same-host training-run variance was measured once (six old-recipe runs on the M6): the child-primary SD is 0.118, strongly influenced by one valid low-scoring run. Three-run contrasts are below the modeled 80%-power target. Matched-difference spread was measured for rollout freshness at two scales: SD 0.075 at 384 updates and 0.229 at 1,536, each over 12 pairs.
- Rollout freshness was tested at two scales on the same 12 parents: 384 updates, and 1,536 with a 1,536-game rollout. Both used one refresh interval (64 games), one cache, the `train-arm` learner, `train-arm` opponents and development seeds. The production learner path was tested on fixed refreshed data in the third and fourth comparisons: it cost about 0.1, and attribution among its three behaviors is unresolved. The historical league used the same nominal champion–heuristic allocation as `train-arm`, with a 20.8% realized heuristic share and empty snapshot buckets. Snapshot opponents were tested once, in the eighth comparison: the arm's own actors every 256 updates over 1,536 updates, with direction unresolved. The historical critic-stratum fallback and the historical scale (about 11,318 updates) are untested. The stale-degeneration pattern is post hoc.
- RL training is bit-reproducible only on the same host (M1 against M6, PyTorch 2.11.0 with Accelerate). Host variation of a six-iteration child (up to 0.17 primary) is as large as most effects in this review, so every RL contrast here carries training-run uncertainty that its intervals do not cover. Future comparisons need same-host controls.

## Reproduction

```bash
X=~/edge_royale-runs/20261025-tactical-parity-warmup.noindex
N=$HOME/edge_royale-runs/20261006-runtime-cost-successor.noindex/out/bin/node
M=$X/models
MODELS="parent=$M/parent-lossless.json r0-learned=$M/r0-learned-full.json r1-learned=$M/r1-learned-full.json r2-learned=$M/r2-learned-full.json r0-fixed=$M/r0-fixed-full.json r1-fixed=$M/r1-fixed-full.json r2-fixed=$M/r2-fixed-full.json"
cd "$X/tactical"
$N probe-fixtures.mjs fixtures.json $MODELS
$N probe-corpus.mjs "$X/corpus/subset-manifest.json" "$X/corpus/objects" corpus-rows.jsonl $MODELS
python3 -I aggregate-corpus.py corpus-rows.jsonl corpus-summary.json
```

Observation v3 ablation (`V/README.md` describes every file). The caches were
built with each mirror's `scripts/edger-dataset.mjs --manifest "$V/manifest.json"`;
that exact command line was not saved, but the build reports were.

```bash
V=~/edge_royale-runs/20261025-observation-v3.noindex
export PATH=$HOME/edge_royale-runs/20260929T0346Z-cadence-confirmation/node-v20.20.2/bin:$PATH
cd "$V"
python3 -I structural.py v2/subset-decisions.parquet 24 > structural-v2.json
python3 -I structural.py v3/subset-decisions.parquet 31 v2/subset-decisions.parquet > structural-v3.json
bc/run.sh            # v2 and v3 BC; eval-bc.py, export, js-eval.mjs and games.mjs per model as in bc/run-arms-resume.sh
bc/run-arms.sh       # v3g and v3s BC
bc/run-arms-resume.sh
python3 -I teacher-placement.py "$X/tactical/corpus-rows.jsonl" > teacher-placement.txt
python3 -I summarize.py > summary.md
```

RL comparison (`W/README.md` describes every file). `run.sh` sets its own `PATH`
and is resumable: it skips finished steps.

```bash
W=~/edge_royale-runs/20261026-observation-rl-comparison.noindex
cd "$W"
bash run.sh                             # writes run.log and DONE
python3 -I analyze.py > analysis.md     # frozen
python3 -I posthoc.py > posthoc.md      # post-hoc, not frozen
```

Observation v4 (`Y/README.md` describes every file). `v4repo` is a scratch
mirror of the repository tree; `dense` is its `src/` and `scripts/` without the
conv's zero-product skip.

```bash
Y=~/edge_royale-runs/20261026-observation-v4.noindex
V=~/edge_royale-runs/20261025-observation-v3.noindex
export PATH=$HOME/edge_royale-runs/20260929T0346Z-cadence-confirmation/node-v20.20.2/bin:$PATH
cd "$Y"
node pins.mjs v4repo > pins-v4.json && node pins.mjs dense > pins-dense.json
(cd v4repo && node scripts/edger-dataset.mjs --manifest "$V/manifest.json" --out "$Y/v4/subset-decisions.parquet" --python /usr/local/bin/python3)
(cd "$V/v3srepo" && node scripts/edger-dataset.mjs --manifest "$V/manifest.json" --out "$Y/v3s-arm64/subset-decisions.parquet" --python /usr/local/bin/python3)
python3 -I cache-equal.py v4/subset-decisions.parquet v3s-arm64/subset-decisions.parquet "$V/v3/subset-decisions.parquet" "$V/v2/subset-decisions.parquet" > cache-equal-arm64.json
bash convert.sh    # six spell-only models converted to v4, plus the control
bash bc.sh         # fresh v4 BC, export and js-eval
```

Proposal 3 (`P/README.md` describes every file). `run.sh` and `post-cap.sh`
set their own `PATH` and skip finished steps; `post-cap.sh` is `run.sh` with a
24 h cap and its own log.

```bash
P=~/edge_royale-runs/20261027-proposal3.noindex
Y=~/edge_royale-runs/20261026-observation-v4.noindex
cd "$P"
(cd p3repo && OMP_NUM_THREADS=1 /usr/local/bin/python3 scripts/edger-v2-training.py bc --dataset "$Y/v4/subset-decisions.parquet" --out "$P/repro/b0-s20260718.pt" --seed 20260718 --epochs 6)
python3 -I repro/compare.py repro/b0-s20260718.pt "$Y/bc/v4-s20260718.pt" > repro/compare.json
bash run.sh                              # frozen; stopped at its 6 h cap
python3 -I analyze.py > analysis-at-cap.md
bash post-cap.sh                         # recorded continuation
python3 -I analyze.py > analysis.md      # frozen analysis, completed output
python3 -I posthoc.py > posthoc.md       # post-hoc, not frozen
```

Option 1, the targeted floor (`T/README.md` describes every file). `t1repo` is
a scratch mirror of the repository at `20a9c9e` with the option 1 working tree
committed on top (`62f0abc`). `run.sh` sets its own `PATH` and skips finished steps.

```bash
T=~/edge_royale-runs/20261030-targeted-floor.noindex
cd "$T"
bash repro/run-repro.sh                  # pre-plan check: iteration 0 of two P arms
bash run.sh                              # frozen; writes run.log and DONE
python3 -I analyze.py > analysis.md      # frozen
```

The stronger targeted floor (`S/README.md` describes every file). `s1repo` is
a clone of the repository at `5aff157`. `run.sh` and `run-m6.sh` set their own
`PATH` and skip finished steps.

```bash
S=~/edge_royale-runs/20261102-targeted-floor-beta1.noindex
T=~/edge_royale-runs/20261030-targeted-floor.noindex
P=~/edge_royale-runs/20261027-proposal3.noindex
cd "$S"
bash run.sh                                   # frozen; writes run.log and DONE
python3 -I analyze.py > analysis.md           # frozen
bash host-check/run.sh                        # post-hoc host check
python3 -I host-check/compare.py "$S" "$T" "$P" > host-check/compare.json
python3 -I host-check/compare2.py "$S" "$T" "$P" > host-check/compare2.json
bash run-m6.sh                                # addendum, frozen in FROZEN-m6.txt; writes m6/
python3 -I analyze-m6.py > analysis-m6.md     # addendum analysis
```

Same-host variance pilot (`VP/README.md` describes every file). `vrepo` is a
clone of the repository at `16e36b4`. `run.sh` sets its own `PATH` and skips
finished steps.

```bash
VP=~/edge_royale-runs/20261103-variance-pilot.noindex
cd "$VP/vrepo" && node scripts/edger-v2-cadence-experiment.mjs replicate-seeds --base "$VP/seeds/seed-plan-r0.json" --out-dir "$VP/seeds-gen" --replicates r1 r2 r3 r4 r5
cd "$VP"
bash run.sh                             # frozen; writes run.log and DONE
python3 -I analyze.py > analysis.md     # frozen
python3 -I posthoc.py > posthoc.md      # post hoc, not frozen
```

Rollout-freshness comparison (`FR/README.md` describes every file). `vrepo` is
a clone of the repository at `d345a49`. `run.sh` sets its own `PATH` and skips
finished steps.

```bash
FR=~/edge_royale-runs/20261106-rollout-freshness.noindex
cd "$FR/vrepo" && node scripts/edger-v2-cadence-experiment.mjs replicate-seeds --base "$FR/seeds/seed-plan-r0.json" --out-dir "$FR/seeds-gen" --replicates r1 r2 r3 r4 r5 r6 r7 r8 r9 r10 r11 r12 r13 r14 r15 r16 r17
cd "$FR"
nohup caffeinate -is bash run.sh > runner.out 2>&1   # frozen; writes run.log and DONE
python3 -I analyze.py > analysis.md                    # frozen
python3 -I posthoc.py > posthoc.md                     # post hoc, not frozen
```

Staleness-at-scale comparison (`SS/README.md` describes every file). `vrepo` is
a clone at `51e5969`; the parents are byte copies of `FR`'s.

```bash
SS=~/edge_royale-runs/20261106-staleness-scale.noindex
cd "$SS/vrepo" && node scripts/edger-v2-cadence-experiment.mjs replicate-seeds --base "$SS/seeds/seed-plan-r0.json" --out-dir "$SS/seeds-gen" --replicates r1 r2 r3 r4 r5 r6 r7 r8 r9 r10 r11 r12 r13 r14 r15 r16 r17 --training 768
cd "$SS"
nohup caffeinate -is bash run.sh > runner.out 2>&1   # frozen; writes run.log and DONE
/usr/local/bin/python3 -I analyze.py > analysis.md     # frozen
/usr/local/bin/python3 -I posthoc.py > posthoc.md      # post hoc, not frozen
```
