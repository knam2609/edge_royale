import { ACTION_SPACE_VERSION, actionSortKey, appendPassAction, isPassAction, PASS_ACTION } from "./actionSpace.js";
import { DEFAULT_DECK, getCard } from "../sim/cards.js";
import { ARROWS_CONFIG, FIREBALL_CONFIG, MATCH_CONFIG, getMatchPhase } from "../sim/config.js";
import { snapPositionToGrid } from "../sim/map.js";
import { getTowerStats } from "../sim/stats.js";

export const EDGER_POLICY_MODEL_SCHEMA_VERSION = "edger_policy_model_v1";
export const EDGER_FEATURE_SCHEMA_VERSION = "edger_oracle_features_v1";
export const EDGER_STATE_FEATURE_DIM = 64;
export const EDGER_ACTION_FEATURE_DIM = 32;
export const EDGER_POLICY_ARCHITECTURE = Object.freeze({
  type: "masked_action_scorer_mlp",
  state_hidden: 64,
  action_hidden: 32,
  activation: "relu",
});

const CARD_INDEX = new Map(DEFAULT_DECK.map((cardId, index) => [cardId, index]));
const MODEL_CACHE = new WeakMap();
const EPSILON = 1e-9;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function safeRatio(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return clamp(value / max, 0, 1);
}

function getTeam(actor) {
  return actor === "red" ? { own: "red", enemy: "blue" } : { own: "blue", enemy: "red" };
}

function getMidY(arena) {
  return (arena.minY + arena.maxY) / 2;
}

function getArenaHeight(arena) {
  return Math.max(EPSILON, arena.maxY - arena.minY);
}

function getArenaWidth(arena) {
  return Math.max(EPSILON, arena.maxX - arena.minX);
}

function normalizeX(arena, x) {
  return safeRatio(x - arena.minX, getArenaWidth(arena));
}

function normalizeY(arena, y) {
  return safeRatio(y - arena.minY, getArenaHeight(arena));
}

function isOnOwnSide(actor, y, arena) {
  const midY = getMidY(arena);
  return actor === "blue" ? y >= midY : y <= midY;
}

function isThreateningOwnSide(actor, y, arena) {
  if (isOnOwnSide(actor, y, arena)) {
    return true;
  }

  const riverBufferTiles = 3.5;
  const midY = getMidY(arena);
  return actor === "blue" ? y >= midY - riverBufferTiles : y <= midY + riverBufferTiles;
}

function cardIndex(cardId) {
  return CARD_INDEX.has(cardId) ? CARD_INDEX.get(cardId) : -1;
}

function positionKey(x, y) {
  return `${Number(x).toFixed(2)}|${Number(y).toFixed(2)}`;
}

function roundPlacement(value) {
  return Math.round(value * 100) / 100;
}

function addSpellInterestKey(keys, arena, x, y) {
  const snapped = snapPositionToGrid(
    {
      x: clamp(x, arena.minX, arena.maxX),
      y: clamp(y, arena.minY, arena.maxY),
    },
    arena,
  );
  keys.add(positionKey(roundPlacement(snapped.x), roundPlacement(snapped.y)));
}

function markCardFeature(features, offset, cardId, scale = 1) {
  const index = cardIndex(cardId);
  if (index >= 0) {
    features[offset + index] += scale;
  }
}

function getEntitiesByTeam(state, actor) {
  const { own, enemy } = getTeam(actor);
  const ownTroops = [];
  const enemyTroops = [];
  const ownTowers = [];
  const enemyTowers = [];

  for (const entity of state.entities ?? []) {
    if (entity.hp <= 0) {
      continue;
    }
    if (entity.team === own && entity.entity_type === "troop") {
      ownTroops.push(entity);
    } else if (entity.team === enemy && entity.entity_type === "troop") {
      enemyTroops.push(entity);
    } else if (entity.team === own && entity.entity_type === "tower") {
      ownTowers.push(entity);
    } else if (entity.team === enemy && entity.entity_type === "tower") {
      enemyTowers.push(entity);
    }
  }

  return { ownTroops, enemyTroops, ownTowers, enemyTowers };
}

function getTowerMaxHp(tower) {
  return getTowerStats(tower?.tower_role === "king" ? "king" : "crown").hp;
}

function towerHpRatio(towers) {
  if (towers.length === 0) {
    return 0;
  }
  const hp = towers.reduce((sum, tower) => sum + Math.max(0, tower.hp), 0);
  const maxHp = towers.reduce((sum, tower) => sum + getTowerMaxHp(tower), 0);
  return safeRatio(hp, maxHp);
}

