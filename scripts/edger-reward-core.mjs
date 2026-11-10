// Edger training reward potentials. These are used in training only. Nothing
// here changes game rules, the live bot or evaluation.
//
// Every reward version has the same per-decision form (see
// assignDecisionRewards in edger-v2-cadence-core.mjs):
//   reward = gamma^dt * Phi(next decision) - Phi(now)  (+ discounted +/-1 last)
// Only the potential Phi differs between versions.
//
// - v1 (edger_potential_reward_v1): crowns and tower HP only.
// - v2 (edger_potential_reward_v2): v1 plus position terms, in elixir units,
//   divided by 75, so 1 elixir is worth about 400 tower HP:
//     Phi_v2 = Phi_v1 + (f(phase) * M + T + R + S) / 75, each term ours - theirs
//   M material, T threat, R answer readiness, S tank support. The new terms
//   are 0 at game end, which is standard potential-based shaping with
//   Phi(terminal) = 0, so they guide learning without changing what winning
//   is worth. Owner design: November 10, 2026 (docs/EDGER_REWARD.md).
//
// Status: the counter table was frozen by the owner on November 10, 2026,
// after the counter duels (scripts/edger-reward-duels.mjs). The weights stay
// a draft until the data check. Once any training run uses v2, a change to
// any constant below needs a new reward version.

import { ELIXIR_REGEN_TICKS, getMatchPhase } from "../src/sim/config.js";
import { CARD_STATS } from "../src/sim/stats.js";

export const EDGER_REWARD_VERSIONS = Object.freeze({
  V1: "edger_potential_reward_v1",
  V2: "edger_potential_reward_v2",
});

const KNOWN_VERSIONS = new Set(Object.values(EDGER_REWARD_VERSIONS));

export function assertRewardVersion(version) {
  if (!KNOWN_VERSIONS.has(version)) {
    throw new Error(`unknown reward version ${version}; expected one of ${[...KNOWN_VERSIONS].join(", ")}`);
  }
  return version;
}

// Elixir units per reward unit: 1 elixir = 30,000 / 75 = 400 tower HP.
export const EDGER_REWARD_V2_ELIXIR_SCALE = 75;

// T: how much a troop threatens towers, per unit cost at full HP.
export const EDGER_REWARD_V2_THREAT_TIER = Object.freeze({
  giant: 1.0,
  mini_pekka: 1.0,
  musketeer: 1.0,
  knight: 0.25,
  archers: 0.25,
  goblins: 0.25,
});

// T: position factor. Locked on an enemy tower beats across the bridge, which
// beats the troop owner's own side.
export const EDGER_REWARD_V2_POSITION = Object.freeze({
  own_side: 0.25,
  across_bridge: 0.75,
  on_tower: 1.0,
});

// R: counter table (strong / partial). The owner's draft, with the changes
// the duels clearly supported (owner decision, November 10, 2026): Goblins
// and Musketeer strong against Giant, Archers and Knight partial; Mini PEKKA
// strong and Fireball partial against Musketeer (688 damage cannot kill a
// 721-HP Musketeer); Archers strong against Mini PEKKA; Musketeer partial
// against Knight. The draft is kept in the duel report for reference.
export const EDGER_REWARD_V2_COUNTERS = Object.freeze({
  giant: Object.freeze({
    strong: Object.freeze(["mini_pekka", "goblins", "musketeer"]),
    partial: Object.freeze(["archers", "knight"]),
  }),
  musketeer: Object.freeze({ strong: Object.freeze(["mini_pekka"]), partial: Object.freeze(["fireball", "knight"]) }),
  mini_pekka: Object.freeze({
    strong: Object.freeze(["goblins", "knight", "archers"]),
    partial: Object.freeze(["musketeer"]),
  }),
  archers: Object.freeze({ strong: Object.freeze(["arrows"]), partial: Object.freeze(["fireball", "knight"]) }),
  goblins: Object.freeze({ strong: Object.freeze(["arrows"]), partial: Object.freeze(["musketeer", "knight"]) }),
  knight: Object.freeze({ strong: Object.freeze(["mini_pekka"]), partial: Object.freeze(["goblins", "musketeer"]) }),
});

export const EDGER_REWARD_V2_READINESS = Object.freeze({
  scale: 0.5,
  strength: Object.freeze({ strong: 1.0, partial: 0.5 }),
  availability: Object.freeze({ hand: 1.0, next_in_queue: 0.5 }),
  // Elixir >= cost: 1.0; >= cost - 2: 0.5; otherwise 0.25.
  affordability: Object.freeze({ now: 1.0, within: 0.5, short: 0.25, within_elixir: 2 }),
  urgency_in_hand: 0.5,
});

