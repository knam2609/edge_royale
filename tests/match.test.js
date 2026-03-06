import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG, MATCH_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { createArena } from "../src/sim/map.js";

function tower(id, team, hp, y) {
  return createTower({ id, team, x: 9, y, hp });
}

test("regulation ends immediately when crowns are not tied", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 77,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      tower("blue_t", "blue", 3800, 29),
      tower("red_t", "red", 80, 3),
      createTroop({ id: "blue_g", cardId: "giant", team: "blue", x: 9, y: 4.3, hp: 2500 }),
    ],
  });

  engine.run([], 20);

  const result = engine.getMatchResult();
  assert.ok(result);
  assert.equal(result.winner, "blue");
  assert.equal(result.reason, "tower_advantage_regulation");

  const resultEvent = engine.state.replay.events.find((event) => event.type === "match_result");
  assert.ok(resultEvent);
});

test("tied regulation state requires overtime", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 78,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [tower("blue_t", "blue", 3800, 29), tower("red_t", "red", 3800, 3)],
  });

  engine.run([], MATCH_CONFIG.regulation_ticks);

  assert.equal(engine.getMatchResult(), null);
  assert.equal(engine.shouldStartOvertime(), true);
});

test("overtime end resolves by tower HP when crowns are tied", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 79,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialOvertime: true,
    initialEntities: [tower("blue_t", "blue", 3400, 29), tower("red_t", "red", 2600, 3)],
  });

  engine.run([], MATCH_CONFIG.overtime_ticks);

  const result = engine.getMatchResult();
  assert.ok(result);
  assert.equal(result.winner, "blue");
  assert.equal(result.reason, "tower_hp_overtime");
});

test("overtime end is draw when crowns and tower HP are tied", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 80,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialOvertime: true,
    initialEntities: [tower("blue_t", "blue", 3000, 29), tower("red_t", "red", 3000, 3)],
  });

  engine.run([], MATCH_CONFIG.overtime_ticks);

  const result = engine.getMatchResult();
  assert.ok(result);
  assert.equal(result.winner, null);
  assert.equal(result.reason, "draw_overtime");
});