function getWeakestTower(towers) {
  if (towers.length === 0) {
    return null;
  }
  return [...towers].sort((a, b) => {
    if (a.hp !== b.hp) {
      return a.hp - b.hp;
    }
    return a.id.localeCompare(b.id);
  })[0];
}

function buildStateSummary({ engine, actor }) {
  const state = engine.state;
  const arena = state.arena;
  const { enemy } = getTeam(actor);
  const ownElixir = finiteOrZero(state.elixir?.[actor]?.elixir);
  const opponentElixir = finiteOrZero(state.elixir?.[enemy]?.elixir);
  const ownHand = typeof engine.getHand === "function" ? engine.getHand(actor) : [];
  const opponentHand = typeof engine.getHand === "function" ? engine.getHand(enemy) : [];
  const opponentDeckQueue = typeof engine.getDeckQueue === "function" ? engine.getDeckQueue(enemy) : [];
  const phase = getMatchPhase({ tick: state.tick, isOvertime: state.isOvertime });
  const { ownTroops, enemyTroops, ownTowers, enemyTowers } = getEntitiesByTeam(state, actor);
  const threateningTroops = enemyTroops.filter((entity) => isThreateningOwnSide(actor, entity.y, arena));
  const nearRiverTroops = enemyTroops.filter((entity) => Math.abs(entity.y - getMidY(arena)) <= 4);
  const pressureTroops = ownTroops.filter((entity) => !isOnOwnSide(actor, entity.y, arena));
  const threatLaneX = threateningTroops.length > 0
    ? threateningTroops.reduce((sum, entity) => sum + entity.x, 0) / threateningTroops.length
    : (arena.minX + arena.maxX) / 2;
  const threatTank = threateningTroops.some((entity) => entity.cardId === "giant" || entity.hp >= 1800);
  const weakestEnemyTower = getWeakestTower(enemyTowers);
  const spellInterestKeys = new Set();
  const spellTargets = [...enemyTroops, ...enemyTowers];
  for (const target of spellTargets) {
    addSpellInterestKey(spellInterestKeys, arena, target.x, target.y);
  }
  for (let i = 0; i < spellTargets.length; i += 1) {
    for (let j = i + 1; j < spellTargets.length; j += 1) {
      const left = spellTargets[i];
      const right = spellTargets[j];
      if (Math.hypot(left.x - right.x, left.y - right.y) > ARROWS_CONFIG.radius_tiles * 2.4) {
        continue;
      }
      addSpellInterestKey(spellInterestKeys, arena, (left.x + right.x) * 0.5, (left.y + right.y) * 0.5);
    }
  }

  return {
    state,
    arena,
    actor,
    enemy,
    phase,
    ownElixir,
    opponentElixir,
    ownHand,
    opponentHand,
    opponentDeckQueue,
    ownTroops,
    enemyTroops,
    ownTowers,
    enemyTowers,
    threateningTroops,
    nearRiverTroops,
    pressureTroops,
    threatLaneX,
    threatTank,
    weakestEnemyTower,
    spellInterestKeys,
  };
}

