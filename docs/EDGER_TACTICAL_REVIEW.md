# Edger v2 tactical investigation — October 25, 2026

This covers Next Task 1 after the [runtime review](EDGER_RUNTIME_REVIEW.md):
Fireball card choice (logits, masks, corpus and teacher frequencies) and the
exact troop-placement ties found by the September 28
[tactical audit](EDGER_EVALUATION_DIAGNOSIS.md#tactical-suite-audit--september-27).

It is read-only. No gate, floor, scorer, fixture, model, observation or runtime
changed, and nothing here selects a model or clears a gate. The owner approved
the [proposals](#proposals--approved-october-25) on
October 25. Proposals 1–2 were implemented, ablated and compared under RL later (see
[below](#proposals-12-observation-v3-and-bc-ablation--october-2526-2026)),
and proposal 3 followed ([below](#proposal-3-data-and-learning-on-v4--october-27-2026)),
with its option 1, a [targeted floor](#option-1-targeted-floor--october-30-2026), on October 30;
those changes are outside this read-only investigation.

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
[observation schema v4](#spell-globals-only-v4--october-26-2026), and proposal 1's geometry is dropped. Proposal 3 is implemented as default-off learner options and tested in a [local experiment](#proposal-3-data-and-learning-on-v4--october-27-2026) (October 27), and the owner's option 1, a [targeted floor](#option-1-targeted-floor--october-30-2026), followed (October 30). Proposal 4 is not implemented. Each lands as its own change, with its own tests and fresh provenance.
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
committed locally and chose option 1 below, the stronger targeted floor.**
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
