# Edger Bot Spec

## 1) Product Bot

The shipped game has one playable opponent: **Edger**.

Edger:

- is selected automatically; there is no bot level selector
- is deterministic for the same seed and input stream
- may use exact opponent elixir, hand, and deck queue
- acts every simulation tick
- returns only legal `PLAY_CARD` actions or `PASS`
- has no deliberate blunders, mercy rule, rubber-banding, or progression scaling
- is implemented as handcrafted oracle heuristics, not a neural model

## 2) Action Space

- `PLAY_CARD(cardId, x, y)`
- `PASS`

Edger and internal baselines can only choose legal placements and cards currently in hand with sufficient elixir.
Troop actions use legal deploy grid cells. Spell actions use snapped arena grid cells.

## 3) Internal Baselines

Internal baselines exist only for tests and `npm run bot:bench`.
They are not player-facing levels and must not appear in the browser UI.

- `random`: noisy legal actions with frequent passing.
- `aggressive`: over-commits into bridge pressure and spell chip.
- `defender`: waits longer, prioritizes defense, and commits mostly near elixir cap.

These baselines are intentionally weaker than Edger and exist to keep a deterministic benchmark signal.

## 4) Profile Rules

The browser profile stores only aggregate match stats against Edger:

- total matches
- wins
- losses
- draws
- timestamps

Old ladder/self-play profiles are ignored because profile storage uses `edge_royale_profile_v2`.
There are no unlocks and no self-play unlock rule.

## 5) Benchmark Gate

Run the Edger gate with:

```bash
npm run bot:bench -- --opponents random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6
```

The gate fails when Edger has no resolved games or has less than `0.60` resolved win rate against any internal baseline.

## 6) Removed Systems

The project intentionally does not ship:

- bot levels or ordered tiers
- progression unlock gates
- player mirroring/self-play gameplay
- local player-decision training
- neural model runtime manifests
- training export/promotion workflows
