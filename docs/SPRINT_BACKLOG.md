# Sprint Backlog (Detailed)

This backlog assumes 10 one-week sprints. IDs are stable so they can become GitHub issues directly.

## Sprint 1: Foundations

- `ENG-001` Initialize monorepo structure (`sim`, `client`, `ai`, `data`, `tests`).
  - Done when: packages build independently and CI runs basic checks.
- `ENG-002` Implement fixed-tick simulation loop (20 TPS).
  - Done when: loop advances deterministic tick counter.
- `ENG-003` Add seedable RNG utility with deterministic test vectors.
  - Done when: same seed reproduces exact sequence in tests.
- `QA-001` Setup test framework and baseline CI workflow.
  - Done when: PR check runs unit tests and reports status.

## Sprint 2: Core Combat

- `SIM-001` Implement entity registry and lifecycle.
- `SIM-002` Implement troop movement and simple lane pathing.
- `SIM-003` Implement target acquisition and attack cooldown logic.
- `SIM-004` Implement tower attacks and tower HP tracking.
- `QA-002` Add unit tests for movement, targeting, and damage resolution.

## Sprint 3: Match Rules

- `SIM-005` Implement elixir regen/cap logic with phase timing.
- `SIM-006` Implement deck/hand/cycle rules for 8-card fixed deck.
- `SIM-007` Implement win conditions + overtime + tiebreak.
- `QA-003` Add determinism replay tests (golden hash snapshots).

## Sprint 4: Client Scaffolding

- `UI-001` Setup rendering engine and arena scene.
- `UI-002` Implement HUD: timer, elixir bar, tower HP.
- `UI-003` Implement card hand UI and drag/drop placement.
- `INT-001` Build engine-state to UI adapter layer.

## Sprint 5: End-to-End Playability

- `UI-004` Implement troop/spell visuals (spawn, projectile, hit).
- `FLOW-001` Implement match state transitions (start, active, end).
- `AI-001` Implement Noob bot policy.
- `QA-004` Add smoke test: full match playable without crash/desync.

## Sprint 6: Mid Tier + Progression

- `AI-002` Implement Mid-ladder Menace heuristics.
- `PROG-001` Add local profile persistence for unlocks/history.
- `PROG-002` Enforce tier unlock gating in UI and match start flow.
- `QA-005` Add progression persistence tests across app restart.

## Sprint 7: Top Tier + Replay

- `AI-003` Implement Top Ladder heuristics (elixir/cycle-aware).
- `DATA-001` Implement replay serialization/deserialization.
- `DATA-002` Add match history screen with replay references.
- `QA-006` Add replay determinism regression tests.

## Sprint 8: Telemetry Pipeline

- `DATA-003` Define telemetry schema v1 and event emission.
- `DATA-004` Build export script for offline dataset generation.
- `DATA-005` Add schema validation and version checks.
- `QA-007` Add telemetry completeness checks per match.

## Sprint 9: Self-Play Foundation

- `AI-004` Implement self-play unlock conditions.
- `ML-001` Build imitation-learning dataset builder from telemetry.
- `ML-002` Integrate baseline policy training pipeline.
- `QA-008` Add offline benchmark harness for trained policy.

## Sprint 10: RL + Hardening

- `ML-003` Integrate self-play RL fine-tuning pipeline.
- `ML-004` Add model promotion gates based on benchmark deltas.
- `PERF-001` Run performance and memory profiling pass.
- `REL-001` Final release checklist and cut MVP tag.

## Cross-Sprint Non-Functional Work

- `DOC-001` Keep `docs/*` specs updated for behavior changes.
- `SEC-001` Input validation and anti-corruption checks for replay loading.
- `OBS-001` Add structured error logs and crash diagnostics.
- `TOOL-001` Add dev scripts (`npm run sim:test`, `npm run bot:bench`, `npm run replay:verify`).

## Dependency Highlights

- `SIM-005`, `SIM-006`, `SIM-007` depend on `ENG-002` and `SIM-001`.
- `UI-003` depends on `SIM-006` card legality and elixir APIs.
- `AI-002`, `AI-003` depend on stable `selectAction` contract from `AI-001`.
- `ML-*` tasks depend on complete telemetry (`DATA-003` to `DATA-005`).

## Milestone Checkpoints

- Milestone A (end Sprint 3): deterministic headless playable simulation.
- Milestone B (end Sprint 5): human-playable game loop with Noob bot.
- Milestone C (end Sprint 7): ladder + progression + replay complete.
- Milestone D (end Sprint 10): self-play loop and MVP release readiness.
