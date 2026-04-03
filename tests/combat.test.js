import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTroop, createTower } from "../src/sim/entities.js";
import { ROYALE_LANE_X, createArena, createRoyaleArena } from "../src/sim/map.js";
import { getTowerStats } from "../src/sim/stats.js";

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
  assert.ok(Math.hypot(blue.velocity.x, blue.velocity.y) > 0);
  assert.ok(Math.hypot(red.velocity.x, red.velocity.y) > 0);
});

test("towers use level-11 crown and king baseline combat stats by default", () => {
  const crown = createTower({ id: "crown", team: "blue", x: 9, y: 29 });
  const king = createTower({ id: "king", team: "blue", x: 9, y: 30, tower_role: "king", is_active: false });

  const crownStats = getTowerStats("crown");
  const kingStats = getTowerStats("king");

  assert.equal(crown.hp, crownStats.hp);
  assert.equal(crown.maxHp, crownStats.hp);
  assert.equal(crown.attack_damage, crownStats.attack_damage);
  assert.equal(crown.attack_range, crownStats.attack_range);
  assert.equal(crown.attack_cooldown_ticks, 16);

  assert.equal(king.hp, kingStats.hp);
  assert.equal(king.maxHp, kingStats.hp);
  assert.equal(king.attack_damage, kingStats.attack_damage);
  assert.equal(king.attack_range, kingStats.attack_range);
  assert.equal(king.attack_cooldown_ticks, 20);
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

test("troops ignore enemies outside sight range", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  const blueKnight = createTroop({ id: "blue_k", cardId: "knight", team: "blue", x: 5, y: 9, hp: 1400 });
  const redKnight = createTroop({ id: "red_k", cardId: "knight", team: "red", x: 5, y: 1, hp: 1400 });

  const engine = createEngine({
    seed: 103,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [blueKnight, redKnight],
  });

  engine.step([]);

  const blue = engine.state.entities.find((entity) => entity.id === "blue_k");
  const red = engine.state.entities.find((entity) => entity.id === "red_k");

  assert.equal(blue.target_entity_id, null);
  assert.equal(red.target_entity_id, null);
  assert.ok(blue.y < 9);
  assert.ok(red.y > 1);
});

test("troops acquire enemies inside sight range before they are in attack range", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  const blueKnight = createTroop({ id: "blue_k", cardId: "knight", team: "blue", x: 5, y: 9, hp: 1400 });
  const redKnight = createTroop({ id: "red_k", cardId: "knight", team: "red", x: 5, y: 4.2, hp: 1400 });

  const engine = createEngine({
    seed: 104,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [blueKnight, redKnight],
  });

  engine.step([]);

  const blue = engine.state.entities.find((entity) => entity.id === "blue_k");
  const red = engine.state.entities.find((entity) => entity.id === "red_k");

  assert.equal(blue.target_entity_id, "red_k");
  assert.equal(red.target_entity_id, "blue_k");
  assert.equal(blue.hp, 1400);
  assert.equal(red.hp, 1400);
  assert.ok(blue.y < 9);
  assert.ok(red.y > 4.2);
});

test("troops route around blocking towers instead of moving through them", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  const engine = createEngine({
    seed: 105,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue_k", cardId: "knight", team: "blue", x: 5, y: 8.5, hp: 1400 }),
      createTower({ id: "blue_blocker", team: "blue", x: 5, y: 5.5, hp: 3052, tower_role: "crown" }),
      createTower({ id: "red_goal", team: "red", x: 5, y: 1.5, hp: 3052, tower_role: "crown" }),
    ],
  });

  let deviatedAroundTower = false;
  for (let tick = 0; tick < 120; tick += 1) {
    engine.step([]);
    const knight = engine.state.entities.find((entity) => entity.id === "blue_k");
    if (!knight || knight.hp <= 0) {
      break;
    }

    const blockerDistance = Math.hypot(knight.x - 5, knight.y - 5.5);
    assert.ok(blockerDistance >= knight.collision_radius + 0.75 - 0.05);
    if (knight.y < 6.6 && knight.y > 4.2 && Math.abs(knight.x - 5) > 0.55) {
      deviatedAroundTower = true;
    }
  }

  assert.ok(deviatedAroundTower, "expected the knight to step around the tower footprint");
});

