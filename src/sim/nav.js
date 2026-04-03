const NAV_STEP = 0.5;
const EPSILON = 1e-9;
const DIAGONAL_COST = Math.SQRT2 * NAV_STEP;
const NEIGHBOR_DELTAS = Object.freeze([
  Object.freeze({ dx: -1, dy: 0, cost: NAV_STEP }),
  Object.freeze({ dx: 1, dy: 0, cost: NAV_STEP }),
  Object.freeze({ dx: 0, dy: -1, cost: NAV_STEP }),
  Object.freeze({ dx: 0, dy: 1, cost: NAV_STEP }),
  Object.freeze({ dx: -1, dy: -1, cost: DIAGONAL_COST }),
  Object.freeze({ dx: 1, dy: -1, cost: DIAGONAL_COST }),
  Object.freeze({ dx: -1, dy: 1, cost: DIAGONAL_COST }),
  Object.freeze({ dx: 1, dy: 1, cost: DIAGONAL_COST }),
]);

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function buildAxis(min, max, step) {
  const values = [];
  for (let value = min; value <= max + EPSILON; value += step) {
    values.push(roundCoord(value));
  }
  return values;
}

function comparePositionsByPreference(a, b, preferredLaneX) {
  const preferenceA = Math.abs(a.x - preferredLaneX);
  const preferenceB = Math.abs(b.x - preferredLaneX);
  if (Math.abs(preferenceA - preferenceB) > EPSILON) {
    return preferenceA - preferenceB;
  }
  if (Math.abs(a.y - b.y) > EPSILON) {
    return a.y - b.y;
  }
  return a.x - b.x;
}

function packIndex(ix, iy, width) {
  return iy * width + ix;
}

function unpackIndex(index, width) {
  return {
    ix: index % width,
    iy: Math.floor(index / width),
  };
}

function getPositionForIndex(index, width, xAxis, yAxis) {
  const { ix, iy } = unpackIndex(index, width);
  return {
    x: xAxis[ix],
    y: yAxis[iy],
  };
}

function getBlockRadius(blocker, troop) {
  return (blocker.collision_radius ?? blocker.radius ?? 0) + (troop.collision_radius ?? troop.radius ?? 0);
}

export function getGroundPathingBlockers(entities) {
  return entities.filter(
    (entity) => entity.hp > 0 && entity.blocks_ground_pathing === true && Number.isFinite(entity.x) && Number.isFinite(entity.y),
  );
}

