import { getElixirRegenTicks } from "../sim/config.js";

export function forecastElixir({ currentElixir, ticksAhead, phase, maxElixir = 10 }) {
  const regenTicks = getElixirRegenTicks(phase);
  const gained = Math.floor(ticksAhead / regenTicks);
  return Math.min(maxElixir, currentElixir + gained);
}
