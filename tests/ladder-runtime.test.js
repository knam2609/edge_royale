import test from "node:test";
import assert from "node:assert/strict";

import { enumerateLegalCardActions, rollDecisionDelayTicks, selectBotAction } from "../src/ai/ladderRuntime.js";
import { trainSelfModel } from "../src/ai/training.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createArena } from "../src/sim/map.js";
import { createTower, createTroop } from "../src/sim/entities.js";

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
  return createEngine({
    seed: 901,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_tower", team: "blue", x: 9, y: 29, hp: 3800 }),
      createTower({ id: "red_tower", team: "red", x: 9, y: 3, hp: 3800 }),
      createTroop({ id: "blue_knight", cardId: "knight", team: "blue", x: 9, y: 23, hp: 1400 }),
    ],
    initialCardState: makeCardState(redHand),
  });
}

test("enumerateLegalCardActions respects side placement for troops", () => {
  const engine = makeEngine(["giant", "fireball", "knight", "arrows"]);
  const actions = enumerateLegalCardActions({ engine, actor: "red" });

  assert.ok(actions.length > 0);
  const troopActions = actions.filter((action) => action.cardId === "giant" || action.cardId === "knight");
  const spellActions = actions.filter((action) => action.cardId === "fireball" || action.cardId === "arrows");

  assert.ok(troopActions.length > 0);
  assert.ok(spellActions.length > 0);
  for (const action of troopActions) {
    assert.ok(action.y <= 16, `red troop action crossed river: y=${action.y}`);
  }
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

  assert.ok(tiny >= 7 && tiny <= 18);
  assert.ok(huge >= 7 && huge <= 18);
});
