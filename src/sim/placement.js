import { getArenaMidY, snapPositionToGrid } from "./map.js";

const POSITION_EPSILON = 1e-9;
const POCKET_WIDTH_TILES = 9;
const POCKET_DEPTH_TILES = 5;
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

function snapArenaRow(arena, y) {
  return snapPositionToGrid({ x: arena.minX, y }, arena).y;
}

function snapArenaColumn(arena, x) {
  return snapPositionToGrid({ x, y: arena.minY }, arena).x;
}

function getSnappedArenaBounds(arena) {
  return {
    minX: snapArenaColumn(arena, arena.minX),
    maxX: snapArenaColumn(arena, arena.maxX),
    minY: snapArenaRow(arena, arena.minY),
    maxY: snapArenaRow(arena, arena.maxY),
  };
}

function getBridgeEntryRow(arena, actor, side) {
  if (!arena.river) {
    return null;
  }

  const bridgeRowOnNorthSide = snapArenaRow(arena, arena.river.minY - 1);
  const bridgeRowOnSouthSide = snapArenaRow(arena, arena.river.maxY);
  const useSouthSide = side === "own" ? actor === "blue" : actor === "red";
  return useSouthSide ? bridgeRowOnSouthSide : bridgeRowOnNorthSide;
}

function shiftSnappedRow(arena, row, steps, towardSouth) {
  return snapArenaRow(arena, row + (towardSouth ? steps : -steps));
}

function getSnappedBridgeRange(arena, bridge) {
  return {
    minX: snapArenaColumn(arena, bridge.minX),
    maxX: snapArenaColumn(arena, bridge.maxX),
  };
}

function getEnemyCrownTowers(entities, actor) {
  const enemy = getEnemyActor(actor);
  return entities.filter(
    (entity) => entity.entity_type === "tower" && entity.team === enemy && entity.tower_role === "crown",
  );
}

function getDestroyedEnemyLanes(arena, entities, actor) {
  const enemyCrowns = getEnemyCrownTowers(entities, actor);
  if (enemyCrowns.length === 0) {
    return [];
  }

  const destroyedCrowns = enemyCrowns.filter((tower) => tower.hp <= 0);
  if (destroyedCrowns.length === 0) {
    return [];
  }

  const sharedBoundaryX = getSharedBoundaryX(arena);
  const lanes = [];

  if (destroyedCrowns.some((tower) => tower.x < sharedBoundaryX - POSITION_EPSILON)) {
    lanes.push("left");
  }
  if (destroyedCrowns.some((tower) => tower.x > sharedBoundaryX + POSITION_EPSILON)) {
    lanes.push("right");
  }

  return lanes;
}

function buildOwnSideRegions(arena, actor) {
  if (!arena.river) {
    const midY = getArenaMidY(arena);
    if (actor === "blue") {
      return [{ kind: "own", zone: "main", minX: arena.minX, maxX: arena.maxX, minY: midY, maxY: arena.maxY }];
    }
    return [{ kind: "own", zone: "main", minX: arena.minX, maxX: arena.maxX, minY: arena.minY, maxY: midY }];
  }

  const bounds = getSnappedArenaBounds(arena);
  const ownBridgeRow = getBridgeEntryRow(arena, actor, "own");
  return actor === "blue"
    ? [{ kind: "own", zone: "main", minX: bounds.minX, maxX: bounds.maxX, minY: ownBridgeRow, maxY: bounds.maxY }]
    : [{ kind: "own", zone: "main", minX: bounds.minX, maxX: bounds.maxX, minY: bounds.minY, maxY: ownBridgeRow }];
}

function buildPocketRegionForLane(arena, actor, lane) {
  const bounds = getSnappedArenaBounds(arena);
  const widthOffset = POCKET_WIDTH_TILES - 1;
  const depthOffset = POCKET_DEPTH_TILES - 1;
  const bridgeRow = getBridgeEntryRow(arena, actor, "enemy");

  const horizontalBounds = lane === "left"
    ? {
        minX: bounds.minX,
        maxX: roundPlacement(bounds.minX + widthOffset),
      }
    : {
        minX: roundPlacement(bounds.maxX - widthOffset),
        maxX: bounds.maxX,
      };

  if (actor === "blue") {
    return {
      kind: "pocket",
      lane,
      ...horizontalBounds,
      minY: shiftSnappedRow(arena, bridgeRow, depthOffset, false),
      maxY: bridgeRow,
    };
  }

  return {
    kind: "pocket",
    lane,
    ...horizontalBounds,
    minY: bridgeRow,
    maxY: shiftSnappedRow(arena, bridgeRow, depthOffset, true),
  };
}

function buildPocketRegions(arena, entities, actor) {
  if (!arena.river) {
    return [];
  }

  return getDestroyedEnemyLanes(arena, entities, actor).map((lane) => buildPocketRegionForLane(arena, actor, lane));
}

