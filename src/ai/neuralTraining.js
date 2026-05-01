export function buildActionTrainingRows(dataset, { maxNegativesPerDecision = 4 } = {}) {
  const rows = [];
  const negativeLimit = Math.max(0, Math.floor(maxNegativesPerDecision));

  for (const episode of Array.isArray(dataset?.episodes) ? dataset.episodes : []) {
    for (const sample of Array.isArray(episode.samples) ? episode.samples : []) {
      const observation = sample.observation?.vector;
      const legalActions = Array.isArray(sample.legal_actions) ? sample.legal_actions : [];
      const chosenIndex = Number(sample.chosen_action_index);

      if (!Array.isArray(observation) || !Number.isInteger(chosenIndex) || !legalActions[chosenIndex]) {
        continue;
      }

      const chosen = legalActions[chosenIndex];
      if (Array.isArray(chosen.action_features)) {
        rows.push({
          input: [...observation, ...chosen.action_features],
          label: 1,
          reward: Number(sample.reward) || 0,
        });
      }

      let negatives = 0;
      for (let index = 0; index < legalActions.length && negatives < negativeLimit; index += 1) {
        if (index === chosenIndex) {
          continue;
        }
        const candidate = legalActions[index];
        if (!Array.isArray(candidate.action_features)) {
          continue;
        }
        rows.push({
          input: [...observation, ...candidate.action_features],
          label: 0,
          reward: Number(sample.reward) || 0,
        });
        negatives += 1;
      }
    }
  }

  return rows;
}

export function summarizeTrainingRows(rows) {
  const validRows = Array.isArray(rows) ? rows : [];
  const positives = validRows.filter((row) => row.label === 1).length;
  const negatives = validRows.length - positives;
  return {
    rows: validRows.length,
    positives,
    negatives,
  };
}
