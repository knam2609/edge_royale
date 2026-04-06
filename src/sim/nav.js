const EPSILON = 1e-9;
const NAV_GRID_STEP = 0.5;
const LINE_OF_SIGHT_STEP = 0.25;

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

function buildOffsetCandidates(radius, step) {
  const points = [];
  for (let dx = -radius; dx <= radius + EPSILON; dx += step) {
    for (let dy = -radius; dy <= radius + EPSILON; dy += step) {
      points.push({
        dx: roundCoord(dx),
        dy: roundCoord(dy),
      });
    }
  }

  points.sort((a, b) => {
    const distA = a.dx * a.dx + a.dy * a.dy;
    const distB = b.dx * b.dx + b.dy * b.dy;
    if (distA !== distB) {
      return distA - distB;
    }
    if (a.dx !== b.dx) {
      return a.dx - b.dx;
    }
    return a.dy - b.dy;
  });

  return points;
}

const CLAMP_OFFSET_CANDIDATES = buildOffsetCandidates(1.5, 0.05);
const NAV_OFFSET_CANDIDATES = buildOffsetCandidates(3, NAV_GRID_STEP);
const NAV_NEIGHBOR_OFFSETS = Object.freeze([
  Object.freeze({ dx: 0, dy: -NAV_GRID_STEP, cost: 1 }),
  Object.freeze({ dx: NAV_GRID_STEP, dy: 0, cost: 1 }),
  Object.freeze({ dx: 0, dy: NAV_GRID_STEP, cost: 1 }),
  Object.freeze({ dx: -NAV_GRID_STEP, dy: 0, cost: 1 }),
  Object.freeze({ dx: NAV_GRID_STEP, dy: -NAV_GRID_STEP, cost: Math.SQRT2 }),
  Object.freeze({ dx: NAV_GRID_STEP, dy: NAV_GRID_STEP, cost: Math.SQRT2 }),
  Object.freeze({ dx: -NAV_GRID_STEP, dy: NAV_GRID_STEP, cost: Math.SQRT2 }),
  Object.freeze({ dx: -NAV_GRID_STEP, dy: -NAV_GRID_STEP, cost: Math.SQRT2 }),
]);

function makeNodeKey(position) {
  return `${roundCoord(position.x)},${roundCoord(position.y)}`;
}

function isPointWithinRect(point, rect) {
  return point.x >= rect.minX - EPSILON
    && point.x <= rect.maxX + EPSILON
    && point.y >= rect.minY - EPSILON
    && point.y <= rect.maxY + EPSILON;
}

function getClosestPointOnRect(point, rect) {
  return {
    x: roundCoord(clamp(point.x, rect.minX, rect.maxX)),
    y: roundCoord(clamp(point.y, rect.minY, rect.maxY)),
  };
}

function getCircleSamples(clearance) {
  if (clearance <= EPSILON) {
    return [{ x: 0, y: 0 }];
  }

  return [
    { x: 0, y: 0 },
    { x: clearance, y: 0 },
    { x: -clearance, y: 0 },
    { x: 0, y: clearance },
    { x: 0, y: -clearance },
    { x: clearance * 0.7071, y: clearance * 0.7071 },
    { x: clearance * 0.7071, y: -clearance * 0.7071 },
    { x: -clearance * 0.7071, y: clearance * 0.7071 },
    { x: -clearance * 0.7071, y: -clearance * 0.7071 },
  ];
}

function isPointPathableWithClearance(point, arena, clearance) {
  if (
    point.x < arena.minX + clearance - EPSILON
    || point.x > arena.maxX - clearance + EPSILON
    || point.y < arena.minY + clearance - EPSILON
    || point.y > arena.maxY - clearance + EPSILON
  ) {
    return false;
  }

  const samples = getCircleSamples(clearance);
  return samples.every((offset) => arena.isPathable(point.x + offset.x, point.y + offset.y));
}

function intersectsCircleRect(point, clearance, rect) {
  const closest = getClosestPointOnRect(point, rect);
  return squaredDistance(point, closest) < clearance * clearance - EPSILON;
}

