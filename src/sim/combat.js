import { TICK_RATE } from "./config.js";
import { clampPositionToArenaAndPathable } from "./map.js";

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
    return target.entity_type === "troop";
  }

  if (attacker.targeting_mode === "buildings") {
    return target.entity_type === "tower";
  }

  return target.entity_type === "troop" || target.entity_type === "tower";
}

function chooseTarget(attacker, entities) {
  const candidates = entities.filter((candidate) => isTargetable(attacker, candidate));
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

function isInRange(attacker, target) {
  const reach = attacker.attack_range + target.radius;
  return squaredDistance(attacker, target) <= reach * reach;
}

function applyAttack(attacker, target) {
  if (attacker.attack_cooldown_ticks_remaining > 0) {
    return false;
  }

  target.hp = Math.max(0, target.hp - attacker.attack_damage);
  attacker.attack_cooldown_ticks_remaining = attacker.attack_cooldown_ticks;
  return true;
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (length <= EPSILON) {
    return { x: 0, y: 0 };
  }

  return { x: x / length, y: y / length };
}

function getForwardDirection(entity) {
  const laneBiasX = (9 - entity.x) * 0.15;
  const laneBiasY = entity.team === "blue" ? -1 : 1;
  return normalizeVector(laneBiasX, laneBiasY);
}

function moveTroop(entity, target, arena) {
  const speedPerTick = entity.move_speed / TICK_RATE;
  if (speedPerTick <= 0) {
    entity.velocity = { x: 0, y: 0 };
    return;
  }

  const direction = target
    ? normalizeVector(target.x - entity.x, target.y - entity.y)
    : getForwardDirection(entity);

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

  for (const entity of ordered) {
    if (!isAlive(entity)) {
      entity.velocity = { x: 0, y: 0 };
      entity.target_entity_id = null;
      continue;
    }

    tickCooldown(entity);

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
      applyAttack(entity, target);
      continue;
    }

    if (entity.entity_type === "troop") {
      moveTroop(entity, target, arena);
    } else {
      entity.velocity = { x: 0, y: 0 };
    }
  }
}
