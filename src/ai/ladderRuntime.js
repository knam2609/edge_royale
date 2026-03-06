import { ARROWS_CONFIG, FIREBALL_CONFIG, getMatchPhase } from "../sim/config.js";
import { getCard } from "../sim/cards.js";
import { selectCardFromModel } from "./training.js";

const BOT_TIER_CONFIG = Object.freeze({
  noob: Object.freeze({
    id: "noob",
    label: "Noob",
    description: "Random legal actions with frequent hesitation.",
    min_delay_ticks: 10,
    max_delay_ticks: 30,
    pass_chance: 0.25,
  }),
  mid: Object.freeze({
    id: "mid",
    label: "Mid-ladder Menace",
    description: "Aggressive and greedy, with weak spell discipline.",
    min_delay_ticks: 7,
    max_delay_ticks: 18,
    pass_chance: 0.08,
  }),
  top: Object.freeze({
    id: "top",
    label: "Top Ladder",
    description: "Elixir-aware defense into counter-push.",
    min_delay_ticks: 5,
    max_delay_ticks: 13,
    pass_chance: 0.03,
  }),
  self: Object.freeze({
    id: "self",
    label: "Self Play",
    description: "Learns player card tendencies and mixes with Top heuristics.",
    min_delay_ticks: 4,
    max_delay_ticks: 12,
    pass_chance: 0.02,
  }),
});

export const BOT_TIERS = Object.freeze(Object.values(BOT_TIER_CONFIG));

const TROOP_BASE_SCORE = Object.freeze({
  giant: 165,
  knight: 140,
  archers: 150,
  mini_pekka: 155,
  musketeer: 160,
  goblins: 130,
});

const MID_SPELL_THRESHOLD = Object.freeze({
  normal: 460,
  double: 410,
  overtime: 360,
});

const TOP_SPELL_THRESHOLD = Object.freeze({
  normal: 430,
  double: 360,
  overtime: 300,
});

const TOP_RESERVE_AFTER_PLAY = Object.freeze({
  normal: 2,
  double: 1,
  overtime: 0,
});

const EPSILON = 1e-9;

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

function isOnOwnSide(actor, y, arena) {
  const midY = getMidY(arena);
  return actor === "blue" ? y >= midY : y <= midY;
}

function buildTroopPlacements(arena, actor) {
  const centerX = (arena.minX + arena.maxX) / 2;
  const width = arena.maxX - arena.minX;
  const midY = getMidY(arena);

  const leftX = clamp(centerX - width * 0.18, arena.minX, arena.maxX);
  const rightX = clamp(centerX + width * 0.18, arena.minX, arena.maxX);

  const frontY = actor === "blue" ? clamp(midY + 1.2, arena.minY, arena.maxY) : clamp(midY - 1.2, arena.minY, arena.maxY);
  const backY = actor === "blue" ? clamp(arena.maxY - 4.0, arena.minY, arena.maxY) : clamp(arena.minY + 4.0, arena.minY, arena.maxY);

  return [
    { x: leftX, y: frontY },
    { x: centerX, y: frontY },
    { x: rightX, y: frontY },
    { x: leftX, y: backY },
    { x: centerX, y: backY },
    { x: rightX, y: backY },
  ].map((position) => ({ x: roundPlacement(position.x), y: roundPlacement(position.y) }));
}

function buildSpellTargets(state, actor) {
  const { enemy } = getTeam(actor);
  const enemies = state.entities.filter((entity) => entity.team === enemy && entity.hp > 0);

  const aliveEnemyTowers = enemies.filter((entity) => entity.entity_type === "tower");
  const enemyTroops = enemies.filter((entity) => entity.entity_type === "troop");

  const ownTowerY = actor === "blue" ? state.arena.maxY : state.arena.minY;
  enemyTroops.sort((a, b) => {
    const da = Math.abs(a.y - ownTowerY);
    const db = Math.abs(b.y - ownTowerY);
    if (Math.abs(da - db) > EPSILON) {
      return da - db;
    }
    if (a.hp !== b.hp) {
      return b.hp - a.hp;
    }
    return a.id.localeCompare(b.id);
  });

  const targetPositions = [];

  for (const troop of enemyTroops.slice(0, 3)) {
    targetPositions.push({ x: troop.x, y: troop.y });
  }

  for (const tower of aliveEnemyTowers) {
    targetPositions.push({ x: tower.x, y: tower.y });
  }

  const centerX = (state.arena.minX + state.arena.maxX) / 2;
  const midY = getMidY(state.arena);
  const pressureY = actor === "blue" ? midY - 1.5 : midY + 1.5;
  targetPositions.push({ x: centerX, y: pressureY });

  const deduped = new Set();
  const result = [];
  for (const position of targetPositions) {
    const x = roundPlacement(clamp(position.x, state.arena.minX, state.arena.maxX));
    const y = roundPlacement(clamp(position.y, state.arena.minY, state.arena.maxY));
    const key = `${x.toFixed(2)}|${y.toFixed(2)}`;
    if (deduped.has(key)) {
      continue;
    }
    deduped.add(key);
    result.push({ x, y });
  }

  return result;
}