function buildStateFeatures(summary) {
  const features = new Array(EDGER_STATE_FEATURE_DIM).fill(0);
  const {
    state,
    arena,
    phase,
    ownElixir,
    opponentElixir,
    ownHand,
    opponentHand,
    opponentDeckQueue,
    ownTroops,
    enemyTroops,
    ownTowers,
    enemyTowers,
    threateningTroops,
    nearRiverTroops,
    pressureTroops,
    threatLaneX,
    weakestEnemyTower,
  } = summary;

  features[0] = 1;
  features[1] = safeRatio(ownElixir, 10);
  features[2] = safeRatio(opponentElixir, 10);
  features[3] = phase === "normal" ? 1 : 0;
  features[4] = phase === "double" ? 1 : 0;
  features[5] = phase === "overtime" ? 1 : 0;

  for (const cardId of ownHand) {
    markCardFeature(features, 6, cardId);
  }
  for (const cardId of opponentHand) {
    markCardFeature(features, 14, cardId);
  }
  opponentDeckQueue.slice(0, DEFAULT_DECK.length).forEach((cardId, index) => {
    markCardFeature(features, 22, cardId, 1 / (index + 1));
  });

  features[30] = towerHpRatio(ownTowers);
  features[31] = towerHpRatio(enemyTowers);
  features[32] = safeRatio(ownTowers.length, 3);
  features[33] = safeRatio(enemyTowers.length, 3);
  features[34] = safeRatio(ownTroops.length, 12);
  features[35] = safeRatio(enemyTroops.length, 12);
  features[36] = safeRatio(ownTroops.reduce((sum, entity) => sum + entity.hp, 0), 12000);
  features[37] = safeRatio(enemyTroops.reduce((sum, entity) => sum + entity.hp, 0), 12000);
  features[38] = safeRatio(threateningTroops.length, 8);
  features[39] = normalizeX(arena, threatLaneX);
  features[40] = weakestEnemyTower ? normalizeX(arena, weakestEnemyTower.x) : 0.5;
  features[41] = weakestEnemyTower ? safeRatio(weakestEnemyTower.hp, getTowerMaxHp(weakestEnemyTower)) : 0;
  features[42] = safeRatio(state.tick, MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks);
  features[43] = state.isOvertime ? 1 : 0;
  features[44] = clamp((ownElixir - 7) / 3, 0, 1);
  features[45] = clamp((4 - opponentElixir) / 4, 0, 1);
  features[46] = safeRatio(ownHand.filter((cardId) => (getCard(cardId)?.cost ?? 99) <= 3).length, 4);
  features[47] = opponentHand.includes("arrows") ? 1 : 0;
  features[48] = opponentHand.includes("fireball") ? 1 : 0;
  features[49] = opponentHand.includes("mini_pekka") ? 1 : 0;
  features[50] = opponentHand.includes("musketeer") ? 1 : 0;
  features[51] = safeRatio(nearRiverTroops.length, 8);
  features[52] = safeRatio(pressureTroops.length, 8);
  features[53] = safeRatio(state.pending_effects?.length ?? 0, 10);
  features[54] = safeRatio(enemyTowers.filter((tower) => tower.tower_role === "crown").length, 2);
  features[55] = safeRatio(ownTowers.filter((tower) => tower.tower_role === "crown").length, 2);

  return features;
}

function laneProximity(arena, x, laneRatio) {
  const laneX = arena.minX + getArenaWidth(arena) * laneRatio;
  return clamp(1 - Math.abs(x - laneX) / Math.max(1, getArenaWidth(arena) * 0.3), 0, 1);
}

function getSpellConfig(cardId) {
  if (cardId === "fireball") {
    return FIREBALL_CONFIG;
  }
  if (cardId === "arrows") {
    return ARROWS_CONFIG;
  }
  return null;
}

function estimateSpellValue({ summary, action, card }) {
  const config = getSpellConfig(card.id);
  if (!config) {
    return { value: 0, towerFinish: 0 };
  }
  if (!summary.spellInterestKeys.has(positionKey(action.x, action.y))) {
    return { value: -0.3, towerFinish: 0 };
  }

  let value = 0;
  let towerFinish = 0;
  for (const entity of [...summary.enemyTroops, ...summary.enemyTowers]) {
    const radius = config.radius_tiles + (entity.radius ?? 0);
    if (Math.hypot(entity.x - action.x, entity.y - action.y) > radius + EPSILON) {
      continue;
    }

    const damage = entity.entity_type === "tower" ? config.tower_damage : config.troop_damage;
    value += Math.min(entity.hp, damage);
    if (entity.hp <= damage) {
      value += entity.entity_type === "tower" ? 800 : 160;
      if (entity.entity_type === "tower") {
        towerFinish = 1;
      }
    }
  }

  value -= card.cost * 90;
  return {
    value: clamp(value / 1800, -1, 2),
    towerFinish,
  };
}

