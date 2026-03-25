import { clampPositionToArenaAndPathable } from "./map.js";
import { TICK_RATE } from "./config.js";
import { getTowerStats, getTroopStats } from "./stats.js";

function toCooldownTicks(seconds) {
  return Math.max(1, Math.round(seconds * TICK_RATE));
}

export function createTroop({ id, cardId, team, x, y, hp = null }) {
  const stats = getTroopStats(cardId);
  const resolvedHp = hp ?? stats.hp;

  return {
    id,
    cardId,
    team,
    entity_type: "troop",
    x,
    y,
    hp: resolvedHp,
    maxHp: resolvedHp,
    radius: 0.45,
    move_speed: stats.move_speed,
    attack_damage: stats.attack_damage,
    attack_range: stats.attack_range,
    sight_range: stats.sight_range,
    attack_cooldown_ticks: toCooldownTicks(stats.hit_speed_seconds),
    attack_cooldown_ticks_remaining: 0,
    targeting_mode: stats.targeting_mode,
    target_entity_id: null,
    velocity: { x: 0, y: 0 },
    forced_motion_vector: { x: 0, y: 0 },
    forced_motion_ticks_remaining: 0,
  };
}

export function createTower({ id, team, x, y, hp = null, tower_role = "crown", is_active = true }) {
  const stats = getTowerStats(tower_role);
  const resolvedHp = hp ?? stats.hp;
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
