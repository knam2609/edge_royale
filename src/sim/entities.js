import { clampPositionToArenaAndPathable } from "./map.js";

export function createTroop({ id, cardId, team, x, y, hp }) {
  return {
    id,
    cardId,
    team,
    entity_type: "troop",
    x,
    y,
    hp,
    maxHp: hp,
    radius: 0.45,
    forced_motion_vector: { x: 0, y: 0 },
    forced_motion_ticks_remaining: 0,
  };
}

export function createTower({ id, team, x, y, hp }) {
  return {
    id,
    cardId: "tower",
    team,
    entity_type: "tower",
    x,
    y,
    hp,
    maxHp: hp,
    radius: 0.75,
    forced_motion_vector: { x: 0, y: 0 },
    forced_motion_ticks_remaining: 0,
  };
}

export function applyForcedMotion(entity, arena) {
  if (entity.forced_motion_ticks_remaining <= 0) {
    return;
  }

  const nextPosition = clampPositionToArenaAndPathable(
    {
      x: entity.x + entity.forced_motion_vector.x,
      y: entity.y + entity.forced_motion_vector.y,
    },
    arena,
  );

  entity.x = nextPosition.x;
  entity.y = nextPosition.y;
  entity.forced_motion_ticks_remaining -= 1;

  if (entity.forced_motion_ticks_remaining <= 0) {
    entity.forced_motion_ticks_remaining = 0;
    entity.forced_motion_vector = { x: 0, y: 0 };
  }
}
