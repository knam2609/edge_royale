# Bot Levels (MVP and Post-MVP)

## 1) Shared Bot Interface

Every bot implements:

- `observe(state)`: read current game state snapshot.
- `selectAction(state, legalActions)`: return one legal action or pass.
- `decisionDelayMs`: reaction delay budget.
- `errorModel`: optional action noise model.

## 2) Action Space

- `PLAY_CARD(cardId, x, y)`
- `PASS`

Bots can only choose legal placements and cards currently in hand with sufficient elixir.

## 3) Tier Definitions

## Noob (MVP)

- Strategy:
  - Uniform random legal card choice.
  - Random legal placement region.
  - No elixir forecasting.
  - No countering logic.
- Reaction delay:
  - 500-1500ms random.
- Error model:
  - 25% chance to delay play even with legal action.

## Mid-ladder Menace (MVP)

- Strategy:
  - Greedy aggression bias: prefers bridge pressure and same-lane stacking.
  - Weak defense; spends aggressively when elixir >= 7.
  - Light heuristic for spell value (casts if 2+ units hit).
- Reaction delay:
  - 350-900ms.
- Error model:
  - Occasional overcommit if elixir >= 8.

## Top Ladder (MVP)

- Strategy:
  - Elixir-aware decisions (reserve threshold before committing).
  - Tracks own cycle and estimates opponent cycle from seen cards.
  - Prefers efficient defense then counter-push.
  - Uses spell only above minimum expected value threshold.
- Reaction delay:
  - 250-650ms.
- Error model:
  - Low; occasional deliberate hold to avoid overcommit.

## Pro (Post-MVP)

- Strategy:
  - Better lane-pressure modulation.
  - Stronger trade evaluation (positive elixir trade targeting).
  - Better timing around double-elixir windows.
- Reaction delay:
  - 180-500ms.

## Goat (Post-MVP)

- Strategy:
  - Can run as a model-backed fair boss when a valid neural Goat artifact is supplied.
  - Scores every legal `PLAY_CARD(cardId, x, y)` candidate from fair public observations.
  - Falls back to the heuristic Goat policy when no valid model is loaded.
  - Keeps strong spell discipline and king-tower pressure choices as the fallback behavior.
- Reaction delay:
  - 120-350ms.

## God (Post-MVP)

- Strategy:
  - Oracle baseline with full opponent hand/elixir access (non-human constraint).
  - Used for upper-bound benchmarking only.
- Reaction delay:
  - 50-120ms.

## 4) Unlock Rules

- Initial unlocked tier: Noob.
- Unlock condition:
  - Beat current highest unlocked tier at least once to unlock next.
- Self-play unlock:
  - Complete at least 100 total matches and beat Top Ladder at least 3 times.

## 5) Benchmark and Promotion Criteria

Bots are promoted only if they meet both:

- Win-rate threshold:
  - `Top` vs `Mid` >= 65% over at least 500 seeded matches.
  - `Mid` vs `Noob` >= 70% over at least 500 seeded matches.
- Stability threshold:
  - Standard deviation of win-rate under target tolerance across 5 seed batches.

Neural Goat model artifacts additionally require:

- Dataset/replay reproducibility from saved seed and actions.
- Deterministic saved-model benchmark output for fixed seeds.
- Legal-action-only runtime behavior.
- Benchmark comparison against Noob, Mid, Top, heuristic Goat, and prior neural snapshots before replacing a playable boss model.

## 6) Anti-Cheat Constraints for Fair Tiers

For Noob/Mid/Top/Pro/Goat:

- Must not read hidden opponent hand.
- Must not read exact opponent elixir, only inferred estimate.
- Must obey human-like reaction delay and placement legality.
- Neural Goat feature encoders must preserve the same fair-observation boundary.

Only God tier can bypass these constraints for benchmark purposes.
