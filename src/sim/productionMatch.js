import { FIREBALL_CONFIG } from "./config.js";
import { createEngine } from "./engine.js";
import { createTower } from "./entities.js";
import {
  ROYALE_TOWER_X,
  ROYALE_TOWER_Y,
  createRoyaleArena,
} from "./map.js";
import { getTowerStats } from "./stats.js";

export const EDGER_RULES_VERSION = "edge_royale_rules_2026_07_18";
export const EDGER_SIMULATOR_VERSION = "edge_royale_simulator_v1";

export const PRODUCTION_ARENA_DESCRIPTOR = Object.freeze({
  type: "royale",
  min_x: 0,
  max_x: 18,
  min_y: 0,
  max_y: 32,
});

function makeTowerSpec({ id, team, towerRole, x, y }) {
  return Object.freeze({
    id,
    team,
    tower_role: towerRole,
    x,
    y,
    hp: getTowerStats(towerRole).hp,
    is_active: towerRole !== "king",
  });
}

export const PRODUCTION_TOWER_LAYOUT = Object.freeze([
  makeTowerSpec({
    id: "blue_crown_left",
    team: "blue",
    towerRole: "crown",
    x: ROYALE_TOWER_X.left,
    y: ROYALE_TOWER_Y.blue.crown,
  }),
  makeTowerSpec({
    id: "blue_crown_right",
    team: "blue",
    towerRole: "crown",
    x: ROYALE_TOWER_X.right,
    y: ROYALE_TOWER_Y.blue.crown,
  }),
  makeTowerSpec({
    id: "blue_king",
    team: "blue",
    towerRole: "king",
    x: ROYALE_TOWER_X.center,
    y: ROYALE_TOWER_Y.blue.king,
  }),
  makeTowerSpec({
    id: "red_crown_left",
    team: "red",
    towerRole: "crown",
    x: ROYALE_TOWER_X.left,
    y: ROYALE_TOWER_Y.red.crown,
  }),
  makeTowerSpec({
    id: "red_crown_right",
    team: "red",
    towerRole: "crown",
    x: ROYALE_TOWER_X.right,
    y: ROYALE_TOWER_Y.red.crown,
  }),
  makeTowerSpec({
    id: "red_king",
    team: "red",
    towerRole: "king",
    x: ROYALE_TOWER_X.center,
    y: ROYALE_TOWER_Y.red.king,
  }),
]);

export function createProductionArena() {
  return createRoyaleArena({
    minX: PRODUCTION_ARENA_DESCRIPTOR.min_x,
    maxX: PRODUCTION_ARENA_DESCRIPTOR.max_x,
    minY: PRODUCTION_ARENA_DESCRIPTOR.min_y,
    maxY: PRODUCTION_ARENA_DESCRIPTOR.max_y,
  });
}

export function createProductionInitialEntities() {
  return PRODUCTION_TOWER_LAYOUT.map((tower) => createTower({ ...tower }));
}

export function createProductionEngine({
  seed = 1,
  initialCardState = null,
} = {}) {
  return createEngine({
    seed,
    arena: createProductionArena(),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: createProductionInitialEntities(),
    initialCardState,
  });
}

export function cloneProductionInitialCardState(engine) {
  return {
    blue: {
      hand: engine.getHand("blue"),
      draw_pile: engine.getDeckQueue("blue"),
    },
    red: {
      hand: engine.getHand("red"),
      draw_pile: engine.getDeckQueue("red"),
    },
  };
}