function isLegalTroopPlacement(actor, arena, y) {
  const midY = getMidY(arena);
  return actor === "blue" ? y >= midY : y <= midY;
}

function cardCost(action) {
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
      for (const placement of buildTroopPlacements(engine.state.arena, actor)) {
        if (!isLegalTroopPlacement(actor, engine.state.arena, placement.y)) {
          continue;
        }
        actions.push({ type: "PLAY_CARD", cardId, x: placement.x, y: placement.y });
      }
      continue;
    }

    for (const target of buildSpellTargets(engine.state, actor)) {
      actions.push({ type: "PLAY_CARD", cardId, x: target.x, y: target.y });
    }
  }

  return actions;
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

function evaluateSpellAction(action, state, actor) {
  const cardId = action.cardId;
  const config = cardId === "fireball" ? FIREBALL_CONFIG : ARROWS_CONFIG;
  const impacted = getEnemiesInRadius(state, actor, action.x, action.y, config.radius_tiles);

  if (impacted.length === 0) {
    return {
      score: -260,
      hits: 0,
      troopHits: 0,
    };
  }

  let score = 0;
  let troopHits = 0;

  for (const entity of impacted) {
    const dealt = Math.min(entity.hp, config.damage);

    if (entity.entity_type === "tower") {
      score += dealt * 0.4;
    } else {
      troopHits += 1;
      score += dealt;
      if (entity.hp <= config.damage) {
        score += 170;
      }
    }
  }

  if (cardId === "fireball") {
    score += troopHits * 65;
  }

  return {
    score,
    hits: impacted.length,
    troopHits,
  };
}

function laneBonus(action, laneX) {
  return Math.max(0, 60 - Math.abs(action.x - laneX) * 28);
}

function evaluateThreat(state, actor) {
  const { enemy } = getTeam(actor);
  const enemyTroops = state.entities.filter(
    (entity) => entity.team === enemy && entity.hp > 0 && entity.entity_type === "troop",
  );
  const onOwnSide = enemyTroops.filter((entity) => isOnOwnSide(actor, entity.y, state.arena));
  const density = onOwnSide.length;

  let hottestLaneX = (state.arena.minX + state.arena.maxX) / 2;
  if (onOwnSide.length > 0) {
    hottestLaneX = onOwnSide.reduce((sum, entity) => sum + entity.x, 0) / onOwnSide.length;
  }

  return {
    density,
    lane_x: hottestLaneX,
  };
}

function evaluateTroopAction(action, state, actor, tierId) {
  const card = getCard(action.cardId);
  const threat = evaluateThreat(state, actor);
  const midY = getMidY(state.arena);

  const bridgeDistance = Math.abs(action.y - midY);
  const bridgeBonus = Math.max(0, 110 - bridgeDistance * 38);
  const base = TROOP_BASE_SCORE[action.cardId] ?? 120;

  const ownTroops = state.entities.filter(
    (entity) => entity.team === actor && entity.entity_type === "troop" && entity.hp > 0,
  );

  const stackCount = ownTroops.filter((entity) => Math.abs(entity.x - action.x) <= 1.7).length;
  const stackBonus = stackCount * 22;

  let defenseBonus = 0;
  if (threat.density > 0 && isOnOwnSide(actor, action.y, state.arena)) {
    defenseBonus = 80 + Math.min(3, threat.density) * 24 + laneBonus(action, threat.lane_x);
  }

  let score = base + bridgeBonus + stackBonus + defenseBonus;

  if (tierId === "top" && card) {
    if (card.cost >= 5 && threat.density === 0) {
      score -= 30;
    }
    if (card.cost <= 3 && threat.density > 0) {
      score += 28;
    }
  }

  return score;
}

function evaluateActionScore({ action, state, actor, tierId }) {
  const card = getCard(action.cardId);
  if (!card) {
    return -Infinity;
  }

  if (card.type === "spell") {
    return evaluateSpellAction(action, state, actor).score;
  }

  return evaluateTroopAction(action, state, actor, tierId);
}

function chooseHighestScoreAction({ actions, state, actor, tierId }) {
  let bestAction = null;
  let bestScore = -Infinity;

  for (const action of actions) {
    const score = evaluateActionScore({ action, state, actor, tierId });
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
    }
  }

  return {
    action: bestAction,
    score: bestScore,
  };
}

function chooseRandomAction(actions, rng) {
  if (actions.length === 0) {
    return null;
  }
  const idx = Math.floor(rng() * actions.length);
  return actions[idx] ?? null;
}

function chooseNoobAction({ legalActions, rng }) {
  if (legalActions.length === 0 || rng() < BOT_TIER_CONFIG.noob.pass_chance) {
    return { type: "PASS" };
  }

  return chooseRandomAction(legalActions, rng) ?? { type: "PASS" };
}