export function createGroundNavigation({ arena, entities, troop }) {
  const xAxis = buildAxis(arena.minX, arena.maxX, NAV_STEP);
  const yAxis = buildAxis(arena.minY, arena.maxY, NAV_STEP);
  const width = xAxis.length;
  const height = yAxis.length;
  const blockers = getGroundPathingBlockers(entities);
  const walkable = new Array(width * height).fill(false);

  for (let iy = 0; iy < height; iy += 1) {
    for (let ix = 0; ix < width; ix += 1) {
      const x = xAxis[ix];
      const y = yAxis[iy];
      const index = packIndex(ix, iy, width);
      if (!arena.isPathable(x, y)) {
        continue;
      }

      let blocked = false;
      for (const blocker of blockers) {
        const blockRadius = getBlockRadius(blocker, troop) - 0.02;
        if (blockRadius > 0 && squaredDistance({ x, y }, blocker) < blockRadius * blockRadius) {
          blocked = true;
          break;
        }
      }

      walkable[index] = !blocked;
    }
  }

  function isWalkable(x, y) {
    if (!arena.isPathable(x, y)) {
      return false;
    }

    for (const blocker of blockers) {
      const blockRadius = getBlockRadius(blocker, troop) - 0.02;
      if (blockRadius > 0 && squaredDistance({ x, y }, blocker) < blockRadius * blockRadius) {
        return false;
      }
    }

    return true;
  }

  function findNearestWalkableIndex(position) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < walkable.length; index += 1) {
      if (!walkable[index]) {
        continue;
      }

      const candidate = getPositionForIndex(index, width, xAxis, yAxis);
      const candidateDistance = squaredDistance(position, candidate);
      if (candidateDistance + EPSILON < bestDistance) {
        bestDistance = candidateDistance;
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  function collectGoalIndices(target, attackReach) {
    const goalIndices = [];
    const maxReach = attackReach + (target.radius ?? 0);
    const maxReachSquared = maxReach * maxReach;

    for (let index = 0; index < walkable.length; index += 1) {
      if (!walkable[index]) {
        continue;
      }

      const candidate = getPositionForIndex(index, width, xAxis, yAxis);
      if (squaredDistance(candidate, target) <= maxReachSquared + EPSILON) {
        goalIndices.push(index);
      }
    }

    return goalIndices;
  }

  function heuristic(index, target, attackReach) {
    const candidate = getPositionForIndex(index, width, xAxis, yAxis);
    return Math.max(0, distance(candidate, target) - (attackReach + (target.radius ?? 0)));
  }

  function compareIndices(a, b, gScore, preferredLaneX, target, attackReach) {
    const fA = gScore[a] + heuristic(a, target, attackReach);
    const fB = gScore[b] + heuristic(b, target, attackReach);
    if (Math.abs(fA - fB) > EPSILON) {
      return fA - fB;
    }

    const positionA = getPositionForIndex(a, width, xAxis, yAxis);
    const positionB = getPositionForIndex(b, width, xAxis, yAxis);
    const preferenceA = Math.abs(positionA.x - preferredLaneX);
    const preferenceB = Math.abs(positionB.x - preferredLaneX);
    if (Math.abs(preferenceA - preferenceB) > EPSILON) {
      return preferenceA - preferenceB;
    }

    const hA = heuristic(a, target, attackReach);
    const hB = heuristic(b, target, attackReach);
    if (Math.abs(hA - hB) > EPSILON) {
      return hA - hB;
    }

    return a - b;
  }

  function getNeighborIndices(index, preferredLaneX, target, attackReach) {
    const { ix, iy } = unpackIndex(index, width);
    const neighbors = [];

    for (const delta of NEIGHBOR_DELTAS) {
      const nextIx = ix + delta.dx;
      const nextIy = iy + delta.dy;
      if (nextIx < 0 || nextIx >= width || nextIy < 0 || nextIy >= height) {
        continue;
      }

      const nextIndex = packIndex(nextIx, nextIy, width);
      if (!walkable[nextIndex]) {
        continue;
      }

      if (Math.abs(delta.dx) === 1 && Math.abs(delta.dy) === 1) {
        const sideA = packIndex(ix + delta.dx, iy, width);
        const sideB = packIndex(ix, iy + delta.dy, width);
        if (!walkable[sideA] || !walkable[sideB]) {
          continue;
        }
      }

      neighbors.push({ index: nextIndex, cost: delta.cost });
    }

    neighbors.sort((a, b) => {
      const positionA = getPositionForIndex(a.index, width, xAxis, yAxis);
      const positionB = getPositionForIndex(b.index, width, xAxis, yAxis);
      const preference = comparePositionsByPreference(positionA, positionB, preferredLaneX);
      if (preference !== 0) {
        return preference;
      }
      if (Math.abs(a.cost - b.cost) > EPSILON) {
        return a.cost - b.cost;
      }
      return compareIndices(a.index, b.index, new Array(walkable.length).fill(0), preferredLaneX, target, attackReach);
    });
    return neighbors;
  }

  function buildPathResult(goalIndex, startIndex, cameFrom, gScore, target) {
    const path = [];
    let index = goalIndex;
    while (index !== -1) {
      path.push(index);
      if (index === startIndex) {
        break;
      }
      index = cameFrom[index];
    }
    path.reverse();

    const nextIndex = path[1] ?? goalIndex;
    return {
      reachable: true,
      distance: gScore[goalIndex],
      goal: getPositionForIndex(goalIndex, width, xAxis, yAxis),
      nextWaypoint: getPositionForIndex(nextIndex, width, xAxis, yAxis),
      target: { x: target.x, y: target.y },
    };
  }

  function findPathToAttackRing(target, preferredLaneX = troop.preferred_lane_x ?? troop.x) {
    const startIndex = findNearestWalkableIndex(troop);
    if (startIndex === -1) {
      return { reachable: false, distance: Number.POSITIVE_INFINITY, goal: null, nextWaypoint: null };
    }

    const goalIndices = collectGoalIndices(target, troop.attack_range ?? 0);
    if (goalIndices.length === 0) {
      return { reachable: false, distance: Number.POSITIVE_INFINITY, goal: null, nextWaypoint: null };
    }

    const goalSet = new Set(goalIndices);
    const totalNodes = walkable.length;
    const open = [startIndex];
    const openSet = new Set([startIndex]);
    const cameFrom = new Array(totalNodes).fill(-1);
    const gScore = new Array(totalNodes).fill(Number.POSITIVE_INFINITY);
    gScore[startIndex] = 0;

    while (open.length > 0) {
      open.sort((a, b) => compareIndices(a, b, gScore, preferredLaneX, target, troop.attack_range ?? 0));
      const current = open.shift();
      openSet.delete(current);

      if (goalSet.has(current)) {
        return buildPathResult(current, startIndex, cameFrom, gScore, target);
      }

      for (const neighbor of getNeighborIndices(current, preferredLaneX, target, troop.attack_range ?? 0)) {
        const tentative = gScore[current] + neighbor.cost;
        if (tentative + EPSILON < gScore[neighbor.index]) {
          cameFrom[neighbor.index] = current;
          gScore[neighbor.index] = tentative;
          if (!openSet.has(neighbor.index)) {
            open.push(neighbor.index);
            openSet.add(neighbor.index);
          }
        }
      }
    }

    return { reachable: false, distance: Number.POSITIVE_INFINITY, goal: null, nextWaypoint: null };
  }

  function getDistanceToAttackRing(target, preferredLaneX = troop.preferred_lane_x ?? troop.x) {
    return findPathToAttackRing(target, preferredLaneX).distance;
  }

  return {
    step: NAV_STEP,
    blockers,
    isWalkable,
    getDistanceToAttackRing,
    findPathToAttackRing,
  };
}
