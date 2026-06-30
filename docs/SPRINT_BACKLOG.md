# Sprint Backlog

## Current Priorities

- `AI-EDGER-001` Add tactical regression scenarios for Edger defense.
  - Done when Edger correctly answers Giants, swarm pressure, and ranged support using legal actions.
- `AI-EDGER-002` Add tower-finishing and spell-value regression scenarios.
  - Done when Edger reliably chooses lethal or high-value Fireball/Arrows targets.
- `AI-EDGER-003` Tune elixir-advantage pressure.
  - Done when benchmark output and targeted tests show Edger punishes low opponent elixir without reckless overcommit.
- `AI-EDGER-004` Expand internal baselines or scripted scenarios.
  - Done when new baselines improve signal without becoming player-facing levels.
- `PERF-001` Measure and optimize every-tick Edger scoring.
  - Done when full-match benchmarks and browser smoke stay comfortably within local runtime expectations.
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
- Simple local Edger match profile.

## Non-Goals

- Online PvP.
- Player-facing bot levels.
- Unlock progression.
- Self-play/player mirroring.
- Local training exports or model promotion workflows.