function getLiveTowerBlockers(entities = []) {
  return entities
    .filter((entity) => entity.entity_type === "tower" && entity.hp > 0 && entity.ground_blocker)
    .map((entity) => ({
      entity_id: entity.id,
      ...entity.ground_blocker,
    }));
}

function getBlockersContainingPoint(blockers, point) {
  return blockers
    .filter((blocker) => isPointWithinRect(point, blocker))
    .map((blocker) => blocker.entity_id);
}

function shouldIgnoreBlocker(blocker, ignoredIds) {
  return ignoredIds.includes(blocker.entity_id);
}

function getHeuristic(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function expandRect(rect, clearance) {
  return {
    minX: rect.minX - clearance,
    maxX: rect.maxX + clearance,
    minY: rect.minY - clearance,
    maxY: rect.maxY + clearance,
  };
}

function segmentIntersectsRect(start, goal, rect) {
  let tMin = 0;
  let tMax = 1;
  const dx = goal.x - start.x;
  const dy = goal.y - start.y;

  const clipAxis = (p, q) => {
    if (Math.abs(p) <= EPSILON) {
      return q >= 0;
    }

    const ratio = q / p;
    if (p < 0) {
      if (ratio > tMax) {
        return false;
      }
      if (ratio > tMin) {
        tMin = ratio;
      }
      return true;
    }

    if (ratio < tMin) {
      return false;
    }
    if (ratio < tMax) {
      tMax = ratio;
    }
    return true;
  };

  return clipAxis(-dx, start.x - rect.minX)
    && clipAxis(dx, rect.maxX - start.x)
    && clipAxis(-dy, start.y - rect.minY)
    && clipAxis(dy, rect.maxY - start.y)
    && tMin <= tMax + EPSILON;
}

export function getTroopCollisionRadius(entity) {
  return entity.collision_radius ?? entity.radius ?? 0;
}

export function getTroopBodyMass(entity) {
  return entity.body_mass ?? 1;
}

export function getTowerBlocker(entity) {
  if (entity.entity_type !== "tower") {
    return null;
  }

  const footprint = entity.ground_blocker;
  if (!footprint) {
    return null;
  }

  return {
    entity_id: entity.id,
    ...footprint,
  };
}

export function getEntitySurfaceDistance(source, target) {
  if (target.entity_type === "tower" && target.ground_blocker) {
    const closest = getClosestPointOnRect(source, target.ground_blocker);
    return Math.hypot(source.x - closest.x, source.y - closest.y);
  }

  const radius = getTroopCollisionRadius(target);
  return Math.max(0, Math.hypot(source.x - target.x, source.y - target.y) - radius);
}

export function getClosestPointOnEntity(source, target) {
  if (target.entity_type === "tower" && target.ground_blocker) {
    return getClosestPointOnRect(source, target.ground_blocker);
  }

  const radius = getTroopCollisionRadius(target);
  const direction = normalizeVector(source.x - target.x, source.y - target.y);
  if (Math.abs(direction.x) <= EPSILON && Math.abs(direction.y) <= EPSILON) {
    return { x: target.x, y: target.y };
  }

  return {
    x: roundCoord(target.x + direction.x * radius),
    y: roundCoord(target.y + direction.y * radius),
  };
}

export function getEntityApproachGoal(source, target, extraDistance = 0) {
  if (target.entity_type === "tower" && target.ground_blocker) {
    const expanded = {
      minX: target.ground_blocker.minX - extraDistance,
      maxX: target.ground_blocker.maxX + extraDistance,
      minY: target.ground_blocker.minY - extraDistance,
      maxY: target.ground_blocker.maxY + extraDistance,
    };
    return getClosestPointOnRect(source, expanded);
  }

  const radius = getTroopCollisionRadius(target) + extraDistance;
  const direction = normalizeVector(source.x - target.x, source.y - target.y);
  if (Math.abs(direction.x) <= EPSILON && Math.abs(direction.y) <= EPSILON) {
    return { x: target.x, y: target.y };
  }

  return {
    x: roundCoord(target.x + direction.x * radius),
    y: roundCoord(target.y + direction.y * radius),
  };
}

export function isGroundPositionPathable({
  position,
  arena,
  entities = [],
  clearance = 0,
  ignoredBlockerIds = [],
}) {
  if (!isPointPathableWithClearance(position, arena, clearance)) {
    return false;
  }

  const blockers = getLiveTowerBlockers(entities);
  for (const blocker of blockers) {
    if (shouldIgnoreBlocker(blocker, ignoredBlockerIds)) {
      continue;
    }

    if (intersectsCircleRect(position, clearance, blocker)) {
      return false;
    }
  }

  return true;
}

export function clampGroundPosition({
  position,
  arena,
  entities = [],
  clearance = 0,
  ignoredBlockerIds = [],
}) {
  const bounded = {
    x: roundCoord(clamp(position.x, arena.minX + clearance, arena.maxX - clearance)),
    y: roundCoord(clamp(position.y, arena.minY + clearance, arena.maxY - clearance)),
  };

  if (isGroundPositionPathable({ position: bounded, arena, entities, clearance, ignoredBlockerIds })) {
    return bounded;
  }

  for (const offset of CLAMP_OFFSET_CANDIDATES) {
    const candidate = {
      x: roundCoord(clamp(bounded.x + offset.dx, arena.minX + clearance, arena.maxX - clearance)),
      y: roundCoord(clamp(bounded.y + offset.dy, arena.minY + clearance, arena.maxY - clearance)),
    };

    if (isGroundPositionPathable({ position: candidate, arena, entities, clearance, ignoredBlockerIds })) {
      return candidate;
    }
  }

  return bounded;
}

function snapNavCoord(value, min, max) {
  return roundCoord(clamp(Math.round(value / NAV_GRID_STEP) * NAV_GRID_STEP, min, max));
}

function snapToNavGrid(position, arena, clearance) {
  return {
    x: snapNavCoord(position.x, arena.minX + clearance, arena.maxX - clearance),
    y: snapNavCoord(position.y, arena.minY + clearance, arena.maxY - clearance),
  };
}

function findNearestGroundNode({ position, arena, entities, clearance, ignoredBlockerIds }) {
  const snapped = snapToNavGrid(position, arena, clearance);

  if (isGroundPositionPathable({ position: snapped, arena, entities, clearance, ignoredBlockerIds })) {
    return snapped;
  }

  for (const offset of NAV_OFFSET_CANDIDATES) {
    const candidate = {
      x: snapNavCoord(snapped.x + offset.dx, arena.minX + clearance, arena.maxX - clearance),
      y: snapNavCoord(snapped.y + offset.dy, arena.minY + clearance, arena.maxY - clearance),
    };
    if (isGroundPositionPathable({ position: candidate, arena, entities, clearance, ignoredBlockerIds })) {
      return candidate;
    }
  }

  return null;
}

function hasClearStraightPath({ start, goal, arena, entities, clearance, ignoredBlockerIds }) {
  const blockers = getLiveTowerBlockers(entities);
  const directIgnoredBlockerIds = [
    ...ignoredBlockerIds,
    ...getBlockersContainingPoint(blockers, goal),
  ];

  if (arena.pathability_mode === "default" && !arena.river) {
    for (const blocker of blockers) {
      if (shouldIgnoreBlocker(blocker, directIgnoredBlockerIds)) {
        continue;
      }
      if (segmentIntersectsRect(start, goal, expandRect(blocker, clearance))) {
        return false;
      }
    }

    return isGroundPositionPathable({
      position: goal,
      arena,
      entities,
      clearance,
      ignoredBlockerIds: directIgnoredBlockerIds,
    });
  }

  const distance = Math.hypot(goal.x - start.x, goal.y - start.y);
  if (distance <= EPSILON) {
    return true;
  }

  const steps = Math.max(1, Math.ceil(distance / LINE_OF_SIGHT_STEP));
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    const sample = {
      x: roundCoord(start.x + (goal.x - start.x) * ratio),
      y: roundCoord(start.y + (goal.y - start.y) * ratio),
    };
    if (!isGroundPositionPathable({
      position: sample,
      arena,
      entities,
      clearance,
      ignoredBlockerIds: directIgnoredBlockerIds,
    })) {
      return false;
    }
  }

  return true;
}

