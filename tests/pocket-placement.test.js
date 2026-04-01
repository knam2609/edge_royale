import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower } from "../src/sim/entities.js";
import { ROYALE_LANE_X, createRoyaleArena } from "../src/sim/map.js";
import { getTroopDeployRegions, getTroopPlacementStatus } from "../src/sim/placement.js";
import { getTowerStats } from "../src/sim/stats.js";

function createRoyaleTowers({
  blueLeftHp = getTowerStats("crown").hp,
  blueRightHp = getTowerStats("crown").hp,
  redLeftHp = getTowerStats("crown").hp,
  redRightHp = getTowerStats("crown").hp,
} = {}) {
  return [
    createTower({ id: "blue_left", team: "blue", x: ROYALE_LANE_X.left, y: 26, hp: blueLeftHp, tower_role: "crown" }),
    createTower({ id: "blue_right", team: "blue", x: ROYALE_LANE_X.right, y: 26, hp: blueRightHp, tower_role: "crown" }),
    createTower({ id: "blue_king", team: "blue", x: ROYALE_LANE_X.center, y: 30, tower_role: "king", is_active: false }),
    createTower({ id: "red_left", team: "red", x: ROYALE_LANE_X.left, y: 6, hp: redLeftHp, tower_role: "crown" }),
    createTower({ id: "red_right", team: "red", x: ROYALE_LANE_X.right, y: 6, hp: redRightHp, tower_role: "crown" }),
    createTower({ id: "red_king", team: "red", x: ROYALE_LANE_X.center, y: 2, tower_role: "king", is_active: false }),
  ];
}

function createPocketEngine(towers = createRoyaleTowers()) {
  return createEngine({
    seed: 400,
    arena: createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 }),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: towers,
    initialCardState: {
      blue: {
        hand: ["knight", "giant", "arrows", "fireball"],
        draw_pile: ["archers", "musketeer", "goblins", "mini_pekka"],
      },
      red: {
        hand: ["knight", "giant", "arrows", "fireball"],
        draw_pile: ["archers", "musketeer", "goblins", "mini_pekka"],
      },
    },
  });
}

test("own-side front row is legal full width while river tiles stay locked before pockets open", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const blueLeftFront = getTroopPlacementStatus({
    arena,
    entities: createRoyaleTowers(),
    actor: "blue",
    position: { x: 3.5, y: 17.5 },
  });
  const blueCenterFront = getTroopPlacementStatus({
    arena,
    entities: createRoyaleTowers(),
    actor: "blue",
    position: { x: 9.5, y: 17.5 },
  });
  const blueRightFront = getTroopPlacementStatus({
    arena,
    entities: createRoyaleTowers(),
    actor: "blue",
    position: { x: 15.5, y: 17.5 },
  });
  const redLeftFront = getTroopPlacementStatus({
    arena,
    entities: createRoyaleTowers(),
    actor: "red",
    position: { x: 3.5, y: 14.5 },
  });
  const redCenterFront = getTroopPlacementStatus({
    arena,
    entities: createRoyaleTowers(),
    actor: "red",
    position: { x: 9.5, y: 14.5 },
  });
  const redRightFront = getTroopPlacementStatus({
    arena,
    entities: createRoyaleTowers(),
    actor: "red",
    position: { x: 15.5, y: 14.5 },
  });
  const lockedBridgeRiver = getTroopPlacementStatus({
    arena,
    entities: createRoyaleTowers(),
    actor: "blue",
    position: { x: 3.5, y: 15.5 },
  });
  const lockedWater = getTroopPlacementStatus({
    arena,
    entities: createRoyaleTowers(),
    actor: "blue",
    position: { x: 5.5, y: 15.5 },
  });

  assert.equal(blueLeftFront.ok, true);
  assert.equal(blueCenterFront.ok, true);
  assert.equal(blueRightFront.ok, true);
  assert.equal(redLeftFront.ok, true);
  assert.equal(redCenterFront.ok, true);
  assert.equal(redRightFront.ok, true);
  assert.equal(lockedBridgeRiver.ok, false);
  assert.equal(lockedWater.ok, false);
  assert.equal(lockedBridgeRiver.reason, "Troops must be played on your side.");
  assert.equal(lockedWater.reason, "Troops need a land tile.");
});

