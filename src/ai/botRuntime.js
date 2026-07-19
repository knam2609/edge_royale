import { ARROWS_CONFIG, FIREBALL_CONFIG, getMatchPhase } from "../sim/config.js";
import { getCard } from "../sim/cards.js";
import { snapPositionToGrid } from "../sim/map.js";
import { buildTroopPlacementCandidates, getTroopPlacementStatus } from "../sim/placement.js";
import { ACTION_SPACE_VERSION, PASS_ACTION, actionSortKey, appendPassAction, isPassAction } from "./actionSpace.js";
import { EDGER_POLICY_MODEL } from "./generated/edgerPolicyCurrent.js";
import { selectMlPolicyAction } from "./mlPolicy.js";
import { getSpellDamageAgainstTarget } from "./spellHeuristics.js";
import {
  EDGER_V2_POLICY_MODEL_SCHEMA_VERSION,
  selectEdgerV2PolicyDecision,
} from "./v2/policy.js";

export { ACTION_SPACE_VERSION, PASS_ACTION, actionSortKey, appendPassAction, isPassAction };

export const EDGER_BOT_ID = "edger";
export const HEURISTIC_BOT_ID = "edger_heuristic";
export const INTERNAL_BASELINE_BOTS = Object.freeze(["random", "aggressive", "defender"]);
export const BENCHMARK_BOTS = Object.freeze([EDGER_BOT_ID, HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS]);

const BOT_CONFIG = Object.freeze({
  edger: Object.freeze({
    id: "edger",
    label: "Edger",
    description: "Deterministic offline-trained hidden-info policy opponent.",
    min_delay_ticks: 1,
    max_delay_ticks: 1,
  }),
  edger_heuristic: Object.freeze({
    id: "edger_heuristic",
    label: "Edger Heuristic",
    description: "Frozen handcrafted oracle baseline for internal benchmarks.",
    min_delay_ticks: 1,
    max_delay_ticks: 1,
  }),
  random: Object.freeze({
    id: "random",
    label: "Random Baseline",
    description: "Internal benchmark baseline with noisy legal actions.",
    min_delay_ticks: 16,
    max_delay_ticks: 36,
    pass_chance: 0.72,
  }),
  aggressive: Object.freeze({
    id: "aggressive",
    label: "Aggressive Baseline",
    description: "Internal benchmark baseline that over-commits into pressure.",
    min_delay_ticks: 12,
    max_delay_ticks: 24,
    pass_chance: 0.48,
  }),
  defender: Object.freeze({
    id: "defender",
    label: "Defender Baseline",
    description: "Internal benchmark baseline that favors defense and delayed commits.",
    min_delay_ticks: 24,
    max_delay_ticks: 46,
    pass_chance: 0.58,
  }),
});

const LEGACY_BOT_ALIASES = Object.freeze({
  heuristic: HEURISTIC_BOT_ID,
  noob: "random",
  mid: "aggressive",
  top: "defender",
  pro: "defender",
  goat: "defender",
  god: "edger",
  god_oracle: "edger",
  self: "edger",
});

const TROOP_BASE_SCORE = Object.freeze({
  giant: 168,
  knight: 142,
  archers: 148,
  mini_pekka: 158,
  musketeer: 164,
  goblins: 132,
});

const BOT_STRATEGY = Object.freeze({
  random: Object.freeze({
    tower_chip_bonus: 18,
    arrows_tower_only_penalty: 130,
    overstack_penalty: 12,
    giant_backline_bonus: 0,
    bridge_bonus_scale: 1.15,
    defense_bonus_scale: 0.35,
    pressure_bonus_scale: 0.75,
  }),
  aggressive: Object.freeze({
    tower_chip_bonus: 42,
    arrows_tower_only_penalty: 180,
    overstack_penalty: 18,
    giant_backline_bonus: 14,
    bridge_bonus_scale: 1.35,
    defense_bonus_scale: 0.55,
    pressure_bonus_scale: 1.2,
  }),
  defender: Object.freeze({
    tower_chip_bonus: 48,
    arrows_tower_only_penalty: 240,
    overstack_penalty: 30,
    giant_backline_bonus: 28,
    bridge_bonus_scale: 0.85,
    defense_bonus_scale: 1.25,
    pressure_bonus_scale: 0.82,
  }),
  edger_heuristic: Object.freeze({
    tower_chip_bonus: 88,
    arrows_tower_only_penalty: 360,
    overstack_penalty: 30,
    giant_backline_bonus: 68,
    bridge_bonus_scale: 1.55,
    defense_bonus_scale: 1.7,
    pressure_bonus_scale: 1.55,
  }),
  edger: Object.freeze({
    tower_chip_bonus: 88,
    arrows_tower_only_penalty: 360,
    overstack_penalty: 30,
    giant_backline_bonus: 68,
    bridge_bonus_scale: 1.55,
    defense_bonus_scale: 1.7,
    pressure_bonus_scale: 1.55,
  }),
});

