import {
  ACTION_FEATURE_SIZE,
  ACTION_SCHEMA_VERSION,
  LEGACY_ACTION_FEATURE_SIZE,
  LEGACY_ACTION_SCHEMA_VERSION,
  normalizeActionFeaturesForSchema,
} from "./neuralFeatures.js";

function normalizeSampleTier(sample, dataset) {
  if (typeof sample?.tier === "string" && sample.tier.length > 0) {
    return sample.tier;
  }
  const datasetTiers = Array.isArray(dataset?.tiers)
    ? dataset.tiers.filter((tier) => typeof tier === "string" && tier.length > 0)
    : [];
  return datasetTiers.length === 1 ? datasetTiers[0] : null;
}

function inferActionSchemaVersion(actionFeatures, actionSchemaVersion) {
  if (actionSchemaVersion === ACTION_SCHEMA_VERSION || actionSchemaVersion === LEGACY_ACTION_SCHEMA_VERSION) {
    return actionSchemaVersion;
  }
  if (!Array.isArray(actionFeatures)) {
    return null;
  }
  if (actionFeatures.length === ACTION_FEATURE_SIZE) {
    return ACTION_SCHEMA_VERSION;
  }
  if (actionFeatures.length === LEGACY_ACTION_FEATURE_SIZE) {
    return LEGACY_ACTION_SCHEMA_VERSION;
  }
  return null;
}

function normalizeTrainingActionFeatures(candidate) {
  const sourceActionSchemaVersion = inferActionSchemaVersion(
    candidate?.action_features,
    candidate?.action_schema_version,
  );
  if (!sourceActionSchemaVersion) {
    return null;
  }
  return normalizeActionFeaturesForSchema({
    actionFeatures: candidate.action_features,
    sourceActionSchemaVersion,
    targetActionSchemaVersion: ACTION_SCHEMA_VERSION,
  });
}

function forEachActionTrainingRow(dataset, { maxNegativesPerDecision = 4, sampleTier = null } = {}, visitRow) {
  const negativeLimit = Math.max(0, Math.floor(maxNegativesPerDecision));
  const normalizedSampleTier = typeof sampleTier === "string" && sampleTier.length > 0 ? sampleTier : null;
  for (const episode of Array.isArray(dataset?.episodes) ? dataset.episodes : []) {
    for (const sample of Array.isArray(episode.samples) ? episode.samples : []) {
      const rowSampleTier = normalizeSampleTier(sample, dataset);
      if (normalizedSampleTier && rowSampleTier !== normalizedSampleTier) {
        continue;
      }
      const observation = sample.observation?.vector;
      const legalActions = Array.isArray(sample.legal_actions) ? sample.legal_actions : [];
      const chosenIndex = Number(sample.chosen_action_index);

      if (!Array.isArray(observation) || !Number.isInteger(chosenIndex) || !legalActions[chosenIndex]) {
        continue;
      }

      const chosen = legalActions[chosenIndex];
      const chosenActionFeatures = normalizeTrainingActionFeatures(chosen);
      if (chosenActionFeatures) {
        visitRow({
          observation,
          actionFeatures: chosenActionFeatures,
          label: 1,
          reward: Number(sample.reward) || 0,
          sampleTier: rowSampleTier,
        });
      }

      let negatives = 0;
      for (let index = 0; index < legalActions.length && negatives < negativeLimit; index += 1) {
        if (index === chosenIndex) {
          continue;
        }
        const candidate = legalActions[index];
        const candidateActionFeatures = normalizeTrainingActionFeatures(candidate);
        if (!candidateActionFeatures) {
          continue;
        }
        visitRow({
          observation,
          actionFeatures: candidateActionFeatures,
          label: 0,
          reward: Number(sample.reward) || 0,
          sampleTier: rowSampleTier,
        });
        negatives += 1;
      }
    }
  }
}

export function buildActionTrainingRows(dataset, { maxNegativesPerDecision = 4, sampleTier = null } = {}) {
  const rows = [];
  forEachActionTrainingRow(
    dataset,
    { maxNegativesPerDecision, sampleTier },
    ({ observation, actionFeatures, label, reward }) => {
      rows.push({
        input: [...observation, ...actionFeatures],
        label,
        reward,
      });
    },
  );
  return rows;
}

export function countActionTrainingRows(dataset, { maxNegativesPerDecision = 4, sampleTier = null } = {}) {
  const summary = {
    rows: 0,
    positives: 0,
    negatives: 0,
  };

  forEachActionTrainingRow(dataset, { maxNegativesPerDecision, sampleTier }, ({ label }) => {
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
  { maxNegativesPerDecision = 4, sampleTier = null, inputSize, inputs, labels, rowOffset = 0 } = {},
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
    { maxNegativesPerDecision, sampleTier },
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
