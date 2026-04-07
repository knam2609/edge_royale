# Progress

## Current State

- As of April 8, 2026, the repo contains a playable browser prototype backed by a deterministic headless simulation.
- The current product shape is a lightweight single-player Clash Royale-inspired game with one arena, a fixed 8-card deck, local bot ladder progression, replay support, and local self-play training scaffolding.
- `progress.md` is now a live handoff only. Git history is the archive for prior implementation details.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and phase intent: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- Deterministic sim with fixed-tick combat, elixir pacing, overtime, match resolution, replay hashing, and Fireball knockback with Giant immunity.
- Playable browser client with six-tower Royale layout, portrait-oriented HUD, card selection and placement, spell targeting, and deterministic browser hooks (`window.render_game_to_text`, `window.advanceTime`).
- Placement and arena rules including bridge-only crossings, crown-tower pocket unlocks, and king activation behavior.
- Local ladder/profile flow with unlock persistence, multiple bot tiers (`noob`, `mid`, `top`, `pro`, `goat`, `god`, `self`), benchmark utilities, and basic self-play training hooks.

## Known Gaps

- Bot strength ordering is not yet reliable enough to treat as a promotion gate. A quick snapshot on April 8, 2026 (`npm run bot:bench -- --seed 202 --rounds 8 --tiers noob,mid,top,pro`) showed unstable results, including `top` and `pro` failing to cleanly separate from lower tiers.
- The roadmap items for telemetry schema/export and a fuller data pipeline are still not present as first-class repo outputs.
- Browser validation exists as an ad hoc workflow, not yet a repeatable repo command with stable artifact conventions.

## Next 3 Tasks

1. Stabilize ladder ordering by tuning `top` and `pro` heuristics against `mid`, then add stronger adjacent-tier benchmark assertions.
2. Implement telemetry/event export work from the roadmap so matches produce training-ready artifacts beyond replay data alone.
3. Turn browser smoke validation into a repeatable documented workflow for UI/input regressions, including artifact paths and expected checks.

## Validation

- April 8, 2026: `npm test` passed (`79/79`).
- April 8, 2026: `npm run bot:bench -- --seed 202 --rounds 8 --tiers noob,mid,top,pro`
  - `mid > noob`: 4-4
  - `top > noob`: 1-5-2
  - `pro > noob`: 2-4-2
  - `top > mid`: 4-4
  - `pro > mid`: 3-5
  - `pro > top`: 5-2-1

## Risks / Notes

- Do not expand this file back into a changelog. Keep it to the current handoff only.
- The current movement model is intentionally lane-locked with only mild local body resolution. Do not reintroduce the reverted half-tile nav/body-blocking system without explicit intent, updated tests, and spec updates.
- The engine remains the source of truth. UI changes should consume state, not redefine rules.
- If local browser serving fails under sandbox restrictions, use an escalated run and record that fact in the validation note.