// S: support troops gain value with one of our tanks ahead in their lane.
export const EDGER_REWARD_V2_SUPPORT = Object.freeze({
  bonus: 0.25,
  support_cards: Object.freeze(["archers", "musketeer", "goblins"]),
  tank_cards: Object.freeze(["knight", "giant"]),
  lane_half_width_tiles: 2,
  max_lead_tiles: 5,
});

function otherTeam(actor) {
  return actor === "blue" ? "red" : "blue";
}

// v1 potential, unchanged: the exact expression of edger-corpus-core.mjs.
export function v1PotentialForActor(engine, actor) {
  const score = engine.getScore();
  const ownCrowns = actor === "blue" ? score.blue_crowns : score.red_crowns;
  const enemyCrowns = actor === "blue" ? score.red_crowns : score.blue_crowns;
  const ownHp = actor === "blue" ? score.blue_tower_hp : score.red_tower_hp;
  const enemyHp = actor === "blue" ? score.red_tower_hp : score.blue_tower_hp;
  return (ownCrowns - enemyCrowns) * 0.25 + (ownHp - enemyHp) / 30_000;
}

function unitCost(cardId) {
  const card = CARD_STATS[cardId];
  return card.cost / (card.spawn_count ?? 1);
}

function hpFraction(entity) {
  return entity.maxHp > 0 ? Math.max(0, entity.hp) / entity.maxHp : 0;
}

function livingTroops(state, team) {
  return (state.entities ?? []).filter(
    (entity) => entity.entity_type === "troop" && entity.team === team && entity.hp > 0 && CARD_STATS[entity.cardId],
  );
}

function isOnOwnSide(team, y, arena) {
  const midY = (arena.minY + arena.maxY) / 2;
  return team === "blue" ? y >= midY : y <= midY;
}

export function elixirPhaseFactor(phase) {
  return ELIXIR_REGEN_TICKS[phase] / ELIXIR_REGEN_TICKS.normal;
}

function bankedElixir(state, team, phase) {
  const tracker = state.elixir?.[team];
  if (!tracker) {
    return 0;
  }
  // At most one elixir of progress: on the tick overtime starts, the
  // accumulator was last advanced at the double-elixir rate.
  return tracker.elixir + Math.min(1, (tracker.regenAccumulatorTicks ?? 0) / ELIXIR_REGEN_TICKS[phase]);
}

// M for one side: banked elixir, troops at unit cost times HP fraction, and
// the full cost of cards still deploying or spells in flight.
function sideMaterial(state, team, phase) {
  let total = bankedElixir(state, team, phase);
  for (const troop of livingTroops(state, team)) {
    total += unitCost(troop.cardId) * hpFraction(troop);
  }
  for (const effect of state.pending_effects ?? []) {
    if (effect.actor === team && CARD_STATS[effect.card_id]) {
      total += CARD_STATS[effect.card_id].cost;
    }
  }
  return total;
}

function troopPosition(troop, state, entityById) {
  const target = troop.target_entity_id ? entityById.get(troop.target_entity_id) : null;
  if (target && target.entity_type === "tower" && target.team !== troop.team && target.hp > 0) {
    return EDGER_REWARD_V2_POSITION.on_tower;
  }
  return isOnOwnSide(troop.team, troop.y, state.arena)
    ? EDGER_REWARD_V2_POSITION.own_side
    : EDGER_REWARD_V2_POSITION.across_bridge;
}

// T for one side.
function sideThreat(state, team, entityById) {
  let total = 0;
  for (const troop of livingTroops(state, team)) {
    const tier = EDGER_REWARD_V2_THREAT_TIER[troop.cardId] ?? 0;
    total += tier * unitCost(troop.cardId) * hpFraction(troop) * troopPosition(troop, state, entityById);
  }
  return total;
}

function affordability(elixir, cost) {
  const rule = EDGER_REWARD_V2_READINESS.affordability;
  if (elixir >= cost) {
    return rule.now;
  }
  return elixir >= cost - rule.within_elixir ? rule.within : rule.short;
}

// Best credit `team` has against one threat card: max over its counters of
// strength x availability x affordability.
export function counterCredit({ hand, nextInQueue, elixir }, threatCardId) {
  const counters = EDGER_REWARD_V2_COUNTERS[threatCardId];
  if (!counters) {
    return 0;
  }
  const rule = EDGER_REWARD_V2_READINESS;
  let best = 0;
  for (const [strengthKey, list] of [["strong", counters.strong], ["partial", counters.partial]]) {
    for (const counterId of list) {
      const availability = hand.includes(counterId)
        ? rule.availability.hand
        : nextInQueue === counterId ? rule.availability.next_in_queue : 0;
      if (availability === 0) {
        continue;
      }
      const credit = rule.strength[strengthKey] * availability * affordability(elixir, CARD_STATS[counterId].cost);
      best = Math.max(best, credit);
    }
  }
  return best;
}

