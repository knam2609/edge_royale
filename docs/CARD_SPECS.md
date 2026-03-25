# Card Specs (Level 11 Tournament Baseline)

This file defines the current level 11 tournament-standard baseline for the fixed 8-card deck.
Engine-specific simplifications remain in place for mechanics we do not model yet.

## Global Conventions

- `deploy_time_s`: delay from placement to spawn/effect.
- `move_speed`: tiles per second after normalizing Clash Royale speed classes into engine values.
- `hit_speed_s`: seconds between attacks.
- `range_tiles`: target range.
- `sight_range_tiles`: aggro/vision radius used for target acquisition.
- `dps`: derived value for balancing checks only.

## 1) Giant

- Type: Ground troop, win condition.
- Cost: 5 elixir.
- HP: 4090.
- Damage: 253.
- Hit speed: 1.5s.
- DPS: 169.
- Move speed: 1.0 (`Slow`).
- Range: 1.2 tiles.
- Sight range: 7.5 tiles.
- Targets: Buildings only.
- Deploy time: 1.0s.

## 2) Knight

- Type: Ground troop, mini-tank.
- Cost: 3 elixir.
- HP: 1766.
- Damage: 202.
- Hit speed: 1.2s.
- DPS: 168.
- Move speed: 1.2 (`Medium`).
- Range: 1.2 tiles.
- Sight range: 5.5 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 3) Archers

- Type: Ranged ground troop pair.
- Cost: 3 elixir.
- Count: 2.
- HP each: 304.
- Damage each: 112.
- Hit speed: 0.9s.
- DPS each: 124.
- Move speed: 1.2 (`Medium`).
- Range: 5.0 tiles.
- Sight range: 5.5 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 4) Mini P.E.K.K.A

- Type: Ground troop, high single-target DPS.
- Cost: 4 elixir.
- HP: 1433.
- Damage: 755.
- Hit speed: 1.6s.
- DPS: 472.
- Move speed: 1.8 (`Fast`).
- Range: 0.8 tiles.
- Sight range: 5.5 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 5) Musketeer

- Type: Ranged support troop.
- Cost: 4 elixir.
- HP: 721.
- Damage: 217.
- Hit speed: 1.0s.
- DPS: 217.
- Move speed: 1.2 (`Medium`).
- Range: 6.0 tiles.
- Sight range: 6.0 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 6) Goblins

- Type: Ground swarm.
- Cost: 2 elixir.
- Count: 4.
- HP each: 202.
- Damage each: 120.
- Hit speed: 1.1s.
- DPS each: 109.
- Move speed: 2.4 (`Very Fast`).
- Range: 0.5 tiles.
- Sight range: 5.5 tiles.
- Targets: Ground units/buildings.
- Deploy time: 1.0s.

## 7) Arrows

- Type: Instant spell.
- Cost: 3 elixir.
- Radius: 3.5 tiles.
- Troop damage: 366.
- Tower damage: 93.
- Cast delay: 0.8s.
- Targets: Enemy ground units and towers.

## 8) Fireball

- Type: Projectile spell.
- Cost: 4 elixir.
- Radius: 2.5 tiles.
- Troop damage: 688.
- Tower damage: 207.
- Cast delay: 0.3s.
- Travel speed: 10.0 tiles/s.
- Targets: Enemy ground units/buildings.
- Knockback:
  - `distance_tiles=0.75`
  - `duration_ticks=5` (250ms at 20 TPS)
  - `immune_card_ids=["giant"]`

## Tower Baseline

- Crown tower:
  - HP: 3052.
  - Damage: 109.
  - Hit speed: 0.8s.
  - Range: 7.5 tiles.
- King tower:
  - HP: 4824.
  - Damage: 109.
  - Hit speed: 1.0s.
  - Range: 7.0 tiles.

## Notes

- Sight range remains an engine-level approximation unless we already have a sourced live value.
- Spell tower damage is explicit per spell instead of being derived from a shared chip percentage.
- Keep this sheet aligned to the level 11 tournament baseline unless the project explicitly introduces a custom balance layer.
