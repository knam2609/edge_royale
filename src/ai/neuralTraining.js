function forEachActionTrainingRow(dataset, { maxNegativesPerDecision = 4 } = {}, visitRow) {
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
        visitRow({
          observation,
          actionFeatures: chosen.action_features,
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
        visitRow({
          observation,
          actionFeatures: candidate.action_features,
          label: 0,
          reward: Number(sample.reward) || 0,
        });
        negatives += 1;
      }
    }
  }
}

export function buildActionTrainingRows(dataset, { maxNegativesPerDecision = 4 } = {}) {
  const rows = [];
  forEachActionTrainingRow(dataset, { maxNegativesPerDecision }, ({ observation, actionFeatures, label, reward }) => {
    rows.push({
      input: [...observation, ...actionFeatures],
      label,
      reward,
    });
  });
  return rows;
}

export function countActionTrainingRows(dataset, { maxNegativesPerDecision = 4 } = {}) {
  const summary = {
    rows: 0,
    positives: 0,
    negatives: 0,
  };

  forEachActionTrainingRow(dataset, { maxNegativesPerDecision }, ({ label }) => {
    summary.rows += 1;
    if (label === 1) {
      summary.positives += 1;
    } else {
      summary.negatives += 1;
    }
  });

  return summary;
}

export function fillActionTrainingBuffers(
  dataset,
  { maxNegativesPerDecision = 4, inputSize, inputs, labels, rowOffset = 0 } = {},
) {
  if (!Number.isInteger(inputSize) || inputSize <= 0) {
    throw new Error(`invalid action training input size: ${inputSize}`);
  }
  if (!inputs || typeof inputs.length !== "number") {
    throw new Error("missing action training input buffer");
  }
  if (!labels || typeof labels.length !== "number") {
    throw new Error("missing action training label buffer");
  }

  let rowIndex = Math.max(0, Math.floor(Number(rowOffset) || 0));
  forEachActionTrainingRow(
    dataset,
    { maxNegativesPerDecision },
    ({ observation, actionFeatures, label }) => {
      if (observation.length + actionFeatures.length !== inputSize) {
        throw new Error(
          `action training row size mismatch: expected ${inputSize}, got ${observation.length + actionFeatures.length}`,
        );
      }

      const start = rowIndex * inputSize;
      if (start + inputSize > inputs.length || rowIndex >= labels.length) {
        throw new Error("action training buffers are too small for dataset rows");
      }

      let inputIndex = start;
      for (const value of observation) {
        inputs[inputIndex] = Number(value) || 0;
        inputIndex += 1;
      }
      for (const value of actionFeatures) {
        inputs[inputIndex] = Number(value) || 0;
        inputIndex += 1;
      }
      labels[rowIndex] = label;
      rowIndex += 1;
    },
  );

  return rowIndex;
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
