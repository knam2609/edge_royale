import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTroop, createTower } from "../src/sim/entities.js";
import { ROYALE_LANE_X, createArena, createRoyaleArena } from "../src/sim/map.js";
import { resolveFireballImpact } from "../src/sim/spells.js";
import { getTowerStats } from "../src/sim/stats.js";

function getEntity(engine, id) {
  return engine.state.entities.find((entity) => entity.id === id);
}

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

test("side-pocket troops fall back to the enemy king instead of drifting to the arena edge", () => {
  const cases = [
    { id: "archer", cardId: "archers", hp: 304 },
    { id: "goblin", cardId: "goblins", hp: 202 },
  ];

  for (const troopCase of cases) {
    const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
    const engine = createEngine({
      seed: 150,
      arena,
      fireballConfig: FIREBALL_CONFIG,
      initialEntities: [
        createTower({ id: "red_left", team: "red", x: ROYALE_LANE_X.left, y: 6, hp: 0, tower_role: "crown" }),
        createTower({ id: "red_right", team: "red", x: ROYALE_LANE_X.right, y: 6, hp: 3052, tower_role: "crown" }),
        createTower({ id: "red_king", team: "red", x: ROYALE_LANE_X.center, y: 2, hp: 4824, tower_role: "king", is_active: false }),
        createTroop({ id: troopCase.id, cardId: troopCase.cardId, team: "blue", x: 0.5, y: 10.5, hp: troopCase.hp }),
      ],
    });

    engine.step([]);

    const troop = getEntity(engine, troopCase.id);
    assert.equal(troop.target_entity_id, "red_king", `${troopCase.cardId} should lock the enemy king as its fallback objective`);
    assert.ok(troop.x > 0.5, `${troopCase.cardId} should move laterally toward the king tower`);
    assert.ok(troop.y < 10.5, `${troopCase.cardId} should advance toward the enemy side objective`);
  }
});

test("troops keep their locked target when a closer enemy enters sight but not attack range", () => {
  const arena = createArena({ minX: 0, maxX: 12, minY: 0, maxY: 12 });
  const engine = createEngine({
    seed: 151,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue", cardId: "knight", team: "blue", x: 6, y: 10, hp: 1766 }),
      createTroop({ id: "red_locked", cardId: "knight", team: "red", x: 6, y: 6.2, hp: 1766 }),
    ],
  });

  engine.step([]);
  assert.equal(getEntity(engine, "blue").target_entity_id, "red_locked");

  engine.state.entities.push(createTroop({ id: "red_closer", cardId: "knight", team: "red", x: 7.8, y: 9.2, hp: 1766 }));
  engine.step([]);

  const blue = getEntity(engine, "blue");
  assert.equal(blue.target_entity_id, "red_locked");
});

test("troops only switch locks when a different target is already in attack range", () => {
  const arena = createArena({ minX: 0, maxX: 12, minY: 0, maxY: 12 });
  const engine = createEngine({
    seed: 152,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue", cardId: "knight", team: "blue", x: 6, y: 10, hp: 1766 }),
      createTroop({ id: "red_locked", cardId: "knight", team: "red", x: 6, y: 6.2, hp: 1766 }),
    ],
  });

  engine.step([]);
  assert.equal(getEntity(engine, "blue").target_entity_id, "red_locked");

  engine.state.entities.push(createTroop({ id: "red_in_range", cardId: "knight", team: "red", x: 6.2, y: 8.6, hp: 1766 }));
  engine.step([]);

  const blue = getEntity(engine, "blue");
  const redInRange = getEntity(engine, "red_in_range");
  assert.equal(blue.target_entity_id, "red_in_range");
  assert.ok(redInRange.hp < 1766, `expected the in-range override target to take damage, got hp ${redInRange.hp}`);
});

test("forced motion clears the current lock until knockback ends, then troops reacquire", () => {
  const arena = createArena({ minX: 0, maxX: 12, minY: 0, maxY: 12 });
  const engine = createEngine({
    seed: 153,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue", cardId: "knight", team: "blue", x: 6, y: 10, hp: 1766 }),
      createTroop({ id: "red_locked", cardId: "knight", team: "red", x: 6, y: 6.2, hp: 1766 }),
    ],
  });

  engine.step([]);
  assert.equal(getEntity(engine, "blue").target_entity_id, "red_locked");

  resolveFireballImpact({
    tick: engine.state.tick,
    impactX: 6,
    impactY: 10,
    entities: engine.state.entities,
    arena,
    sourceSpell: "fireball",
    fireballConfig: {
      ...FIREBALL_CONFIG,
      troop_damage: 0,
      tower_damage: 0,
    },
  });

  for (let i = 0; i < FIREBALL_CONFIG.knockback_duration_ticks; i += 1) {
    engine.step([]);
    assert.equal(getEntity(engine, "blue").target_entity_id, null);
  }

  engine.step([]);
  assert.equal(getEntity(engine, "blue").target_entity_id, "red_locked");
});

test("towers keep their current lock until another troop is in range and the old lock is not", () => {
  const arena = createArena({ minX: 0, maxX: 12, minY: 0, maxY: 12 });
  const engine = createEngine({
    seed: 154,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_t", team: "blue", x: 6, y: 10, hp: 3800 }),
      createTroop({ id: "red_locked", cardId: "knight", team: "red", x: 6, y: 4.2, hp: 1766 }),
    ],
  });

  engine.step([]);
  assert.equal(getEntity(engine, "blue_t").target_entity_id, "red_locked");

  engine.state.entities.push(createTroop({ id: "red_in_range", cardId: "knight", team: "red", x: 6.2, y: 9, hp: 1766 }));
  engine.step([]);

  assert.equal(getEntity(engine, "blue_t").target_entity_id, "red_locked");
  assert.equal(getEntity(engine, "red_in_range").hp, 1766);

  getEntity(engine, "red_locked").y = 0;
  engine.step([]);

  assert.equal(getEntity(engine, "blue_t").target_entity_id, "red_in_range");
});