// The enemy's threats `team` must answer: troop groups on the board (grouped
// by card, urgency = summed HP fraction, at most 1) and troop cards in hand.
function threatsAgainst(engine, team) {
  const enemy = otherTeam(team);
  const threats = [];
  const groups = new Map();
  for (const troop of livingTroops(engine.state, enemy)) {
    const card = CARD_STATS[troop.cardId];
    const share = hpFraction(troop) / (card.spawn_count ?? 1);
    groups.set(troop.cardId, (groups.get(troop.cardId) ?? 0) + share);
  }
  for (const cardId of [...groups.keys()].sort()) {
    threats.push({ cardId, urgency: Math.min(1, groups.get(cardId)) });
  }
  for (const cardId of engine.getHand(enemy)) {
    if (CARD_STATS[cardId]?.type === "troop") {
      threats.push({ cardId, urgency: EDGER_REWARD_V2_READINESS.urgency_in_hand });
    }
  }
  return threats;
}

// How ready `team` is to answer the enemy's threats.
function sideReadiness(engine, team) {
  const context = {
    hand: engine.getHand(team),
    nextInQueue: engine.getDeckQueue(team)[0] ?? null,
    elixir: engine.state.elixir?.[team]?.elixir ?? 0,
  };
  let total = 0;
  for (const threat of threatsAgainst(engine, team)) {
    const card = CARD_STATS[threat.cardId];
    const tier = EDGER_REWARD_V2_THREAT_TIER[threat.cardId] ?? 0;
    total += EDGER_REWARD_V2_READINESS.scale * card.cost * tier * threat.urgency * counterCredit(context, threat.cardId);
  }
  return total;
}

// S for one side: each support unit with one of our tanks 0-5 tiles ahead of
// it (toward the enemy) in the same lane.
function sideSupport(state, team) {
  const rule = EDGER_REWARD_V2_SUPPORT;
  const troops = livingTroops(state, team);
  const tanks = troops.filter((troop) => rule.tank_cards.includes(troop.cardId));
  if (tanks.length === 0) {
    return 0;
  }
  // Blue attacks toward smaller y, red toward larger y.
  const forward = team === "blue" ? -1 : 1;
  let total = 0;
  for (const unit of troops) {
    if (!rule.support_cards.includes(unit.cardId)) {
      continue;
    }
    const covered = tanks.some((tank) => {
      const lead = (tank.y - unit.y) * forward;
      return Math.abs(tank.x - unit.x) <= rule.lane_half_width_tiles && lead >= 0 && lead <= rule.max_lead_tiles;
    });
    if (covered) {
      total += rule.bonus * unitCost(unit.cardId) * hpFraction(unit);
    }
  }
  return total;
}

// One side's v2 position terms before the ours-minus-theirs difference
// (material before the phase factor). Used by tests and diagnostics.
export function sidePositionTerms(engine, team) {
  const state = engine.state;
  const phase = getMatchPhase({ tick: state.tick, isOvertime: state.isOvertime });
  const entityById = new Map((state.entities ?? []).map((entity) => [entity.id, entity]));
  return {
    phase,
    material: sideMaterial(state, team, phase),
    threat: sideThreat(state, team, entityById),
    readiness: sideReadiness(engine, team),
    support: sideSupport(state, team),
  };
}

// The full potential for `actor` and its parts. Every part is ours - theirs,
// computed side by side, so blue's value is exactly minus red's.
export function potentialForActor(engine, actor, version = EDGER_REWARD_VERSIONS.V1) {
  assertRewardVersion(version);
  const v1 = v1PotentialForActor(engine, actor);
  if (version === EDGER_REWARD_VERSIONS.V1) {
    return { version, total: v1, v1 };
  }
  const state = engine.state;
  const enemy = otherTeam(actor);
  const phase = getMatchPhase({ tick: state.tick, isOvertime: state.isOvertime });
  const phaseFactor = elixirPhaseFactor(phase);
  const entityById = new Map((state.entities ?? []).map((entity) => [entity.id, entity]));
  const material = sideMaterial(state, actor, phase) - sideMaterial(state, enemy, phase);
  const threat = sideThreat(state, actor, entityById) - sideThreat(state, enemy, entityById);
  const readiness = sideReadiness(engine, actor) - sideReadiness(engine, enemy);
  const support = sideSupport(state, actor) - sideSupport(state, enemy);
  const position = phaseFactor * material + threat + readiness + support;
  return {
    version,
    total: v1 + position / EDGER_REWARD_V2_ELIXIR_SCALE,
    v1,
    phase,
    phase_factor: phaseFactor,
    material,
    threat,
    readiness,
    support,
    position,
  };
}

// The potential at game end. The v2 position terms are 0 there.
export function terminalPotentialForActor(engine, actor, version = EDGER_REWARD_VERSIONS.V1) {
  assertRewardVersion(version);
  return v1PotentialForActor(engine, actor);
}
