import test from "node:test";
import assert from "node:assert/strict";

import { resolveTroopBodyCollisions } from "../src/sim/combat.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { applyForcedMotion, createTower, createTroop } from "../src/sim/entities.js";
import { ROYALE_LANE_X, ROYALE_TOWER_X, ROYALE_TOWER_Y, createArena, createRoyaleArena } from "../src/sim/map.js";
import { getTowerBlocker } from "../src/sim/nav.js";
import { resolveFireballImpact } from "../src/sim/spells.js";

const MOVE_BODY_RADIUS = 0.45;
const MIN_ALLOWED_SEPARATION = MOVE_BODY_RADIUS * 2 - 0.18;

function assertNoSevereCompression(troops, label) {
  for (let i = 0; i < troops.length; i += 1) {
    for (let j = i + 1; j < troops.length; j += 1) {
      const actualDistance = Math.hypot(troops[i].x - troops[j].x, troops[i].y - troops[j].y);
      assert.ok(
        actualDistance >= MIN_ALLOWED_SEPARATION - 1e-3,
        `${label}: expected ${troops[i].id}/${troops[j].id} distance ${actualDistance} >= ${MIN_ALLOWED_SEPARATION}`,
      );
    }
  }
}

function runUntilTick(engine, tick) {
  while (engine.state.tick < tick) {
    engine.step([]);
  }
}

test("single giant crosses the left bridge cleanly without lateral obstruction", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 1,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "giant", cardId: "giant", team: "blue", x: ROYALE_LANE_X.left, y: 18.5, hp: 4090 }),
      createTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: 3052, tower_role: "crown" }),
    ],
  });

  const riverPositions = [];
  let maxDeviation = 0;
  for (let tick = 0; tick < 90; tick += 1) {
    engine.step([]);
    const giant = engine.state.entities.find((entity) => entity.id === "giant");
    maxDeviation = Math.max(maxDeviation, Math.abs(giant.x - ROYALE_LANE_X.left));
    if (giant.y >= arena.river.minY && giant.y <= arena.river.maxY) {
      riverPositions.push(giant.x);
    }
  }

  const giant = engine.state.entities.find((entity) => entity.id === "giant");
  assert.ok(giant.y <= 14.1, `expected giant to clear the bridge approach, got y=${giant.y}`);
  assert.ok(riverPositions.length > 0, "expected the giant to enter the river bridge corridor");
  assert.ok(
    riverPositions.every((x) => x >= 2.5 && x <= 4.5),
    `expected bridge positions to remain inside the left bridge corridor, got ${JSON.stringify(riverPositions)}`,
  );
  assert.ok(maxDeviation <= 0.3, `expected only a mild lateral correction toward the left crown tower, got ${maxDeviation}`);
});

test("same-lane giants compress briefly instead of hard-queueing at the bridge mouth", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 1,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "front", cardId: "giant", team: "blue", x: ROYALE_LANE_X.left, y: 18.2, hp: 4090 }),
      createTroop({ id: "rear", cardId: "giant", team: "blue", x: ROYALE_LANE_X.left, y: 19.6, hp: 4090 }),
      createTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: 3052, tower_role: "crown" }),
    ],
  });

  const riverPositions = [];
  let sharedBridgeOccupancy = false;
  let minSeparation = Number.POSITIVE_INFINITY;

  for (let tick = 0; tick < 100; tick += 1) {
    engine.step([]);
    const front = engine.state.entities.find((entity) => entity.id === "front");
    const rear = engine.state.entities.find((entity) => entity.id === "rear");
    minSeparation = Math.min(minSeparation, Math.hypot(front.x - rear.x, front.y - rear.y));

    const frontInRiver = front.y >= arena.river.minY && front.y <= arena.river.maxY;
    const rearInRiver = rear.y >= arena.river.minY && rear.y <= arena.river.maxY;
    if (frontInRiver) {
      riverPositions.push(front.x);
    }
    if (rearInRiver) {
      riverPositions.push(rear.x);
    }
    if (frontInRiver && rearInRiver) {
      sharedBridgeOccupancy = true;
    }
  }

  const rear = engine.state.entities.find((entity) => entity.id === "rear");
  assert.ok(sharedBridgeOccupancy, "expected both giants to occupy the bridge corridor without hard queueing");
  assert.ok(rear.y < arena.river.maxY, `expected rear giant to reach the bridge corridor, got y=${rear.y}`);
  assert.ok(
    riverPositions.every((x) => x >= 2.5 && x <= 4.5),
    `expected river positions to stay inside the left bridge corridor, got ${JSON.stringify(riverPositions)}`,
  );
  assert.ok(
    minSeparation >= MIN_ALLOWED_SEPARATION - 1e-3,
    `expected only mild temporary compression, got min separation ${minSeparation}`,
  );
});

test("giant yields less than goblins during local body resolution", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 12 });
  const giant = createTroop({ id: "giant", cardId: "giant", team: "blue", x: 5, y: 6, hp: 4090 });
  const goblins = [
    createTroop({ id: "g1", cardId: "goblins", team: "blue", x: 5.15, y: 6.02, hp: 202 }),
    createTroop({ id: "g2", cardId: "goblins", team: "blue", x: 4.88, y: 5.96, hp: 202 }),
    createTroop({ id: "g3", cardId: "goblins", team: "blue", x: 5.04, y: 6.18, hp: 202 }),
  ];
  const entities = [giant, ...goblins];
  const startPositions = new Map(entities.map((entity) => [entity.id, { x: entity.x, y: entity.y }]));

  for (let tick = 0; tick < 4; tick += 1) {
    resolveTroopBodyCollisions({ entities, arena });
  }

  const giantShift = Math.hypot(giant.x - startPositions.get("giant").x, giant.y - startPositions.get("giant").y);
  const maxGoblinShift = Math.max(
    ...goblins.map((entity) => {
      const start = startPositions.get(entity.id);
      return Math.hypot(entity.x - start.x, entity.y - start.y);
    }),
  );

  assert.ok(
    maxGoblinShift > giantShift + 0.05,
    `expected lighter goblins to be displaced more than giant, got goblins=${maxGoblinShift} giant=${giantShift}`,
  );
  assertNoSevereCompression([giant, ...goblins], "giant-vs-goblins");
});

