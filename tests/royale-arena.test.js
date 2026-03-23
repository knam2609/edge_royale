import test from "node:test";
import assert from "node:assert/strict";

import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { getScoreSnapshot } from "../src/sim/match.js";
import { createArena, createRoyaleArena } from "../src/sim/map.js";

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

test("troops cross the royale river only on bridge tiles", () => {
  const arena = createRoyaleArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const engine = createEngine({
    seed: 301,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTroop({ id: "blue_k", cardId: "knight", team: "blue", x: 2.5, y: 20.5, hp: 1400 }),
      createTower({ id: "red_left", team: "red", x: 5, y: 6, hp: 2500, tower_role: "crown" }),
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
    riverPositions.every((position) => position.x >= 4 && position.x <= 6),
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
    createTower({ id: "red_left", team: "red", x: 5, y: 6, hp: 0, tower_role: "crown" }),
    createTower({ id: "red_right", team: "red", x: 13, y: 6, hp: 2500, tower_role: "crown" }),
    createTower({ id: "red_king", team: "red", x: 9, y: 2, hp: 3600, tower_role: "king", is_active: false }),
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
