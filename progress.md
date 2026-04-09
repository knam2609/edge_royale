# Progress

## Current State

- As of April 10, 2026, the sim keeps nearest-target priority during approach but preserves an `any`-target troop's tower lock once that tower is already in attack range.
- Late defensive drops no longer peel an engaged attacker off the tower; early drops still pull aggro before tower engagement.
- Fireball forced motion and enemy-caused body-collision displacement now both clear engaged tower locks so troops reacquire normally on the next legal targeting tick.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and phase intent: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- Deterministic sim with fixed-tick combat, elixir pacing, overtime, replay hashing, Fireball knockback, tower blocker-aware pathing, and engaged tower-lock persistence.
- Early-vs-late pull behavior is covered in combat tests, including tower destruction, Fireball unlock, enemy-collision unlock, and allied-compression no-op cases.
- Royale bridge lanes remain centered on the fourth tile from each side edge, crown towers share those columns again, and king towers sit one tile closer to the river.
- Troop placement, overlay highlighting, path blockers, and renderer pads still follow the same tower footprint truth.

## Known Gaps

- Bot strength ordering is still not reliable enough to serve as a promotion gate.
- Telemetry/export pipeline work from the roadmap is still incomplete beyond replay data.
- Browser validation is still an ad hoc skill-driven workflow rather than a single repo command with stable conventions.

## Next 3 Tasks

1. Add a repeatable browser smoke for early-pull vs late-pull tower engagement so combat lock behavior is validated outside headless tests.
2. Stabilize ladder ordering by tuning `top` and `pro` heuristics against `mid`, then add stronger adjacent-tier benchmark assertions.
3. Implement telemetry/event export work from the roadmap so matches produce training-ready artifacts beyond replay data alone.

## Validation

- April 10, 2026: `npm test`

## Risks / Notes

- `ROYALE_TOWER_X.left/right` now intentionally match `ROYALE_LANE_X.left/right`; keep using the tower constants for tower layout so crown and king anchors can still diverge if needed.
- Placement blocks tower footprint tiles even when a tower has been destroyed; movement/path blockers still apply only to live towers.
- Enemy body-collision unlock is applied on the tick after collision because collision resolution still runs after combat targeting inside the engine step.
