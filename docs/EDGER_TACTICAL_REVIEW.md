# Edger v2 tactical investigation — October 25, 2026

This covers Next Task 1 after the [runtime review](EDGER_RUNTIME_REVIEW.md):
Fireball card choice (logits, masks, corpus and teacher frequencies) and the
exact troop-placement ties found by the September 28
[tactical audit](EDGER_EVALUATION_DIAGNOSIS.md#tactical-suite-audit--september-27).

It is read-only. No gate, floor, scorer, fixture, model, observation or runtime
changed, and nothing here selects a model or clears a gate. The owner approved
the [proposals](#proposals--approved-october-25-not-yet-implemented) on
October 25; none is implemented yet.

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

## Proposals — approved October 25, not yet implemented

**Owner decision, October 25, 2026.** All four proposals are approved as
written, including the scoring gate change in proposal 4. **None is implemented
yet.** Each lands as its own change, with its own tests and fresh provenance.
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

## Limits

- The corpus is a 160-episode subset, not the production corpus.
- All seven models are local, non-promotable diagnostics.
- Opportunity checks mirror the fixture scorers (Fireball radius plus entity radius, value ≥ 0.70, tower HP ≤ 207). They are not a strategic optimum.
- The RL suppression mechanism is inferred from model outputs, not traced through training.

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
