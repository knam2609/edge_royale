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
- is implemented as a deterministic offline-trained ML policy

The in-game `edger` policy path:

- enumerates legal `PLAY_CARD` candidates with `enumerateLegalCardActions(...)`
- appends stable `PASS`
- encodes oracle state features with own/opponent elixir, hand, deck queue, tower state, phase, troop aggregates, and action features
- scores each legal candidate with a stateless feed-forward MLP
- chooses the highest logit with stable action-sort tie-breaks
- imports the promoted model from generated JavaScript, not an async browser fetch

The previous handcrafted oracle is frozen as `edger_heuristic`, with alias `heuristic`, for benchmarks and regression comparison only.

## 2) Model Format

Promoted model JSON lives at `artifacts/edger-training/promoted/edger_policy_current.json`.
Runtime JavaScript is generated at `src/ai/generated/edgerPolicyCurrent.js`.

Current schema:

- `schema_version: "edger_policy_model_v1"`
- `action_space_version: "full_snapped_grid_v1"`
- `feature_schema_version: "edger_oracle_features_v1"`
- `architecture.type: "masked_action_scorer_mlp"`
- `architecture.state_hidden: 64`
- `architecture.action_hidden: 32`
- `architecture.activation: "relu"`

Runtime validation rejects version mismatches, wrong dimensions, missing weights, and non-finite weight values.
Feature schema changes require retraining and promotion.

## 3) Action Space

- `PLAY_CARD(cardId, x, y)`
- `PASS`

Edger and internal baselines can only choose legal placements and cards currently in hand with sufficient elixir.
Troop actions use legal deploy grid cells. Spell actions use snapped arena grid cells.

## 4) Training and Promotion

Developer-only commands:

```bash
npm run edger:train -- --mode ppo --seed <seed> --profile <smoke|daily> --out-dir <run-dir>
npm run edger:evaluate -- --model artifacts/edger-training/promoted/edger_policy_current.json --json-out <report-json>
npm run edger:promote -- --model <candidate-json> --report <report-json> --require-gates
npm run edger:daily -- --seed <seed> --profile daily
```

Raw runs belong under ignored `artifacts/edger-training/runs/`.
Promoted JSON and reports belong under tracked `artifacts/edger-training/promoted/`.

The trainer exports deterministic masked PPO candidates from heuristic behavior cloning plus seeded self-play rollouts. The `@tensorflow/tfjs` package is a training-only development dependency; runtime/browser code must not import it. Daily automation runs from GitHub Actions at 4am Australia/Melbourne, uploads run artifacts for 30 days, and only opens a promotion PR when every required gate passes.

A candidate can replace the in-game model only when all pass:

- model vs `edger_heuristic`: point win rate `>= 0.55` and Wilson lower bound above `0.50`
- model vs `random`, `aggressive`, and `defender`: each resolved win rate `>= 0.60`
- tactical scenario league improves over heuristic aggregate score and required defense/spell/tower-finishing scenarios pass
- repeated same-seed policy matches produce identical action streams
- replay round-trip from generated actions preserves final hash/events
- runtime scoring p95 stays within the `5ms` per-tick budget on fixed fixtures
- browser UI exposes no training, levels, unlocks, or bot selector

## 5) Internal Baselines

Internal baselines exist only for tests and `npm run bot:bench`.
They are not player-facing levels and must not appear in the browser UI.

- `edger_heuristic`: frozen handcrafted oracle baseline; alias `heuristic`.
- `random`: noisy legal actions with frequent passing.
- `aggressive`: over-commits into bridge pressure and spell chip.
- `defender`: waits longer, prioritizes defense, and commits mostly near elixir cap.

`random`, `aggressive`, and `defender` are intentionally weaker smoke baselines.
`edger_heuristic` is the stronger frozen comparison baseline for promotion decisions.

## 6) Profile Rules

The browser profile stores only aggregate match stats against Edger:

- total matches
- wins
- losses
- draws
- timestamps

Old ladder/self-play profiles are ignored because profile storage uses `edge_royale_profile_v2`.
There are no unlocks and no self-play unlock rule.

## 7) Benchmark Gate

Run the Edger gate with:

```bash
npm run bot:bench -- --opponents edger_heuristic,random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6
```

The gate fails when Edger has no resolved games or has less than `0.60` resolved win rate against any internal baseline.

## 8) Removed Systems

The project intentionally does not ship:

- bot levels or ordered tiers
- progression unlock gates
- player mirroring/self-play gameplay
- browser training UI
- player-facing model manifests
