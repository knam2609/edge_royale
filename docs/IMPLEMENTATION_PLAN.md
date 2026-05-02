# Edge Royale Implementation Plan

## 1) Product Scope

### Goal
Build a lightweight, single-player Clash Royale-inspired game where players fight progressively stronger bots, unlock tiers by beating previous tiers, and eventually unlock self-play AI that improves from gameplay data.

### MVP (v0.1)
- Human vs bot only (no online PvP).
- One arena.
- One fixed 8-card deck: Giant, Knight, Archers, Mini P.E.K.K.A, Musketeer, Goblins, Arrows, Fireball.
- Bot tiers shipped: Noob, Mid-ladder Menace, Top Ladder.
- Progression lock: must beat prior tier to unlock next.
- Match history + replay export.

### Post-MVP (v0.2+)
- Add Pro, Goat, God tiers.
- Add training pipeline for self-play unlock.
- Add imitation + RL loop for personalized bot.

## 2) Technical Strategy

### Architecture (monorepo)
- `packages/sim`: deterministic headless simulation engine (game rules, combat, elixir, card cycle).
- `packages/client`: browser game UI (rendering, input, HUD, match flow).
- `packages/ai`: bot policy interface and tier implementations.
- `packages/data`: telemetry schema, replay serialization, offline export tools.
- `packages/tests`: simulation regression tests, bot-vs-bot benchmark suite, replay determinism tests.

### Core principles
- Engine-first: game rules and combat run in headless mode before UI.
- Deterministic simulation with fixed tick rate and seedable RNG.
- UI is a consumer of engine state, never source-of-truth.
- Every bot decision uses a shared action API for easy benchmarking.

## 3) Execution Roadmap

## Phase 0: Spec Lock (3-5 days)

### Tasks
- Finalize gameplay constants and match format.
- Define all 8 card stats and behavior contracts.
- Define bot tier behavior contracts and acceptance win-rate targets.
- Define telemetry event schema and replay format v1.

### Deliverables
- `docs/GAME_RULES.md`
- `docs/CARD_SPECS.md`
- `docs/BOT_LEVELS.md`
- `docs/TELEMETRY_SCHEMA.md` (next)

### Acceptance criteria
- No unresolved TBD fields for MVP behavior.
- Sim team and UI team can implement independently from docs.

## Phase 1: Simulation Engine (1.5-2 weeks)

### Tasks
- Implement fixed-tick loop and seedable RNG.
- Implement entities: troops, projectiles, towers, spells.
- Implement movement/pathing and target selection.
- Implement damage resolution and death lifecycle.
- Implement elixir regen/cap and card hand/cycle system.
- Implement win conditions, overtime, and sudden-death logic.
- Implement Fireball knockback with troop-only displacement and Giant immunity.

### Acceptance criteria
- Same seed + same input stream => identical output hash.
- Unit tests for all core subsystems pass.
- 100+ replay determinism tests pass locally.
- Overtime elixir timing verified at 3x pace (`+1 every 1.0s`) and Fireball knockback immunity tests pass.

## Phase 2: Playable Client UI (1-1.5 weeks)

### Tasks
- Arena rendering and camera/layout scaling (desktop + mobile).
- Card hand UI, drag/drop placement validation, elixir bar.
- Tower HP bars, timer, match state banners.
- Basic SFX/VFX and spawn/projectile hit animations.
- Engine-to-UI adapter with state interpolation.

### Acceptance criteria
- Full match playable end-to-end with no desync.
- 60 FPS target on standard laptop browser.
- Input latency acceptable for manual play testing.

## Phase 3: Bot Ladder v1 (1.5-2.5 weeks)

### Tasks
- Define `BotPolicy.selectAction(state, legalActions)` interface.
- Implement Noob (uniform random legal actions + random delays).
- Implement Mid-ladder Menace (aggressive push heuristics).
- Implement Top Ladder (elixir-aware + cycle-aware heuristics).
- Build automated benchmark harness (`bot_a` vs `bot_b`, N seeds).

### Acceptance criteria
- Tier ordering holds in benchmarks (Top > Mid > Noob).
- Win-rate stability within confidence interval across seed batches.

## Phase 4: Progression + Persistence (4-6 days)

### Tasks
- Local profile persistence (unlocks, match count, wins).
- Unlock logic based on tier victory.
- Match result history and replay reference storage.
- Add reset profile/dev cheat flags for testing.