function buildActionFeatures({ summary, action, policyPrior = 0 }) {
  const features = new Array(EDGER_ACTION_FEATURE_DIM).fill(0);
  const { arena, actor, ownElixir, opponentElixir, threatLaneX, threatTank, threateningTroops, weakestEnemyTower } = summary;

  features[0] = 1;
  if (isPassAction(action)) {
    features[1] = 1;
    return features;
  }

  const card = getCard(action.cardId);
  if (!card) {
    features[1] = 1;
    return features;
  }

  const index = cardIndex(card.id);
  features[2] = safeRatio(card.cost, 5);
  if (index >= 0) {
    features[3 + index] = 1;
  }
  features[11] = card.type === "troop" ? 1 : 0;
  features[12] = card.type === "spell" ? 1 : 0;
  features[13] = normalizeX(arena, action.x);
  features[14] = normalizeY(arena, action.y);
  features[15] = isOnOwnSide(actor, action.y, arena) ? 1 : 0;
  features[16] = clamp(1 - Math.abs(action.y - getMidY(arena)) / (getArenaHeight(arena) * 0.5), 0, 1);
  features[17] = laneProximity(arena, action.x, 0.22);
  features[18] = laneProximity(arena, action.x, 0.5);
  features[19] = laneProximity(arena, action.x, 0.78);
  features[20] = clamp(1 - Math.abs(action.x - threatLaneX) / Math.max(1, getArenaWidth(arena) * 0.35), 0, 1);
  features[21] = card.id === "giant" ? 1 : 0;
  features[22] = card.id === "fireball" ? 1 : 0;
  features[23] = card.id === "arrows" ? 1 : 0;

  if (card.type === "spell") {
    const spell = estimateSpellValue({ summary, action, card });
    features[24] = clamp(spell.value, 0, 2);
    features[25] = spell.towerFinish;
  } else {
    const defenseLane = features[20];
    const counterBonus = threatTank && (card.id === "mini_pekka" || card.id === "musketeer") ? 0.55 : 0;
    const densityBonus = safeRatio(threateningTroops.length, 4);
    features[26] = features[15] * clamp(defenseLane * 0.65 + densityBonus * 0.45 + counterBonus, 0, 2);

    const towerLane = weakestEnemyTower
      ? clamp(1 - Math.abs(action.x - weakestEnemyTower.x) / Math.max(1, getArenaWidth(arena) * 0.35), 0, 1)
      : 0;
    const bridgePressure = features[16] * towerLane;
    const backlineGiant = card.id === "giant" ? clamp(1 - Math.abs(action.y - (actor === "blue" ? arena.maxY : arena.minY)) / 10, 0, 1) : 0;
    features[27] = clamp(bridgePressure + backlineGiant * 0.55, 0, 2);
  }

  features[28] = clamp((4 - opponentElixir) / 4, 0, 1) * clamp(card.cost / 5, 0, 1);
  features[29] = clamp((ownElixir - card.cost) / 10, 0, 1);

  const normalizedPrior = finiteOrZero(policyPrior) / 1000;
  features[30] = clamp(-normalizedPrior, 0, 3);
  features[31] = clamp(normalizedPrior, 0, 3);

  return features;
}