function chooseMidAction({ legalActions, state, actor, phase, rng }) {
  if (legalActions.length === 0 || rng() < BOT_TIER_CONFIG.mid.pass_chance) {
    return { type: "PASS" };
  }

  const currentElixir = state.elixir[actor]?.elixir ?? 0;
  const troopActions = legalActions.filter((action) => getCard(action.cardId)?.type === "troop");

  if (currentElixir >= 8 && troopActions.length > 0 && rng() < 0.2) {
    const sorted = [...troopActions].sort((a, b) => cardCost(b) - cardCost(a));
    return sorted[0] ?? { type: "PASS" };
  }

  const best = chooseHighestScoreAction({ actions: legalActions, state, actor, tierId: "mid" });
  if (!best.action) {
    return { type: "PASS" };
  }

  const card = getCard(best.action.cardId);
  if (card?.type === "spell") {
    const threshold = MID_SPELL_THRESHOLD[phase] ?? MID_SPELL_THRESHOLD.normal;
    if (best.score < threshold) {
      return { type: "PASS" };
    }
  } else if (best.score < 180) {
    return { type: "PASS" };
  }

  return best.action;
}

function chooseTopAction({ legalActions, state, actor, phase, rng }) {
  if (legalActions.length === 0 || rng() < BOT_TIER_CONFIG.top.pass_chance) {
    return { type: "PASS" };
  }

  const reserve = TOP_RESERVE_AFTER_PLAY[phase] ?? TOP_RESERVE_AFTER_PLAY.normal;
  const currentElixir = state.elixir[actor]?.elixir ?? 0;

  const filtered = legalActions.filter((action) => {
    const cost = cardCost(action);
    return currentElixir - cost >= reserve;
  });

  if (filtered.length === 0) {
    return { type: "PASS" };
  }

  const threat = evaluateThreat(state, actor);
  if (threat.density === 0 && currentElixir < 5 && rng() < 0.2) {
    return { type: "PASS" };
  }

  if (threat.density === 0 && rng() < 0.08) {
    return { type: "PASS" };
  }

  const best = chooseHighestScoreAction({ actions: filtered, state, actor, tierId: "top" });
  if (!best.action) {
    return { type: "PASS" };
  }

  const card = getCard(best.action.cardId);
  if (card?.type === "spell") {
    const threshold = TOP_SPELL_THRESHOLD[phase] ?? TOP_SPELL_THRESHOLD.normal;
    if (best.score < threshold) {
      return { type: "PASS" };
    }
    return best.action;
  }

  const troopThreshold = threat.density > 0 ? 140 : 200;
  if (best.score < troopThreshold) {
    return { type: "PASS" };
  }

  return best.action;
}

function chooseSelfAction({ legalActions, state, actor, phase, hand, rng, trainedModel }) {
  if (legalActions.length === 0) {
    return { type: "PASS" };
  }

  const preferredCard = selectCardFromModel(trainedModel, {
    phase,
    elixir: state.elixir[actor]?.elixir ?? 0,
    hand,
  });

  if (preferredCard && rng() > 0.1) {
    const preferredActions = legalActions.filter((action) => action.cardId === preferredCard);
    if (preferredActions.length > 0) {
      const bestPreferred = chooseHighestScoreAction({
        actions: preferredActions,
        state,
        actor,
        tierId: "top",
      });
      if (bestPreferred.action) {
        return bestPreferred.action;
      }
    }
  }

  return chooseTopAction({ legalActions, state, actor, phase, rng });
}

export function normalizeBotTierId(tierId) {
  if (typeof tierId === "string" && BOT_TIER_CONFIG[tierId]) {
    return tierId;
  }
  return "noob";
}

export function getBotTierConfig(tierId) {
  return BOT_TIER_CONFIG[normalizeBotTierId(tierId)];
}

export function rollDecisionDelayTicks({ tierId, rng }) {
  const tier = getBotTierConfig(tierId);
  const random = typeof rng === "function" ? rng : Math.random;
  const span = Math.max(0, tier.max_delay_ticks - tier.min_delay_ticks);
  return tier.min_delay_ticks + Math.floor(random() * (span + 1));
}

export function selectBotAction({
  tierId,
  engine,
  actor = "red",
  legalActions,
  rng = Math.random,
  trainedModel = null,
}) {
  const normalizedTier = normalizeBotTierId(tierId);
  const state = engine.state;
  const phase = getMatchPhase({ tick: state.tick, isOvertime: state.isOvertime });
  const hand = engine.getHand(actor);

  if (normalizedTier === "noob") {
    return chooseNoobAction({ legalActions, rng });
  }

  if (normalizedTier === "mid") {
    return chooseMidAction({ legalActions, state, actor, phase, rng });
  }

  if (normalizedTier === "top") {
    return chooseTopAction({ legalActions, state, actor, phase, rng });
  }

  return chooseSelfAction({ legalActions, state, actor, phase, hand, rng, trainedModel });
}