### Acceptance criteria
- Unlock state survives restart.
- Locked tiers cannot be entered by normal flow.

## Phase 5: Telemetry + Data Pipeline (1-1.5 weeks)

### Tasks
- Emit structured event stream per tick/action.
- Serialize replay files (`.jsonl` or binary + index).
- Build offline export script for training datasets.
- Add schema versioning and validation checks.
- Export deterministic training episodes with fair observations, legal actions, chosen action, reward, result, seed, replay hash, and state hash.

### Acceptance criteria
- Every match generates valid telemetry + replay artifacts.
- Export pipeline supports filtering by bot tier, result, and date.

## Phase 6: Self-Play Unlock + AI Training (2-4 weeks)

### Tasks
- Define unlock rule (example: 100 completed matches minimum).
- Train model-backed fair ladder tiers from deterministic rollout export (`noob`, `mid`, `top`, `pro`, `goat`) while keeping heuristic fallbacks.
- Train baseline policy from logged player data (imitation stage).
- Run self-play fine-tune (RL stage) with periodic evaluation.
- Add safety gates to prevent deploying regressed models.
- Train a model-backed fair Goat boss from generated rollout data before promoting stronger self-play variants.
- Use TensorFlow.js for offline training and plain-JS MLP inference in gameplay/runtime benchmarks.

### Next implementation slice for self bot
- Log full public-observation decision samples from player matches, including legal action candidates and chosen action index.
- Replace the current bucket-count self model with a legal-action scorer initialized from player imitation data.
- Add a batched retrain flow: always collect samples, retrain only when enough new data exists and the player triggers training.
- Fine-tune the self model with RL against frozen self checkpoints and nearby ladder opponents while preserving player style with held-out similarity gates.

### Acceptance criteria
- Self bot improves on benchmark suite over baseline.
- Training outputs are reproducible from saved config + seed.
- Saved neural fair-tier artifacts validate against schema, return only legal actions, and produce deterministic benchmark output for fixed model + seeds.

## Phase 7: Stabilization and Release (1 week)

### Tasks
- Regression test pass on simulation and bot benchmarks.
- Performance profiling and memory leak checks.
- Tuning pass for card balance and bot behavior edge cases.
- Create release notes and rollout checklist.

### Acceptance criteria
- Zero P0/P1 bugs open.
- Release checklist complete.

## 4) Sprint Plan (10 one-week sprints)

### Sprint 1
- Repo scaffolding.
- Test harness setup.
- Deterministic tick loop + RNG.

### Sprint 2
- Troop/tower/spell core mechanics.
- Pathing + targeting.

### Sprint 3
- Elixir + hand/cycle system.
- Win conditions + overtime.
- Determinism tests.

### Sprint 4
- UI arena + HUD base.
- Card placement input.

### Sprint 5
- Full playable match loop.
- Noob bot.

### Sprint 6
- Mid-ladder bot.
- Benchmark harness.
- Progression storage.

### Sprint 7
- Top Ladder bot.
- Replay save/load.

### Sprint 8
- Telemetry schema + export pipeline.
- Dashboard scripts for data sanity.

### Sprint 9
- Self-play unlock flow.
- Imitation training baseline.

### Sprint 10
- RL fine-tune integration.
- Stabilization + release hardening.

## 5) Testing and Quality Gates

### Automated tests
- Unit tests: card logic, pathing, targeting, elixir math.
- Integration tests: full match simulations with golden hashes.
- Replay tests: deserialize + re-simulate equality checks.
- Bot tests: pairwise win-rate benchmark matrix.

### Release gates
- Determinism suite green.
- Benchmark matrix respects required tier ordering.
- No critical crash in 1,000 simulated matches.

## 6) Risks and Mitigations

- Risk: simulation and UI drift.
  - Mitigation: UI renders engine snapshots only; replay-based visual verification.

- Risk: bot behavior overfitting to one strategy.
  - Mitigation: benchmark on diverse seeded scenarios and scripted openings.

- Risk: RL instability and regressions.
  - Mitigation: offline model promotion gates + fixed benchmark suite.

- Risk: scope creep.
  - Mitigation: lock MVP to single deck/single arena/no PvP.

## 7) Definition of Done

MVP is done when:
- A player can launch, choose unlocked bot tier, and complete a full match.
- Progression unlocks work.
- Replay + telemetry are generated.
- Top Ladder bot reliably outperforms lower tiers.
- Test suites and release gates are green.
