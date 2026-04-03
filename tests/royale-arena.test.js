import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { getScoreSnapshot } from "../src/sim/match.js";
import { ROYALE_LANE_X, createArena, createRoyaleArena } from "../src/sim/map.js";
import { getTroopStats } from "../src/sim/stats.js";

function makeCardState({ blueHand, blueQueue }) {
  return {
    blue: {
      hand: blueHand,
      draw_pile: blueQueue,
    },
    red: {
      hand: ["giant", "knight", "archers", "mini_pekka"],
      draw_pile: ["musketeer", "goblins", "arrows", "fireball"],
    },
  };
}

function getEntitiesByIds(engine, ids) {
  return ids
    .map((id) => engine.state.entities.find((entity) => entity.id === id))
    .filter(Boolean);
}

function assertWithin(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${actual} within ${tolerance} of ${expected}`,
  );
}

test("royale arena PLAY_CARD snaps troop placement to tile centers", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 300,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [],
    initialCardState: makeCardState({
      blueHand: ["knight", "giant", "arrows", "fireball"],
      blueQueue: ["archers", "musketeer", "goblins", "mini_pekka"],
    }),
  });

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "knight",
      x: 4.2,
      y: 20.1,
    },
  ]);

  while (engine.state.tick < 21) {
    engine.step([]);
  }

  const deployEvent = engine.state.replay.events.find((event) => event.type === "troop_deployed" && event.card_id === "knight");
  assert.ok(deployEvent);
  assert.equal(deployEvent.x, 4.5);
  assert.equal(deployEvent.y, 20.5);
});

test("royale arena keeps bridge lanes three tiles from the side edges", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });

  assert.deepEqual(
    arena.bridges.map((bridge) => ({ x: bridge.x, minX: bridge.minX, maxX: bridge.maxX })),
    [
      { x: ROYALE_LANE_X.left, minX: 2, maxX: 4 },
      { x: ROYALE_LANE_X.right, minX: 14, maxX: 16 },
    ],
  );
});

test("archers deploy as a visible pair around the snapped placement", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 304,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [],
    initialCardState: makeCardState({
      blueHand: ["archers", "giant", "arrows", "fireball"],
      blueQueue: ["knight", "musketeer", "goblins", "mini_pekka"],
    }),
  });

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "archers",
      x: 9.2,
      y: 20.1,
    },
  ]);

  while (engine.state.tick < 21) {
    engine.step([]);
  }

  const deployEvent = engine.state.replay.events.find((event) => event.type === "troop_deployed" && event.card_id === "archers");
  assert.ok(deployEvent);
  assert.equal(deployEvent.x, 9.5);
  assert.equal(deployEvent.y, 20.5);
  assert.equal(deployEvent.entity_ids.length, 2);

  const archers = getEntitiesByIds(engine, deployEvent.entity_ids).sort((a, b) => a.x - b.x);
  const archerStats = getTroopStats("archers");
  assert.equal(archers.length, 2);
  assert.deepEqual(archers.map((entity) => entity.preferred_lane_x), [3, 15]);
  assert.ok(archers.every((entity) => entity.hp === archerStats.hp));
  assert.ok(archers.every((entity) => entity.attack_damage === archerStats.attack_damage));
  assert.ok(archers[0].x < deployEvent.x);
  assert.ok(archers[1].x > deployEvent.x);
  assert.ok(archers[1].x - archers[0].x > 0.55);
  assertWithin((archers[0].x + archers[1].x) * 0.5, deployEvent.x, 0.05, "archer midpoint x");
  assertWithin(archers[0].y, deployEvent.y, 0.08, "left archer y");
  assertWithin(archers[1].y, deployEvent.y, 0.08, "right archer y");
});

test("goblins deploy as four distinct units around the snapped placement", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 305,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [],
    initialCardState: makeCardState({
      blueHand: ["goblins", "giant", "arrows", "fireball"],
      blueQueue: ["knight", "musketeer", "archers", "mini_pekka"],
    }),
  });

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "goblins",
      x: 9.4,
      y: 20.2,
    },
  ]);

  while (engine.state.tick < 21) {
    engine.step([]);
  }

  const deployEvent = engine.state.replay.events.find((event) => event.type === "troop_deployed" && event.card_id === "goblins");
  assert.ok(deployEvent);
  assert.equal(deployEvent.x, 9.5);
  assert.equal(deployEvent.y, 20.5);
  assert.equal(deployEvent.entity_ids.length, 4);

  const goblins = getEntitiesByIds(engine, deployEvent.entity_ids);
  const goblinStats = getTroopStats("goblins");
  assert.equal(goblins.length, 4);
  assert.equal(new Set(goblins.map((entity) => `${entity.x},${entity.y}`)).size, 4);
  assert.deepEqual(goblins.map((entity) => entity.preferred_lane_x).sort((a, b) => a - b), [3, 3, 15, 15]);
  assert.ok(goblins.every((entity) => entity.hp === goblinStats.hp));
  assert.ok(goblins.every((entity) => entity.attack_damage === goblinStats.attack_damage));
  const xs = goblins.map((entity) => entity.x).sort((a, b) => a - b);
  const ys = goblins.map((entity) => entity.y).sort((a, b) => a - b);
  assert.ok(xs[0] < deployEvent.x - 0.2);
  assert.ok(xs[3] > deployEvent.x + 0.2);
  assert.ok(ys[1] < deployEvent.y);
  assert.ok(ys[2] > deployEvent.y);
  assertWithin(goblins.reduce((total, entity) => total + entity.x, 0) / goblins.length, deployEvent.x, 0.08, "goblin midpoint x");
});

test("off-center multi-unit deployments stay on one lane", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });

  const archersEngine = createEngine({
    seed: 306,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [],
    initialCardState: makeCardState({
      blueHand: ["archers", "giant", "arrows", "fireball"],
      blueQueue: ["knight", "musketeer", "goblins", "mini_pekka"],
    }),
  });

  archersEngine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "archers",
      x: 10.2,
      y: 20.1,
    },
  ]);

  while (archersEngine.state.tick < 21) {
    archersEngine.step([]);
  }

  const archersDeploy = archersEngine.state.replay.events.find(
    (event) => event.type === "troop_deployed" && event.card_id === "archers",
  );
  const archers = getEntitiesByIds(archersEngine, archersDeploy.entity_ids);
  assert.deepEqual(archers.map((entity) => entity.preferred_lane_x), [15, 15]);

  const goblinsEngine = createEngine({
    seed: 307,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [],
    initialCardState: makeCardState({
      blueHand: ["goblins", "giant", "arrows", "fireball"],
      blueQueue: ["knight", "musketeer", "archers", "mini_pekka"],
    }),
  });

  goblinsEngine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "goblins",
      x: 7.2,
      y: 20.1,
    },
  ]);

  while (goblinsEngine.state.tick < 21) {
    goblinsEngine.step([]);
  }

  const goblinsDeploy = goblinsEngine.state.replay.events.find(
    (event) => event.type === "troop_deployed" && event.card_id === "goblins",
  );
  const goblins = getEntitiesByIds(goblinsEngine, goblinsDeploy.entity_ids);
  assert.deepEqual(goblins.map((entity) => entity.preferred_lane_x), [3, 3, 3, 3]);
});

test("troops cross the royale river only on bridge tiles", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 301,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue_k", cardId: "knight", team: "blue", x: 2.5, y: 20.5, hp: 1400 }),
      createTower({ id: "red_left", team: "red", x: ROYALE_LANE_X.left, y: 6, hp: 2500, tower_role: "crown" }),
    ],
  });

  const riverPositions = [];
  let crossedRiver = false;

  for (let tick = 0; tick < 220; tick += 1) {
    engine.step([]);
    const troop = engine.state.entities.find((entity) => entity.id === "blue_k");
    if (!troop || troop.hp <= 0) {
      break;
    }

    if (troop.y >= arena.river.minY && troop.y <= arena.river.maxY) {
      riverPositions.push({ x: troop.x, y: troop.y });
    }

    if (troop.y < arena.river.minY) {
      crossedRiver = true;
      break;
    }
  }

  assert.ok(crossedRiver, "expected the troop to cross the river");
  assert.ok(riverPositions.length > 0, "expected the troop to spend time in the bridge corridor");
  assert.ok(
    riverPositions.every((position) => position.x >= 2 && position.x <= 4),
    `expected river positions to stay on the left bridge, got ${JSON.stringify(riverPositions)}`,
  );
});

test("king tower stays dormant until hit, then activates and defends", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  const engine = createEngine({
    seed: 302,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "red_king", team: "red", x: 5, y: 4, hp: 3600, tower_role: "king", is_active: false }),
      createTroop({ id: "blue_k", cardId: "knight", team: "blue", x: 10, y: 4, hp: 1400 }),
    ],
    initialCardState: makeCardState({
      blueHand: ["fireball", "knight", "arrows", "giant"],
      blueQueue: ["archers", "musketeer", "goblins", "mini_pekka"],
    }),
  });

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "fireball",
      x: 5,
      y: 4,
    },
  ]);

  while (engine.state.tick < 18) {
    engine.step([]);
  }

  const preImpactKnight = engine.state.entities.find((entity) => entity.id === "blue_k");
  assert.equal(preImpactKnight.hp, 1400);

  engine.step([]);

  const kingTower = engine.state.entities.find((entity) => entity.id === "red_king");
  const knight = engine.state.entities.find((entity) => entity.id === "blue_k");
  assert.equal(kingTower.is_active, true);
  assert.ok(knight.hp < 1400, `expected king tower retaliation after activation, got hp ${knight.hp}`);
});

test("destroying a crown tower adds one crown but destroying the king tower grants three", () => {
  const crownScore = getScoreSnapshot([
    createTower({ id: "red_left", team: "red", x: ROYALE_LANE_X.left, y: 6, hp: 0, tower_role: "crown" }),
    createTower({ id: "red_right", team: "red", x: ROYALE_LANE_X.right, y: 6, hp: 2500, tower_role: "crown" }),
    createTower({ id: "red_king", team: "red", x: ROYALE_LANE_X.center, y: 2, hp: 3600, tower_role: "king", is_active: false }),
  ]);
  assert.equal(crownScore.blue_crowns, 1);

  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  const engine = createEngine({
    seed: 303,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "red_king", team: "red", x: 5, y: 4, hp: 80, tower_role: "king", is_active: true }),
      createTroop({ id: "blue_k", cardId: "knight", team: "blue", x: 5, y: 5, hp: 1400 }),
    ],
  });

  engine.step([]);

  const result = engine.getMatchResult();
  assert.ok(result);
  assert.equal(result.winner, "blue");
  assert.equal(result.reason, "king_tower_destroyed");
  assert.equal(result.score.blue_crowns, 3);
});
