# Progress

## Current State

- As of April 9, 2026, the repo has a playable deterministic browser prototype with crown towers back on the bridge columns and king towers still one row closer to the river.
- Crown towers now use `3x3` footprints centered at `x=3.5/14.5` and `y=6.5/25.5`, matching the bridge columns.
- King towers now use `4x4` footprints centered at `x=9` and `y=3/29`, which keeps the back-most row behind each king legal for troop placement.

## Source of Truth

- Product overview and run instructions: `README.md`
- Roadmap and phase intent: `docs/IMPLEMENTATION_PLAN.md`
- Gameplay rules and engine behavior: `docs/GAME_RULES.md`
- Card stats and contracts: `docs/CARD_SPECS.md`
- Bot tier expectations and promotion targets: `docs/BOT_LEVELS.md`
- Backlog and milestone framing: `docs/SPRINT_BACKLOG.md`
- Durable agent workflow and handoff rules: `AGENTS.md`

## What Works

- Deterministic sim with fixed-tick combat, elixir pacing, overtime, replay hashing, Fireball knockback, and tower blocker-aware pathing.
- Royale bridge lanes remain centered on the fourth tile from each side edge, crown towers share those columns again, and king towers sit one tile closer to the river.
- Troop placement, overlay highlighting, path blockers, and renderer pads now all follow the same tower footprint truth.
- Browser smoke validation confirmed the crown pads line up with the bridge columns and a troop can still be played in the back row behind the blue king.

## Known Gaps

- Bot strength ordering is still not reliable enough to serve as a promotion gate.
- Telemetry/export pipeline work from the roadmap is still incomplete beyond replay data.
- Browser validation is still an ad hoc skill-driven workflow rather than a single repo command with stable conventions.

## Next 3 Tasks

1. Polish the arena art around the bridge-aligned crown pads, bridge approaches, and forward king pads so the layout reads closer to Clash Royale.
2. Stabilize ladder ordering by tuning `top` and `pro` heuristics against `mid`, then add stronger adjacent-tier benchmark assertions.
3. Implement telemetry/event export work from the roadmap so matches produce training-ready artifacts beyond replay data alone.

## Validation

- April 9, 2026: `npm test`
- April 9, 2026: `PORT=4173 npm run dev` (escalated local serve because sandbox blocked the default local bind)
- April 9, 2026: `node /Users/thangnguyen/.codex/skills/develop-web-game/scripts/web_game_playwright_client.js --url http://127.0.0.1:4173 --click-selector '#start-btn' --actions-json '{"steps":[{"buttons":[],"frames":1}]}' --iterations 1 --pause-ms 250 --screenshot-dir output/web-game/crown-bridge-column-smoke/start`
  - Visual artifact: `output/web-game/crown-bridge-column-smoke/start/shot-0.png`
  - State artifact: `output/web-game/crown-bridge-column-smoke/start/state-0.json`
- April 9, 2026: `node /Users/thangnguyen/.codex/skills/develop-web-game/scripts/web_game_playwright_client.js --url http://127.0.0.1:4173 --click-selector '#start-btn' --actions-json '{"steps":[{"buttons":["left_mouse_button"],"frames":1,"mouse_x":160,"mouse_y":610},{"buttons":[],"frames":2},{"buttons":["left_mouse_button"],"frames":1,"mouse_x":190,"mouse_y":535},{"buttons":[],"frames":20}]}' --iterations 1 --pause-ms 250 --screenshot-dir output/web-game/crown-bridge-column-smoke/back-row`
  - Visual artifact: `output/web-game/crown-bridge-column-smoke/back-row/shot-0.png`
  - State artifact: `output/web-game/crown-bridge-column-smoke/back-row/state-0.json`

## Risks / Notes

- `ROYALE_TOWER_X.left/right` now intentionally match `ROYALE_LANE_X.left/right`; keep using the tower constants for tower layout so crown and king anchors can still diverge if needed.
- Placement blocks tower footprint tiles even when a tower has been destroyed; movement/path blockers still apply only to live towers.
- Collision/path tests still allow mild post-bridge drift while requiring river movement to stay inside the bridge corridor.