function getNeighborNodes({ node, arena, entities, clearance, ignoredBlockerIds }) {
  const neighbors = [];

  for (const offset of NAV_NEIGHBOR_OFFSETS) {
    const candidate = {
      x: roundCoord(node.x + offset.dx),
      y: roundCoord(node.y + offset.dy),
    };

    if (!isGroundPositionPathable({ position: candidate, arena, entities, clearance, ignoredBlockerIds })) {
      continue;
    }

    if (Math.abs(offset.dx) > EPSILON && Math.abs(offset.dy) > EPSILON) {
      const horizontal = { x: roundCoord(node.x + offset.dx), y: node.y };
      const vertical = { x: node.x, y: roundCoord(node.y + offset.dy) };
      if (
        !isGroundPositionPathable({ position: horizontal, arena, entities, clearance, ignoredBlockerIds })
        || !isGroundPositionPathable({ position: vertical, arena, entities, clearance, ignoredBlockerIds })
      ) {
        continue;
      }
    }

    neighbors.push({
      position: candidate,
      cost: offset.cost,
    });
  }

  return neighbors;
}

function reconstructPath(cameFrom, currentKey) {
  const path = [];
  let key = currentKey;
  while (key) {
    const node = cameFrom.get(key);
    if (!node) {
      break;
    }
    path.push(node.position);
    key = node.parentKey;
  }

  return path.reverse();
}