export function buildEdgerOracleFeatures({ engine, actor = "red", action = PASS_ACTION, policyPrior = 0 }) {
  const summary = buildStateSummary({ engine, actor });
  return {
    state: buildStateFeatures(summary),
    action: buildActionFeatures({ summary, action, policyPrior }),
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNumberArray(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${label} must be a numeric array of length ${length}`);
  }
  for (let i = 0; i < value.length; i += 1) {
    if (!Number.isFinite(value[i])) {
      throw new Error(`${label}[${i}] must be finite`);
    }
  }
}

function assertDenseLayer(layer, { inputDim, outputDim, label }) {
  assertObject(layer, label);
  if (layer.input_dim !== inputDim || layer.output_dim !== outputDim) {
    throw new Error(`${label} dimensions must be ${inputDim}x${outputDim}`);
  }
  assertNumberArray(layer.weights, inputDim * outputDim, `${label}.weights`);
  assertNumberArray(layer.bias, outputDim, `${label}.bias`);
}

export function validateEdgerPolicyModel(model) {
  assertObject(model, "model");
  if (model.schema_version !== EDGER_POLICY_MODEL_SCHEMA_VERSION) {
    throw new Error(`model schema_version must be ${EDGER_POLICY_MODEL_SCHEMA_VERSION}`);
  }
  if (model.action_space_version !== ACTION_SPACE_VERSION) {
    throw new Error(`model action_space_version must be ${ACTION_SPACE_VERSION}`);
  }
  if (model.feature_schema_version !== EDGER_FEATURE_SCHEMA_VERSION) {
    throw new Error(`model feature_schema_version must be ${EDGER_FEATURE_SCHEMA_VERSION}`);
  }

  assertObject(model.architecture, "model.architecture");
  for (const [key, value] of Object.entries(EDGER_POLICY_ARCHITECTURE)) {
    if (model.architecture[key] !== value) {
      throw new Error(`model.architecture.${key} must be ${value}`);
    }
  }

  assertObject(model.weights, "model.weights");
  assertDenseLayer(model.weights.state_encoder, {
    inputDim: EDGER_STATE_FEATURE_DIM,
    outputDim: EDGER_POLICY_ARCHITECTURE.state_hidden,
    label: "model.weights.state_encoder",
  });
  assertDenseLayer(model.weights.action_encoder, {
    inputDim: EDGER_ACTION_FEATURE_DIM,
    outputDim: EDGER_POLICY_ARCHITECTURE.action_hidden,
    label: "model.weights.action_encoder",
  });
  assertDenseLayer(model.weights.scorer, {
    inputDim: EDGER_POLICY_ARCHITECTURE.state_hidden + EDGER_POLICY_ARCHITECTURE.action_hidden,
    outputDim: 1,
    label: "model.weights.scorer",
  });

  return model;
}

function compileDenseLayer(layer) {
  return Array.from({ length: layer.output_dim }, (_, outputIndex) => {
    const terms = [];
    for (let inputIndex = 0; inputIndex < layer.input_dim; inputIndex += 1) {
      const weight = layer.weights[inputIndex * layer.output_dim + outputIndex];
      if (weight !== 0) {
        terms.push([inputIndex, weight]);
      }
    }
    return terms;
  });
}

function compileModel(model) {
  return {
    state_encoder: compileDenseLayer(model.weights.state_encoder),
    action_encoder: compileDenseLayer(model.weights.action_encoder),
    scorer: compileDenseLayer(model.weights.scorer),
  };
}

function ensureModel(model) {
  if (!model || typeof model !== "object") {
    validateEdgerPolicyModel(model);
  }
  if (!MODEL_CACHE.has(model)) {
    validateEdgerPolicyModel(model);
    MODEL_CACHE.set(model, {
      model,
      compiled: compileModel(model),
    });
  }
  return MODEL_CACHE.get(model);
}

function activate(value, activation) {
  if (activation === "relu") {
    return Math.max(0, value);
  }
  throw new Error(`unsupported activation ${activation}`);
}

function runDense(input, layer, activation = null, compiledLayer = null) {
  const output = new Array(layer.output_dim).fill(0);
  for (let outputIndex = 0; outputIndex < layer.output_dim; outputIndex += 1) {
    let value = layer.bias[outputIndex];
    const terms = compiledLayer?.[outputIndex] ?? null;
    if (terms) {
      for (const [inputIndex, weight] of terms) {
        value += input[inputIndex] * weight;
      }
    } else {
      for (let inputIndex = 0; inputIndex < layer.input_dim; inputIndex += 1) {
        value += input[inputIndex] * layer.weights[inputIndex * layer.output_dim + outputIndex];
      }
    }
    output[outputIndex] = activation ? activate(value, activation) : value;
  }
  return output;
}

function scoreHidden({ stateHidden, actionFeatures, model, compiled }) {
  const actionHidden = runDense(
    actionFeatures,
    model.weights.action_encoder,
    model.architecture.activation,
    compiled.action_encoder,
  );
  const combined = stateHidden.concat(actionHidden);
  return runDense(combined, model.weights.scorer, null, compiled.scorer)[0];
}

export function scoreEdgerAction({ model, engine, actor = "red", action = PASS_ACTION, policyPrior = 0 }) {
  const checked = ensureModel(model);
  const summary = buildStateSummary({ engine, actor });
  const stateFeatures = buildStateFeatures(summary);
  const stateHidden = runDense(
    stateFeatures,
    checked.model.weights.state_encoder,
    checked.model.architecture.activation,
    checked.compiled.state_encoder,
  );
  const actionFeatures = buildActionFeatures({ summary, action, policyPrior });
  return scoreHidden({ stateHidden, actionFeatures, model: checked.model, compiled: checked.compiled });
}

export function selectMlPolicyAction({
  model,
  legalActions,
  engine,
  actor = "red",
  scoreActionPrior = null,
}) {
  const checked = ensureModel(model);
  const candidates = appendPassAction(legalActions).sort((left, right) => actionSortKey(left).localeCompare(actionSortKey(right)));
  if (candidates.length === 0) {
    return PASS_ACTION;
  }

  const summary = buildStateSummary({ engine, actor });
  const stateFeatures = buildStateFeatures(summary);
  const stateHidden = runDense(
    stateFeatures,
    checked.model.weights.state_encoder,
    checked.model.architecture.activation,
    checked.compiled.state_encoder,
  );
  let bestAction = PASS_ACTION;
  let bestLogit = -Infinity;

  for (const action of candidates) {
    const prior = typeof scoreActionPrior === "function" ? scoreActionPrior(action) : 0;
    const actionFeatures = buildActionFeatures({ summary, action, policyPrior: prior });
    const logit = scoreHidden({ stateHidden, actionFeatures, model: checked.model, compiled: checked.compiled });
    if (
      logit > bestLogit ||
      (logit === bestLogit && actionSortKey(action).localeCompare(actionSortKey(bestAction)) < 0)
    ) {
      bestLogit = logit;
      bestAction = action;
    }
  }

  return bestAction ?? PASS_ACTION;
}
