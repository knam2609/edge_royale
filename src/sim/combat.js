import { TICK_RATE } from "./config.js";
import { clampPositionToArenaAndPathable } from "./map.js";
import { createGroundNavigation, getGroundPathingBlockers } from "./nav.js";

const EPSILON = 1e-9;
const MAX_COLLISION_PASSES = 3;
const CROWD_INFLUENCE_PADDING = 0.4;
const MOVEMENT_STEP_SCALES = Object.freeze([1, 0.72, 0.45]);
const SIDE_STEP_ANGLES = Object.freeze([0, 0.4, -0.4, 0.8, -0.8]);

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

function dotProduct(a, b) {
  return a.x * b.x + a.y * b.y;
}

function rotateVector(vector, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: vector.x * cosine - vector.y * sine,
    y: vector.x * sine + vector.y * cosine,
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

function overlapsEntityAt(position, radius, otherPosition, otherRadius) {
  const minDistance = radius + otherRadius;
  return squaredDistance(position, otherPosition) < minDistance * minDistance - EPSILON;
}

function getStableCollisionNormal(a, b) {
  if (a.preferred_lane_x !== b.preferred_lane_x) {
    return normalizeVector((a.preferred_lane_x ?? a.x) - (b.preferred_lane_x ?? b.x), 0);
  }
  return normalizeVector(a.id.localeCompare(b.id) <= 0 ? -1 : 1, a.team === "blue" ? 1 : -1);
}

function resolvePositionAgainstStaticBlockers(position, entity, blockers, arena) {
  let resolved = clampPositionToArenaAndPathable(position, arena);

  for (let pass = 0; pass < 2; pass += 1) {
    let moved = false;
    for (const blocker of blockers) {
      if (blocker.id === entity.id) {
        continue;
      }

      const minDistance = (entity.collision_radius ?? entity.radius ?? 0) + (blocker.collision_radius ?? blocker.radius ?? 0);
      const dx = resolved.x - blocker.x;
      const dy = resolved.y - blocker.y;
      const distance = Math.hypot(dx, dy);
      if (distance >= minDistance - EPSILON) {
        continue;
      }

      const direction =
        distance > EPSILON
          ? { x: dx / distance, y: dy / distance }
          : getStableCollisionNormal(entity, blocker);
      const pushDistance = minDistance - distance + 0.01;
      resolved = clampPositionToArenaAndPathable(
        {
          x: resolved.x + direction.x * pushDistance,
          y: resolved.y + direction.y * pushDistance,
        },
        arena,
      );
      moved = true;
    }

    if (!moved) {
      break;
    }
  }

  return resolved;
}

function computeSeparationVector(entity, troopPositions, entitiesById) {
  const current = troopPositions.get(entity.id) ?? entity;
  let x = 0;
  let y = 0;

  for (const [otherId, otherPosition] of troopPositions.entries()) {
    if (otherId === entity.id) {
      continue;
    }

    const other = entitiesById.get(otherId);
    if (!other || other.hp <= 0 || other.entity_type !== "troop") {
      continue;
    }

    const minDistance = (entity.collision_radius ?? entity.radius ?? 0) + (other.collision_radius ?? other.radius ?? 0);
    const influenceDistance = minDistance + CROWD_INFLUENCE_PADDING;
    const dx = current.x - otherPosition.x;
    const dy = current.y - otherPosition.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= EPSILON || distance >= influenceDistance) {
      continue;
    }

    const strength = ((influenceDistance - distance) / influenceDistance) / Math.max(0.2, entity.body_mass ?? 1);
    x += (dx / distance) * strength;
    y += (dy / distance) * strength;
  }

  return { x, y };
}

function isCandidatePositionClear(entity, candidate, troopPositions, entitiesById, blockers, arena) {
  if (!arena.isPathable(candidate.x, candidate.y)) {
    return false;
  }

  for (const blocker of blockers) {
    if (blocker.id === entity.id) {
      continue;
    }

    if (overlapsEntityAt(candidate, entity.collision_radius ?? entity.radius ?? 0, blocker, blocker.collision_radius ?? blocker.radius ?? 0)) {
      return false;
    }
  }

  for (const [otherId, otherPosition] of troopPositions.entries()) {
    if (otherId === entity.id) {
      continue;
    }

    const other = entitiesById.get(otherId);
    if (!other || other.hp <= 0 || other.entity_type !== "troop") {
      continue;
    }

    if (overlapsEntityAt(candidate, entity.collision_radius ?? entity.radius ?? 0, otherPosition, other.collision_radius ?? other.radius ?? 0)) {
      return false;
    }
  }

  return true;
}

function compareObjectivePlans(entity, candidate, incumbent) {
  if (!incumbent) {
    return -1;
  }

  if (Math.abs(candidate.path.distance - incumbent.path.distance) > EPSILON) {
    return candidate.path.distance - incumbent.path.distance;
  }

  const preferredX = entity.preferred_lane_x ?? entity.x;
  const candidatePreference = Math.abs(candidate.objective.x - preferredX);
  const incumbentPreference = Math.abs(incumbent.objective.x - preferredX);
  if (Math.abs(candidatePreference - incumbentPreference) > EPSILON) {
    return candidatePreference - incumbentPreference;
  }

  return candidate.objective.id.localeCompare(incumbent.objective.id);
}

