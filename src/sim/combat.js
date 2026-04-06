import { TICK_RATE } from "./config.js";
import { clampPositionToArenaAndPathable, getArenaSide, getNearestBridge } from "./map.js";

const EPSILON = 1e-9;
const TROOP_BUCKET_SIZE = 2;
const MOVE_COLLISION_RADIUS = 0.45;
const MAX_TEMPORARY_COMPRESSION = 0.18;
const MAX_LATERAL_SLIP_PER_TICK = 0.2;

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (length <= EPSILON) {
    return { x: 0, y: 0 };
  }

  return { x: x / length, y: y / length };
}

function getTroopBucketKey(x, y) {
  return `${Math.floor(x / TROOP_BUCKET_SIZE)},${Math.floor(y / TROOP_BUCKET_SIZE)}`;
}

function buildTroopBuckets(entities) {
  const buckets = new Map();
  for (const entity of entities) {
    if (entity.entity_type !== "troop" || !isAlive(entity)) {
      continue;
    }

    const key = getTroopBucketKey(entity.x, entity.y);
    const list = buckets.get(key) ?? [];
    list.push(entity);
    buckets.set(key, list);
  }
  return buckets;
}

function getNearbyTroops(entity, buckets) {
  const centerX = Math.floor(entity.x / TROOP_BUCKET_SIZE);
  const centerY = Math.floor(entity.y / TROOP_BUCKET_SIZE);
  const nearby = [];

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const bucket = buckets.get(`${centerX + dx},${centerY + dy}`);
      if (!bucket) {
        continue;
      }
      nearby.push(...bucket);
    }
  }

  return nearby;
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

function getTargetRadius(target) {
  if (target.entity_type === "troop") {
    return MOVE_COLLISION_RADIUS;
  }
  return target.radius ?? MOVE_COLLISION_RADIUS;
}

function sortTargetCandidates(attacker, entities, predicate = () => true) {
  const candidates = entities.filter((candidate) => isTargetable(attacker, candidate) && predicate(candidate));
  if (candidates.length === 0) {
    return candidates;
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

  return candidates;
}

function chooseTarget(attacker, entities, predicate = () => true) {
  const candidates = sortTargetCandidates(attacker, entities, predicate);
  if (candidates.length === 0) {
    return null;
  }

  return candidates[0];
}

function getLockedTarget(attacker, entitiesById) {
  if (!attacker.target_entity_id) {
    return null;
  }

  const target = entitiesById.get(attacker.target_entity_id);
  if (!target || !isTargetable(attacker, target)) {
    return null;
  }

  return target;
}

function chooseVisibleTarget(attacker, entities) {
  return chooseTarget(attacker, entities, (candidate) => isWithinSight(attacker, candidate));
}

function chooseImmediateAttackTarget(attacker, entities, excludedId = null) {
  return chooseTarget(
    attacker,
    entities,
    (candidate) => candidate.id !== excludedId && isInRange(attacker, candidate),
  );
}

function chooseTowerObjective(attacker, entities) {
  if (attacker.entity_type !== "troop") {
    return null;
  }

  return chooseTarget(attacker, entities, (candidate) => candidate.entity_type === "tower");
}

function resolveTarget(attacker, entities, entitiesById) {
  const lockedTarget = getLockedTarget(attacker, entitiesById);
  if (lockedTarget) {
    if (isInRange(attacker, lockedTarget)) {
      return lockedTarget;
    }

    return chooseImmediateAttackTarget(attacker, entities, lockedTarget.id) ?? lockedTarget;
  }

  const visibleTarget = chooseVisibleTarget(attacker, entities);
  if (visibleTarget) {
    return visibleTarget;
  }

  return chooseTowerObjective(attacker, entities);
}

function isWithinSight(attacker, target) {
  if (attacker.entity_type !== "troop" || attacker.sight_range == null) {
    return true;
  }

  const sightReach = attacker.sight_range + getTargetRadius(target);
  return squaredDistance(attacker, target) <= sightReach * sightReach;
}

function isInRange(attacker, target) {
  const reach = attacker.attack_range + getTargetRadius(target);
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

  const bridge = getNearestBridge(arena, entity.preferred_lane_x ?? entity.x);
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

function getMovementBodyRadius(entity) {
  if (entity.entity_type === "troop") {
    return MOVE_COLLISION_RADIUS;
  }

  return entity.radius ?? MOVE_COLLISION_RADIUS;
}

function getTroopBodyMass(entity) {
  return entity.body_mass ?? 1;
}

function getStableSeparationNormal(a, b) {
  const direction = a.id.localeCompare(b.id) <= 0 ? -1 : 1;
  return normalizeVector(direction * 0.2, 1);
}

function clampLateralDelta(deltaX) {
  return Math.min(MAX_LATERAL_SLIP_PER_TICK, Math.max(-MAX_LATERAL_SLIP_PER_TICK, deltaX));
}

function displaceTroop(entity, delta, arena) {
  if (Math.abs(delta.x) <= EPSILON && Math.abs(delta.y) <= EPSILON) {
    return { x: 0, y: 0 };
  }

  const limitedDelta = {
    x: clampLateralDelta(delta.x),
    y: delta.y,
  };
  const nextPosition = clampPositionToArenaAndPathable(
    {
      x: entity.x + limitedDelta.x,
      y: entity.y + limitedDelta.y,
    },
    arena,
  );

  const applied = {
    x: nextPosition.x - entity.x,
    y: nextPosition.y - entity.y,
  };

  entity.x = nextPosition.x;
  entity.y = nextPosition.y;
  return applied;
}

export function resolveTroopBodyCollisions({ entities, arena }) {
  const troops = entities
    .filter((entity) => entity.entity_type === "troop" && isAlive(entity))
    .sort((a, b) => a.id.localeCompare(b.id));
  const troopBuckets = buildTroopBuckets(troops);

  for (const first of troops) {
    for (const second of getNearbyTroops(first, troopBuckets)) {
      if (second.id <= first.id) {
        continue;
      }

      const minDistance = getMovementBodyRadius(first) + getMovementBodyRadius(second);
      const requiredDistance = Math.max(0, minDistance - MAX_TEMPORARY_COMPRESSION);
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      if (Math.abs(dx) >= minDistance || Math.abs(dy) >= minDistance) {
        continue;
      }

      const distance = Math.hypot(dx, dy);
      if (distance + EPSILON >= requiredDistance) {
        continue;
      }

      const normal = distance > EPSILON ? { x: dx / distance, y: dy / distance } : getStableSeparationNormal(first, second);
      const overlap = requiredDistance - Math.max(distance, EPSILON) + 1e-4;
      const firstMass = getTroopBodyMass(first);
      const secondMass = getTroopBodyMass(second);
      const totalMass = Math.max(1, firstMass + secondMass);
      const firstShare = overlap * (secondMass / totalMass);
      const secondShare = overlap * (firstMass / totalMass);

      displaceTroop(first, { x: -normal.x * firstShare, y: -normal.y * firstShare }, arena);
      displaceTroop(second, { x: normal.x * secondShare, y: normal.y * secondShare }, arena);
    }
  }
}

export function stepCombat({ entities, arena }) {
  const ordered = [...entities].sort((a, b) => a.id.localeCompare(b.id));
  const entitiesById = new Map(ordered.map((entity) => [entity.id, entity]));
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

    const target = resolveTarget(entity, ordered, entitiesById);
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
