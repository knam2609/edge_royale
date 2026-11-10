# Edger Training Reward

This doc describes the reward Edger is trained on. The reward is training-only. It does not change game rules, the live bot, the frozen `heuristic` baseline or how bots are evaluated: evaluation always uses match results.

Code:
- [`scripts/edger-reward-core.mjs`](../scripts/edger-reward-core.mjs): potentials and constants.
- [`scripts/edger-v2-cadence-core.mjs`](../scripts/edger-v2-cadence-core.mjs): `assignDecisionRewards`, the per-decision reward.
- [`scripts/edger-reward-duels.mjs`](../scripts/edger-reward-duels.mjs): counter duels.

## Versions

| Version | Status | Potential Φ |
|---|---|---|
| `edger_potential_reward_v1` | Default. Every model and comparison so far. | Crowns and tower HP |
| `edger_potential_reward_v2` | Opt-in (`--reward edger_potential_reward_v2` on `collect` and `train-arm`). Frozen November 11, 2026, after two data checks: counter table, weights, and R at weight 0. Not yet used in training. | v1 plus M, T and S |

Every version has the same per-decision form, over the interval Δ ticks to the actor's next decision:

```text
reward = 0.9997^Δ × Φ(next decision) − Φ(now)      (+ 0.9997^Δ × (+1 / 0 / −1) on the last decision)
```

Over a game the shaping cancels out. A decision's discounted return is −Φ(now) + 0.9997^(T+1−t) × (Φ_end + result).

Version rules:
- The default stays v1. With the default, collection reproduces earlier runs byte for byte.
- One arm uses one version. The learner refuses a collection, an episode or a continuing checkpoint with a different version.
- `convert-collection` (the production path) accepts v1 only.
- v2 is frozen. Any change to its constants needs a new version.

## v1: crowns and tower HP

```text
Φ_v1 = 0.25 × (our crowns − their crowns) + (our tower HP − their tower HP) / 30,000
```

## v2: position-aware (owner design, November 10, 2026)

Owner decisions:
- **Guide only.** The new terms extend Φ (potential-based shaping) and are 0 at game end. They give each move instant credit for improving the position, but cancel out over a game, so winning stays the only real goal and the terms can't be farmed.
- **Weights:** the owner sets them and a data check reviews them. They are frozen before training and never tuned on training results.
- **Final weights (November 11, 2026, after the data checks `RC` and `RC2`):** M, T and S at weight 1, and R at weight 0. R is still computed and reported in the potential's breakdown, for diagnostics.
- **Elixir value:** 1 elixir ≈ 400 tower HP.

```text
Φ_v2 = Φ_v1 + (f(phase) × M + T + 0 × R + S) / 75        each term = ours − theirs
```

The weights are `EDGER_REWARD_V2_TERM_WEIGHTS` (material 1, threat 1, readiness 0, support 1). At game end, M, T, R and S are 0, and Φ_v1, the ±1 result and the discount are unchanged. v1 and v2 therefore differ only in the added terms. Every term is computed side by side, so blue's Φ is exactly minus red's.

### M: material, scaled by `f(phase)`

M counts:
- banked elixir, including refill progress;
- each living troop at unit cost × HP fraction (unit cost is card cost / spawn count: an Archer is 1.5, a Goblin 0.5);
- the full cost of each card still deploying or spell in flight.

Consequences:
- Playing a card leaves M unchanged at the moment of play.
- Trades show up as material swings. For example, Goblins kill a Mini PEKKA and lose two goblins: +3 elixir, or +0.04.
- Elixir wasted at 10 shows up on its own.

`f(phase)` is the elixir refill ratio: 1 in normal time, ½ in double elixir, 20/56 in overtime. It scales all of M, so playing a card stays neutral in every phase.

### T: tower threat

For each living troop: tier × unit cost × HP fraction × position.
- **Tier:** Giant, Mini PEKKA and Musketeer 1.0; Knight, Archers and Goblins 0.25.
- **Position:** 0.25 on the owner's side, 0.75 across the bridge, 1.0 when locked onto an enemy tower.

Example: a full-HP Giant locked on a tower counts material plus threat = 10 units, about 0.13.

### R: answer readiness (cycle), as an unanswered-threat charge

**Weight 0 in Φ_v2: reported for diagnostics only** (owner, November 11, 2026). This is the owner's redesign of November 10, after the data check. It was re-checked in `RC2` (below): it helps alone but hurts given M and T.

For each enemy threat, whether a troop group on the board (by card) or a troop card in the enemy's hand, a side is charged:

```text
−0.5 × cost × tier × urgency × (1 − best counter credit)
```

- **Urgency:** on the board, the group's HP fraction (at most 1); in hand, 0.5.
- **Counter credit:** the maximum over the threat's counters of strength × availability × affordability.
  - Strength: strong 1.0, partial 0.5.
  - Availability: in hand 1.0, next in queue 0.5, otherwise 0.
  - Affordability: elixir ≥ cost 1.0, ≥ cost − 2 gives 0.5, otherwise 0.25.