function getTowerObjectives(entity, entities) {
  const enemyTowers = entities.filter(
    (candidate) => candidate.hp > 0 && candidate.entity_type === "tower" && candidate.team !== entity.team,
  );
  const enemyCrownsDestroyed = entities.some(
    (candidate) =>
      candidate.entity_type === "tower" &&
      candidate.team !== entity.team &&
      candidate.tower_role === "crown" &&
      candidate.hp <= 0,
  );

  return enemyTowers.filter((tower) => {
    if (tower.tower_role === "crown") {
      return true;
    }
    return enemyCrownsDestroyed;
  });
}

function getNavigationCacheKey(entity, blockers) {
  const blockerSignature = blockers
    .map((blocker) => `${blocker.id}:${roundCoord(blocker.x)}:${roundCoord(blocker.y)}:${roundCoord(blocker.collision_radius ?? blocker.radius ?? 0)}`)
    .join("|");
  return `${roundCoord(entity.collision_radius ?? entity.radius ?? 0)}|${blockerSignature}`;
}

function getNavigationForTroop(entity, entities, arena, navigationCache) {
  const blockers = getGroundPathingBlockers(entities);
  const cacheKey = getNavigationCacheKey(entity, blockers);
  const cached = navigationCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const navigation = createGroundNavigation({ arena, entities, troop: entity });
  navigationCache.set(cacheKey, navigation);
  return navigation;
}

function chooseMovementPlan(entity, target, entities, arena, navigationCache) {
  const navigation = getNavigationForTroop(entity, entities, arena, navigationCache);

  if (target) {
    const targetPath = navigation.findPathToAttackRing(target);
    if (targetPath.reachable) {
      return {
        navigation,
        objective: target,
        objectiveAnchor: { x: target.x, y: target.y },
        path: targetPath,
      };
    }
  }

  const objectives = getTowerObjectives(entity, entities);
  let best = null;
  for (const objective of objectives) {
    const path = navigation.findPathToAttackRing(objective);
    if (!path.reachable) {
      continue;
    }

    const candidate = {
      navigation,
      objective,
      objectiveAnchor: { x: objective.x, y: objective.y },
      path,
    };
    if (compareObjectivePlans(entity, candidate, best) < 0) {
      best = candidate;
    }
  }

  return best;
}

function scoreMovementCandidate(entity, currentPosition, candidatePosition, baseDirection, objectiveAnchor) {
  const moveVector = normalizeVector(candidatePosition.x - currentPosition.x, candidatePosition.y - currentPosition.y);
  const progress = objectiveAnchor
    ? Math.hypot(objectiveAnchor.x - currentPosition.x, objectiveAnchor.y - currentPosition.y) -
      Math.hypot(objectiveAnchor.x - candidatePosition.x, objectiveAnchor.y - candidatePosition.y)
    : 0;
  const lanePreference = Math.abs(candidatePosition.x - (entity.preferred_lane_x ?? entity.x));
  return progress * 100 + dotProduct(moveVector, baseDirection) * 2 - lanePreference * 0.001;
}

function moveTroop(entity, target, arena, entities, troopPositions, entitiesById, navigationCache) {
  const speedPerTick = entity.move_speed / TICK_RATE;
  if (speedPerTick <= 0) {
    return;
  }

  const movementPlan = chooseMovementPlan(entity, target, entities, arena, navigationCache);
  const blockers = movementPlan?.navigation.blockers ?? getGroundPathingBlockers(entities);
  const currentPosition = troopPositions.get(entity.id) ?? { x: entity.x, y: entity.y };
  const objectiveAnchor = movementPlan?.path?.goal ?? movementPlan?.objectiveAnchor ?? {
    x: entity.preferred_lane_x ?? entity.x,
    y: entity.team === "blue" ? arena.minY : arena.maxY,
  };
  const waypoint = movementPlan?.path?.nextWaypoint ?? movementPlan?.objectiveAnchor ?? objectiveAnchor;
  const baseDirection = normalizeVector(waypoint.x - currentPosition.x, waypoint.y - currentPosition.y);
  const fallbackDirection =
    Math.hypot(baseDirection.x, baseDirection.y) > EPSILON
      ? baseDirection
      : normalizeVector(objectiveAnchor.x - currentPosition.x, objectiveAnchor.y - currentPosition.y);
  const separationVector = computeSeparationVector(entity, troopPositions, entitiesById);
  const steeringDirection = normalizeVector(
    fallbackDirection.x + separationVector.x * 1.35,
    fallbackDirection.y + separationVector.y * 1.35,
  );

  const directions = [];
  const baseCandidate = Math.hypot(steeringDirection.x, steeringDirection.y) > EPSILON ? steeringDirection : fallbackDirection;
  for (const angle of SIDE_STEP_ANGLES) {
    const direction = angle === 0 ? baseCandidate : rotateVector(baseCandidate, angle);
    if (Math.hypot(direction.x, direction.y) > EPSILON) {
      directions.push(direction);
    }
  }
  const pureSeparation = normalizeVector(separationVector.x, separationVector.y);
  if (Math.hypot(pureSeparation.x, pureSeparation.y) > EPSILON) {
    directions.push(pureSeparation);
  }

  let bestPosition = currentPosition;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const direction of directions) {
    for (const scale of MOVEMENT_STEP_SCALES) {
      const candidatePosition = resolvePositionAgainstStaticBlockers(
        {
          x: currentPosition.x + direction.x * speedPerTick * scale,
          y: currentPosition.y + direction.y * speedPerTick * scale,
        },
        entity,
        blockers,
        arena,
      );

      if (!isCandidatePositionClear(entity, candidatePosition, troopPositions, entitiesById, blockers, arena)) {
        continue;
      }

      const score = scoreMovementCandidate(entity, currentPosition, candidatePosition, fallbackDirection, objectiveAnchor);
      if (score > bestScore + EPSILON) {
        bestScore = score;
        bestPosition = candidatePosition;
      }
    }
  }

  troopPositions.set(entity.id, bestPosition);
  entity.x = roundCoord(bestPosition.x);
  entity.y = roundCoord(bestPosition.y);
}

