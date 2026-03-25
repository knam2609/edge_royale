import { getSpellStats } from "./stats.js";

export const TICK_RATE = 20;

export const ELIXIR_REGEN_TICKS = Object.freeze({
  normal: 56,
  double: 28,
  overtime: 20,
});

export const SIMULATION_CONFIG = Object.freeze({
  tick_rate: TICK_RATE,
  elixir_regen_ticks: ELIXIR_REGEN_TICKS,
});

export const MATCH_CONFIG = Object.freeze({
  regulation_ticks: 180 * TICK_RATE,
  double_elixir_start_tick: 120 * TICK_RATE,
  overtime_ticks: 120 * TICK_RATE,
});

function createSpellConfig(cardId) {
  const spell = getSpellStats(cardId);
  if (!spell) {
    return Object.freeze({});
  }

  return Object.freeze({
    cost: spell.cost,
    radius_tiles: spell.radius_tiles,
    troop_damage: spell.troop_damage,
    tower_damage: spell.tower_damage,
    cast_delay_ticks: spell.cast_delay_ticks,
    travel_speed_tiles_per_second: spell.travel_speed_tiles_per_second,
    knockback_distance_tiles: spell.knockback_distance_tiles,
    knockback_duration_ticks: spell.knockback_duration_ticks,
    knockback_immune_card_ids: spell.knockback_immune_card_ids,
  });
}

export const FIREBALL_CONFIG = createSpellConfig("fireball");

export const ARROWS_CONFIG = createSpellConfig("arrows");

export function getMatchPhase({ tick, isOvertime }) {
  if (isOvertime) {
    return "overtime";
  }
  if (tick >= MATCH_CONFIG.double_elixir_start_tick) {
    return "double";
  }
  return "normal";
}

export function getElixirRegenTicks(phase) {
  return ELIXIR_REGEN_TICKS[phase] ?? ELIXIR_REGEN_TICKS.normal;
}