test("body contact during retargeting does not push a giant off its assigned bridge", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 7,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "giant", cardId: "giant", team: "blue", x: ROYALE_LANE_X.left, y: 18.4, hp: 4090 }),
      createTroop({ id: "knight", cardId: "knight", team: "blue", x: ROYALE_LANE_X.left, y: 16.9, hp: 1766 }),
      createTroop({ id: "red_knight", cardId: "knight", team: "red", x: ROYALE_LANE_X.left, y: 14.2, hp: 1766 }),
      createTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: 3052, tower_role: "crown" }),
    ],
  });

  let maxDeviation = 0;
  const giantRiverXs = [];

  for (let tick = 0; tick < 90; tick += 1) {
    engine.step([]);
    const giant = engine.state.entities.find((entity) => entity.id === "giant");
    maxDeviation = Math.max(maxDeviation, Math.abs(giant.x - ROYALE_LANE_X.left));
    if (giant.y >= arena.river.minY && giant.y <= arena.river.maxY) {
      giantRiverXs.push(giant.x);
    }
  }

  const giant = engine.state.entities.find((entity) => entity.id === "giant");
  assert.ok(giant.y < 15.2, `expected giant to keep advancing through the left lane, got y=${giant.y}`);
  assert.ok(maxDeviation <= 0.55, `expected giant to stay on the left bridge approach while retargeting, got max deviation ${maxDeviation}`);
  assert.ok(
    giantRiverXs.every((x) => x >= 2.5 && x <= 4.5),
    `expected giant bridge path to stay inside the left bridge corridor, got ${JSON.stringify(giantRiverXs)}`,
  );
});

test("off-lane retarget during bridge crossing stays within body-clearance bridge bounds", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const redSide = createTroop({ id: "red_side", cardId: "knight", team: "red", x: 8.8, y: 14.2, hp: 1766 });
  redSide.move_speed = 0;

  const engine = createEngine({
    seed: 17,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue", cardId: "knight", team: "blue", x: ROYALE_LANE_X.left, y: 18.2, hp: 1766 }),
      redSide,
      createTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: 3052, tower_role: "crown" }),
    ],
  });

  const leftBridge = arena.bridges.find((bridge) => bridge.lane === "left");
  const minClearX = leftBridge.minX + MOVE_BODY_RADIUS;
  const maxClearX = leftBridge.maxX - MOVE_BODY_RADIUS;
  const riverPositions = [];
  let retargetedInRiver = false;

  for (let tick = 0; tick < 120; tick += 1) {
    engine.step([]);
    const blue = engine.state.entities.find((entity) => entity.id === "blue");

    if (blue.y >= arena.river.minY && blue.y <= arena.river.maxY) {
      riverPositions.push({ x: blue.x, y: blue.y, target: blue.target_entity_id });
      if (blue.target_entity_id === "red_side") {
        retargetedInRiver = true;
      }
    }
  }

  const blue = engine.state.entities.find((entity) => entity.id === "blue");
  assert.ok(retargetedInRiver, `expected blue troop to retarget to off-lane troop while in river, got ${JSON.stringify(riverPositions)}`);
  assert.ok(blue.y < arena.river.minY, `expected blue troop to clear the far bridge exit, got y=${blue.y}`);
  assert.ok(
    riverPositions.every((position) => position.x >= minClearX - 1e-3 && position.x <= maxClearX + 1e-3),
    `expected body-clear bridge x in [${minClearX}, ${maxClearX}], got ${JSON.stringify(riverPositions)}`,
  );
});

test("fireball knockback stays outside tower blockers and resolves to a mildly compressed state", () => {
  const arena = createArena({ minX: 0, maxX: 12, minY: 0, maxY: 12 });
  const tower = createTower({ id: "tower", team: "red", x: 5, y: 5, hp: 3000, tower_role: "crown" });
  const knight = createTroop({ id: "k", cardId: "knight", team: "red", x: 7.2, y: 5, hp: 1400 });
  const goblin = createTroop({ id: "g", cardId: "goblins", team: "red", x: 6.7, y: 5.1, hp: 220 });
  const entities = [tower, knight, goblin];
  const blocker = getTowerBlocker(tower);

  resolveFireballImpact({
    tick: 1,
    impactX: 8.5,
    impactY: 5,
    entities,
    arena,
    sourceSpell: "fireball",
    fireballConfig: {
      ...FIREBALL_CONFIG,
      troop_damage: 0,
      tower_damage: 0,
    },
  });

  for (let tick = 0; tick < FIREBALL_CONFIG.knockback_duration_ticks; tick += 1) {
    for (const entity of entities) {
      applyForcedMotion(entity, arena, entities);
    }
    resolveTroopBodyCollisions({ entities, arena });
  }

  for (const troop of [knight, goblin]) {
    assert.ok(
      troop.x < blocker.minX || troop.x > blocker.maxX || troop.y < blocker.minY || troop.y > blocker.maxY,
      `expected ${troop.id} to stay outside the tower blocker, got (${troop.x}, ${troop.y})`,
    );
  }
  assertNoSevereCompression([knight, goblin], "fireball-post-knockback");
});