function getBridgeConnectorBounds(arena) {
  if (!arena.river) {
    return null;
  }

  const northBridgeRow = snapArenaRow(arena, arena.river.minY - 1);
  const southBridgeRow = snapArenaRow(arena, arena.river.maxY);
  const minY = shiftSnappedRow(arena, northBridgeRow, 1, true);
  const maxY = shiftSnappedRow(arena, southBridgeRow, 1, false);

  if (maxY < minY - POSITION_EPSILON) {
    return null;
  }

  return { minY, maxY };
}

function buildBridgeConnectorRegionForLane(arena, lane) {
  if (!arena.river) {
    return null;
  }

  const bridge = (arena.bridges ?? []).find((candidate) => candidate.lane === lane);
  const connectorBounds = getBridgeConnectorBounds(arena);
  if (!bridge || !connectorBounds) {
    return null;
  }

  const span = getSnappedBridgeRange(arena, bridge);
  return {
    kind: "bridge_connector",
    lane,
    minX: span.minX,
    maxX: span.maxX,
    minY: connectorBounds.minY,
    maxY: connectorBounds.maxY,
  };
}

function buildBridgeConnectorRegions(arena, entities, actor) {
  if (!arena.river) {
    return [];
  }

  return getDestroyedEnemyLanes(arena, entities, actor)
    .map((lane) => buildBridgeConnectorRegionForLane(arena, lane))
    .filter(Boolean);
}

function isWithinRegion(position, region) {
  return (
    position.x >= region.minX - POSITION_EPSILON &&
    position.x <= region.maxX + POSITION_EPSILON &&
    position.y >= region.minY - POSITION_EPSILON &&
    position.y <= region.maxY + POSITION_EPSILON
  );
}

function isBlockedByTowerFootprint(position, entities = []) {
  return entities.some(
    (entity) => entity.entity_type === "tower" && entity.ground_blocker && isWithinRegion(position, entity.ground_blocker),
  );
}

function isOnOwnSideWithoutRiver(arena, actor, position) {
  const midY = getArenaMidY(arena);
  return actor === "blue" ? position.y > midY + POSITION_EPSILON : position.y < midY - POSITION_EPSILON;
}

export function getTroopDeployRegions({ arena, entities = [], actor = "blue" }) {
  return [
    ...buildOwnSideRegions(arena, actor),
    ...buildBridgeConnectorRegions(arena, entities, actor),
    ...buildPocketRegions(arena, entities, actor),
  ];
}

export function getTroopPlacementStatus({ arena, entities = [], actor = "blue", position, regions = null }) {
  const snappedPosition = snapPositionToGrid(position, arena);
  if (!arena.isPathable(snappedPosition.x, snappedPosition.y)) {
    return { ok: false, reason: "Troops need a land tile.", position: snappedPosition };
  }

  if (isBlockedByTowerFootprint(snappedPosition, entities)) {
    return { ok: false, reason: "Troops cannot be played on tower tiles.", position: snappedPosition };
  }

  if (!arena.river) {
    const ok = isOnOwnSideWithoutRiver(arena, actor, snappedPosition);
    return {
      ok,
      reason: ok ? null : "Troops must be played on your side.",
      position: snappedPosition,
    };
  }

  const deployRegions = regions ?? getTroopDeployRegions({ arena, entities, actor });
  const ok = deployRegions.some((region) => isWithinRegion(snappedPosition, region));
  if (ok) {
    return { ok: true, reason: null, position: snappedPosition };
  }

  const hasPocket = deployRegions.some((region) => region.kind === "pocket");
  return {
    ok: false,
    reason: hasPocket ? "Troops must be played on your side or in an unlocked pocket." : "Troops must be played on your side.",
    position: snappedPosition,
  };
}

function getCandidateRowsForRegion(region, arena) {
  if (Math.abs(region.maxY - region.minY) <= POSITION_EPSILON) {
    return [roundPlacement(region.minY)];
  }

  const isNorthRegion = (region.minY + region.maxY) * 0.5 < getArenaMidY(arena);
  const maxDepth = Math.max(0, region.maxY - region.minY);
  const deepOffset = Math.min(TROOP_BACK_OFFSET[region.kind] ?? TROOP_BACK_OFFSET.own, maxDepth);
  const offsets = [...new Set([0, deepOffset])];

  return offsets.map((offset) => {
    const y = isNorthRegion ? region.maxY - offset : region.minY + offset;
    return roundPlacement(clamp(y, region.minY, region.maxY));
  });
}

function getCandidateColumnsForRegion(region, arena) {
  const candidates = [
    snapPositionToGrid({ x: (region.minX + region.maxX) * 0.5, y: region.minY }, arena).x,
    ...(arena.bridges?.map((bridge) => snapArenaColumn(arena, bridge.x)) ?? []),
  ];
  const seen = new Set();
  const columns = [];

  for (const candidate of candidates) {
    const rounded = roundPlacement(candidate);
    if (rounded < region.minX - POSITION_EPSILON || rounded > region.maxX + POSITION_EPSILON) {
      continue;
    }
    const key = rounded.toFixed(2);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    columns.push(rounded);
  }

  return columns;
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
  const placements = [];
  const seen = new Set();

  for (const region of regions) {
    const xOptions = getCandidateColumnsForRegion(region, arena);
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
