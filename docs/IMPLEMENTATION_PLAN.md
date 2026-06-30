# Edge Royale Implementation Plan

## 1) Product Scope

### Goal

Build a lightweight, single-player Clash Royale-inspired game where the player fights one deterministic oracle bot named Edger.

### MVP

- Human vs Edger only. No online PvP.
- One arena.
- One fixed 8-card deck: Giant, Knight, Archers, Mini P.E.K.K.A, Musketeer, Goblins, Arrows, Fireball.
- Deterministic simulation with replay serialization for debugging.
- Simple local profile stats: matches, wins, losses, draws.
- Internal benchmark baselines for Edger tuning only.

### Out of Scope

- Player-facing bot levels.
- Unlock progression.
- Self-play or player mirroring.
- Model training, model manifests, training exports, and promotion workflows.

## 2) Technical Strategy

- `src/sim`: deterministic headless simulation engine.
- `src/client`: browser renderer/input layer over engine state.
- `src/ai`: Edger oracle policy, internal baselines, profile helpers, benchmarks.
- `src/replay`: replay serialization and compatibility helpers.
- `tests`: simulation, replay, profile, Edger, benchmark, and UI-layout coverage.

Core principles:

- Engine-first: game rules and combat run in headless mode before UI.
- Same seed + same input stream must produce identical output.
- UI must not implement rules independently.
- Edger must be legal-action-only even with hidden information.

## 3) Current Roadmap

1. Stabilize Edger's handcrafted oracle heuristics against internal baselines.
2. Add targeted tactical regression tests for defense, spell value, tower finishing, elixir advantage, and pocket pressure.
3. Improve browser smoke repeatability and runtime performance while keeping Edger every-tick deterministic.
4. Polish match readability, HUD clarity, and portrait usability.
5. Preserve replay compatibility for simulation debugging.

## 4) Quality Gates

Automated checks:

- `npm test`
- `npm run bot:bench -- --opponents random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6`
- `npm run smoke:browser`

Release gates:

- Determinism suite green.
- Edger clears the benchmark floor against every internal baseline.
- Browser smoke verifies Edger-only UI and simple profile persistence.
- No critical crash in simulated matches.

## 5) Risks and Mitigations

- Risk: Edger every-tick full-action scoring becomes expensive.
  - Mitigation: optimize action enumeration/scoring only after benchmark and browser smoke measurements show it is needed.
- Risk: Edger overfits to weak internal baselines.
  - Mitigation: add scenario-specific tactical tests and stronger internal benchmark scenarios over time.
- Risk: old ladder/self-play assumptions reappear.
  - Mitigation: keep README, AGENTS, tests, and UI aligned around Edger-only scope.
