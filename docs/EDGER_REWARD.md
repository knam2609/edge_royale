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
| `edger_potential_reward_v2` | Opt-in (`--reward edger_potential_reward_v2` on `collect` and `train-arm`). Counter table frozen November 10, 2026; weights still need the data check. Not yet used in training. | v1 plus position terms |

Every version has the same per-decision form, over the interval Δ ticks to the actor's next decision:

```text
reward = 0.9997^Δ × Φ(next decision) − Φ(now)      (+ 0.9997^Δ × (+1 / 0 / −1) on the last decision)
```

Over a game the shaping cancels out. A decision's discounted return is −Φ(now) + 0.9997^(T+1−t) × (Φ_end + result).

Version rules:
- The default stays v1. With the default, collection reproduces earlier runs byte for byte.
- One arm uses one version. The learner refuses a collection, an episode or a continuing checkpoint with a different version.
- `convert-collection` (the production path) accepts v1 only.
- Once a training run has used v2, any change to its constants needs a new version.

## v1: crowns and tower HP

```text
Φ_v1 = 0.25 × (our crowns − their crowns) + (our tower HP − their tower HP) / 30,000
```

## v2: position-aware (owner design, November 10, 2026)

Owner decisions:
- **Guide only.** The new terms extend Φ (potential-based shaping) and are 0 at game end. They give each move instant credit for improving the position, but cancel out over a game, so winning stays the only real goal and the terms can't be farmed.
- **Weights:** the owner sets them and a data check reviews them. They are frozen before training and never tuned on training results.
- **Elixir value:** 1 elixir ≈ 400 tower HP.

```text
Φ_v2 = Φ_v1 + (f(phase) × M + T + R + S) / 75        each term = ours − theirs
```

At game end, M, T, R and S are 0, and Φ_v1, the ±1 result and the discount are unchanged. v1 and v2 therefore differ only in the added terms. Every term is computed side by side, so blue's Φ is exactly minus red's.

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

### R: answer readiness (cycle)

For each enemy threat, whether a troop group on the board (by card) or a troop card in the enemy's hand:

```text
0.5 × cost × tier × urgency × best counter credit
```

- **Urgency:** on the board, the group's HP fraction (at most 1); in hand, 0.5.
- **Counter credit:** the maximum over the threat's counters of strength × availability × affordability.
  - Strength: strong 1.0, partial 0.5.
  - Availability: in hand 1.0, next in queue 0.5, otherwise 0.
  - Affordability: elixir ≥ cost 1.0, ≥ cost − 2 gives 0.5, otherwise 0.25.

R is our readiness against their threats minus theirs against ours. Edger may use the exact enemy hand, queue and elixir.

Effects:
- Playing your only counter needlessly loses readiness.
- Pushing Giant when the enemy has no affordable answer avoids raising theirs.
- Known simplification: one counter card can be credited against several threats.

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

## Remaining steps before v2 trains

1. **Data check** (frozen plan before output):
   - On fresh games, check that Φ_v2 predicts the winner at least as well as Φ_v1 at every 10 s checkpoint, and better on average.
   - Check that removing any one of M, T, R or S does not improve prediction.
   - Report reward magnitudes by component.
   - The owner may adjust the weights once, then they are frozen.
2. **Playstyle diagnostics** in evaluation summaries (descriptive): wasted elixir, counter responses, Giant plays into an affordable answer, and M/T/R at 60 s and 120 s.
3. **Fifth comparison** (v2 against v1), under the frozen comparison rule:
   - the same 12 parents and seeds, the `train-arm` learner, refreshed rollouts and 1,536 updates;
   - an identical critic-only warm-up in both arms;
   - the primary endpoint is the existing match-result primary score.

   The owner reviews the design before any run.
