# Agent Framework

## Mission

Ship `edge_royale` as a lightweight, single-player Clash Royale-inspired game with:

- one arena
- one fixed 8-card deck
- deterministic simulation
- progressively stronger local bot tiers
- unlock progression
- replay/data hooks that can later support self-play training

Favor forward progress on the shipped game over speculative architecture.

## Product Boundaries

- MVP is human vs bot only. No online PvP.
- Keep the fixed deck unless the task explicitly expands scope.
- Preserve deterministic simulation as a hard constraint.
- UI is a renderer/input layer over engine state, not an alternate rules implementation.
- Current movement behavior is lane-locked with mild local collision resolution. Treat that as intentional unless the task explicitly reopens movement/pathing design.

## Source-of-Truth Order

Read these before making non-trivial changes:

1. `progress.md`
2. `README.md`
3. The relevant spec doc for the subsystem:
   - `docs/GAME_RULES.md`
   - `docs/CARD_SPECS.md`
   - `docs/BOT_LEVELS.md`
   - `docs/IMPLEMENTATION_PLAN.md`
   - `docs/SPRINT_BACKLOG.md`
4. The code and tests for the touched area

Use this rule when artifacts disagree:

- Tests and code describe current implemented behavior.
- Docs describe intended behavior and must be updated when intentional behavior changes land.
- Do not silently leave docs and tests diverged after changing gameplay, AI, or UI behavior.

## Repo Map

- `src/sim`: deterministic gameplay engine, combat, map, placement, match rules
- `src/client`: browser UI, layout, input handling, rendering
- `src/ai`: bot policies, tier logic, training/profile helpers, benchmarks
- `src/replay`: replay serialization and schema helpers
- `tests`: simulation, UI-layout, replay, AI, progression, and regression coverage
- `scripts/dev-server.mjs`: local static server
- `scripts/bot-benchmark.mjs`: benchmark matrix runner

## Default Workflow

For any meaningful task:

1. Read `progress.md` and the relevant docs/tests first.
2. Inspect the touched subsystem before proposing structure changes.
3. Make the smallest coherent change that solves the actual problem.
4. Add or update tests when behavior changes.
5. Run validation appropriate to the change type.
6. Update relevant docs if rules, AI expectations, UX behavior, or workflow changed.
7. Rewrite `progress.md` before ending the session.

Git history is the archive. Do not append session diaries to `progress.md`.

## Change Rules

### Simulation

- Preserve determinism.
- Avoid adding UI-only state to the engine unless it is required for reproducible rendering/event playback.
- When changing gameplay rules, update tests and `docs/GAME_RULES.md` or `docs/CARD_SPECS.md` in the same pass.

### AI

- Keep tiers behaviorally distinct and ordered by strength.
- Do not trust anecdotal match feel alone; use benchmark output.
- If you change heuristics, record the benchmark command and what it showed in `progress.md`.
- Promotion targets live in `docs/BOT_LEVELS.md`; if the implementation cannot meet them yet, say so explicitly rather than implying it does.

### Client

- Keep the engine as source of truth.
- Protect portrait usability and the Royale-style battlefield framing already established in `src/client/layout.js` and `src/client/webGame.js`.
- When changing placement, HUD, or combat readability, verify both code-level tests and a browser smoke check when feasible.

### Scope

- Prefer finishing the next bottleneck over starting new feature branches of work.
- If a task would materially expand scope, document the tradeoff first and keep the shipped path clear.

## Validation Expectations

Minimum expectations by task type:

- Docs-only change:
  - No test run required, but note that validation was docs-only.
- Sim, replay, progression, or rules change:
  - Run `npm test`.
- AI heuristic or tier-strength change:
  - Run `npm test`.
  - Run `npm run bot:bench -- ...` with explicit seed/rounds/tiers and record the outcome.
- Client/input/rendering change:
  - Run `npm test`.
  - Run a browser smoke check if possible.
  - If sandbox blocks local serving, use an escalated run and record it.

If you cannot run a needed validation step, say exactly what was not run and why.

## Current Hot Spots

- Ladder ordering is still not stable enough to serve as a real promotion gate.
- Telemetry/export pipeline work from the roadmap is still incomplete.
- Browser validation is useful but not yet fully standardized into one repeatable repo command.

## `progress.md` Contract

`progress.md` must stay short and must always use these sections only:

- `Current State`
- `Source of Truth`
- `What Works`
- `Known Gaps`
- `Next 3 Tasks`
- `Validation`
- `Risks / Notes`

Rules:

- Keep only the latest handoff.
- No historical changelog entries.
- No brainstorming dump.
- No duplicated commit history.
- Use exact commands for validation.
- Use concrete dates when recording validation or state snapshots.

## End-of-Session Checklist

Before you stop:

1. Make sure relevant tests/docs are updated.
2. Record the current truth in `progress.md`.
3. Keep `Next 3 Tasks` actionable and prioritized.
4. Note any unresolved risk plainly.
5. Leave the repo in a state the next agent can resume without rereading old chat.
