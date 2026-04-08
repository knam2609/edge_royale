import test from "node:test";
import assert from "node:assert/strict";

import { enumerateLegalCardActions, evaluateSpellAction, rollDecisionDelayTicks, selectBotAction } from "../src/ai/ladderRuntime.js";
import { trainSelfModel } from "../src/ai/training.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { ROYALE_LANE_X, ROYALE_TOWER_X, ROYALE_TOWER_Y, createArena, createRoyaleArena } from "../src/sim/map.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { getTowerStats } from "../src/sim/stats.js";

function makeCardState(redHand) {
  return {
    blue: {
      hand: ["giant", "knight", "archers", "arrows"],
      draw_pile: ["musketeer", "mini_pekka", "goblins", "fireball"],
    },
    red: {
      hand: redHand,
      draw_pile: ["musketeer", "mini_pekka", "goblins", "archers"],
    },
  };
}

function makeEngine(redHand) {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const crownHp = getTowerStats("crown").hp;
  return createEngine({
    seed: 901,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_tower", team: "blue", x: 9, y: 29, hp: crownHp }),
      createTower({ id: "red_tower", team: "red", x: 9, y: 3, hp: crownHp }),
      createTroop({ id: "blue_knight", cardId: "knight", team: "blue", x: 9, y: 23, hp: 1400 }),
    ],
    initialCardState: makeCardState(redHand),
  });
}

function makeRoyaleEngine(redHand, { blueLeftHp = getTowerStats("crown").hp, blueRightHp = getTowerStats("crown").hp } = {}) {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const crownHp = getTowerStats("crown").hp;
  return createEngine({
    seed: 902,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_left", team: "blue", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.blue.crown, hp: blueLeftHp, tower_role: "crown" }),
      createTower({ id: "blue_right", team: "blue", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.blue.crown, hp: blueRightHp, tower_role: "crown" }),
      createTower({ id: "blue_king", team: "blue", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.blue.king, tower_role: "king", is_active: false }),
      createTower({ id: "red_left", team: "red", x: ROYALE_TOWER_X.left, y: ROYALE_TOWER_Y.red.crown, hp: crownHp, tower_role: "crown" }),
      createTower({ id: "red_right", team: "red", x: ROYALE_TOWER_X.right, y: ROYALE_TOWER_Y.red.crown, hp: crownHp, tower_role: "crown" }),
      createTower({ id: "red_king", team: "red", x: ROYALE_TOWER_X.center, y: ROYALE_TOWER_Y.red.king, tower_role: "king", is_active: false }),
      createTroop({ id: "blue_knight", cardId: "knight", team: "blue", x: 9, y: 23, hp: 1400 }),
    ],
    initialCardState: makeCardState(redHand),
  });
}

test("enumerateLegalCardActions includes the full front row on your side", () => {
  const engine = makeRoyaleEngine(["giant", "fireball", "knight", "arrows"]);
  const actions = enumerateLegalCardActions({ engine, actor: "red" });

  assert.ok(actions.length > 0);
  const troopActions = actions.filter((action) => action.cardId === "giant" || action.cardId === "knight");
  const spellActions = actions.filter((action) => action.cardId === "fireball" || action.cardId === "arrows");

  assert.ok(troopActions.length > 0);
  assert.ok(spellActions.length > 0);
  for (const action of troopActions) {
    assert.ok(action.y <= 14.5, `red troop action crossed river: y=${action.y}`);
  }
  assert.ok(troopActions.some((action) => action.y === 14.5 && action.x === 3.5));
  assert.ok(troopActions.some((action) => action.y === 14.5 && action.x === 9.5));
  assert.ok(troopActions.some((action) => action.y === 14.5 && action.x === ROYALE_LANE_X.right));
});

test("enumerateLegalCardActions unlocks only the captured 5x9 pocket and bridge connector for red troops", () => {
  const engine = makeRoyaleEngine(["giant", "fireball", "knight", "arrows"], { blueLeftHp: 0 });
  const actions = enumerateLegalCardActions({ engine, actor: "red" });
  const troopActions = actions.filter((action) => action.cardId === "giant" || action.cardId === "knight");
  const pocketActions = troopActions.filter((action) => action.y >= 17.5);
  const bridgeActions = troopActions.filter((action) => action.y > 14.5 && action.y < 17.5);

  assert.ok(pocketActions.length > 0);
  assert.ok(pocketActions.some((action) => action.x === 3.5 || action.x === 4.5));
  assert.ok(pocketActions.every((action) => action.x <= 8.5));
  assert.ok(pocketActions.every((action) => action.y <= 21.5));
  assert.ok(!pocketActions.some((action) => action.x === 15.5));
  assert.ok(bridgeActions.some((action) => action.x === 3.5));
  assert.ok(bridgeActions.every((action) => action.x === 3.5));
  assert.ok(bridgeActions.every((action) => action.y === 15.5 || action.y === 16.5));
});

