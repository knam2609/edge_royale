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
- Deterministic offline-trained Edger policy with a frozen heuristic comparison baseline.
- Internal benchmark baselines for Edger evaluation only.

### Out of Scope

- Player-facing bot levels.
- Unlock progression.
- Player-facing self-play or player mirroring.
- Browser training UI, unlocks, model selectors, or player-facing model manifests.

## 2) Technical Strategy

- `src/sim`: deterministic headless simulation engine.
- `src/client`: browser renderer/input layer over engine state.
- `src/ai`: Edger ML runtime policy, frozen heuristic baseline, hidden baselines, profile helpers, benchmarks.
- `artifacts/edger-training/promoted`: promoted policy JSON and reports.
- `src/replay`: replay serialization and compatibility helpers.
- `tests`: simulation, replay, profile, Edger, benchmark, and UI-layout coverage.

Core principles:

- Engine-first: game rules and combat run in headless mode before UI.
- Same seed + same input stream must produce identical output.
- UI must not implement rules independently.
- Edger must be legal-action-only even with hidden information.
- Browser gameplay imports a generated JS model module; no async model fetch runs during matches.

## 3) Current Roadmap

1. Harden the daily PPO/self-play training loop with faster rollouts and better candidate quality.
2. Expand tactical scenario league coverage for defense, spell value, tower finishing, elixir advantage, and pocket pressure.
3. Promote only models that beat `edger_heuristic` and hidden baselines under the documented gate.
4. Keep GitHub Actions daily training green and artifact-producing at 4am Australia/Melbourne.
5. Polish match readability, HUD clarity, and portrait usability without exposing training or model selection.
6. Preserve replay compatibility for simulation debugging.

## 4) Quality Gates

Automated checks:

- `npm test`
- `npm run edger:evaluate -- --model artifacts/edger-training/promoted/edger_policy_current.json`
- `npm run bot:bench -- --opponents edger_heuristic,random,aggressive,defender --rounds 30 --seed 20260630 --max-ticks 6040 --min-win-rate 0.6`
- `npm run smoke:browser`

Release gates:

- Determinism suite green.
- Edger clears the benchmark floor against `edger_heuristic` and every hidden internal baseline before a model is considered promotable.
- Browser smoke verifies Edger-only UI and simple profile persistence.
- No critical crash in simulated matches.

## 5) Risks and Mitigations

- Risk: Edger every-tick full-action ML scoring becomes expensive.
  - Mitigation: compile sparse generated weights, keep feature extraction cheap for irrelevant spell cells, and add timing gates before promotion.
- Risk: Edger overfits to weak internal baselines or the frozen heuristic prior.
  - Mitigation: add scenario-specific tactical tests, self-play snapshots, and stronger internal benchmark scenarios over time.
- Risk: old ladder/self-play assumptions reappear.
  - Mitigation: keep README, AGENTS, tests, and UI aligned around Edger-only scope.
