import {
  ACTION_SCHEMA_VERSION,
  FEATURE_SCHEMA_VERSION,
  MODEL_INPUT_SIZE,
  encodeModelInput,
} from "./neuralFeatures.js";

export const NEURAL_MODEL_VERSION = 1;
export const NEURAL_MODEL_KIND = "legal_action_mlp";

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function cloneNumberArray(values) {
  if (!Array.isArray(values) || values.some((value) => !isFiniteNumber(value))) {
    return null;
  }
  return values.map((value) => Number(value));
}

function normalizeDenseLayer(layer, inputSize) {
  if (!layer || layer.type !== "dense") {
    return null;
  }

  const weights = Array.isArray(layer.weights) ? layer.weights.map(cloneNumberArray) : null;
  const bias = cloneNumberArray(layer.bias);
  if (!weights || !bias || weights.some((row) => row === null)) {
    return null;
  }
  if (weights.length !== inputSize) {
    return null;
  }
  if (weights.length > 0 && weights.some((row) => row.length !== bias.length)) {
    return null;
  }

  const activation = ["linear", "relu", "sigmoid", "tanh"].includes(layer.activation)
    ? layer.activation
    : "linear";

  return {
    type: "dense",
    activation,
    weights,
    bias,
  };
}

export function normalizeNeuralPolicyModel(rawModel) {
  if (!rawModel || typeof rawModel !== "object") {
    return null;
  }
  if (rawModel.kind !== NEURAL_MODEL_KIND || Number(rawModel.version) !== NEURAL_MODEL_VERSION) {
    return null;
  }
  if (
    rawModel.feature_schema_version !== FEATURE_SCHEMA_VERSION ||
    rawModel.action_schema_version !== ACTION_SCHEMA_VERSION
  ) {
    return null;
  }

  const inputSize = Number(rawModel.input_size);
  if (!Number.isInteger(inputSize) || inputSize !== MODEL_INPUT_SIZE) {
    return null;
  }

  const layers = [];
  let width = inputSize;
  for (const rawLayer of Array.isArray(rawModel.layers) ? rawModel.layers : []) {
    const layer = normalizeDenseLayer(rawLayer, width);
    if (!layer) {
      return null;
    }
    width = layer.bias.length;
    layers.push(layer);
  }

  if (layers.length === 0 || width !== 1) {
    return null;
  }

  return {
    version: NEURAL_MODEL_VERSION,
    kind: NEURAL_MODEL_KIND,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    action_schema_version: ACTION_SCHEMA_VERSION,
    input_size: inputSize,
    training_config: rawModel.training_config && typeof rawModel.training_config === "object"
      ? rawModel.training_config
      : {},
    dataset_hash: typeof rawModel.dataset_hash === "string" ? rawModel.dataset_hash : null,
    seed: Number.isFinite(Number(rawModel.seed)) ? Number(rawModel.seed) : null,
    layers,
  };
}

export function isNeuralPolicyModel(rawModel) {
  return normalizeNeuralPolicyModel(rawModel) !== null;
}

export function getNeuralModelTargetTier(rawModel) {
  const normalized = normalizeNeuralPolicyModel(rawModel);
  if (!normalized) {
    return null;
  }

  const targetTier = normalized.training_config?.target_tier;
  if (typeof targetTier === "string" && targetTier.length > 0) {
    return targetTier;
  }

  const legacyTiers = Array.isArray(normalized.training_config?.tiers)
    ? normalized.training_config.tiers.filter((tier) => typeof tier === "string" && tier.length > 0)
    : [];
  if (legacyTiers.includes("goat")) {
    return "goat";
  }

  return null;
}

function activate(value, activation) {
  if (activation === "relu") {
    return Math.max(0, value);
  }
  if (activation === "sigmoid") {
    return 1 / (1 + Math.exp(-value));
  }
  if (activation === "tanh") {
    return Math.tanh(value);
  }
  return value;
}

function scoreWithNormalizedModel(normalized, input) {
  if (!normalized || !Array.isArray(input) || input.length !== normalized.input_size) {
    return null;
  }

  let activations = input.map((value) => Number(value) || 0);
  for (const layer of normalized.layers) {
    const next = [];
    for (let unit = 0; unit < layer.bias.length; unit += 1) {
      let sum = layer.bias[unit];
      for (let i = 0; i < activations.length; i += 1) {
        sum += activations[i] * layer.weights[i][unit];
      }
      next.push(activate(sum, layer.activation));
    }
    activations = next;
  }

  const score = activations[0];
  return Number.isFinite(score) ? score : null;
}

export function scoreEncodedInput(model, input) {
  return scoreWithNormalizedModel(normalizeNeuralPolicyModel(model), input);
}

function actionSortKey(action) {
  return `${action.cardId}|${Number(action.x).toFixed(2)}|${Number(action.y).toFixed(2)}`;
}

export function scoreActionWithModel(model, { engine, actor = "red", action }) {
  const input = encodeModelInput({ engine, actor, action });
  return scoreEncodedInput(model, input);
}

export function selectActionFromNeuralModel(model, { engine, actor = "red", legalActions }) {
  const normalized = normalizeNeuralPolicyModel(model);
  if (!normalized || !Array.isArray(legalActions) || legalActions.length === 0) {
    return null;
  }

  let bestAction = null;
  let bestScore = -Infinity;
  let bestKey = "";

  for (const action of legalActions) {
    const input = encodeModelInput({ engine, actor, action });
    const score = scoreWithNormalizedModel(normalized, input);
    if (!Number.isFinite(score)) {
      continue;
    }

    const key = actionSortKey(action);
    if (score > bestScore || (score === bestScore && (!bestAction || key < bestKey))) {
      bestAction = action;
      bestScore = score;
      bestKey = key;
    }
  }

  return bestAction;
}

export function createZeroNeuralPolicyModel({ hiddenUnits = 4, seed = 0 } = {}) {
  const hidden = Math.max(1, Math.floor(hiddenUnits));
  const firstWeights = Array.from({ length: MODEL_INPUT_SIZE }, () => Array.from({ length: hidden }, () => 0));
  const secondWeights = Array.from({ length: hidden }, () => [0]);

  return {
    version: NEURAL_MODEL_VERSION,
    kind: NEURAL_MODEL_KIND,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    action_schema_version: ACTION_SCHEMA_VERSION,
    input_size: MODEL_INPUT_SIZE,
    training_config: { fixture: true },
    dataset_hash: "fixture",
    seed,
    layers: [
      {
        type: "dense",
        activation: "relu",
        weights: firstWeights,
        bias: Array.from({ length: hidden }, () => 0),
      },
      {
        type: "dense",
        activation: "sigmoid",
        weights: secondWeights,
        bias: [0],
      },
    ],
  };
}
