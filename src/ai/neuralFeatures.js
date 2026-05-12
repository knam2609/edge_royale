import { DEFAULT_DECK, getCard } from "../sim/cards.js";
import { MATCH_CONFIG, getMatchPhase } from "../sim/config.js";
import { getTowerStats } from "../sim/stats.js";

export const FEATURE_SCHEMA_VERSION = "goat_state_features_v1";
export const GOD_FEATURE_SCHEMA_VERSION = "god_state_features_v1";
export const LEGACY_ACTION_SCHEMA_VERSION = "goat_action_features_v1";
export const ACTION_SCHEMA_VERSION = "goat_action_features_v2";
export const CARD_FEATURE_ORDER = Object.freeze([...DEFAULT_DECK]);
export const PHASE_FEATURE_ORDER = Object.freeze(["normal", "double", "overtime"]);

export const STATE_FEATURE_SIZE = 74;
export const GOD_STATE_FEATURE_SIZE = STATE_FEATURE_SIZE + 17;
export const LEGACY_ACTION_FEATURE_SIZE = 17;
export const ACTION_FEATURE_SIZE = 18;
export const LEGACY_MODEL_INPUT_SIZE = STATE_FEATURE_SIZE + LEGACY_ACTION_FEATURE_SIZE;
export const LEGACY_GOD_MODEL_INPUT_SIZE = GOD_STATE_FEATURE_SIZE + LEGACY_ACTION_FEATURE_SIZE;
export const MODEL_INPUT_SIZE = STATE_FEATURE_SIZE + ACTION_FEATURE_SIZE;
export const GOD_MODEL_INPUT_SIZE = GOD_STATE_FEATURE_SIZE + ACTION_FEATURE_SIZE;

const LANE_KEYS = Object.freeze(["left", "center", "right"]);
const TROOP_SUMMARY_TEAMS = Object.freeze(["own", "enemy"]);
const TROOP_SUMMARY_HALVES = Object.freeze(["own", "enemy"]);

function clamp(value, min = 0, max = 1) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

function norm(value, denominator, min = 0, max = 1) {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(denominator)) || denominator === 0) {
    return min;
  }
  return clamp(value / denominator, min, max);
}

function getArenaWidth(arena) {
  return Math.max(1, arena.maxX - arena.minX);
}

function getArenaHeight(arena) {
  return Math.max(1, arena.maxY - arena.minY);
}

function getMidX(arena) {
  return (arena.minX + arena.maxX) / 2;
}

function getMidY(arena) {
  return (arena.minY + arena.maxY) / 2;
}

function getTeam(actor) {
  return actor === "red" ? { own: "red", enemy: "blue" } : { own: "blue", enemy: "red" };
}

function isOnOwnSide(actor, y, arena) {
  const midY = getMidY(arena);
  return actor === "blue" ? y >= midY : y <= midY;
}

function perspectiveY(actor, y, arena) {
  const raw = norm(y - arena.minY, getArenaHeight(arena));
  return actor === "blue" ? raw : 1 - raw;
}

function laneKeyForX(x, arena) {
  const width = getArenaWidth(arena);
  const leftBreak = arena.minX + width / 3;
  const rightBreak = arena.minX + (width * 2) / 3;
  if (x < leftBreak) {
    return "left";
  }
  if (x > rightBreak) {
    return "right";
  }
  return "center";
}

function oneHot(value, order) {
  return order.map((entry) => (entry === value ? 1 : 0));
}

function isPassAction(action) {
  return action?.type === "PASS";
}

function pushCardPresence(features, cards) {
  const cardSet = new Set(Array.isArray(cards) ? cards : []);
  for (const cardId of CARD_FEATURE_ORDER) {
    features.push(cardSet.has(cardId) ? 1 : 0);
  }
}

function pushDeckPositions(features, deckQueue) {
  const queue = Array.isArray(deckQueue) ? deckQueue : [];
  for (const cardId of CARD_FEATURE_ORDER) {
    const index = queue.indexOf(cardId);
    features.push(index >= 0 ? norm(index + 1, CARD_FEATURE_ORDER.length) : 0);
  }
}

function getTowersForTeam(state, team) {
  return state.entities.filter(
    (entity) => entity.team === team && entity.entity_type === "tower" && entity.hp > 0,
  );
}

function pushTowerSummary(features, state, team) {
  const towers = getTowersForTeam(state, team);
  const crownTowers = towers.filter((tower) => (tower.tower_role ?? "crown") === "crown");
  const kingTower = towers.find((tower) => tower.tower_role === "king") ?? null;
  const crownMaxHp = getTowerStats("crown").hp;
  const kingMaxHp = getTowerStats("king").hp;
  const crownHpValues = crownTowers.map((tower) => tower.hp);
  const crownMinHp = crownHpValues.length > 0 ? Math.min(...crownHpValues) : 0;
  const crownAvgHp =
    crownHpValues.length > 0 ? crownHpValues.reduce((sum, hp) => sum + hp, 0) / crownHpValues.length : 0;

  features.push(norm(crownTowers.length, 2));
  features.push(norm(crownMinHp, crownMaxHp));
  features.push(norm(crownAvgHp, crownMaxHp));
  features.push(norm(kingTower?.hp ?? 0, kingMaxHp));
  features.push(kingTower?.is_active === false ? 0 : kingTower ? 1 : 0);
}

