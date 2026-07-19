import { DEFAULT_DECK, getCard } from "../../sim/cards.js";
import { MATCH_CONFIG, getMatchPhase } from "../../sim/config.js";
import { getTowerStats } from "../../sim/stats.js";

export const EDGER_V2_OBSERVATION_SCHEMA_VERSION = "edger_oracle_observation_v2";
export const EDGER_V2_ACTION_SPACE_VERSION = "edger_autoregressive_action_v2";
export const EDGER_V2_BOARD_HEIGHT = 32;
export const EDGER_V2_BOARD_WIDTH = 18;
export const EDGER_V2_BOARD_CHANNELS = 24;
export const EDGER_V2_GLOBAL_FEATURES = 96;
export const EDGER_V2_CARD_ACTIONS = Object.freeze(["PASS", ...DEFAULT_DECK]);
export const EDGER_V2_DELAY_BINS = 200;

const CARD_INDEX = new Map(DEFAULT_DECK.map((cardId, index) => [cardId, index]));
const EPSILON = 1e-9;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeRatio(value, denominator) {
  if (!Number.isFinite(value) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return clamp(value / denominator, -1, 1);
}

function otherTeam(actor) {
  return actor === "blue" ? "red" : "blue";
}

function canonicalCell(actor, x, y) {
  let canonicalX = Number(x);
  let canonicalY = Number(y);
  if (actor === "blue") {
    canonicalX = EDGER_V2_BOARD_WIDTH - canonicalX;
    canonicalY = EDGER_V2_BOARD_HEIGHT - canonicalY;
  }
  return {
    row: clamp(Math.floor(canonicalY), 0, EDGER_V2_BOARD_HEIGHT - 1),
    column: clamp(Math.floor(canonicalX), 0, EDGER_V2_BOARD_WIDTH - 1),
  };
}

function canonicalVector(actor, x, y) {
  if (actor === "blue") {
    return { x: -x, y: -y };
  }
  return { x, y };
}

function boardOffset(row, column, channel) {
  return ((row * EDGER_V2_BOARD_WIDTH + column) * EDGER_V2_BOARD_CHANNELS) + channel;
}

function addBoardFeature(board, row, column, channel, value, { replace = false } = {}) {
  const offset = boardOffset(row, column, channel);
  if (replace) {
    board[offset] = value;
  } else {
    board[offset] += value;
  }
}

function getTowerHpRatio(entity) {
  const role = entity.tower_role === "king" ? "king" : "crown";
  return safeRatio(Math.max(0, entity.hp), getTowerStats(role).hp);
}

function getEntityHpRatio(entity) {
  if (entity.entity_type === "tower") {
    return getTowerHpRatio(entity);
  }
  return safeRatio(Math.max(0, entity.hp), Math.max(1, entity.maxHp ?? entity.hp));
}

function paintEntity({ board, entity, actor, entityById }) {
  if (!entity || entity.hp <= 0) {
    return;
  }
  const own = entity.team === actor;
  const cell = canonicalCell(actor, entity.x, entity.y);
  const velocity = canonicalVector(actor, entity.velocity?.x ?? 0, entity.velocity?.y ?? 0);
  const target = entityById.get(entity.target_entity_id);
  const targetVector = target
    ? canonicalVector(actor, target.x - entity.x, target.y - entity.y)
    : { x: 0, y: 0 };
  const cooldown = safeRatio(
    entity.attack_cooldown_ticks_remaining ?? 0,
    Math.max(1, entity.attack_cooldown_ticks ?? 1),
  );

  if (entity.entity_type === "tower") {
    addBoardFeature(board, cell.row, cell.column, own ? 2 : 3, 1);
    if (entity.tower_role === "king") {
      addBoardFeature(board, cell.row, cell.column, own ? 4 : 5, entity.is_active === false ? 0.5 : 1);
    }
  } else {
    addBoardFeature(board, cell.row, cell.column, own ? 0 : 1, 1);
    const cardValue = ((CARD_INDEX.get(entity.cardId) ?? -1) + 1) / DEFAULT_DECK.length;
    addBoardFeature(board, cell.row, cell.column, own ? 8 : 9, cardValue);
  }

  addBoardFeature(board, cell.row, cell.column, own ? 6 : 7, getEntityHpRatio(entity));
  addBoardFeature(board, cell.row, cell.column, own ? 10 : 12, safeRatio(velocity.x, 0.25));
  addBoardFeature(board, cell.row, cell.column, own ? 11 : 13, safeRatio(velocity.y, 0.25));
  addBoardFeature(board, cell.row, cell.column, own ? 14 : 16, safeRatio(targetVector.x, EDGER_V2_BOARD_WIDTH));
  addBoardFeature(board, cell.row, cell.column, own ? 15 : 17, safeRatio(targetVector.y, EDGER_V2_BOARD_HEIGHT));
  addBoardFeature(board, cell.row, cell.column, own ? 18 : 19, cooldown);
}

function paintPendingEffect({ board, effect, actor, tick }) {
  if (!Number.isFinite(effect?.x) || !Number.isFinite(effect?.y)) {
    return;
  }
  const own = effect.actor === actor;
  const cell = canonicalCell(actor, effect.x, effect.y);
  const channel = own ? 20 : 21;
  const detailChannel = own ? 22 : 23;
  const typeValue = effect.effect_type === "spell_fireball"
    ? 1
    : effect.effect_type === "spell_arrows"
      ? 0.75
      : 0.5;
  const timeValue = 1 - clamp((effect.resolve_tick - tick) / EDGER_V2_DELAY_BINS, 0, 1);
  addBoardFeature(board, cell.row, cell.column, channel, 1);
  addBoardFeature(board, cell.row, cell.column, detailChannel, typeValue * (0.5 + 0.5 * timeValue));
}

function markCards(features, offset, cards) {
  for (const cardId of cards) {
    const index = CARD_INDEX.get(cardId);
    if (index !== undefined) {
      features[offset + index] = 1;
    }
  }
}

function markQueue(features, offset, queue) {
  queue.slice(0, DEFAULT_DECK.length).forEach((cardId, position) => {
    const index = CARD_INDEX.get(cardId);
    features[offset + position] = index === undefined ? 0 : (index + 1) / DEFAULT_DECK.length;
  });
}

function livingTowers(state, team) {
  return (state.entities ?? [])
    .filter((entity) => entity.entity_type === "tower" && entity.team === team && entity.hp > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function towerByRoleAndLane(state, team, role, lane) {
  const towers = (state.entities ?? []).filter(
    (entity) => entity.entity_type === "tower" && entity.team === team && entity.tower_role === role,
  );
  if (role === "king") {
    return towers[0] ?? null;
  }
  return [...towers].sort((left, right) => left.x - right.x)[lane === "left" ? 0 : 1] ?? null;
}

function towerFeature(entity) {
  if (!entity || entity.hp <= 0) {
    return 0;
  }
  return getTowerHpRatio(entity);
}

function buildGlobalFeatures(engine, actor) {
  const state = engine.state;
  const enemy = otherTeam(actor);
  const phase = getMatchPhase({ tick: state.tick, isOvertime: state.isOvertime });
  const features = new Float32Array(EDGER_V2_GLOBAL_FEATURES);
  const ownTowers = livingTowers(state, actor);
  const enemyTowers = livingTowers(state, enemy);
  const ownTroops = (state.entities ?? []).filter(
    (entity) => entity.entity_type === "troop" && entity.team === actor && entity.hp > 0,
  );
  const enemyTroops = (state.entities ?? []).filter(
    (entity) => entity.entity_type === "troop" && entity.team === enemy && entity.hp > 0,
  );

  features[0] = 1;
  features[1] = safeRatio(state.elixir?.[actor]?.elixir ?? 0, 10);
  features[2] = safeRatio(state.elixir?.[enemy]?.elixir ?? 0, 10);
  features[3] = safeRatio(
    state.tick,
    MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks,
  );
  features[4] = phase === "normal" ? 1 : 0;
  features[5] = phase === "double" ? 1 : 0;
  features[6] = phase === "overtime" ? 1 : 0;
  features[7] = safeRatio(ownTowers.length, 3);
  features[8] = safeRatio(enemyTowers.length, 3);
  features[9] = safeRatio(ownTroops.length, 16);
  features[10] = safeRatio(enemyTroops.length, 16);
  features[11] = state.isOvertime ? 1 : 0;

  markCards(features, 12, engine.getHand(actor));
  markCards(features, 20, engine.getHand(enemy));
  markQueue(features, 28, engine.getDeckQueue(actor));
  markQueue(features, 36, engine.getDeckQueue(enemy));

  const ownLeft = towerByRoleAndLane(state, actor, "crown", actor === "red" ? "left" : "right");
  const ownRight = towerByRoleAndLane(state, actor, "crown", actor === "red" ? "right" : "left");
  const enemyLeft = towerByRoleAndLane(state, enemy, "crown", actor === "red" ? "left" : "right");
  const enemyRight = towerByRoleAndLane(state, enemy, "crown", actor === "red" ? "right" : "left");
  const ownKing = towerByRoleAndLane(state, actor, "king", "left");
  const enemyKing = towerByRoleAndLane(state, enemy, "king", "left");

  features[44] = ownLeft?.hp <= 0 ? 1 : 0;
  features[45] = ownRight?.hp <= 0 ? 1 : 0;
  features[46] = enemyLeft?.hp <= 0 ? 1 : 0;
  features[47] = enemyRight?.hp <= 0 ? 1 : 0;
  [ownLeft, ownRight, ownKing, enemyLeft, enemyRight, enemyKing].forEach((tower, index) => {
    features[48 + index] = towerFeature(tower);
  });
  features[54] = ownKing?.is_active === false ? 0 : 1;
  features[55] = enemyKing?.is_active === false ? 0 : 1;
  features[56] = safeRatio(
    (state.pending_effects ?? []).filter((effect) => effect.actor === actor).length,
    8,
  );
  features[57] = safeRatio(
    (state.pending_effects ?? []).filter((effect) => effect.actor === enemy).length,
    8,
  );
  features[58] = safeRatio(ownTroops.reduce((sum, troop) => sum + Math.max(0, troop.hp), 0), 16000);
  features[59] = safeRatio(enemyTroops.reduce((sum, troop) => sum + Math.max(0, troop.hp), 0), 16000);

  // Rank-weighted deck identity retains exact queue order while leaving two
  // final slots for the current match score.
  engine.getDeckQueue(actor).slice(0, 8).forEach((cardId, position) => {
    const index = CARD_INDEX.get(cardId);
    if (index !== undefined) {
      features[60 + index] += 1 / (position + 1);
    }
  });
  engine.getDeckQueue(enemy).slice(0, 8).forEach((cardId, position) => {
    const index = CARD_INDEX.get(cardId);
    if (index !== undefined) {
      features[68 + index] += 1 / (position + 1);
    }
  });
  engine.getHand(actor).forEach((cardId, position) => {
    const index = CARD_INDEX.get(cardId);
    features[76 + position] = index === undefined ? 0 : (index + 1) / DEFAULT_DECK.length;
  });
  engine.getHand(enemy).forEach((cardId, position) => {
    const index = CARD_INDEX.get(cardId);
    features[80 + position] = index === undefined ? 0 : (index + 1) / DEFAULT_DECK.length;
  });

  features[84] = safeRatio(state.spawn_sequence ?? 0, 64);
  features[85] = safeRatio(state.effect_sequence ?? 0, 32);
  features[86] = safeRatio(state.overtime_start_tick ?? 0, MATCH_CONFIG.regulation_ticks);
  features[87] = safeRatio(state.recent_combat_events?.length ?? 0, 16);
  features[88] = safeRatio(ownTroops.filter((troop) => troop.cardId === "giant").length, 4);
  features[89] = safeRatio(enemyTroops.filter((troop) => troop.cardId === "giant").length, 4);
  features[90] = safeRatio(ownTroops.filter((troop) => troop.target_entity_id).length, 12);
  features[91] = safeRatio(enemyTroops.filter((troop) => troop.target_entity_id).length, 12);
  const score = engine.getScore();
  features[92] = safeRatio(actor === "blue" ? score.blue_crowns : score.red_crowns, 3);
  features[93] = safeRatio(actor === "blue" ? score.red_crowns : score.blue_crowns, 3);
  features[94] = safeRatio(
    actor === "blue" ? score.blue_tower_hp : score.red_tower_hp,
    15000,
  );
  features[95] = safeRatio(
    actor === "blue" ? score.red_tower_hp : score.blue_tower_hp,
    15000,
  );

  return features;
}

export function buildEdgerV2Observation({ engine, actor = "red" }) {
  const board = new Float32Array(
    EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH * EDGER_V2_BOARD_CHANNELS,
  );
  const entityById = new Map((engine.state.entities ?? []).map((entity) => [entity.id, entity]));
  for (const entity of engine.state.entities ?? []) {
    paintEntity({ board, entity, actor, entityById });
  }
  for (const effect of engine.state.pending_effects ?? []) {
    paintPendingEffect({ board, effect, actor, tick: engine.state.tick });
  }

  // Stacked occupants remain bounded without changing deterministic ordering.
  for (let i = 0; i < board.length; i += 1) {
    board[i] = clamp(board[i], -1, 1);
  }

  return {
    schema_version: EDGER_V2_OBSERVATION_SCHEMA_VERSION,
    board,
    global: buildGlobalFeatures(engine, actor),
  };
}

function placementIndex(actor, x, y) {
  const cell = canonicalCell(actor, x, y);
  return cell.row * EDGER_V2_BOARD_WIDTH + cell.column;
}

export function placementIndexToPosition(actor, index) {
  const row = Math.floor(index / EDGER_V2_BOARD_WIDTH);
  const column = index % EDGER_V2_BOARD_WIDTH;
  if (
    row < 0 ||
    row >= EDGER_V2_BOARD_HEIGHT ||
    column < 0 ||
    column >= EDGER_V2_BOARD_WIDTH
  ) {
    return null;
  }
  if (actor === "blue") {
    return {
      x: EDGER_V2_BOARD_WIDTH - column - 0.5,
      y: EDGER_V2_BOARD_HEIGHT - row - 0.5,
    };
  }
  return { x: column + 0.5, y: row + 0.5 };
}

export function buildEdgerV2LegalMasks({
  actor = "red",
  selectedCardIndex = null,
  legalActions = [],
}) {
  const cardMask = new Uint8Array(EDGER_V2_CARD_ACTIONS.length);
  cardMask[0] = 1;
  for (const action of legalActions) {
    const index = CARD_INDEX.get(action.cardId);
    if (index !== undefined) {
      cardMask[index + 1] = 1;
    }
  }

  const placementMask = new Uint8Array(EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH);
  if (selectedCardIndex === 0 || selectedCardIndex === null) {
    placementMask[0] = 1;
  } else {
    const cardId = EDGER_V2_CARD_ACTIONS[selectedCardIndex];
    for (const action of legalActions) {
      if (action.cardId === cardId) {
        placementMask[placementIndex(actor, action.x, action.y)] = 1;
      }
    }
  }

  const delayMask = new Uint8Array(EDGER_V2_DELAY_BINS);
  delayMask.fill(1);
  return {
    action_space_version: EDGER_V2_ACTION_SPACE_VERSION,
    card: cardMask,
    placement: placementMask,
    delay: delayMask,
  };
}

export function encodeEdgerV2Action({
  actor = "red",
  action,
  delayTicks = 1,
}) {
  if (!action || action.type === "PASS") {
    return {
      card_index: 0,
      placement_index: 0,
      delay_index: clamp(Math.round(delayTicks), 1, EDGER_V2_DELAY_BINS) - 1,
    };
  }
  const deckIndex = CARD_INDEX.get(action.cardId);
  if (deckIndex === undefined) {
    throw new Error(`unknown v2 card ${action.cardId}`);
  }
  return {
    card_index: deckIndex + 1,
    placement_index: placementIndex(actor, action.x, action.y),
    delay_index: clamp(Math.round(delayTicks), 1, EDGER_V2_DELAY_BINS) - 1,
  };
}

export function decodeEdgerV2Action({
  actor = "red",
  cardIndex,
  placementIndex: selectedPlacementIndex,
  delayIndex,
}) {
  const delayTicks = clamp(Math.round(delayIndex) + 1, 1, EDGER_V2_DELAY_BINS);
  if (cardIndex === 0) {
    return { action: { type: "PASS" }, delayTicks };
  }
  const cardId = EDGER_V2_CARD_ACTIONS[cardIndex];
  const position = placementIndexToPosition(actor, selectedPlacementIndex);
  if (!cardId || !position || !getCard(cardId)) {
    return { action: { type: "PASS" }, delayTicks };
  }
  return {
    action: {
      type: "PLAY_CARD",
      cardId,
      x: position.x,
      y: position.y,
    },
    delayTicks,
  };
}

export function isEdgerV2ActionLegal({ actor = "red", action, legalActions = [] }) {
  if (!action || action.type === "PASS") {
    return true;
  }
  return legalActions.some(
    (candidate) =>
      candidate.cardId === action.cardId &&
      Math.abs(candidate.x - action.x) <= EPSILON &&
      Math.abs(candidate.y - action.y) <= EPSILON,
  );
}
