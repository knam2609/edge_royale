import { evaluateFireballValue } from "./spellHeuristics.js";

const FIREBALL_VALUE_THRESHOLD = Object.freeze({
  normal: 450,
  double: 390,
  overtime: 330,
});

export const midBot = {
  id: "mid",
  selectAction(state, legalActions) {
    const fireballAction = legalActions.find((action) => action.type === "PLAY_FIREBALL");
    if (!fireballAction) {
      return { type: "PASS" };
    }

    const value = evaluateFireballValue({
      targets: state.targets,
      damage: state.fireball.damage,
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
