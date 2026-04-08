import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { ROYALE_LANE_X, ROYALE_TOWER_X, ROYALE_TOWER_Y, createArena, createRoyaleArena } from "../src/sim/map.js";

function makeInitialEntities() {
  return [
    createTroop({ id: "a", cardId: "knight", team: "blue", x: 4.2, y: 4.1, hp: 1400 }),
    createTroop({ id: "b", cardId: "goblins", team: "red", x: 4.6, y: 4.4, hp: 220 }),
    createTroop({ id: "c", cardId: "giant", team: "red", x: 5.2, y: 5, hp: 2500 }),
  ];
}

const actions = [
  { tick: 5, type: "CAST_FIREBALL", x: 4.5, y: 4.4, actor: "blue" },
  { tick: 25, type: "CAST_FIREBALL", x: 5.0, y: 5.0, actor: "red" },
];

test("same seed + same input stream yields identical hash with knockback enabled", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });

  const engineA = createEngine({
    seed: 99,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeInitialEntities(),
  });
  engineA.setOvertime(true);
  engineA.run(actions, 50);

  const engineB = createEngine({
    seed: 99,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeInitialEntities(),
  });
  engineB.setOvertime(true);
  engineB.run(actions, 50);

  assert.equal(engineA.getStateHash(), engineB.getStateHash());

  const spellImpacts = engineA.state.replay.events.filter((event) => event.type === "spell_impact");
  assert.ok(spellImpacts.length > 0);
  assert.ok(spellImpacts.some((event) => event.knockback_events.length > 0));
});

test("same seed + same input stream yields identical hash with obstacle pathing and crowd blocking", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const initialEntities = [
    createTroop({ id: "blue_giant", cardId: "giant", team: "blue", x: ROYALE_LANE_X.left, y: 19, hp: 4090 }),
    createTroop({ id: "blue_goblin", cardId: "goblins", team: "blue", x: ROYALE_LANE_X.left, y: 20.2, hp: 202 }),
    createTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: 0, tower_role: "crown" }),
    createTower({ id: "red_right", team: "red", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.red.crown, hp: 3052, tower_role: "crown" }),
    createTower({ id: "red_king", team: "red", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.red.king, hp: 4824, tower_role: "king", is_active: false }),
  ];

  const engineA = createEngine({
    seed: 140,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities,
  });
  engineA.run([], 90);

  const engineB = createEngine({
    seed: 140,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities,
  });
  engineB.run([], 90);

  assert.equal(engineA.getStateHash(), engineB.getStateHash());
});
