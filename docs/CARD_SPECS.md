# Card Specs (MVP v0.1)

This file defines initial balancing values for the fixed 8-card deck.
Values are intentionally approximate and should be tuned with simulation data.

## Global Conventions

- `deploy_time_s`: delay from placement to spawn/effect.
- `move_speed`: tiles per second.
- `hit_speed_s`: seconds between attacks.
- `range_tiles`: target range.
- `dps`: derived value for balancing checks only.

## 1) Giant

- Type: Ground troop, win condition.
- Cost: 5 elixir.
- HP: 2500.
- Damage: 90.
- Hit speed: 1.5s.
- DPS: 60.
- Move speed: 1.0.
- Range: 1.2 tiles.
- Targets: Buildings only.
- Deploy time: 1.0s.

## 2) Knight

- Type: Ground troop, mini-tank.
- Cost: 3 elixir.
- HP: 1400.
- Damage: 160.
- Hit speed: 1.2s.
- DPS: 133.
- Move speed: 1.2.
- Range: 1.2 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 3) Archers

- Type: Ranged ground troop pair.
- Cost: 3 elixir.
- Count: 2.
- HP each: 300.
- Damage each: 95.
- Hit speed: 1.1s.
- DPS each: 86.
- Move speed: 1.2.
- Range: 5.0 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 4) Mini P.E.K.K.A

- Type: Ground troop, high single-target DPS.
- Cost: 4 elixir.
- HP: 1200.
- Damage: 420.
- Hit speed: 1.6s.
- DPS: 262.
- Move speed: 1.3.
- Range: 1.2 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 5) Musketeer

- Type: Ranged support troop.
- Cost: 4 elixir.
- HP: 700.
- Damage: 190.
- Hit speed: 1.1s.
- DPS: 172.
- Move speed: 1.1.
- Range: 6.0 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 6) Goblins

- Type: Ground swarm.
- Cost: 2 elixir.
- Count: 3.
- HP each: 220.
- Damage each: 95.
- Hit speed: 1.0s.
- DPS each: 95.
- Move speed: 1.8.
- Range: 1.0 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 7) Arrows

- Type: Instant spell.
- Cost: 3 elixir.
- Radius: 3.0 tiles.
- Damage: 350.
- Cast delay: 0.8s.
- Targets: Enemy ground units only (MVP).

## 8) Fireball

- Type: Projectile spell.
- Cost: 4 elixir.
- Radius: 2.5 tiles.
- Damage: 520.
- Cast delay: 0.3s.
- Travel speed: 10.0 tiles/s.
- Targets: Enemy ground units/buildings.
- Knockback.

## Balancing Rules

- Cost efficiency target:
  - Same-cost direct counters should be close to neutral outcomes.
  - Swarm cards should lose value sharply against spells.
- Benchmark scenarios:
  - Giant + support push against defensive placements.
  - Equal-elixir bridge fights for each troop pair.
  - Spell value test with clustered units.
- Adjust max +/- 10% per tuning pass unless fixing broken interactions.
