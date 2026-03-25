import { forecastElixir } from "./elixirForecast.js";
import { evaluateFireballValue } from "./spellHeuristics.js";

const FIREBALL_VALUE_THRESHOLD = Object.freeze({
  normal: 420,
  double: 350,
  overtime: 280,
});

const RESERVE_AFTER_CAST = Object.freeze({
  normal: 0,
  double: 0,
  overtime: 0,
});

export const topBot = {
  id: "top",
  selectAction(state, legalActions) {
    const fireballAction = legalActions.find((action) => action.type === "PLAY_FIREBALL");
    if (!fireballAction) {
      return { type: "PASS" };
    }

    const projectedElixir = forecastElixir({
      currentElixir: state.currentElixir,
      ticksAhead: state.lookaheadTicks,
      phase: state.phase,
    });

    const reserve = RESERVE_AFTER_CAST[state.phase] ?? RESERVE_AFTER_CAST.normal;
    const elixirAfterCast = projectedElixir - state.fireball.cost;
    if (projectedElixir < state.fireball.cost || elixirAfterCast < reserve) {
      return { type: "PASS" };
    }

    const value = evaluateFireballValue({
      targets: state.targets,
      troopDamage: state.fireball.troop_damage,
      towerDamage: state.fireball.tower_damage,
      knockbackDistanceTiles: state.fireball.knockback_distance_tiles,
      impactY: state.fireball.impactY,
    });

    const threshold = FIREBALL_VALUE_THRESHOLD[state.phase] ?? FIREBALL_VALUE_THRESHOLD.normal;
    if (value >= threshold) {
      return fireballAction;
    }

    return { type: "PASS" };
  },
};