function tickCooldown(entity) {
  if (entity.attack_cooldown_ticks_remaining > 0) {
    entity.attack_cooldown_ticks_remaining -= 1;
  }
}

export function resolveGroundUnitCollisions({ entities, arena, originalPositions = null }) {
  const troops = entities
    .filter((entity) => entity.entity_type === "troop" && entity.hp > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const blockers = getGroundPathingBlockers(entities);

  for (let pass = 0; pass < MAX_COLLISION_PASSES; pass += 1) {
    let changed = false;

    for (const troop of troops) {
      const resolved = resolvePositionAgainstStaticBlockers(troop, troop, blockers, arena);
      if (Math.abs(resolved.x - troop.x) > EPSILON || Math.abs(resolved.y - troop.y) > EPSILON) {
        troop.x = roundCoord(resolved.x);
        troop.y = roundCoord(resolved.y);
        changed = true;
      }
    }

    for (let i = 0; i < troops.length; i += 1) {
      for (let j = i + 1; j < troops.length; j += 1) {
        const a = troops[i];
        const b = troops[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.hypot(dx, dy);
        const minDistance = (a.collision_radius ?? a.radius ?? 0) + (b.collision_radius ?? b.radius ?? 0);
        if (distance >= minDistance - EPSILON) {
          continue;
        }

        const direction = distance > EPSILON ? { x: dx / distance, y: dy / distance } : getStableCollisionNormal(a, b);
        const overlap = minDistance - distance + 0.01;
        const inverseMassA = 1 / Math.max(0.2, a.body_mass ?? 1);
        const inverseMassB = 1 / Math.max(0.2, b.body_mass ?? 1);
        const totalInverseMass = inverseMassA + inverseMassB;
        const moveA = overlap * (inverseMassA / totalInverseMass);
        const moveB = overlap * (inverseMassB / totalInverseMass);

        const nextA = resolvePositionAgainstStaticBlockers(
          {
            x: a.x + direction.x * moveA,
            y: a.y + direction.y * moveA,
          },
          a,
          blockers,
          arena,
        );
        const nextB = resolvePositionAgainstStaticBlockers(
          {
            x: b.x - direction.x * moveB,
            y: b.y - direction.y * moveB,
          },
          b,
          blockers,
          arena,
        );

        a.x = roundCoord(nextA.x);
        a.y = roundCoord(nextA.y);
        b.x = roundCoord(nextB.x);
        b.y = roundCoord(nextB.y);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  if (originalPositions) {
    for (const troop of troops) {
      const original = originalPositions.get(troop.id);
      if (!original) {
        continue;
      }

      troop.velocity = {
        x: roundCoord(troop.x - original.x),
        y: roundCoord(troop.y - original.y),
      };
    }
  }
}

export function stepCombat({ entities, arena }) {
  const ordered = [...entities].sort((a, b) => a.id.localeCompare(b.id));
  const attackEvents = [];
  const navigationCache = new Map();
  const originalPositions = new Map(
    ordered
      .filter((entity) => entity.entity_type === "troop" && entity.hp > 0)
      .map((entity) => [entity.id, { x: entity.x, y: entity.y }]),
  );
  const troopPositions = new Map(
    ordered
      .filter((entity) => entity.entity_type === "troop" && entity.hp > 0)
      .map((entity) => [entity.id, { x: entity.x, y: entity.y }]),
  );
  const entitiesById = new Map(ordered.map((entity) => [entity.id, entity]));

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
        moveTroop(entity, null, arena, ordered, troopPositions, entitiesById, navigationCache);
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
      moveTroop(entity, target, arena, ordered, troopPositions, entitiesById, navigationCache);
    } else {
      entity.velocity = { x: 0, y: 0 };
    }
  }

  resolveGroundUnitCollisions({ entities: ordered, arena, originalPositions });
  return attackEvents;
}
