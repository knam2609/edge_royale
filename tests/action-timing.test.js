import test from "node:test";
import assert from "node:assert/strict";

import { ARROWS_CONFIG, FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { createArena } from "../src/sim/map.js";
import { getTowerStats, getTroopStats } from "../src/sim/stats.js";

function makeCardState({ blueHand, blueQueue }) {
  const redHand = ["giant", "knight", "archers", "mini_pekka"];
  const redQueue = ["musketeer", "goblins", "arrows", "fireball"];

  return {
    blue: {
      hand: blueHand,
      draw_pile: blueQueue,
    },
    red: {
      hand: redHand,
      draw_pile: redQueue,
    },
  };
}

function countAliveTroopsByCard(engine, team, cardId) {
  return engine.state.entities.filter(
    (entity) => entity.entity_type === "troop" && entity.team === team && entity.cardId === cardId && entity.hp > 0,
  ).length;
}

function getEntityHp(engine, entityId) {
  const entity = engine.state.entities.find((candidate) => candidate.id === entityId);
  return entity?.hp ?? null;
}

test("troop PLAY_CARD resolves only after deploy delay", () => {
  const arena = createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 });
  const initialCardState = makeCardState({
    blueHand: ["knight", "fireball", "arrows", "giant"],
    blueQueue: ["archers", "musketeer", "goblins", "mini_pekka"],
  });

  const engine = createEngine({
    seed: 71,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [],
    initialCardState,
  });

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "knight",
      x: 9,
      y: 24,
    },
  ]);

  assert.equal(countAliveTroopsByCard(engine, "blue", "knight"), 0);

  while (engine.state.tick < 20) {
    engine.step([]);
  }
  assert.equal(countAliveTroopsByCard(engine, "blue", "knight"), 0);

  engine.step([]);
  assert.equal(engine.state.tick, 21);
  assert.equal(countAliveTroopsByCard(engine, "blue", "knight"), 1);

  const cardPlayed = engine.state.replay.events.find((event) => event.type === "card_played" && event.card_id === "knight");
  const troopDeployed = engine.state.replay.events.find(
    (event) => event.type === "troop_deployed" && event.card_id === "knight",
  );

  assert.ok(cardPlayed);
  assert.ok(troopDeployed);
  assert.equal(cardPlayed.resolve_tick, 21);
  assert.equal(troopDeployed.tick, 21);
  assert.equal(cardPlayed.effect_id, troopDeployed.effect_id);
});

test("arrows PLAY_CARD applies troop and tower damage only after cast delay", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  const knightStats = getTroopStats("knight");
  const crownStats = getTowerStats("crown");
  const enemy = createTroop({ id: "enemy", cardId: "knight", team: "red", x: 5, y: 5, hp: knightStats.hp });
  const enemyTower = createTower({ id: "tower_red", team: "red", x: 5, y: 4, hp: crownStats.hp });
  const initialCardState = makeCardState({
    blueHand: ["arrows", "knight", "fireball", "giant"],
    blueQueue: ["archers", "musketeer", "goblins", "mini_pekka"],
  });

  const engine = createEngine({
    seed: 72,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [enemy, enemyTower],
    initialCardState,
  });

  engine.step([
    {
      tick: 1,
      type: "PLAY_CARD",
      actor: "blue",
      cardId: "arrows",
      x: 5,
      y: 5,
    },
  ]);

  while (engine.state.tick < 16) {
    engine.step([]);
  }
  assert.equal(getEntityHp(engine, "enemy"), knightStats.hp);
  assert.equal(getEntityHp(engine, "tower_red"), crownStats.hp);

  engine.step([]);
  assert.equal(engine.state.tick, 17);
  assert.equal(getEntityHp(engine, "enemy"), knightStats.hp - ARROWS_CONFIG.troop_damage);
  assert.equal(getEntityHp(engine, "tower_red"), crownStats.hp - ARROWS_CONFIG.tower_damage);

  const impact = engine.state.replay.events.find(
    (event) => event.type === "spell_impact" && event.source_spell === "arrows",
  );
  assert.ok(impact);
  assert.equal(impact.tick, 17);
});

test("fireball PLAY_CARD resolves troop and tower damage after cast plus travel delay", () => {
  const arena = createArena({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  const knightStats = getTroopStats("knight");
  const crownStats = getTowerStats("crown");
  const enemyTower = createTower({ id: "tower_red", team: "red", x: 5, y: 4, hp: crownStats.hp });
  const enemyTroop = createTroop({ id: "enemy", cardId: "knight", team: "red", x: 5, y: 5, hp: knightStats.hp });
  const initialCardState = makeCardState({
    blueHand: ["fireball", "knight", "arrows", "giant"],
    blueQueue: ["archers", "musketeer", "goblins", "mini_pekka"],
  });

  const engine = createEngine({
    seed: 73,
    arena,
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [enemyTower, enemyTroop],
    initialCardState,
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
  assert.equal(getEntityHp(engine, "tower_red"), crownStats.hp);
  assert.equal(getEntityHp(engine, "enemy"), knightStats.hp);

  engine.step([]);
  assert.equal(engine.state.tick, 19);
  assert.equal(getEntityHp(engine, "tower_red"), crownStats.hp - FIREBALL_CONFIG.tower_damage);
  assert.equal(getEntityHp(engine, "enemy"), knightStats.hp - FIREBALL_CONFIG.troop_damage);

  const scheduled = engine.state.replay.events.find(
    (event) => event.type === "effect_scheduled" && event.card_id === "fireball",
  );
  const impact = engine.state.replay.events.find(
    (event) => event.type === "spell_impact" && event.source_spell === "fireball",
  );

  assert.ok(scheduled);
  assert.ok(impact);
  assert.equal(scheduled.resolve_tick, 19);
  assert.equal(impact.tick, 19);
});
