export const noobBot = {
  id: "noob",
  selectAction(state, legalActions) {
    if (!Array.isArray(legalActions) || legalActions.length === 0) {
      return { type: "PASS" };
    }

    const rng = state?.rng ?? Math.random;
    const index = Math.floor(rng() * legalActions.length);
    return legalActions[index] ?? { type: "PASS" };
  },
};