test("one destroyed crown tower unlocks only that lane's 5x9 pocket box and bridge connector", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const entities = createRoyaleTowers({ redLeftHp: 0 });
  const regions = getTroopDeployRegions({ arena, entities, actor: "blue" });
  const pocket = regions.find((region) => region.kind === "pocket");
  const connector = regions.find((region) => region.kind === "bridge_connector");

  assert.deepEqual(pocket, {
    kind: "pocket",
    lane: "left",
    minX: 0.5,
    maxX: 8.5,
    minY: 10.5,
    maxY: 14.5,
  });
  assert.deepEqual(connector, {
    kind: "bridge_connector",
    lane: "left",
    minX: 2.5,
    maxX: 4.5,
    minY: 15.5,
    maxY: 16.5,
  });

  const legalBridgeRow = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 3.5, y: 14.5 } });
  const legalUpperBridgeConnector = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 3.5, y: 15.5 } });
  const legalLowerBridgeConnector = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 3.5, y: 16.5 } });
  const legalInnerEdge = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 8.5, y: 10.5 } });
  const illegalCenter = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 9.5, y: 14.5 } });
  const illegalRight = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 15.5, y: 14.5 } });
  const illegalOtherBridge = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 15.5, y: 15.5 } });
  const illegalWater = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 5.5, y: 15.5 } });

  assert.equal(legalBridgeRow.ok, true);
  assert.equal(legalUpperBridgeConnector.ok, true);
  assert.equal(legalLowerBridgeConnector.ok, true);
  assert.equal(legalInnerEdge.ok, true);
  assert.equal(illegalCenter.ok, false);
  assert.equal(illegalRight.ok, false);
  assert.equal(illegalOtherBridge.ok, false);
  assert.equal(illegalWater.ok, false);
  assert.equal(illegalCenter.reason, "Troops must be played on your side or in an unlocked pocket.");
  assert.equal(illegalRight.reason, "Troops must be played on your side or in an unlocked pocket.");
  assert.equal(illegalOtherBridge.reason, "Troops must be played on your side or in an unlocked pocket.");
  assert.equal(illegalWater.reason, "Troops need a land tile.");
});

test("two destroyed crown towers unlock both 5x9 pocket boxes and bridge connectors without merging", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const entities = createRoyaleTowers({ redLeftHp: 0, redRightHp: 0 });
  const regions = getTroopDeployRegions({ arena, entities, actor: "blue" });
  const pockets = regions.filter((region) => region.kind === "pocket");
  const connectors = regions.filter((region) => region.kind === "bridge_connector");

  assert.deepEqual(pockets, [
    {
      kind: "pocket",
      lane: "left",
      minX: 0.5,
      maxX: 8.5,
      minY: 10.5,
      maxY: 14.5,
    },
    {
      kind: "pocket",
      lane: "right",
      minX: 9.5,
      maxX: 17.5,
      minY: 10.5,
      maxY: 14.5,
    },
  ]);
  assert.deepEqual(connectors, [
    {
      kind: "bridge_connector",
      lane: "left",
      minX: 2.5,
      maxX: 4.5,
      minY: 15.5,
      maxY: 16.5,
    },
    {
      kind: "bridge_connector",
      lane: "right",
      minX: 14.5,
      maxX: 16.5,
      minY: 15.5,
      maxY: 16.5,
    },
  ]);

  const legalRight = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 15.5, y: 14.5 } });
  const legalRightInnerEdge = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 9.5, y: 10.5 } });
  const legalLeftBridgeConnector = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 3.5, y: 16.5 } });
  const legalRightBridgeConnector = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 15.5, y: 15.5 } });
  const tooDeep = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 9.5, y: 9.5 } });

  assert.equal(legalRight.ok, true);
  assert.equal(legalRightInnerEdge.ok, true);
  assert.equal(legalLeftBridgeConnector.ok, true);
  assert.equal(legalRightBridgeConnector.ok, true);
  assert.equal(tooDeep.ok, false);
});

test("engine rejects locked pockets without cycling the card", () => {
  const engine = createPocketEngine(createRoyaleTowers({ redLeftHp: 0 }));
  const handBefore = engine.getHand("blue");
  const elixirBefore = engine.state.elixir.blue.elixir;

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "knight",
      x: 15.5,
      y: 14.5,
    },
  ]);

  assert.deepEqual(engine.getHand("blue"), handBefore);
  assert.equal(engine.state.elixir.blue.elixir, elixirBefore);
  assert.equal(engine.state.replay.events.some((event) => event.type === "card_played"), false);
});

test("engine rejects locked bridge river placements without cycling the card", () => {
  const engine = createPocketEngine();
  const handBefore = engine.getHand("blue");
  const elixirBefore = engine.state.elixir.blue.elixir;

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "knight",
      x: 3.5,
      y: 15.5,
    },
  ]);

  assert.deepEqual(engine.getHand("blue"), handBefore);
  assert.equal(engine.state.elixir.blue.elixir, elixirBefore);
  assert.equal(engine.state.replay.events.some((event) => event.type === "card_played"), false);
});

test("engine accepts unlocked pocket placements and cycles the card", () => {
  const engine = createPocketEngine(createRoyaleTowers({ redLeftHp: 0 }));
  const handBefore = engine.getHand("blue");

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "knight",
      x: 3,
      y: 14.5,
    },
  ]);

  assert.notDeepEqual(engine.getHand("blue"), handBefore);
  const playedEvent = engine.state.replay.events.find((event) => event.type === "card_played" && event.card_id === "knight");
  assert.ok(playedEvent);
  assert.equal(playedEvent.x, 3.5);
  assert.equal(playedEvent.y, 14.5);
});

test("engine accepts unlocked bridge river placements and cycles the card", () => {
  const engine = createPocketEngine(createRoyaleTowers({ redLeftHp: 0 }));
  const handBefore = engine.getHand("blue");

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "knight",
      x: 3.5,
      y: 15.5,
    },
  ]);

  assert.notDeepEqual(engine.getHand("blue"), handBefore);
  const playedEvent = engine.state.replay.events.find((event) => event.type === "card_played" && event.card_id === "knight");
  assert.ok(playedEvent);
  assert.equal(playedEvent.x, 3.5);
  assert.equal(playedEvent.y, 15.5);
});