function buildTroopSummary(state, actor) {
  const { own, enemy } = getTeam(actor);
  const summary = {};
  for (const teamKey of TROOP_SUMMARY_TEAMS) {
    summary[teamKey] = {};
    for (const halfKey of TROOP_SUMMARY_HALVES) {
      summary[teamKey][halfKey] = {};
      for (const laneKey of LANE_KEYS) {
        summary[teamKey][halfKey][laneKey] = { count: 0, hp: 0 };
      }
    }
  }

  for (const entity of state.entities) {
    if (entity.entity_type !== "troop" || entity.hp <= 0) {
      continue;
    }
    const teamKey = entity.team === own ? "own" : entity.team === enemy ? "enemy" : null;
    if (!teamKey) {
      continue;
    }
    const halfKey = isOnOwnSide(actor, entity.y, state.arena) ? "own" : "enemy";
    const laneKey = laneKeyForX(entity.x, state.arena);
    summary[teamKey][halfKey][laneKey].count += 1;
    summary[teamKey][halfKey][laneKey].hp += entity.hp;
  }

  return summary;
}

function pushTroopSummary(features, state, actor) {
  const summary = buildTroopSummary(state, actor);
  for (const teamKey of TROOP_SUMMARY_TEAMS) {
    for (const halfKey of TROOP_SUMMARY_HALVES) {
      for (const laneKey of LANE_KEYS) {
        const bucket = summary[teamKey][halfKey][laneKey];
        features.push(norm(bucket.count, 8));
        features.push(norm(bucket.hp, 8000));
      }
    }
  }
}

function pushTroopCardCounts(features, state, actor) {
  const { own, enemy } = getTeam(actor);
  for (const team of [own, enemy]) {
    for (const cardId of CARD_FEATURE_ORDER) {
      const count = state.entities.filter(
        (entity) =>
          entity.team === team &&
          entity.entity_type === "troop" &&
          entity.hp > 0 &&
          entity.card_id === cardId,
      ).length;
      features.push(norm(count, 8));
    }
  }
}

export function encodeStateFeatures({ engine, actor = "red" }) {
  const state = engine.state;
  const phase = getMatchPhase({ tick: state.tick, isOvertime: state.isOvertime });
  const features = [];

  features.push(...oneHot(phase, PHASE_FEATURE_ORDER));
  features.push(norm(state.tick, MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks));
  features.push(norm(Math.max(0, MATCH_CONFIG.regulation_ticks - Math.min(state.tick, MATCH_CONFIG.regulation_ticks)), MATCH_CONFIG.regulation_ticks));
  const overtimeElapsed = Math.max(0, state.tick - MATCH_CONFIG.regulation_ticks);
  features.push(norm(Math.max(0, MATCH_CONFIG.overtime_ticks - overtimeElapsed), MATCH_CONFIG.overtime_ticks));
  features.push(state.isOvertime ? 1 : 0);

  features.push(norm(state.elixir[actor]?.elixir ?? 0, 10));
  pushCardPresence(features, engine.getHand(actor));
  pushDeckPositions(features, engine.getDeckQueue(actor));

  const { own, enemy } = getTeam(actor);
  pushTowerSummary(features, state, own);
  pushTowerSummary(features, state, enemy);
  pushTroopSummary(features, state, actor);
  pushTroopCardCounts(features, state, actor);

  if (features.length !== STATE_FEATURE_SIZE) {
    throw new Error(`state feature size mismatch: expected ${STATE_FEATURE_SIZE}, got ${features.length}`);
  }

  return features;
}

export function encodeGodStateFeatures({ engine, actor = "red" }) {
  const features = encodeStateFeatures({ engine, actor });
  const { enemy } = getTeam(actor);

  features.push(norm(engine.state.elixir[enemy]?.elixir ?? 0, 10));
  pushCardPresence(features, engine.getHand(enemy));
  pushDeckPositions(features, engine.getDeckQueue(enemy));

  if (features.length !== GOD_STATE_FEATURE_SIZE) {
    throw new Error(`god state feature size mismatch: expected ${GOD_STATE_FEATURE_SIZE}, got ${features.length}`);
  }

  return features;
}

export function getStateFeatureSizeForSchema(featureSchemaVersion = FEATURE_SCHEMA_VERSION) {
  if (featureSchemaVersion === GOD_FEATURE_SCHEMA_VERSION) {
    return GOD_STATE_FEATURE_SIZE;
  }
  return STATE_FEATURE_SIZE;
}

export function getActionFeatureSizeForSchema(actionSchemaVersion = ACTION_SCHEMA_VERSION) {
  return actionSchemaVersion === LEGACY_ACTION_SCHEMA_VERSION
    ? LEGACY_ACTION_FEATURE_SIZE
    : ACTION_FEATURE_SIZE;
}

