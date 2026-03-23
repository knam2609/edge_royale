import { MATCH_CONFIG } from "./config.js";

function towersByTeam(entities, team) {
  return entities.filter((entity) => entity.entity_type === "tower" && entity.team === team);
}

function isKingTower(tower) {
  return tower.tower_role === "king";
}

function isCrownTower(tower) {
  return !isKingTower(tower);
}

function crownsFromDestroyedTowers(enemyTowers) {
  const deadKing = enemyTowers.find((tower) => isKingTower(tower) && tower.hp <= 0);
  if (deadKing) {
    return 3;
  }

  return enemyTowers.filter((tower) => isCrownTower(tower) && tower.hp <= 0).length;
}

export function getScoreSnapshot(entities) {
  const blueTowers = towersByTeam(entities, "blue");
  const redTowers = towersByTeam(entities, "red");

  return {
    blue_crowns: crownsFromDestroyedTowers(redTowers),
    red_crowns: crownsFromDestroyedTowers(blueTowers),
    blue_tower_hp: blueTowers.reduce((sum, tower) => sum + Math.max(0, tower.hp), 0),
    red_tower_hp: redTowers.reduce((sum, tower) => sum + Math.max(0, tower.hp), 0),
  };
}

export function isRegulationTieForOvertime(score) {
  return score.blue_crowns === score.red_crowns;
}

function finalizeResult({ tick, winner, reason, score }) {
  return {
    tick,
    winner,
    reason,
    score,
  };
}

function crownsWinner(score) {
  if (score.blue_crowns > score.red_crowns) {
    return "blue";
  }
  if (score.red_crowns > score.blue_crowns) {
    return "red";
  }
  return null;
}

function hpWinner(score) {
  if (score.blue_tower_hp > score.red_tower_hp) {
    return "blue";
  }
  if (score.red_tower_hp > score.blue_tower_hp) {
    return "red";
  }
  return null;
}

export function evaluateMatchResult({ tick, isOvertime, entities, overtimeStartTick = null }) {
  const score = getScoreSnapshot(entities);
  if (score.blue_crowns === 3 || score.red_crowns === 3) {
    return finalizeResult({
      tick,
      winner: score.blue_crowns === 3 ? "blue" : "red",
      reason: "king_tower_destroyed",
      score,
    });
  }

  const crownsLead = crownsWinner(score);

  if (crownsLead) {
    const reason = isOvertime ? "tower_advantage_overtime" : "tower_advantage_regulation";
    return finalizeResult({ tick, winner: crownsLead, reason, score });
  }

  const overtimeBaseTick = overtimeStartTick ?? MATCH_CONFIG.regulation_ticks;
  const overtimeEndTick = overtimeBaseTick + MATCH_CONFIG.overtime_ticks;
  if (isOvertime && tick >= overtimeEndTick) {
    const hpLead = hpWinner(score);
    if (hpLead) {
      return finalizeResult({ tick, winner: hpLead, reason: "tower_hp_overtime", score });
    }

    return finalizeResult({ tick, winner: null, reason: "draw_overtime", score });
  }

  return null;
}
