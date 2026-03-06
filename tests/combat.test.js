import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTroop, createTower } from "../src/sim/entities.js";
import { createArena } from "../src/sim/map.js";

test("troops advance toward enemy side when out of range", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const blueKnight = createTroop({ id: "blue_k", cardId: "knight", team: "blue", x: 8.8, y: 26, hp: 1400 });
  const redKnight = createTroop({ id: "red_k", cardId: "knight", team: "red", x: 9.2, y: 6, hp: 1400 });

  const engine = createEngine({
    seed: 100,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [blueKnight, redKnight],
  });

  engine.run([], 30);

  const blue = engine.state.entities.find((entity) => entity.id === "blue_k");
  const red = engine.state.entities.find((entity) => entity.id === "red_k");

  assert.ok(blue.y < 26);
  assert.ok(red.y > 6);
  assert.ok(Math.abs(blue.velocity.y) > 0);
  assert.ok(Math.abs(red.velocity.y) > 0);
});

test("tower auto-attacks enemy troops in range", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const blueTower = createTower({ id: "blue_t", team: "blue", x: 9, y: 29, hp: 3800 });
  const redKnight = createTroop({ id: "red_k", cardId: "knight", team: "red", x: 9, y: 24, hp: 1400 });

  const engine = createEngine({
    seed: 101,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [blueTower, redKnight],
  });

  engine.run([], 25);

  const red = engine.state.entities.find((entity) => entity.id === "red_k");
  assert.ok(red.hp < 1400, `Expected tower damage on red troop, got hp ${red.hp}`);
});

test("giant does not attack enemy troops when no building target exists", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const blueGiant = createTroop({ id: "blue_g", cardId: "giant", team: "blue", x: 9, y: 16, hp: 2500 });
  const redKnight = createTroop({ id: "red_k", cardId: "knight", team: "red", x: 9, y: 14.9, hp: 1400 });

  const engine = createEngine({
    seed: 102,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [blueGiant, redKnight],
  });

  engine.run([], 40);

  const red = engine.state.entities.find((entity) => entity.id === "red_k");
  const blue = engine.state.entities.find((entity) => entity.id === "blue_g");

  assert.equal(red.hp, 1400);
  assert.ok(blue.hp < 2500, "Red knight should still be able to damage giant");
});
