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

export const FIREBALL_CONFIG = Object.freeze({
  cost: 4,
  radius_tiles: 2.5,
  damage: 520,
  cast_delay_ticks: 6,
  travel_speed_tiles_per_second: 10,
  knockback_distance_tiles: 0.75,
  knockback_duration_ticks: 5,
  knockback_immune_card_ids: Object.freeze(["giant"]),
});

export const ARROWS_CONFIG = Object.freeze({
  cost: 3,
  radius_tiles: 3.0,
  damage: 350,
  cast_delay_ticks: 16,
});

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