const SPELL_THRESHOLD = Object.freeze({
  aggressive: Object.freeze({ normal: 230, double: 185, overtime: 150 }),
  defender: Object.freeze({ normal: 190, double: 150, overtime: 120 }),
  edger_heuristic: Object.freeze({ normal: 1100, double: 950, overtime: 750 }),
  edger: Object.freeze({ normal: 1100, double: 950, overtime: 750 }),
});

const EPSILON = 1e-9;
const SPELL_TARGET_CACHE = new WeakMap();

function getTeam(actor) {
  return actor === "red" ? { own: "red", enemy: "blue" } : { own: "blue", enemy: "red" };
}

function roundPlacement(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getMidY(arena) {
  return (arena.minY + arena.maxY) / 2;
}

function getMidX(arena) {
  return (arena.minX + arena.maxX) / 2;
}

function isOnOwnSide(actor, y, arena) {
  const midY = getMidY(arena);
  return actor === "blue" ? y >= midY : y <= midY;
}

function isThreateningOwnSide(actor, y, arena) {
  if (isOnOwnSide(actor, y, arena)) {
    return true;
  }

  const midY = getMidY(arena);
  const riverBufferTiles = 3.5;
  return actor === "blue" ? y >= midY - riverBufferTiles : y <= midY + riverBufferTiles;
}

function buildTroopPlacements(state, actor) {
  return buildTroopPlacementCandidates({
    arena: state.arena,
    entities: state.entities,
    actor,
  }).map((position) => {
    const snapped = snapPositionToGrid(position, state.arena);
    return { x: roundPlacement(snapped.x), y: roundPlacement(snapped.y) };
  });
}

function buildFullArenaSpellTargets(state) {
  const { arena } = state;
  const cached = SPELL_TARGET_CACHE.get(arena);
  if (cached) {
    return cached;
  }

  const step = Math.max(0.1, Number(arena.grid?.step) || 1);
  const deduped = new Set();
  const result = [];

  for (let x = arena.minX; x <= arena.maxX + EPSILON; x += step) {
    for (let y = arena.minY; y <= arena.maxY + EPSILON; y += step) {
      const snapped = snapPositionToGrid(
        {
          x: clamp(x, arena.minX, arena.maxX),
          y: clamp(y, arena.minY, arena.maxY),
        },
        arena,
      );
      const sx = roundPlacement(snapped.x);
      const sy = roundPlacement(snapped.y);
      const key = `${sx.toFixed(2)}|${sy.toFixed(2)}`;
      if (deduped.has(key)) {
        continue;
      }
      deduped.add(key);
      result.push({ x: sx, y: sy });
    }
  }

  const targets = result.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  SPELL_TARGET_CACHE.set(arena, targets);
  return targets;
}

function isLegalTroopPlacement(actor, state, placement) {
  return getTroopPlacementStatus({
    arena: state.arena,
    entities: state.entities,
    actor,
    position: placement,
  }).ok;
}

function positionKey(x, y) {
  return `${Number(x).toFixed(2)}|${Number(y).toFixed(2)}`;
}

function cardCost(action) {
  if (isPassAction(action)) {
    return 0;
  }
  return getCard(action.cardId)?.cost ?? 0;
}

export function enumerateLegalCardActions({ engine, actor = "red" }) {
  const hand = engine.getHand(actor);
  const elixir = engine.state.elixir[actor]?.elixir ?? 0;
  const actions = [];

  for (const cardId of hand) {
    const card = getCard(cardId);
    if (!card || card.cost > elixir) {
      continue;
    }

    if (card.type === "troop") {
      for (const placement of buildTroopPlacements(engine.state, actor)) {
        if (!isLegalTroopPlacement(actor, engine.state, placement)) {
          continue;
        }
        actions.push({ type: "PLAY_CARD", cardId, x: placement.x, y: placement.y });
      }
      continue;
    }

    for (const target of buildFullArenaSpellTargets(engine.state)) {
      actions.push({ type: "PLAY_CARD", cardId, x: target.x, y: target.y });
    }
  }

  return actions.sort((left, right) => actionSortKey(left).localeCompare(actionSortKey(right)));
}

function getEnemiesInRadius(state, actor, x, y, radius) {
  const { enemy } = getTeam(actor);
  return state.entities.filter((entity) => {
    if (entity.team !== enemy || entity.hp <= 0) {
      return false;
    }

    const effectiveRadius = radius + (entity.radius ?? 0);
    return Math.hypot(entity.x - x, entity.y - y) <= effectiveRadius + EPSILON;
  });
}

function getLivingEnemies(state, actor) {
  const { enemy } = getTeam(actor);
  return state.entities.filter((entity) => entity.team === enemy && entity.hp > 0);
}

function addSnappedSpellCandidate(keys, state, x, y) {
  const snapped = snapPositionToGrid(
    {
      x: clamp(x, state.arena.minX, state.arena.maxX),
      y: clamp(y, state.arena.minY, state.arena.maxY),
    },
    state.arena,
  );
  keys.add(positionKey(roundPlacement(snapped.x), roundPlacement(snapped.y)));
}

function buildSpellScoringKeys(state, actor) {
  const enemies = getLivingEnemies(state, actor);
  const keys = new Set();

  for (const enemy of enemies) {
    addSnappedSpellCandidate(keys, state, enemy.x, enemy.y);
  }

  for (let i = 0; i < enemies.length; i += 1) {
    for (let j = i + 1; j < enemies.length; j += 1) {
      const left = enemies[i];
      const right = enemies[j];
      if (Math.hypot(left.x - right.x, left.y - right.y) > ARROWS_CONFIG.radius_tiles * 2.4) {
        continue;
      }
      addSnappedSpellCandidate(keys, state, (left.x + right.x) * 0.5, (left.y + right.y) * 0.5);
    }
  }

  return keys;
}

function buildScoringActionSubset({ legalActions, engine, actor, botId }) {
  if (normalizeBotId(botId) !== HEURISTIC_BOT_ID) {
    return legalActions;
  }

  const spellKeys = buildSpellScoringKeys(engine.state, actor);
  return legalActions.filter((action) => {
    const card = getCard(action.cardId);
    if (card?.type !== "spell") {
      return true;
    }
    return spellKeys.has(positionKey(action.x, action.y));
  });
}

function getStrategy(botId) {
  return BOT_STRATEGY[botId] ?? BOT_STRATEGY[HEURISTIC_BOT_ID];
}

export function evaluateSpellAction(action, state, actor, phase, botId = HEURISTIC_BOT_ID) {
  const strategy = getStrategy(normalizeBotId(botId));
  const cardId = action.cardId;
  const config = cardId === "fireball" ? FIREBALL_CONFIG : ARROWS_CONFIG;
  const impacted = getEnemiesInRadius(state, actor, action.x, action.y, config.radius_tiles);

  if (impacted.length === 0) {
    return {
      score: -320,
      hits: 0,
      troopHits: 0,
      towerHits: 0,
    };
  }

  let score = 0;
  let troopHits = 0;
  let towerHits = 0;

  for (const entity of impacted) {
    const damage = getSpellDamageAgainstTarget(entity, {
      troopDamage: config.troop_damage,
      towerDamage: config.tower_damage,
    });
    const dealt = Math.min(entity.hp, damage);

    if (entity.entity_type === "tower") {
      towerHits += 1;
      score += dealt;
      if (entity.hp <= damage) {
        score += 1300;
      }
    } else {
      troopHits += 1;
      score += dealt;
      if (entity.hp <= damage) {
        score += 170;
      }
    }
  }

  if (cardId === "fireball") {
    score += troopHits * 78;
    if (towerHits > 0 && troopHits > 0) {
      score += 80;
    }
  } else if (towerHits > 0 && troopHits === 0) {
    score -= strategy.arrows_tower_only_penalty;
  }

  if (towerHits > 0) {
    const phaseMultiplier = phase === "overtime" ? 1.75 : phase === "double" ? 1.35 : 1;
    score += Math.round(towerHits * strategy.tower_chip_bonus * phaseMultiplier);
  }

  score -= (getCard(cardId)?.cost ?? 0) * 34;
  return {
    score,
    hits: impacted.length,
    troopHits,
    towerHits,
  };
}

function laneBonus(action, laneX) {
  return Math.max(0, 64 - Math.abs(action.x - laneX) * 30);
}

function evaluateThreat(state, actor) {
  const { enemy } = getTeam(actor);
  const enemyTroops = state.entities.filter(
    (entity) => entity.team === enemy && entity.hp > 0 && entity.entity_type === "troop",
  );
  const threateningTroops = enemyTroops.filter((entity) => isThreateningOwnSide(actor, entity.y, state.arena));
  const density = threateningTroops.length;

  let hottestLaneX = getMidX(state.arena);
  if (threateningTroops.length > 0) {
    hottestLaneX = threateningTroops.reduce((sum, entity) => sum + entity.x, 0) / threateningTroops.length;
  }

  const tank = threateningTroops.find((entity) => entity.cardId === "giant" || entity.hp >= 1800) ?? null;
  return {
    density,
    lane_x: hottestLaneX,
    tank,
  };
}

function getWeakestEnemyTower(state, actor) {
  const { enemy } = getTeam(actor);
  const enemyTowers = state.entities.filter(
    (entity) => entity.team === enemy && entity.entity_type === "tower" && entity.hp > 0,
  );
  if (enemyTowers.length === 0) {
    return null;
  }

  enemyTowers.sort((a, b) => {
    if (a.hp !== b.hp) {
      return a.hp - b.hp;
    }
    return a.id.localeCompare(b.id);
  });
  return enemyTowers[0];
}

function getOpponentInfo(engine, actor) {
  const { enemy } = getTeam(actor);
  return {
    elixir: engine?.state?.elixir?.[enemy]?.elixir ?? 0,
    hand: typeof engine?.getHand === "function" ? engine.getHand(enemy) : [],
    deckQueue: typeof engine?.getDeckQueue === "function" ? engine.getDeckQueue(enemy) : [],
  };
}

function opponentHasAnswer(opponent, cardId) {
  if (cardId === "giant") {
    return opponent.hand.includes("mini_pekka") || opponent.hand.includes("musketeer");
  }
  if (cardId === "goblins" || cardId === "archers") {
    return opponent.hand.includes("arrows") || opponent.hand.includes("fireball");
  }
  if (cardId === "musketeer") {
    return opponent.hand.includes("fireball");
  }
  return false;
}

function evaluateTroopAction(action, state, actor, botId, engine) {
  const normalizedBot = normalizeBotId(botId);
  const isOracleHeuristic = normalizedBot === HEURISTIC_BOT_ID || normalizedBot === EDGER_BOT_ID;
  const strategy = getStrategy(normalizedBot);
  const card = getCard(action.cardId);
  const threat = evaluateThreat(state, actor);
  const midY = getMidY(state.arena);
  const currentElixir = state.elixir[actor]?.elixir ?? 0;
  const opponent = getOpponentInfo(engine, actor);

  const bridgeDistance = Math.abs(action.y - midY);
  const bridgeBonus = Math.max(0, 116 - bridgeDistance * 40) * strategy.bridge_bonus_scale;
  const base = TROOP_BASE_SCORE[action.cardId] ?? 120;

  const ownTroops = state.entities.filter(
    (entity) => entity.team === actor && entity.entity_type === "troop" && entity.hp > 0,
  );

  const stackCount = ownTroops.filter((entity) => Math.abs(entity.x - action.x) <= 1.7).length;
  const stackSupportBonus = Math.min(stackCount, 2) * 20;
  const overstackPenalty = Math.max(0, stackCount - 2) * strategy.overstack_penalty;
  const stackBonus = stackSupportBonus - overstackPenalty;

  let defenseBonus = 0;
  if (threat.density > 0 && isOnOwnSide(actor, action.y, state.arena)) {
    defenseBonus = (92 + Math.min(4, threat.density) * 30 + laneBonus(action, threat.lane_x)) * strategy.defense_bonus_scale;
    if (threat.tank && (action.cardId === "mini_pekka" || action.cardId === "musketeer")) {
      defenseBonus += isOracleHeuristic ? 125 : 70;
    }
  }

  const weakestTower = getWeakestEnemyTower(state, actor);
  const pressureBonus = weakestTower
    ? laneBonus(action, weakestTower.x) * (threat.density > 0 ? 0.45 : strategy.pressure_bonus_scale)
    : 0;

  let giantTempoBonus = 0;
  if (action.cardId === "giant") {
    const ownTowerY = actor === "blue" ? state.arena.maxY : state.arena.minY;
    const depth = Math.abs(action.y - ownTowerY);
    const backlineSetup = Math.max(0, 78 - depth * 8);
    giantTempoBonus = threat.density === 0 ? backlineSetup + strategy.giant_backline_bonus : -28;
  }

  let score = base + bridgeBonus + stackBonus + defenseBonus + pressureBonus + giantTempoBonus;
  if (card) {
    const nearCap = Math.max(0, currentElixir - 7);
    score += nearCap * card.cost * 13;
    score -= card.cost * 10;
  }

  if (isOracleHeuristic && card) {
    const elixirLead = currentElixir - opponent.elixir;
    if (opponent.elixir <= 3 && threat.density <= 1) {
      score += 95 + card.cost * 12;
    }
    if (elixirLead >= 3 && threat.density === 0) {
      score += 70;
    }
    if (opponentHasAnswer(opponent, action.cardId) && opponent.elixir >= Math.max(3, card.cost - 1)) {
      score -= 45;
    }
    if (opponent.deckQueue.slice(0, 2).includes("arrows") && ["goblins", "archers"].includes(action.cardId)) {
      score -= 30;
    }
    if (action.cardId === "giant" && opponent.elixir <= 4) {
      score += 75;
    }
  }

  return score;
}

function evaluateActionScore({ action, engine, actor, botId, phase }) {
  const card = getCard(action.cardId);
  if (!card) {
    return -Infinity;
  }

  if (card.type === "spell") {
    return evaluateSpellAction(action, engine.state, actor, phase, botId).score;
  }

  return evaluateTroopAction(action, engine.state, actor, botId, engine);
}

function chooseHighestScoreAction({ actions, engine, actor, botId, phase }) {
  let bestAction = null;
  let bestScore = -Infinity;

  for (const action of actions) {
    const score = evaluateActionScore({ action, engine, actor, botId, phase });
    if (
      score > bestScore ||
      (score === bestScore && (!bestAction || actionSortKey(action) < actionSortKey(bestAction)))
    ) {
      bestScore = score;
      bestAction = action;
    }
  }

  return {
    action: bestAction,
    score: bestScore,
  };
}

function chooseTroopFallback({ actions, engine, actor, minScore = -Infinity, botId = EDGER_BOT_ID, phase }) {
  const troopActions = actions.filter((action) => getCard(action.cardId)?.type === "troop");
  if (troopActions.length === 0) {
    return null;
  }

  const bestTroop = chooseHighestScoreAction({
    actions: troopActions,
    engine,
    actor,
    botId,
    phase,
  });
  if (!bestTroop.action || bestTroop.score < minScore) {
    return null;
  }

  return bestTroop.action;
}

function chooseRandomAction(actions, rng) {
  if (actions.length === 0) {
    return null;
  }
  const idx = Math.floor(rng() * actions.length);
  return actions[idx] ?? null;
}

function chooseRandomBaseline({ legalActions, rng }) {
  if (legalActions.length === 0 || rng() < BOT_CONFIG.random.pass_chance) {
    return PASS_ACTION;
  }
  return chooseRandomAction(legalActions, rng) ?? PASS_ACTION;
}

function chooseAggressiveBaseline({ legalActions, engine, actor, phase, rng }) {
  if (legalActions.length === 0 || rng() < BOT_CONFIG.aggressive.pass_chance) {
    return PASS_ACTION;
  }

  const troopActions = legalActions.filter((action) => getCard(action.cardId)?.type === "troop");
  if (troopActions.length > 0) {
    const midY = getMidY(engine.state.arena);
    return [...troopActions].sort((a, b) => {
      const bridgeDiff = Math.abs(a.y - midY) - Math.abs(b.y - midY);
      if (Math.abs(bridgeDiff) > EPSILON) {
        return bridgeDiff;
      }
      if (cardCost(a) !== cardCost(b)) {
        return cardCost(b) - cardCost(a);
      }
      return actionSortKey(a).localeCompare(actionSortKey(b));
    })[0] ?? PASS_ACTION;
  }

  const spellActions = legalActions.filter((action) => getCard(action.cardId)?.type === "spell");
  return rng() < 0.15 ? chooseRandomAction(spellActions, rng) ?? PASS_ACTION : PASS_ACTION;
}

function chooseDefenderBaseline({ legalActions, engine, actor, phase, rng }) {
  if (legalActions.length === 0 || rng() < BOT_CONFIG.defender.pass_chance) {
    return PASS_ACTION;
  }

  const threat = evaluateThreat(engine.state, actor);
  const currentElixir = engine.state.elixir[actor]?.elixir ?? 0;
  const filtered = legalActions.filter((action) => currentElixir - cardCost(action) >= 1);
  const candidates = filtered.length > 0 ? filtered : legalActions;

  if (threat.density >= 1 && currentElixir >= 7) {
    const defenders = candidates.filter((action) => {
      const card = getCard(action.cardId);
      return card?.type === "troop" && isOnOwnSide(actor, action.y, engine.state.arena);
    });
    if (defenders.length > 0) {
      const bestDefense = chooseHighestScoreAction({
        actions: defenders,
        engine,
        actor,
        botId: "defender",
        phase,
      });
      if (bestDefense.action) {
        return bestDefense.action;
      }
    }
  }

  if (threat.density > 0) {
    return PASS_ACTION;
  }

  if (currentElixir < 10) {
    return PASS_ACTION;
  }

  if (threat.density === 0) {
    const troopActions = candidates.filter((action) => getCard(action.cardId)?.type === "troop");
    if (troopActions.length === 0) {
      return PASS_ACTION;
    }
    const ownTowerY = actor === "blue" ? engine.state.arena.maxY : engine.state.arena.minY;
    return [...troopActions].sort((a, b) => {
      const depthDiff = Math.abs(a.y - ownTowerY) - Math.abs(b.y - ownTowerY);
      if (Math.abs(depthDiff) > EPSILON) {
        return depthDiff;
      }
      if (cardCost(a) !== cardCost(b)) {
        return cardCost(a) - cardCost(b);
      }
      return actionSortKey(a).localeCompare(actionSortKey(b));
    })[0] ?? PASS_ACTION;
  }

  return PASS_ACTION;
}

export function selectHeuristicAction({ legalActions, engine, actor = "red" }) {
  if (legalActions.length === 0) {
    return PASS_ACTION;
  }

  const phase = getMatchPhase({ tick: engine.state.tick, isOvertime: engine.state.isOvertime });
  const scoringActions = buildScoringActionSubset({ legalActions, engine, actor, botId: HEURISTIC_BOT_ID });
  const best = chooseHighestScoreAction({ actions: scoringActions, engine, actor, botId: HEURISTIC_BOT_ID, phase });
  if (!best.action) {
    return PASS_ACTION;
  }

  const threat = evaluateThreat(engine.state, actor);
  if (threat.density > 0) {
    const bestDefense = chooseTroopFallback({
      actions: legalActions.filter((action) => !isPassAction(action) && isOnOwnSide(actor, action.y, engine.state.arena)),
      engine,
      actor,
      minScore: threat.tank ? 170 : 135,
      botId: HEURISTIC_BOT_ID,
      phase,
    });
    if (bestDefense && (threat.tank || getCard(best.action.cardId)?.type !== "spell")) {
      return bestDefense;
    }
  }

  const card = getCard(best.action.cardId);
  if (card?.type === "spell") {
    const threshold = SPELL_THRESHOLD[HEURISTIC_BOT_ID][phase] ?? SPELL_THRESHOLD[HEURISTIC_BOT_ID].normal;
    if (best.score >= threshold) {
      return best.action;
    }
    return chooseTroopFallback({ actions: legalActions, engine, actor, minScore: 70, botId: HEURISTIC_BOT_ID, phase }) ??
      PASS_ACTION;
  }

  const threshold = threat.density > 0 ? 50 : 70;
  return best.score >= threshold ? best.action : PASS_ACTION;
}

export function getEdgerPolicyPrior({ action, engine, actor = "red" }) {
  const phase = getMatchPhase({ tick: engine.state.tick, isOvertime: engine.state.isOvertime });
  const threat = evaluateThreat(engine.state, actor);
  const spellKeys = buildSpellScoringKeys(engine.state, actor);

  if (isPassAction(action)) {
    return 0;
  }
  const card = getCard(action.cardId);
  if (card?.type === "spell" && !spellKeys.has(positionKey(action.x, action.y))) {
    return -1000;
  }
  const score = evaluateActionScore({
    action,
    engine,
    actor,
    botId: HEURISTIC_BOT_ID,
    phase,
  });
  if (!Number.isFinite(score)) {
    return -1000;
  }
  const threshold = card?.type === "spell"
    ? SPELL_THRESHOLD[HEURISTIC_BOT_ID][phase] ?? SPELL_THRESHOLD[HEURISTIC_BOT_ID].normal
    : threat.density > 0
      ? 50
      : 70;
  return score - threshold;
}

export function selectEdgerAction({ legalActions, engine, actor = "red", model = EDGER_POLICY_MODEL }) {
  if (model?.schema_version === EDGER_V2_POLICY_MODEL_SCHEMA_VERSION) {
    return selectEdgerV2PolicyDecision({
      model,
      engine,
      actor,
      legalActions,
    }).action;
  }
  const scoreActionPrior = (action) => getEdgerPolicyPrior({ action, engine, actor });

  return selectMlPolicyAction({
    model,
    legalActions,
    engine,
    actor,
    scoreActionPrior,
  });
}

export function normalizeBotId(botId) {
  if (typeof botId === "string") {
    if (BOT_CONFIG[botId]) {
      return botId;
    }
    if (LEGACY_BOT_ALIASES[botId]) {
      return LEGACY_BOT_ALIASES[botId];
    }
  }
  return EDGER_BOT_ID;
}

export function getBotConfig(botId) {
  return BOT_CONFIG[normalizeBotId(botId)];
}

export function getBotTierConfig(botId) {
  return getBotConfig(botId);
}

export function normalizeBotTierId(botId) {
  return normalizeBotId(botId);
}

export function rollDecisionDelayTicks({ botId, tierId, rng }) {
  const bot = getBotConfig(botId ?? tierId);
  const random = typeof rng === "function" ? rng : Math.random;
  const span = Math.max(0, bot.max_delay_ticks - bot.min_delay_ticks);
  return bot.min_delay_ticks + Math.floor(random() * (span + 1));
}

export function selectBotAction({
  botId,
  tierId,
  engine,
  actor = "red",
  legalActions,
  rng = Math.random,
  edgerModel = EDGER_POLICY_MODEL,
}) {
  const normalizedBot = normalizeBotId(botId ?? tierId);
  const phase = getMatchPhase({ tick: engine.state.tick, isOvertime: engine.state.isOvertime });

  if (normalizedBot === HEURISTIC_BOT_ID) {
    return selectHeuristicAction({ legalActions, engine, actor });
  }
  if (normalizedBot === "random") {
    return chooseRandomBaseline({ legalActions, rng });
  }
  if (normalizedBot === "aggressive") {
    return chooseAggressiveBaseline({ legalActions, engine, actor, phase, rng });
  }
  if (normalizedBot === "defender") {
    return chooseDefenderBaseline({ legalActions, engine, actor, phase, rng });
  }

  return selectEdgerAction({ legalActions, engine, actor, model: edgerModel });
}

export function selectBotDecision({
  botId,
  tierId,
  engine,
  actor = "red",
  legalActions,
  rng = Math.random,
  edgerModel = EDGER_POLICY_MODEL,
}) {
  const normalizedBot = normalizeBotId(botId ?? tierId);
  if (
    normalizedBot === EDGER_BOT_ID &&
    edgerModel?.schema_version === EDGER_V2_POLICY_MODEL_SCHEMA_VERSION
  ) {
    return selectEdgerV2PolicyDecision({
      model: edgerModel,
      engine,
      actor,
      legalActions,
    });
  }

  const delayTicks = rollDecisionDelayTicks({
    botId: normalizedBot,
    rng,
  });
  return {
    action: selectBotAction({
      botId: normalizedBot,
      engine,
      actor,
      legalActions,
      rng,
      edgerModel,
    }),
    delayTicks,
  };
}
