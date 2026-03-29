import { getArenaMidY, snapPositionToGrid } from "./map.js";

const POSITION_EPSILON = 1e-9;
const TROOP_BACK_OFFSET = Object.freeze({
  own: 9,
  pocket: 5,
});

function getEnemyActor(actor) {
  return actor === "blue" ? "red" : "blue";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundPlacement(value) {
  return Math.round(value * 100) / 100;
}

function getSharedBoundaryX(arena) {
  return snapPositionToGrid({ x: (arena.minX + arena.maxX) * 0.5, y: getArenaMidY(arena) }, arena).x;
}

function getFirstLandRowBeyondRiver(arena, actor, side) {
  if (!arena.river) {
    return null;
  }

  if (actor === "blue") {
    const y = side === "enemy" ? arena.river.minY - 1 : arena.river.maxY + 1;
    return snapPositionToGrid({ x: arena.minX, y }, arena).y;
  }

  const y = side === "enemy" ? arena.river.maxY + 1 : arena.river.minY - 1;
  return snapPositionToGrid({ x: arena.minX, y }, arena).y;
}

function getEnemyCrownTowers(entities, actor) {
  const enemy = getEnemyActor(actor);
  return entities.filter(
    (entity) => entity.entity_type === "tower" && entity.team === enemy && entity.tower_role === "crown",
  );
}

function buildOwnSideRegion(arena, actor) {
  if (!arena.river) {
    const midY = getArenaMidY(arena);
    if (actor === "blue") {
      return { kind: "own", minX: arena.minX, maxX: arena.maxX, minY: midY, maxY: arena.maxY };
    }
    return { kind: "own", minX: arena.minX, maxX: arena.maxX, minY: arena.minY, maxY: midY };
  }

  const ownFrontY = getFirstLandRowBeyondRiver(arena, actor, "own");
  if (actor === "blue") {
    return { kind: "own", minX: arena.minX, maxX: arena.maxX, minY: ownFrontY, maxY: arena.maxY };
  }
  return { kind: "own", minX: arena.minX, maxX: arena.maxX, minY: arena.minY, maxY: ownFrontY };
}

function buildPocketRegions(arena, entities, actor) {
  if (!arena.river) {
    return [];
  }

  const enemyCrowns = getEnemyCrownTowers(entities, actor);
  if (enemyCrowns.length === 0) {
    return [];
  }

  const destroyedCrowns = enemyCrowns.filter((tower) => tower.hp <= 0);
  if (destroyedCrowns.length === 0) {
    return [];
  }

  const pocketRiverY = getFirstLandRowBeyondRiver(arena, actor, "enemy");
  const crownYs = enemyCrowns.map((tower) => tower.y);
  const sharedBoundaryX = getSharedBoundaryX(arena);
  const verticalBounds =
    actor === "blue"
      ? {
          minY: Math.min(...crownYs),
          maxY: pocketRiverY,
        }
      : {
          minY: pocketRiverY,
          maxY: Math.max(...crownYs),
        };

  const leftDestroyed = destroyedCrowns.some((tower) => tower.x < sharedBoundaryX - POSITION_EPSILON);
  const rightDestroyed = destroyedCrowns.some((tower) => tower.x > sharedBoundaryX + POSITION_EPSILON);

  if (leftDestroyed && rightDestroyed) {
    return [{ kind: "pocket", lane: "full", minX: arena.minX, maxX: arena.maxX, ...verticalBounds }];
  }

  const pockets = [];
  if (leftDestroyed) {
    pockets.push({ kind: "pocket", lane: "left", minX: arena.minX, maxX: sharedBoundaryX, ...verticalBounds });
  }
  if (rightDestroyed) {
    pockets.push({ kind: "pocket", lane: "right", minX: sharedBoundaryX, maxX: arena.maxX, ...verticalBounds });
  }
  return pockets;
}

function isWithinRegion(position, region) {
  return (
    position.x >= region.minX - POSITION_EPSILON &&
    position.x <= region.maxX + POSITION_EPSILON &&
    position.y >= region.minY - POSITION_EPSILON &&
    position.y <= region.maxY + POSITION_EPSILON
  );
}

function isOnOwnSideWithoutRiver(arena, actor, position) {
  const midY = getArenaMidY(arena);
  return actor === "blue" ? position.y > midY + POSITION_EPSILON : position.y < midY - POSITION_EPSILON;
}

export function getTroopDeployRegions({ arena, entities = [], actor = "blue" }) {
  return [buildOwnSideRegion(arena, actor), ...buildPocketRegions(arena, entities, actor)];
}

export function getTroopPlacementStatus({ arena, entities = [], actor = "blue", position }) {
  const snappedPosition = snapPositionToGrid(position, arena);
  if (!arena.isPathable(snappedPosition.x, snappedPosition.y)) {
    return { ok: false, reason: "Troops need a land tile.", position: snappedPosition };
  }

  if (!arena.river) {
    const ok = isOnOwnSideWithoutRiver(arena, actor, snappedPosition);
    return {
      ok,
      reason: ok ? null : "Troops must be played on your side.",
      position: snappedPosition,
    };
  }

  const regions = getTroopDeployRegions({ arena, entities, actor });
  const ok = regions.some((region) => isWithinRegion(snappedPosition, region));
  if (ok) {
    return { ok: true, reason: null, position: snappedPosition };
  }

  const hasPocket = regions.some((region) => region.kind === "pocket");
  return {
    ok: false,
    reason: hasPocket ? "Troops must be played on your side or in an unlocked pocket." : "Troops must be played on your side.",
    position: snappedPosition,
  };
}

function getCandidateRowsForRegion(region, arena) {
  const isNorthRegion = (region.minY + region.maxY) * 0.5 < getArenaMidY(arena);
  const maxDepth = Math.max(1, region.maxY - region.minY - 1);
  const deepOffset = Math.min(TROOP_BACK_OFFSET[region.kind] ?? TROOP_BACK_OFFSET.own, maxDepth);
  const offsets = [...new Set([1, deepOffset])];

  return offsets.map((offset) => {
    const y = isNorthRegion ? region.maxY - offset : region.minY + offset;
    return roundPlacement(clamp(y, region.minY, region.maxY));
  });
}

export function buildTroopPlacementCandidates({ arena, entities = [], actor = "blue" }) {
  if (!arena.river) {
    const midY = getArenaMidY(arena);
    const frontY = actor === "blue" ? midY + 2.5 : midY - 2.5;
    const backY = actor === "blue" ? arena.maxY - 5.5 : arena.minY + 5.5;
    const centerX = (arena.minX + arena.maxX) * 0.5;
    const laneXs = arena.bridges?.length ? arena.bridges.map((bridge) => bridge.x) : [centerX - 4, centerX, centerX + 4];
    const positions = [
      { x: laneXs[0] ?? centerX - 4, y: frontY },
      { x: centerX, y: frontY },
      { x: laneXs[1] ?? centerX + 4, y: frontY },
      { x: laneXs[0] ?? centerX - 4, y: backY },
      { x: centerX, y: backY },
      { x: laneXs[1] ?? centerX + 4, y: backY },
    ];

    return positions.map((position) => {
      const snapped = snapPositionToGrid(position, arena);
      return { x: roundPlacement(snapped.x), y: roundPlacement(snapped.y) };
    });
  }

  const regions = getTroopDeployRegions({ arena, entities, actor });
  const centerX = getSharedBoundaryX(arena);
  const laneXs = arena.bridges?.length
    ? arena.bridges.map((bridge) => bridge.x)
    : [((arena.minX + arena.maxX) * 0.5) - 4, centerX, ((arena.minX + arena.maxX) * 0.5) + 4];
  const candidateXs = [...new Set([...laneXs, centerX].map((value) => roundPlacement(value)))];
  const placements = [];
  const seen = new Set();

  for (const region of regions) {
    const xOptions = candidateXs.filter(
      (value) => value >= region.minX - POSITION_EPSILON && value <= region.maxX + POSITION_EPSILON,
    );
    const rows = getCandidateRowsForRegion(region, arena);
    for (const x of xOptions) {
      for (const y of rows) {
        const status = getTroopPlacementStatus({ arena, entities, actor, position: { x, y } });
        if (!status.ok) {
          continue;
        }
        const key = `${status.position.x.toFixed(2)}|${status.position.y.toFixed(2)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        placements.push({ x: roundPlacement(status.position.x), y: roundPlacement(status.position.y) });
      }
    }
  }

  return placements;
}
