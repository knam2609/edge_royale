import { clampGroundPosition, getIgnoredBlockerIdsForEntity } from "./nav.js";
import { TICK_RATE } from "./config.js";
import { getTowerStats, getTroopStats } from "./stats.js";

function toCooldownTicks(seconds) {
  return Math.max(1, Math.round(seconds * TICK_RATE));
}

export function createTroop({ id, cardId, team, x, y, hp = null }) {
  const stats = getTroopStats(cardId);
  const resolvedHp = hp ?? stats.hp;
  const movementRadius = 0.45;

  return {
    id,
    cardId,
    team,
    entity_type: "troop",
    x,
    y,
    hp: resolvedHp,
    maxHp: resolvedHp,
    radius: movementRadius,
    collision_radius: movementRadius,
    body_mass: stats.body_mass,
    move_speed: stats.move_speed,
    attack_damage: stats.attack_damage,
    attack_range: stats.attack_range,
    sight_range: stats.sight_range,
    attack_cooldown_ticks: toCooldownTicks(stats.hit_speed_seconds),
    attack_cooldown_ticks_remaining: 0,
    targeting_mode: stats.targeting_mode,
    target_entity_id: null,
    preferred_lane_x: x,
    velocity: { x: 0, y: 0 },
    forced_motion_vector: { x: 0, y: 0 },
    forced_motion_ticks_remaining: 0,
  };
}

function createTowerFootprint(x, y, size) {
  const halfSize = size * 0.5;
  return {
    kind: "rect",
    width: size,
    height: size,
    minX: x - halfSize,
    maxX: x + halfSize,
    minY: y - halfSize,
    maxY: y + halfSize,
  };
}

export function createTower({ id, team, x, y, hp = null, tower_role = "crown", is_active = true }) {
  const stats = getTowerStats(tower_role);
  const resolvedHp = hp ?? stats.hp;
  const footprintSize = tower_role === "king" ? 4 : 3;
  return {
    id,
    cardId: "tower",
    team,
    entity_type: "tower",
    tower_role,
    is_active,
    x,
    y,
    hp: resolvedHp,
    maxHp: resolvedHp,
    radius: tower_role === "king" ? 0.95 : 0.75,
    ground_blocker: createTowerFootprint(x, y, footprintSize),
    move_speed: stats.move_speed,
    attack_damage: stats.attack_damage,
    attack_range: stats.attack_range,
    attack_cooldown_ticks: toCooldownTicks(stats.hit_speed_seconds),
    attack_cooldown_ticks_remaining: 0,
    targeting_mode: stats.targeting_mode,
    target_entity_id: null,
    velocity: { x: 0, y: 0 },
    forced_motion_vector: { x: 0, y: 0 },
    forced_motion_ticks_remaining: 0,
  };
}

export function applyForcedMotion(entity, arena, entities = []) {
  if (entity.forced_motion_ticks_remaining <= 0) {
    return;
  }

  const startX = entity.x;
  const startY = entity.y;
  const nextPosition = clampGroundPosition({
    position: {
      x: entity.x + entity.forced_motion_vector.x,
      y: entity.y + entity.forced_motion_vector.y,
    },
    arena,
    entities,
    clearance: entity.collision_radius ?? entity.radius ?? 0,
    ignoredBlockerIds: getIgnoredBlockerIdsForEntity(entity, entities),
  });

  entity.x = nextPosition.x;
  entity.y = nextPosition.y;
  entity.velocity = {
    x: nextPosition.x - startX,
    y: nextPosition.y - startY,
  };
  entity.forced_motion_ticks_remaining -= 1;

  if (entity.forced_motion_ticks_remaining <= 0) {
    entity.forced_motion_ticks_remaining = 0;
    entity.forced_motion_vector = { x: 0, y: 0 };
  }
}
