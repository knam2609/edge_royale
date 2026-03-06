import { clampPositionToArenaAndPathable } from "./map.js";
import { TICK_RATE } from "./config.js";

const TROOP_STATS = Object.freeze({
  giant: Object.freeze({
    move_speed: 1.0,
    attack_damage: 90,
    attack_range: 1.2,
    hit_speed_seconds: 1.5,
    targeting_mode: "buildings",
  }),
  knight: Object.freeze({
    move_speed: 1.2,
    attack_damage: 160,
    attack_range: 1.2,
    hit_speed_seconds: 1.2,
    targeting_mode: "any",
  }),
  goblins: Object.freeze({
    move_speed: 1.8,
    attack_damage: 95,
    attack_range: 1.0,
    hit_speed_seconds: 1.0,
    targeting_mode: "any",
  }),
  archers: Object.freeze({
    move_speed: 1.2,
    attack_damage: 95,
    attack_range: 5.0,
    hit_speed_seconds: 1.1,
    targeting_mode: "any",
  }),
  musketeer: Object.freeze({
    move_speed: 1.1,
    attack_damage: 190,
    attack_range: 6.0,
    hit_speed_seconds: 1.1,
    targeting_mode: "any",
  }),
  "mini_pekka": Object.freeze({
    move_speed: 1.3,
    attack_damage: 420,
    attack_range: 1.2,
    hit_speed_seconds: 1.6,
    targeting_mode: "any",
  }),
});

const TOWER_STATS = Object.freeze({
  move_speed: 0,
  attack_damage: 120,
  attack_range: 6.2,
  hit_speed_seconds: 1.0,
  targeting_mode: "troops",
});

function toCooldownTicks(seconds) {
  return Math.max(1, Math.round(seconds * TICK_RATE));
}

function getTroopStats(cardId) {
  return TROOP_STATS[cardId] ?? TROOP_STATS.knight;
}

export function createTroop({ id, cardId, team, x, y, hp }) {
  const stats = getTroopStats(cardId);

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
    move_speed: TOWER_STATS.move_speed,
    attack_damage: TOWER_STATS.attack_damage,
    attack_range: TOWER_STATS.attack_range,
    attack_cooldown_ticks: toCooldownTicks(TOWER_STATS.hit_speed_seconds),
    attack_cooldown_ticks_remaining: 0,
    targeting_mode: TOWER_STATS.targeting_mode,
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
