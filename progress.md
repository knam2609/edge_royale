# Progress

## Current State

- As of May 1, 2026, troop target acquisition uses route distance to the target's attackable surface, including bridge-corridor waypoints while crossing.
- Destroyed-lane bridge connector deployments now prefer the enemy king over a surviving opposite crown when the bridge route makes the king closer.
- Off-lane or early defensive retargeting is still allowed by current targeting rules, and bridge-crossing troops keep their assigned bridge corridor with body-radius clearance.
- Fireball forced motion and enemy-caused body-collision displacement still clear engaged tower locks so troops reacquire normally on the next legal targeting tick.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and phase intent: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- Deterministic sim with fixed-tick combat, elixir pacing, overtime, replay hashing, Fireball knockback, route-aware target selection, tower blocker-aware pathing, bridge-edge clearance, and engaged tower-lock persistence.
- Early-vs-late pull behavior is covered in combat tests, including tower destruction, bridge-connector king fallback, Fireball unlock, enemy-collision unlock, and allied-compression no-op cases.
- Royale bridge lanes remain centered on the fourth tile from each side edge; troops crossing a bridge stay within body-clear bridge bounds even after off-lane retargeting.
- Troop placement, overlay highlighting, path blockers, and renderer pads still follow the same tower footprint truth.

## Known Gaps

- Bot strength ordering is still not reliable enough to serve as a promotion gate.
- Telemetry/export pipeline work from the roadmap is still incomplete beyond replay data.
- Browser validation is still an ad hoc skill-driven workflow rather than a single repo command with stable conventions.

## Next 3 Tasks

1. Add a repeatable browser smoke for bridge crossing, destroyed-lane bridge connector targeting, and early-pull vs late-pull tower engagement.
2. Stabilize ladder ordering by tuning `top` and `pro` heuristics against `mid`, then add stronger adjacent-tier benchmark assertions.
3. Implement telemetry/event export work from the roadmap so matches produce training-ready artifacts beyond replay data alone.

## Validation

- May 1, 2026: `node --test tests/combat.test.js`
- May 1, 2026: `npm test`

## Risks / Notes

- `ROYALE_TOWER_X.left/right` now intentionally match `ROYALE_LANE_X.left/right`; keep using the tower constants for tower layout so crown and king anchors can still diverge if needed.
- Placement blocks tower footprint tiles even when a tower has been destroyed; movement/path blockers still apply only to live towers.
- Enemy body-collision unlock is applied on the tick after collision because collision resolution still runs after combat targeting inside the engine step.
- Route-aware target sorting is not a lane lock: a destroyed-lane pocket troop can still choose a surviving opposite crown if that tower is genuinely closer by route distance.