R is our charge minus theirs, so it is always "ours − theirs" like the other terms. Edger may use the exact enemy hand, queue and elixir.

Effects:
- Holding a strong, affordable answer to a threat is neutral. A threat with no answer costs its full value.
- Being attacked never raises R: a new enemy threat adds charge unless it is fully answered.
- Playing your only counter needlessly brings back the charge for the threats it answered.
- Pushing Giant when the enemy has no affordable answer charges the enemy.
- Known simplification: one counter card can reduce the charge of several threats.

**First form (checked in `RC`, replaced):** credit for answers held, +0.5 × cost × tier × urgency × credit. It rose whenever enemy threats were on the board, so it partly mirrored the other side's pressure. Removing it improved winner prediction (see the data check). The two forms differ by our threat value minus theirs: new R = first-form R + Σ over our threats of 0.5 × cost × tier × urgency − the same sum over theirs.

### S: tank support

Each of our Archer, Musketeer or Goblin units adds 0.25 × unit cost × HP fraction when one of our Knights or Giants is in the same lane (|dx| ≤ 2 tiles) and 0–5 tiles ahead of it, toward the enemy.

## Counter table (frozen November 10, 2026)

| Threat | Strong | Partial |
|---|---|---|
| Giant | Mini PEKKA, Goblins, Musketeer | Archers, Knight |
| Musketeer | Mini PEKKA | Fireball, Knight |
| Mini PEKKA | Goblins, Knight, Archers | Musketeer |
| Archers | Arrows | Fireball, Knight |
| Goblins | Arrows | Musketeer, Knight |
| Knight | Mini PEKKA | Goblins, Musketeer |

How it was set:
- The owner drafted the table.
- It was checked by counter duels: `node scripts/edger-reward-duels.mjs --out <dir>`, run in `~/edge_royale-runs/20261110-reward-duels.noindex/`.
- The owner then chose "draft plus the changes the duels clearly support."

### Duel method

The rules were fixed before the run:
- Red pushes one lane with the threat. The scenarios are a lone threat, and Musketeer or Archers two tiles behind a Giant.
- Blue answers with one card, using the placements bots can actually use.
- Towers fight as usual.
- Each pair runs in 2 lanes × 2 response times, keeping the best placement in each.
- **net** = red elixir destroyed − blue elixir lost − blue tower HP lost / 400.
- **value** = net − the net with no answer.

### Duel findings (median value in elixir)

- **Giant:** Mini PEKKA +7.3, Goblins +6.7, Musketeer +5.7, Archers +5.4, Knight +4.8. Spells don't help (Arrows −3.0, Fireball −4.0).
- **Musketeer:** Fireball does 688 damage and can't kill a 721-HP Musketeer.
  - Against a lone Musketeer, Fireball is −2.1, because the tower already handles a lone Musketeer (no answer is +1.8).
  - Behind a Giant, Fireball is +0.7 while Mini PEKKA is +11.8.
- **Archers and Goblins:**
  - Alone, the tower handles them. Every spell is a bad trade (−1.8 to −3.2), and troops add at most +1.2.
  - Behind a Giant, Arrows +7.7 and Fireball +6.7 are strong answers to Archers.
- **The pre-set labels were too generous:** strong meant value ≥ +1 in 4/4 variants. Compared with no answer, almost every troop qualified against every lone threat. The final table is therefore the owner's judgment, informed by the values, not the pre-set labels.

### Limits

- Duels are single engagements with no follow-up play.
- Supported pushes were tested only for Musketeer and Archers behind a Giant.
- **Bots can place troops at only four cells:** the three bridge-front cells and the back-center cell, plus pocket cells once an enemy crown tower falls. Placement strongly affects every counter. For example, Musketeer answers a Giant only from its own lane's bridge cell. This is existing action-space behavior and a separate follow-up task.

## Data check (November 10, 2026)

Run `RC` = `~/edge_royale-runs/20261110-reward-check.noindex/`. The plan, generator and analysis were frozen before any main game (`FROZEN.txt`, clean clone at `4ec6098`).

**Design:**
- 1,960 games on 1,080 new seeds. The seeds exclude the frozen suites, every earlier run's seed plans and the duel seed.
  - The heuristic plays aggressive, defender and random (200 games each, both sides) and itself (200 seeds, once each, because swapping sides replays the identical game).
  - Live v1 plays the heuristic in 200 games.
  - The 12 `SS` A′ children each play the heuristic in 80 games.
- At every 10 s checkpoint, each score (Φ_v1, Φ_v2, and Φ_v2 minus one term) gets its own logistic fit of the winner, an intercept plus a slope. The fit is for the comparison only and changes no weight.
- Metric: log-loss. Intervals: a stratified cluster bootstrap by seed, 2,000 replicates.
- 26 checkpoints (10–260 s) had the required 200 decisive games in progress.

**Preflight:**
- The generator reproduced `runEdgerV2CadenceMatch` exactly on smoke seeds, including decision potentials.
- Recording changed no game.
- A rerun was byte-identical.
- The analysis rebuilt the collector's per-decision rewards to within 2.2e-16.

**Frozen results:**

