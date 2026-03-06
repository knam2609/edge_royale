function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function createArena({ minX = 0, maxX = 18, minY = 0, maxY = 32, isPathable } = {}) {
  return {
    minX,
    maxX,
    minY,
    maxY,
    isPathable: isPathable ?? (() => true),
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