export function getNextGroundWaypoint({
  start,
  goal,
  arena,
  entities = [],
  clearance = 0,
  ignoredBlockerIds = [],
}) {
  if (hasClearStraightPath({ start, goal, arena, entities, clearance, ignoredBlockerIds })) {
    return goal;
  }

  const startNode = findNearestGroundNode({ position: start, arena, entities, clearance, ignoredBlockerIds });
  const goalNode = findNearestGroundNode({ position: goal, arena, entities, clearance, ignoredBlockerIds });

  if (!startNode || !goalNode) {
    return clampGroundPosition({ position: goal, arena, entities, clearance, ignoredBlockerIds });
  }

  const open = [{
    key: makeNodeKey(startNode),
    position: startNode,
    g: 0,
    f: getHeuristic(startNode, goalNode),
  }];
  const cameFrom = new Map([[open[0].key, { position: startNode, parentKey: null }]]);
  const bestScores = new Map([[open[0].key, 0]]);
  const visited = new Set();
  const goalKey = makeNodeKey(goalNode);

  while (open.length > 0) {
    open.sort((a, b) => {
      if (Math.abs(a.f - b.f) > EPSILON) {
        return a.f - b.f;
      }
      if (Math.abs(a.g - b.g) > EPSILON) {
        return a.g - b.g;
      }
      if (a.position.y !== b.position.y) {
        return a.position.y - b.position.y;
      }
      return a.position.x - b.position.x;
    });

    const current = open.shift();
    if (!current || visited.has(current.key)) {
      continue;
    }

    if (current.key === goalKey) {
      const path = reconstructPath(cameFrom, current.key);
      if (path.length <= 1) {
        return goalNode;
      }

      let waypoint = path[1];
      for (let index = 1; index < path.length; index += 1) {
        if (!hasClearStraightPath({ start, goal: path[index], arena, entities, clearance, ignoredBlockerIds })) {
          break;
        }
        waypoint = path[index];
      }
      return waypoint;
    }

    visited.add(current.key);

    for (const neighbor of getNeighborNodes({
      node: current.position,
      arena,
      entities,
      clearance,
      ignoredBlockerIds,
    })) {
      const key = makeNodeKey(neighbor.position);
      const tentativeG = current.g + neighbor.cost;
      if (tentativeG + EPSILON >= (bestScores.get(key) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      bestScores.set(key, tentativeG);
      cameFrom.set(key, {
        position: neighbor.position,
        parentKey: current.key,
      });
      open.push({
        key,
        position: neighbor.position,
        g: tentativeG,
        f: tentativeG + getHeuristic(neighbor.position, goalNode),
      });
    }
  }

  return clampGroundPosition({ position: goal, arena, entities, clearance, ignoredBlockerIds });
}

export function getIgnoredBlockerIdsForEntity(entity, entities = []) {
  const blockers = getLiveTowerBlockers(entities);
  return getBlockersContainingPoint(blockers, entity);
}
