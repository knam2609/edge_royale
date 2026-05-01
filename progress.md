# Progress

## Current State

- As of May 2, 2026, the repo has an offline-first neural Goat training pipeline.
- Deterministic rollout export now produces replayable training episodes with fair observations, legal action candidates, chosen action labels, rewards, replay hashes, and state hashes.
- Goat can use a schema-validated neural legal-action MLP artifact for plain-JS runtime inference, and falls back to the heuristic Goat policy when no valid model is supplied.
- TensorFlow.js is installed for Node-side training scripts; generated datasets and models are written under ignored `artifacts/` paths by default.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and phase intent: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Neural training workflow and schemas: `docs/TRAINING_PIPELINE.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- Deterministic sim with fixed-tick combat, elixir pacing, overtime, replay hashing, Fireball knockback, route-aware target selection, tower blocker-aware pathing, bridge-edge clearance, and engaged tower-lock persistence.
- Training data export via `npm run data:export` generates deterministic episode datasets that can be replayed from saved actions.
- Training via `npm run train:goat` builds a TensorFlow.js MLP from exported legal-action rows and writes a schema-validated model artifact plus summary.
- Model benchmarking via `npm run model:bench` loads a saved neural Goat artifact and runs fixed-seed benchmark matches through the normal bot runtime.
- Unit coverage now includes neural feature size stability, model validation/inference determinism, replayable training datasets, supervised row generation, and model-backed Goat benchmark determinism.

## Known Gaps

- The neural Goat pipeline is operational, but the tiny smoke-trained model is not a promoted strong boss.
- The PSRO-lite implementation currently establishes the population/evaluation structure around supervised best-response training; richer zero-sum RL fine-tuning is still future work.
- Bot strength ordering is still not reliable enough to serve as a promotion gate.
- Browser validation is still an ad hoc skill-driven workflow rather than a single repo command with stable conventions.

## Next 3 Tasks

1. Run larger Goat training sweeps with fixed seeds, compare against heuristic Goat and prior neural snapshots, and record payoff summaries.
2. Stabilize ladder ordering by tuning `top` and `pro` heuristics against `mid`, then add stronger adjacent-tier benchmark assertions.
3. Add a repeatable browser smoke for bridge crossing, destroyed-lane bridge connector targeting, early-pull vs late-pull tower engagement, and model-backed Goat loading.

## Validation

- May 2, 2026: `npm test` -> 96 tests passed.
- May 2, 2026: `npm run data:export -- --episodes 1 --max-ticks 80 --seed 11 --out /private/tmp/edge_royale_goat_dataset.json` -> dataset hash `e321d0e7`, 1 episode, 3 samples.
- May 2, 2026: `npm run train:goat -- --dataset /private/tmp/edge_royale_goat_dataset.json --iterations 1 --epochs 1 --eval-rounds 1 --eval-max-ticks 80 --out /private/tmp/edge_royale_goat_model.json --summary-out /private/tmp/edge_royale_goat_summary.json` -> model and summary written; TensorFlow.js reported CPU backend guidance.
- May 2, 2026: `npm run model:bench -- --model /private/tmp/edge_royale_goat_model.json --tiers noob,mid --rounds 1 --max-ticks 80 --seed 22` -> both smoke matches drew (`0-0`, 1 draw each).
- May 2, 2026: `npm run bot:bench -- --tiers noob,mid,top --rounds 20 --seed 202` -> `mid` vs `noob` 0.375, `top` vs `noob` 0.467, `top` vs `mid` 0.158.

## Risks / Notes

- Neural Goat uses fair public observations only; keep hidden opponent hand and exact opponent elixir out of future feature encoders.
- Saved model evaluation is deterministic for fixed model + seed; TensorFlow.js training is recorded by config/seed/dataset hash rather than treated as cross-platform bit-for-bit weight reproducibility.
- Current model inference scores only legal `PLAY_CARD` candidates; pass/hold behavior still comes from fallback/no-legal-action paths and may need explicit modeling for stronger bosses.
- Ladder benchmark output still shows unstable tier ordering, so do not use current Top/Mid results as promotion gates yet.
