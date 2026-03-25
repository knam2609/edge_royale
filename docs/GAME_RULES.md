# Edge Royale Game Rules (Level 11 Tournament Baseline)

## 1) Match Format

- Mode: 1v1, player vs bot.
- Arena: single lane map with two king towers and two princess towers (one side per player).
- Stat baseline: current level 11 tournament-standard values for the supported deck and towers.
- Match duration: 180 seconds regulation.
- Overtime: 120 seconds sudden death if tied.
- Result priority:
  - Player/bot with more destroyed towers wins.
  - If still tied after overtime, higher total remaining tower HP wins.
  - If still tied, draw.

## 2) Simulation Timing

- Fixed tick rate: 20 ticks per second (`50ms` per tick).
- All movement, combat, and elixir updates happen on tick boundaries.
- RNG is seedable and deterministic.

## 3) Elixir System

- Starting elixir: 5.
- Max elixir: 10.
- Regen:
  - 0:00-2:00 elapsed: +1 elixir every 2.8 seconds.
  - 2:00-3:00 elapsed (double elixir): +1 elixir every 1.4 seconds.
  - Overtime (3x elixir): +1 elixir every 1.0 seconds.
- Spending elixir:
  - Card is deployable only if current elixir >= card cost.
  - Elixir deducted immediately when deployment is accepted.

## 4) Deck and Hand Rules

- Fixed deck (8 cards): Giant, Knight, Archers, Mini P.E.K.K.A, Musketeer, Goblins, Arrows, Fireball.
- Hand size: 4 visible cards.
- Draw order:
  - Initial hand is first 4 cards of shuffled deck (random).
  - After playing one card, next deck card fills hand slot.
  - Played card cycles to back of deck queue.
- Duplicate cards in hand are not possible.

## 5) Deployment Rules

- Ground troops can only be dropped on own side of arena.
- Spells can target valid map coordinates on either side.
- Multi-unit troops dropped on the center-most deploy columns split lane commitment evenly across the left and right bridges.
- A deployment request is invalid if:
  - Card not in current hand.
  - Insufficient elixir.
  - Coordinate out of legal placement region.
- Invalid requests are ignored and logged for telemetry.

## 6) Combat Model

- Units have:
  - Hit points.
  - Movement speed.
  - Sight range.
  - Attack range.
  - Attack cooldown.
  - Damage per hit.
  - Targeting rules.
- Troops only acquire targets that are inside sight range; attack range still determines when attacks can fire.
- Target selection priority:
  - Closest valid enemy by path distance.
  - If tie: lower HP first, then lower entity id.
- Projectiles:
  - Ranged attacks create projectile entities with travel time.
  - Damage is applied on projectile impact tick.
- Death handling:
  - Entity removed immediately after lethal damage resolution on tick.

## 7) Tower Rules

- Princess towers target nearest valid enemy in range.
- King tower activation:
  - Starts dormant.
  - Activates immediately once damaged or when a friendly crown tower falls.
  - No warm-up delay is modeled in this simplified engine.
- Tower destruction:
  - Destroyed tower is removed from targeting/attack system.
- Win by crown:
  - Destroying enemy king tower ends match instantly.

## 8) Movement and Pathing

- Troops follow shortest lane path toward opposing towers.
- Collision handling:
  - Soft separation to avoid exact overlap.
  - No advanced body-block simulation.
- Repathing:
  - Recompute target path if target is destroyed.

## 9) Spells

- Arrows:
  - Area-of-effect instant damage after cast delay.
  - Damages all enemy troops and towers in radius.
  - Uses explicit 366 troop damage and 93 tower damage.
- Fireball:
  - Projectile with travel time.
  - Area-of-effect damage plus short knockback.
  - Uses explicit 688 troop damage and 207 tower damage.
  - Knockback applies to troops only.
  - Giant is immune to Fireball knockback but still takes Fireball damage.

## 10) Determinism Contract

- Inputs are timestamped actions: `tick`, `cardId`, `x`, `y`, `actor`.
- Engine output hash must match for same seed and same input stream.
- All floating-point operations should be fixed-point or rounded consistently.

## 11) Out-of-Scope Simplifications

- Online multiplayer.
- Multiple arenas.
- Additional cards/decks.
- Emotes/clans/economy systems.
- Full Clash Royale parity such as air interactions, Arrows multi-wave timing, and real king-tower wake-up delay.
