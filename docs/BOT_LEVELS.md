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
The model action space is `full_snapped_grid_v1`: troops use every legal deploy grid cell, and spells use every snapped arena grid cell.

## 3) Tier Definitions

Noob/Mid/Top/Pro/Goat can all run through the same legal-action neural scorer when a valid same-tier artifact is supplied. If no valid artifact is loaded, they fall back to the current heuristic implementations.

Self Play uses a local `legal_action_mlp` trained from the player's public-observation decision samples. It scores only currently legal actions, runs a reward-weighted RL v1 fine-tune after imitation, and falls back to Top-style heuristics when no ready self model is available.

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
  - Can run as a model-backed fair boss when a valid same-tier neural artifact is supplied.
  - Scores every legal fair-observation candidate, including synthetic `PASS` in `goat_action_features_v2`.
  - Falls back to the heuristic Goat policy when no valid model is loaded.
  - Keeps strong spell discipline and king-tower pressure choices as the fallback behavior.
- Reaction delay:
  - 120-350ms.

## God (Post-MVP)

- Strategy:
  - Playable boss tier after Goat.
  - Uses a same-tier `legal_action_mlp` when a valid God artifact is supplied.
  - Uses `god_state_features_v1`, which adds exact opponent elixir, opponent hand, and opponent deck queue to the fair public feature vector.
  - Falls back to the internal God oracle heuristic when no valid model is loaded.
  - `god_oracle` is an internal teacher/benchmark path, not a UI-selectable tier.
- Reaction delay:
  - 50-120ms.

## 4) Unlock Rules

- Initial unlocked tier: Noob.
- Unlock condition:
  - Beat current highest unlocked tier at least once to unlock next.
- Self-play unlock:
  - Complete at least 100 total matches and beat Top Ladder at least 3 times.

## 5) Benchmark and Promotion Criteria

Fair ladder promotion now uses two gates:

- Daily fair refresh gate:
  - Runs in `.github/workflows/daily-ladder-training.yml`.
  - Validates candidate artifacts, determinism, and matrix improvement signal.
  - Produces candidate manifests and artifacts for manual review.
  - Does not update tracked fair runtime models.
- Strict fair promotion gate:
  - Runs locally with `npm run train:ladder:strict -- ...` or in `.github/workflows/strict-fair-ladder-promotion.yml`.
  - Uses full-match `6040` tick games.
  - Uses `5` fixed seed batches of `100` rounds for each adjacent fair pair.
  - Applies the calibrated pair floors below plus stability and non-regression checks before tracked fair models can change.

Strict fair adjacent pair thresholds:

- `Mid` vs `Noob` mean resolved win rate >= `0.72`
- `Top` vs `Mid` mean resolved win rate >= `0.67`
- `Pro` vs `Top` mean resolved win rate >= `0.52`
- `Goat` vs `Pro` mean resolved win rate >= `0.52`
- Every adjacent pair mean resolved fraction >= `0.75`
- Every adjacent pair win-rate stddev across the `5` batches <= `0.08`
- No adjacent pair may regress versus the checked-in fair baseline by more than `0.05` resolved win rate
- No adjacent pair may regress versus the checked-in fair baseline by more than `0.05` resolved fraction

Current strict thresholds are seeded from the May 9, 2026 calibration pass inputs:

- checked-in promoted fair ladder manifest `artifacts/training/ladder-models.json`
- May 8, 2026 daily candidate artifact from run `25516896901`

Neural fair-tier model artifacts additionally require:

- Dataset/replay reproducibility from saved seed and actions.
- Deterministic saved-model benchmark output for fixed seeds.
- Legal-action-only runtime behavior.
- Benchmark comparison against heuristic same-tier, adjacent fair tiers, and prior neural snapshots before replacing a playable tier.

Daily GitHub Actions training may still open or update the manual-review branch under the lighter improvement gate when God passes. Fair tracked runtime promotion remains blocked on the strict gate above, even if the lighter fair refresh gate passes.

God model artifacts use a separate daily gate. Bootstrap accepts the first valid deterministic same-tier God model. After a baseline God model exists, a candidate must avoid regression versus Goat and score at least `50%` resolved win rate against the prior God model on the fixed-seed comparison.

## 6) Anti-Cheat Constraints for Fair Tiers

For Noob/Mid/Top/Pro/Goat:

- Must not read hidden opponent hand.
- Must not read exact opponent elixir, only inferred estimate.
- Must obey human-like reaction delay and placement legality.
- Neural fair-tier feature encoders must preserve the same fair-observation boundary.

Only playable God and internal `god_oracle` can bypass these constraints. They must still return legal actions only.