| Check | Result |
|---|---|
| C1: no worse than v1 at each checkpoint (upper bound of the log-loss difference ≤ +0.01) | **FAIL** at 250 s and 260 s only. The point estimates there favor v2 (−0.028, −0.025), but with 248 and 212 games the intervals reach +0.021 and +0.027. At the other 24 checkpoints the whole interval is below 0. |
| C2: better than v1 on average | **PASS**: −0.0374 [−0.0444, −0.0302] |
| C3: no term hurts | **FAIL**: removing R *improves* prediction, −0.0036 [−0.0050, −0.0022]. M (+0.0138) and T (+0.0169) contribute. S has no measurable effect (−0.0002 [−0.0011, +0.0005]). |
| C4: shaping small next to ±1 (p95 ≤ 0.25) | **PASS**: \|Φ_v2 − Φ_v1\| p95 0.106; per-game \|position-shaping sum\| p95 0.072 |

**Descriptive results:**
- Adding one term alone to v1 changes log-loss by: M −0.027, T −0.028, S −0.002, R +0.007 (worse).
- At 10 s, v2's AUC is 0.738 against v1's 0.480, while tower HP has barely moved.
- A multi-term fit, context only, puts M at about 2.1× and T at about 2.2× their v1-equivalent weight, and R at −2.4×.
- In child games, the position part's per-decision |reward| averages 0.013 (p95 0.043). v1's averages 0.007 (p95 0.019), with rare crown steps of about 0.25.

**Post hoc** (not a check): R correlates −0.40 with T and −0.29 with v1. As defined, a side gains readiness when *enemy* threats are on the board and loses it when its own threats are, so R partly mirrors the other side's pressure. This is a likely mechanism, not a tested one.

**Owner decision (November 10, 2026): redesign R, then re-check.** R becomes the unanswered-threat charge above, a new formula rather than a weight change, so it gets its own frozen check on fresh seeds (`RC2`) before the weights freeze. M, T and S are unchanged.

### Re-check with the redesigned R (`RC2`, November 10, 2026)

Run `RC2` = `~/edge_royale-runs/20261110-reward-check-r2.noindex/`.
- **Design:** the same as `RC`, with byte-identical `analyze.py`, `fidelity.mjs` and `run.sh`. The 1,960 games use 1,080 fresh seeds, disjoint from `RC`'s.
- **Code:** a clean clone at `4ec6098` plus `r-redesign.patch`, which changes R and its test.
- **Preflight:** fidelity 368/368, a byte-identical repeat, and rewards rebuilt within 2.2e-16.
- **Freeze:** `FROZEN.txt`, 28 hashes, written before output.

| Check | `RC2` (charge form) | `RC` (credit form) |
|---|---|---|
| C1 | **FAIL** at 240, 250 and 260 s (274–216 games, intervals about ±0.06). At 260 s: +0.045 [−0.012, +0.105]. At the other 23 checkpoints the whole interval is below 0. | FAIL at 250 and 260 s |
| C2 | **PASS**: −0.0409 [−0.0493, −0.0323] | PASS: −0.0374 |
| C3 | **FAIL**: removing R improves, −0.0046 [−0.0068, −0.0027]. M (+0.0116) and T (+0.0106) contribute; S has no measurable effect (−0.0001). | FAIL: −0.0036 |
| C4 | **PASS**: p95 0.121 and 0.067 | PASS |
| v1 + R alone (descriptive) | −0.0041 [−0.0061, −0.0022], helps | +0.0071, hurts |

Post hoc (not checks):
- The charge form correlates +0.36 with T and +0.42 with M. The credit form correlated −0.40 with T.
- Given M and T, R still has a negative association (context-only multi-term fit: −2.06 × v1).
- Likely reading: R's new information mostly duplicates M and T, while its leftover credit-for-answers part keeps the negative association.

**Owner decision (November 11, 2026): drop R, keep M, T and S.** R's weight is 0, and the frozen v2 is exactly the "v2 minus R" score both checks measured. It predicted the winner better than the full v2 in both runs: by 0.0036 nats in `RC` and 0.0046 in `RC2`. That makes about −0.045 against v1 on average in `RC2`, an arithmetic sum of frozen point estimates, with no separate interval. This ends the one-time adjustment. The weights are frozen and are not re-tuned on `RC` or `RC2` games.

Not covered by the checks:
- C1's label stays FAIL in both runs: at the last overtime checkpoints (about 220–270 games) the samples cannot show v2 is no worse.
- The frozen v2 (without R) was not run through C1 as its own score.
- R's charge form is kept for diagnostics: cycle play can be watched without being rewarded.

## Remaining steps before v2 trains

1. **Playstyle diagnostics** in evaluation summaries (descriptive): wasted elixir, counter responses, Giant plays into an affordable answer, and M/T/R at 60 s and 120 s.
2. **Fifth comparison** (v2 against v1), under the frozen comparison rule:
   - the same 12 parents and seeds, the `train-arm` learner, refreshed rollouts and 1,536 updates;
   - an identical critic-only warm-up in both arms;
   - the primary endpoint is the existing match-result primary score.

   The owner reviews the design before any run.
