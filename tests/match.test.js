import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG, MATCH_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower } from "../src/sim/entities.js";
import { ROYALE_TOWER_X, ROYALE_TOWER_Y, createArena } from "../src/sim/map.js";

function tower(id, team, hp, y) {
  return createTower({ id, team, x: 9, y, hp });
}

function crownTower({ id, team, hp, x, y }) {
  return createTower({ id, team, x, y, hp, tower_role: "crown" });
}

function kingTower({ id, team, hp, x, y, is_active = false }) {
  return createTower({ id, team, x, y, hp, tower_role: "king", is_active });
}

test("regulation waits for the clock before tower advantage decides the winner", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 77,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      tower("blue_t", "blue", 3800, 29),
      tower("red_t", "red", 0, 3),
    ],
  });

  engine.run([], MATCH_CONFIG.regulation_ticks - 1);

  assert.equal(engine.getMatchResult(), null);

  engine.step([]);

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

test("overtime ends immediately when tower counts become unequal", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 79,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialOvertime: true,
    initialEntities: [tower("blue_t", "blue", 3800, 29), tower("red_t", "red", 0, 3)],
  });

  engine.step([]);

  const result = engine.getMatchResult();
  assert.ok(result);
  assert.equal(result.winner, "blue");
  assert.equal(result.reason, "tower_advantage_overtime");
});

test("overtime tied tower counts continue without a winner", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 80,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialOvertime: true,
    initialEntities: [tower("blue_t", "blue", 0, 29), tower("red_t", "red", 0, 3)],
  });

  engine.step([]);

  assert.equal(engine.getMatchResult(), null);
});

test("overtime end resolves by weakest surviving tower HP when tower counts are tied", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 81,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialOvertime: true,
    initialEntities: [
      crownTower({ id: "blue_left", team: "blue", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.blue.crown, hp: 0 }),
      crownTower({ id: "blue_right", team: "blue", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.blue.crown, hp: 100 }),
      kingTower({ id: "blue_king", team: "blue", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.blue.king, hp: 3600 }),
      crownTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: 0 }),
      crownTower({ id: "red_right", team: "red", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.red.crown, hp: 200 }),
      kingTower({ id: "red_king", team: "red", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.red.king, hp: 300 }),
    ],
  });

  engine.run([], MATCH_CONFIG.overtime_ticks);

  const result = engine.getMatchResult();
  assert.ok(result);
  assert.equal(result.winner, "red");
  assert.equal(result.reason, "tower_hp_overtime");
});

test("overtime end is draw when weakest surviving tower HP is tied", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 82,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialOvertime: true,
    initialEntities: [
      crownTower({ id: "blue_left", team: "blue", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.blue.crown, hp: 0 }),
      crownTower({ id: "blue_right", team: "blue", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.blue.crown, hp: 200 }),
      kingTower({ id: "blue_king", team: "blue", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.blue.king, hp: 3000 }),
      crownTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: 0 }),
      crownTower({ id: "red_right", team: "red", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.red.crown, hp: 300 }),
      kingTower({ id: "red_king", team: "red", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.red.king, hp: 200 }),
    ],
  });

  engine.run([], MATCH_CONFIG.overtime_ticks);

  const result = engine.getMatchResult();
  assert.ok(result);
  assert.equal(result.winner, null);
  assert.equal(result.reason, "draw_overtime");
});