test("enumerateLegalCardActions unlocks both 5x9 pockets and both bridge connectors after both crowns fall", () => {
  const engine = makeRoyaleEngine(["giant", "fireball", "knight", "arrows"], { blueLeftHp: 0, blueRightHp: 0 });
  const actions = enumerateLegalCardActions({ engine, actor: "red" });
  const troopActions = actions.filter((action) => action.cardId === "giant" || action.cardId === "knight");
  const pocketActions = troopActions.filter((action) => action.y >= 17.5);
  const bridgeActions = troopActions.filter((action) => action.y > 14.5 && action.y < 17.5);

  assert.ok(pocketActions.some((action) => action.x <= 8.5));
  assert.ok(pocketActions.some((action) => action.x === 13.5 || action.x === ROYALE_LANE_X.right));
  assert.ok(pocketActions.every((action) => action.y <= 21.5));
  assert.ok(bridgeActions.some((action) => action.x === 3.5));
  assert.ok(bridgeActions.some((action) => action.x === ROYALE_LANE_X.right));
});

test("noob bot returns a legal action when not passing", () => {
  const engine = makeEngine(["knight", "goblins", "arrows", "fireball"]);
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });

  const action = selectBotAction({
    tierId: "noob",
    engine,
    actor: "red",
    legalActions,
    rng: () => 0.9,
  });

  assert.equal(action.type, "PLAY_CARD");
  assert.ok(legalActions.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action)));
});

test("top bot returns a legal action when one is available", () => {
  const engine = makeEngine(["giant", "knight", "arrows", "fireball"]);
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });

  const action = selectBotAction({
    tierId: "top",
    engine,
    actor: "red",
    legalActions,
    rng: () => 0.9,
  });

  if (action.type === "PASS") {
    return;
  }
  assert.ok(legalActions.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action)));
});

test("pro/goat/god tiers produce legal outputs", () => {
  const engine = makeEngine(["giant", "knight", "arrows", "fireball"]);
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });

  for (const tierId of ["pro", "goat", "god"]) {
    const action = selectBotAction({
      tierId,
      engine,
      actor: "red",
      legalActions,
      rng: () => 0.9,
    });

    if (action.type === "PASS") {
      continue;
    }
    assert.ok(
      legalActions.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action)),
      `tier ${tierId} returned illegal action`,
    );
  }
});

test("self bot follows trained card preference when available", () => {
  const engine = makeEngine(["knight", "giant", "arrows", "fireball"]);
  const model = trainSelfModel(
    [
      { phase: "normal", elixir: 4, card_id: "knight", hand: ["knight", "giant"], tick: 1 },
      { phase: "normal", elixir: 4, card_id: "knight", hand: ["knight", "giant"], tick: 2 },
      { phase: "normal", elixir: 4, card_id: "giant", hand: ["knight", "giant"], tick: 3 },
    ],
    { minSamples: 1 },
  );

  const legalActions = [
    { type: "PLAY_CARD", cardId: "giant", x: 9, y: 12 },
    { type: "PLAY_CARD", cardId: "knight", x: 9, y: 12 },
  ];

  const action = selectBotAction({
    tierId: "self",
    engine,
    actor: "red",
    legalActions,
    trainedModel: model,
    rng: () => 0.9,
  });

  assert.equal(action.type, "PLAY_CARD");
  assert.equal(action.cardId, "knight");
});

test("decision delay for tier is always within configured bounds", () => {
  const tiny = rollDecisionDelayTicks({ tierId: "mid", rng: () => 0 });
  const huge = rollDecisionDelayTicks({ tierId: "mid", rng: () => 0.999 });

  assert.ok(tiny >= 8 && tiny <= 20);
  assert.ok(huge >= 8 && huge <= 20);
});

test("spell evaluation uses explicit tower chip values for arrows and fireball", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const tower = createTower({ id: "red_tower", team: "red", x: 9, y: 3 });
  const state = {
    arena,
    entities: [tower],
  };

  const fireballScore = evaluateSpellAction(
    { type: "PLAY_CARD", cardId: "fireball", x: 9, y: 3 },
    state,
    "blue",
    "normal",
    "mid",
  );
  const arrowsScore = evaluateSpellAction(
    { type: "PLAY_CARD", cardId: "arrows", x: 9, y: 3 },
    state,
    "blue",
    "normal",
    "mid",
  );

  assert.equal(fireballScore.score, 237);
  assert.equal(fireballScore.towerHits, 1);
  assert.equal(fireballScore.troopHits, 0);

  assert.equal(arrowsScore.score, -37);
  assert.equal(arrowsScore.towerHits, 1);
  assert.equal(arrowsScore.troopHits, 0);
});