export function getModelInputSizeForSchemas({
  featureSchemaVersion = FEATURE_SCHEMA_VERSION,
  actionSchemaVersion = ACTION_SCHEMA_VERSION,
} = {}) {
  return (
    getStateFeatureSizeForSchema(featureSchemaVersion) +
    getActionFeatureSizeForSchema(actionSchemaVersion)
  );
}

export function getModelInputSizeForFeatureSchema(featureSchemaVersion = FEATURE_SCHEMA_VERSION) {
  return getModelInputSizeForSchemas({ featureSchemaVersion });
}

export function normalizeActionFeatureSchemaVersion(actionSchemaVersion = ACTION_SCHEMA_VERSION) {
  return actionSchemaVersion === LEGACY_ACTION_SCHEMA_VERSION || actionSchemaVersion === ACTION_SCHEMA_VERSION
    ? actionSchemaVersion
    : null;
}

export function normalizeActionFeaturesForSchema({
  actionFeatures,
  sourceActionSchemaVersion = ACTION_SCHEMA_VERSION,
  targetActionSchemaVersion = ACTION_SCHEMA_VERSION,
} = {}) {
  const sourceSchemaVersion = normalizeActionFeatureSchemaVersion(sourceActionSchemaVersion);
  const targetSchemaVersion = normalizeActionFeatureSchemaVersion(targetActionSchemaVersion);
  if (!sourceSchemaVersion || !targetSchemaVersion || !Array.isArray(actionFeatures)) {
    return null;
  }

  const expectedSourceSize = getActionFeatureSizeForSchema(sourceSchemaVersion);
  if (actionFeatures.length !== expectedSourceSize) {
    return null;
  }

  const normalized = actionFeatures.map((value) => Number(value));
  if (normalized.some((value) => !Number.isFinite(value))) {
    return null;
  }

  if (sourceSchemaVersion === targetSchemaVersion) {
    return normalized;
  }

  if (
    sourceSchemaVersion === LEGACY_ACTION_SCHEMA_VERSION &&
    targetSchemaVersion === ACTION_SCHEMA_VERSION
  ) {
    return [...normalized, 0];
  }

  if (
    sourceSchemaVersion === ACTION_SCHEMA_VERSION &&
    targetSchemaVersion === LEGACY_ACTION_SCHEMA_VERSION
  ) {
    return normalized.slice(0, LEGACY_ACTION_FEATURE_SIZE);
  }

  return null;
}

export function encodeStateFeaturesForSchema({
  engine,
  actor = "red",
  featureSchemaVersion = FEATURE_SCHEMA_VERSION,
}) {
  if (featureSchemaVersion === GOD_FEATURE_SCHEMA_VERSION) {
    return encodeGodStateFeatures({ engine, actor });
  }
  return encodeStateFeatures({ engine, actor });
}

export function encodeActionFeatures({
  engine,
  actor = "red",
  action,
  actionSchemaVersion = ACTION_SCHEMA_VERSION,
}) {
  const state = engine.state;
  const schemaVersion =
    normalizeActionFeatureSchemaVersion(actionSchemaVersion) ?? ACTION_SCHEMA_VERSION;
  const card = isPassAction(action) ? null : getCard(action?.cardId);
  const features = [];

  if (isPassAction(action)) {
    features.push(...Array.from({ length: LEGACY_ACTION_FEATURE_SIZE }, () => 0));
  } else {
    features.push(...oneHot(action?.cardId, CARD_FEATURE_ORDER));
    features.push(norm(card?.cost ?? 0, 5));
    features.push(card?.type === "troop" ? 1 : 0);
    features.push(card?.type === "spell" ? 1 : 0);
    features.push(norm((Number(action?.x) || 0) - state.arena.minX, getArenaWidth(state.arena)));
    features.push(perspectiveY(actor, Number(action?.y) || 0, state.arena));
    features.push(
      clamp(
        ((Number(action?.x) || 0) - getMidX(state.arena)) / (getArenaWidth(state.arena) / 2),
        -1,
        1,
      ),
    );
    features.push(
      norm(
        Math.abs((Number(action?.y) || 0) - getMidY(state.arena)),
        getArenaHeight(state.arena) / 2,
      ),
    );
    features.push(isOnOwnSide(actor, Number(action?.y) || 0, state.arena) ? 1 : 0);
    features.push(norm((state.elixir[actor]?.elixir ?? 0) - (card?.cost ?? 0), 10, -1, 1));
  }

  if (schemaVersion === ACTION_SCHEMA_VERSION) {
    features.push(isPassAction(action) ? 1 : 0);
  }

  const expectedSize = getActionFeatureSizeForSchema(schemaVersion);
  if (features.length !== expectedSize) {
    throw new Error(`action feature size mismatch: expected ${expectedSize}, got ${features.length}`);
  }

  return features;
}

export function encodeModelInput({
  engine,
  actor = "red",
  action,
  featureSchemaVersion = FEATURE_SCHEMA_VERSION,
  actionSchemaVersion = ACTION_SCHEMA_VERSION,
}) {
  return [
    ...encodeStateFeaturesForSchema({ engine, actor, featureSchemaVersion }),
    ...encodeActionFeatures({ engine, actor, action, actionSchemaVersion }),
  ];
}