test("smaller troops queue behind larger troops in a one-lane choke", () => {
  const arena = createArena({
    minX: 4,
    maxX: 6,
    minY: 0,
    maxY: 12,
    isPathable: (x, y) => x >= 4.4 && x <= 5.6 && y >= 0 && y <= 12,
  });
  const engine = createEngine({
    seed: 106,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue_giant", cardId: "giant", team: "blue", x: 5, y: 9.5, hp: 4090 }),
      createTroop({ id: "blue_goblin", cardId: "goblins", team: "blue", x: 5, y: 10.6, hp: 202 }),
      createTower({ id: "red_goal", team: "red", x: 5, y: 1.5, hp: 3052, tower_role: "crown" }),
    ],
  });

  for (let tick = 0; tick < 120; tick += 1) {
    engine.step([]);
    const giant = engine.state.entities.find((entity) => entity.id === "blue_giant");
    const goblin = engine.state.entities.find((entity) => entity.id === "blue_goblin");
    if (!giant || !goblin || giant.hp <= 0 || goblin.hp <= 0) {
      break;
    }

    assert.ok(goblin.y >= giant.y - 0.02, `expected goblin to remain queued behind giant, got ${goblin.y} < ${giant.y}`);
    const separation = Math.hypot(giant.x - goblin.x, giant.y - goblin.y);
    assert.ok(separation >= giant.collision_radius + goblin.collision_radius - 0.06);
  }
});

test("smaller troops can slide into side clearance without phasing through the tank", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 12 });
  const engine = createEngine({
    seed: 108,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue_giant", cardId: "giant", team: "blue", x: 5, y: 9.5, hp: 4090 }),
      createTroop({ id: "blue_goblin", cardId: "goblins", team: "blue", x: 5, y: 10.6, hp: 202 }),
      createTower({ id: "red_goal", team: "red", x: 5, y: 1.5, hp: 3052, tower_role: "crown" }),
    ],
  });

  let foundSideSlip = false;
  for (let tick = 0; tick < 80; tick += 1) {
    engine.step([]);
    const giant = engine.state.entities.find((entity) => entity.id === "blue_giant");
    const goblin = engine.state.entities.find((entity) => entity.id === "blue_goblin");
    if (!giant || !goblin || giant.hp <= 0 || goblin.hp <= 0) {
      break;
    }

    const separation = Math.hypot(giant.x - goblin.x, giant.y - goblin.y);
    assert.ok(separation >= giant.collision_radius + goblin.collision_radius - 0.06);
    if (Math.abs(goblin.x - giant.x) > 0.12) {
      foundSideSlip = true;
    }
  }

  assert.ok(foundSideSlip, "expected the goblin to use side clearance when the lane is open");
});

test("troops repath diagonally toward the king tower after a crown tower falls", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 107,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue_k", cardId: "knight", team: "blue", x: ROYALE_LANE_X.left, y: 14, hp: 1400 }),
      createTower({ id: "red_left", team: "red", x: ROYALE_LANE_X.left, y: 6, hp: 0, tower_role: "crown" }),
      createTower({ id: "red_right", team: "red", x: ROYALE_LANE_X.right, y: 6, hp: getTowerStats("crown").hp, tower_role: "crown" }),
      createTower({ id: "red_king", team: "red", x: ROYALE_LANE_X.center, y: 2, hp: getTowerStats("king").hp, tower_role: "king", is_active: false }),
    ],
  });

  for (let tick = 0; tick < 20; tick += 1) {
    engine.step([]);
  }

  const knight = engine.state.entities.find((entity) => entity.id === "blue_k");
  assert.ok(knight.x > ROYALE_LANE_X.left + 0.5, `expected diagonal repath toward king tower, got x=${knight.x}`);
  assert.ok(knight.y < 14);
});
