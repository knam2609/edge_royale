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

test("troop placement stays on own side until an enemy crown tower falls", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const status = getTroopPlacementStatus({
    arena,
    entities: createRoyaleTowers(),
    actor: "blue",
    position: { x: 3, y: 14.5 },
  });

  assert.equal(status.ok, false);
  assert.equal(status.reason, "Troops must be played on your side.");
});

test("one destroyed crown tower unlocks only that pocket plus the shared center column", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const entities = createRoyaleTowers({ redLeftHp: 0 });

  const legalLeft = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 3, y: 14.5 } });
  const legalCenter = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 9.5, y: 14.5 } });
  const illegalRight = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 15, y: 14.5 } });

  assert.equal(legalLeft.ok, true);
  assert.equal(legalCenter.ok, true);
  assert.equal(illegalRight.ok, false);
  assert.equal(illegalRight.reason, "Troops must be played on your side or in an unlocked pocket.");
});

test("two destroyed crown towers merge both pockets but stop at the crown row", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const entities = createRoyaleTowers({ redLeftHp: 0, redRightHp: 0 });
  const regions = getTroopDeployRegions({ arena, entities, actor: "blue" });
  const pocket = regions.find((region) => region.kind === "pocket");

  assert.deepEqual(pocket, {
    kind: "pocket",
    lane: "full",
    minX: 0,
    maxX: 18,
    minY: 6,
    maxY: 14.5,
  });

  const legalRight = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 15, y: 14.5 } });
  const tooDeep = getTroopPlacementStatus({ arena, entities, actor: "blue", position: { x: 9.5, y: 5.5 } });

  assert.equal(legalRight.ok, true);
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
      x: 15,
      y: 14.5,
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
