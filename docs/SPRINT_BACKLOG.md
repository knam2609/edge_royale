# Sprint Backlog

## Current Priorities

- `AI-ML-001` Harden deterministic ML runtime performance.
  - Done when full legal-action scoring stays inside the chosen per-tick budget and the benchmark suite is not materially slower than the frozen heuristic path.
- `AI-ML-002` Implement masked PPO/self-play trainer.
  - Done when `npm run edger:train` produces trained candidates from heuristic behavior cloning plus PPO against self-play snapshots and hidden baselines.
- `AI-ML-003` Build tactical scenario league and promotion reports.
  - Done when `npm run edger:evaluate` reports defense, spell value, tower finishing, elixir punishment, and pocket pressure scenario scores against `edger_heuristic`.
- `AI-ML-004` Enforce promotion gates.
  - Done when `npm run edger:promote` refuses candidates that miss schema, determinism, replay, timing, heuristic, baseline, or scenario requirements.
- `AI-EDGER-001` Add tactical regression scenarios for Edger defense.
  - Done when Edger correctly answers Giants, swarm pressure, and ranged support using legal actions.
- `AI-EDGER-002` Add tower-finishing and spell-value regression scenarios.
  - Done when Edger reliably chooses lethal or high-value Fireball/Arrows targets.
- `AI-EDGER-003` Tune elixir-advantage pressure.
  - Done when benchmark output and targeted tests show Edger punishes low opponent elixir without reckless overcommit.
- `AI-EDGER-004` Expand internal baselines or scripted scenarios.
  - Done when new baselines improve signal without becoming player-facing levels.
- `PERF-001` Measure and optimize every-tick Edger scoring.
  - Done when full-match benchmarks and browser smoke stay comfortably within local runtime expectations for ML Edger.
- `UI-001` Polish Edger-only setup overlay.
  - Done when the first screen starts the playable game with no old level/training language.
- `QA-001` Keep browser smoke deterministic and fast.
  - Done when `npm run smoke:browser` verifies UI, runtime, and profile persistence without flaky timing.
- `DOC-001` Keep docs aligned with Edger-only scope.
  - Done when README, AGENTS, and subsystem docs do not reference removed ladder/self-training systems except as explicitly removed scope.

## Completed Baseline

- Deterministic simulation engine.
- Fixed 8-card deck and card cycle.
- Royale-style placement, bridge, and pocket behavior.
- Replay serialization for debugging/determinism.
- Browser UI with portrait battlefield, card hand, elixir, tower HP, and match banners.
- Single Edger opponent with internal benchmark baselines.
- Frozen `edger_heuristic` baseline with `heuristic` alias.
- Deterministic ML runtime path for `edger` with promoted JSON plus generated JS module.
- Simple local Edger match profile.

## Non-Goals

- Online PvP.
- Player-facing bot levels.
- Unlock progression.
- Player-facing self-play/player mirroring.
- Browser training UI or model selectors.
