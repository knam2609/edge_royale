import { TICK_RATE } from "./config.js";
import {
  clampPositionToArenaAndPathable,
  getArenaMidY,
  getArenaSide,
  getNearestBridge,
} from "./map.js";

const EPSILON = 1e-9;

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function isAlive(entity) {
  return entity.hp > 0;
}

function isTargetable(attacker, target) {
  if (!isAlive(target) || attacker.team === target.team) {
    return false;
  }

  if (attacker.entity_type === "tower") {
    if (attacker.is_active === false) {
      return false;
    }
    return target.entity_type === "troop";
  }

  if (attacker.targeting_mode === "buildings") {
    return target.entity_type === "tower";
  }

  return target.entity_type === "troop" || target.entity_type === "tower";
}

function chooseTarget(attacker, entities) {
  const candidates = entities.filter((candidate) => isTargetable(attacker, candidate) && isWithinSight(attacker, candidate));
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const distA = squaredDistance(attacker, a);
    const distB = squaredDistance(attacker, b);
    if (Math.abs(distA - distB) > EPSILON) {
      return distA - distB;
    }
    if (a.hp !== b.hp) {
      return a.hp - b.hp;
    }
    return a.id.localeCompare(b.id);
  });

  return candidates[0];
}

function isWithinSight(attacker, target) {
  if (attacker.entity_type !== "troop" || attacker.sight_range == null) {
    return true;
  }

  const sightReach = attacker.sight_range + target.radius;
  return squaredDistance(attacker, target) <= sightReach * sightReach;
}

function isInRange(attacker, target) {
  const reach = attacker.attack_range + target.radius;
  return squaredDistance(attacker, target) <= reach * reach;
}

function applyAttack(attacker, target, attackEvents) {
  if (attacker.attack_cooldown_ticks_remaining > 0) {
    return false;
  }

  target.hp = Math.max(0, target.hp - attacker.attack_damage);
  attacker.attack_cooldown_ticks_remaining = attacker.attack_cooldown_ticks;
  attackEvents.push({
    attacker_id: attacker.id,
    attacker_card_id: attacker.cardId,
    attacker_team: attacker.team,
    attacker_entity_type: attacker.entity_type,
    attacker_x: roundCoord(attacker.x),
    attacker_y: roundCoord(attacker.y),
    target_id: target.id,
    target_card_id: target.cardId,
    target_x: roundCoord(target.x),
    target_y: roundCoord(target.y),
    damage: attacker.attack_damage,
  });
  return true;
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (length <= EPSILON) {
    return { x: 0, y: 0 };
  }

  return { x: x / length, y: y / length };
}

function getForwardDirection(entity, arena) {
  const bridge = getNearestBridge(arena, entity.x);
  const laneBiasX = bridge ? (bridge.x - entity.x) * 0.18 : ((arena.minX + arena.maxX) * 0.5 - entity.x) * 0.15;
  const laneBiasY = entity.team === "blue" ? -1 : 1;
  return normalizeVector(laneBiasX, laneBiasY);
}

function getBridgeWaypoint(entity, goal, arena) {
  if (!arena.river || !arena.bridges?.length) {
    return goal;
  }

  const entitySide = getArenaSide(arena, entity.y);
  const goalSide = getArenaSide(arena, goal.y);

  if (entitySide === "river" || goalSide === "river" || entitySide === goalSide) {
    return goal;
  }

  const bridge = getNearestBridge(arena, entity.bridge_x ?? entity.x);
  if (!bridge) {
    return goal;
  }

  return {
    x: bridge.x,
    y: arena.river.centerY,
  };
}

function activateKingTowers(entities) {
  const crownsByTeam = new Map();
  const kings = [];

  for (const entity of entities) {
    if (entity.entity_type !== "tower") {
      continue;
    }

    if (entity.tower_role === "king") {
      kings.push(entity);
      continue;
    }

    const list = crownsByTeam.get(entity.team) ?? [];
    list.push(entity);
    crownsByTeam.set(entity.team, list);
  }

  for (const king of kings) {
    if (king.is_active) {
      continue;
    }

    const friendlyCrowns = crownsByTeam.get(king.team) ?? [];
    const crownDestroyed = friendlyCrowns.some((tower) => tower.hp <= 0);
    const kingDamaged = king.hp < king.maxHp;
    if (crownDestroyed || kingDamaged) {
      king.is_active = true;
    }
  }
}

function moveTroop(entity, target, arena) {
  const speedPerTick = entity.move_speed / TICK_RATE;
  if (speedPerTick <= 0) {
    entity.velocity = { x: 0, y: 0 };
    return;
  }

  const movementGoal = target
    ? getBridgeWaypoint(entity, target, arena)
    : getBridgeWaypoint(
        entity,
        {
          x: entity.x,
          y: entity.team === "blue" ? arena.minY : arena.maxY,
        },
        arena,
      );
  const direction =
    target || movementGoal !== null
      ? normalizeVector(movementGoal.x - entity.x, movementGoal.y - entity.y)
      : getForwardDirection(entity, arena);

  const desiredPosition = {
    x: entity.x + direction.x * speedPerTick,
    y: entity.y + direction.y * speedPerTick,
  };

  const nextPosition = clampPositionToArenaAndPathable(desiredPosition, arena);
  entity.velocity = {
    x: roundCoord(nextPosition.x - entity.x),
    y: roundCoord(nextPosition.y - entity.y),
  };
  entity.x = nextPosition.x;
  entity.y = nextPosition.y;
}

function tickCooldown(entity) {
  if (entity.attack_cooldown_ticks_remaining > 0) {
    entity.attack_cooldown_ticks_remaining -= 1;
  }
}

export function stepCombat({ entities, arena }) {
  const ordered = [...entities].sort((a, b) => a.id.localeCompare(b.id));
  const attackEvents = [];

  for (const entity of ordered) {
    if (!isAlive(entity)) {
      entity.velocity = { x: 0, y: 0 };
      entity.target_entity_id = null;
      continue;
    }

    tickCooldown(entity);
    activateKingTowers(ordered);

    if (entity.entity_type !== "troop" && entity.entity_type !== "tower") {
      continue;
    }

    if (entity.entity_type === "troop" && entity.forced_motion_ticks_remaining > 0) {
      entity.velocity = {
        x: entity.forced_motion_vector.x,
        y: entity.forced_motion_vector.y,
      };
      entity.target_entity_id = null;
      continue;
    }

    const target = chooseTarget(entity, ordered);
    entity.target_entity_id = target?.id ?? null;

    if (!target) {
      if (entity.entity_type === "troop") {
        moveTroop(entity, null, arena);
      } else {
        entity.velocity = { x: 0, y: 0 };
      }
      continue;
    }

    if (isInRange(entity, target)) {
      entity.velocity = { x: 0, y: 0 };
      applyAttack(entity, target, attackEvents);
      continue;
    }

    if (entity.entity_type === "troop") {
      moveTroop(entity, target, arena);
    } else {
      entity.velocity = { x: 0, y: 0 };
    }
  }

  return attackEvents;
}
