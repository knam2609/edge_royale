export const ACTION_SPACE_VERSION = "full_snapped_grid_v1";

export const PASS_ACTION = Object.freeze({ type: "PASS" });

export function isPassAction(action) {
  return action?.type === "PASS";
}

export function actionSortKey(action) {
  if (isPassAction(action)) {
    return "~PASS";
  }
  return `${action.cardId}|${Number(action.x).toFixed(2)}|${Number(action.y).toFixed(2)}`;
}

export function appendPassAction(legalActions = []) {
  const normalized = Array.isArray(legalActions) ? [...legalActions] : [];
  if (!normalized.some((action) => isPassAction(action))) {
    normalized.push(PASS_ACTION);
  }
  return normalized;
}
