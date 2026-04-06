function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isWithinBridge(x, bridges = []) {
  return bridges.some((bridge) => x >= bridge.minX && x <= bridge.maxX);
}

function createDefaultIsPathable(arena) {
  return (x, y) => {
    if (!arena.river) {
      return true;
    }

    if (y >= arena.river.minY && y <= arena.river.maxY) {
      return isWithinBridge(x, arena.bridges);
    }

    return true;
  };
}

export const ROYALE_LANE_X = Object.freeze({
  left: 3,
  center: 9,
  right: 15,
});

export const ROYALE_BRIDGES = Object.freeze([
  Object.freeze({ lane: "left", x: ROYALE_LANE_X.left, minX: 2, maxX: 4 }),
  Object.freeze({ lane: "right", x: ROYALE_LANE_X.right, minX: 14, maxX: 16 }),
]);

export function createArena({
  minX = 0,
  maxX = 18,
  minY = 0,
  maxY = 32,
  isPathable,
  river = null,
  bridges = [],
  grid = null,
} = {}) {
  const arena = {
    minX,
    maxX,
    minY,
    maxY,
    river,
    bridges,
    grid,
    pathability_mode: isPathable ? "custom" : "default",
  };

  arena.isPathable = isPathable ?? createDefaultIsPathable(arena);
  return arena;
}

export function createRoyaleArena({ minX = 0, maxX = 18, minY = 0, maxY = 32 } = {}) {
  return createArena({
    minX,
    maxX,
    minY,
    maxY,
    river: {
      minY: 15,
      maxY: 17,
      centerY: 16,
    },
    bridges: ROYALE_BRIDGES.map((bridge) => ({ ...bridge })),
    grid: {
      step: 1,
      offsetX: 0.5,
      offsetY: 0.5,
    },
  });
}

export function getArenaMidY(arena) {
  return (arena.minY + arena.maxY) / 2;
}

export function getArenaSide(arena, y) {
  if (!arena.river) {
    const midY = getArenaMidY(arena);
    return y < midY ? "north" : "south";
  }

  if (y < arena.river.minY) {
    return "north";
  }
  if (y > arena.river.maxY) {
    return "south";
  }
  return "river";
}

export function isRiverTile(arena, x, y) {
  if (!arena.river) {
    return false;
  }
  return y >= arena.river.minY && y <= arena.river.maxY && !isWithinBridge(x, arena.bridges);
}

export function getNearestBridge(arena, x) {
  if (!arena.bridges || arena.bridges.length === 0) {
    return null;
  }

  return [...arena.bridges].sort((a, b) => {
    const da = Math.abs(a.x - x);
    const db = Math.abs(b.x - x);
    if (da !== db) {
      return da - db;
    }
    return a.x - b.x;
  })[0];
}

function snapCoord(value, min, max, step, offset) {
  const minSnap = min + offset;
  const maxSnap = max - (step - offset);
  const snapped = Math.round((value - minSnap) / step) * step + minSnap;
  return roundCoord(clamp(snapped, minSnap, maxSnap));
}

export function snapPositionToGrid(position, arena) {
  if (!arena.grid) {
    return clampToArena(position, arena);
  }

  const grid = arena.grid;
  return {
    x: snapCoord(position.x, arena.minX, arena.maxX, grid.step, grid.offsetX),
    y: snapCoord(position.y, arena.minY, arena.maxY, grid.step, grid.offsetY),
  };
}

export function clampToArena(position, arena) {
  return {
    x: roundCoord(clamp(position.x, arena.minX, arena.maxX)),
    y: roundCoord(clamp(position.y, arena.minY, arena.maxY)),
  };
}

function buildOffsetCandidates(radius, step) {
  const points = [];
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dy = -radius; dy <= radius; dy += step) {
      points.push({ dx: roundCoord(dx), dy: roundCoord(dy) });
    }
  }

  points.sort((a, b) => {
    const da = a.dx * a.dx + a.dy * a.dy;
    const db = b.dx * b.dx + b.dy * b.dy;
    if (da !== db) {
      return da - db;
    }
    if (a.dx !== b.dx) {
      return a.dx - b.dx;
    }
    return a.dy - b.dy;
  });

  return points;
}

export function clampPositionToArenaAndPathable(position, arena) {
  const bounded = clampToArena(position, arena);
  if (arena.isPathable(bounded.x, bounded.y)) {
    return bounded;
  }

  const offsets = buildOffsetCandidates(1.5, 0.05);
  for (const { dx, dy } of offsets) {
    const candidate = clampToArena(
      {
        x: bounded.x + dx,
        y: bounded.y + dy,
      },
      arena,
    );

    if (arena.isPathable(candidate.x, candidate.y)) {
      return candidate;
    }
  }

  return bounded;
}
