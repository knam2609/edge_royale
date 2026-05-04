import {
  ACTION_FEATURE_SIZE,
  ACTION_SCHEMA_VERSION,
  FEATURE_SCHEMA_VERSION,
  MODEL_INPUT_SIZE,
  encodeActionFeatures,
  encodeStateFeatures,
} from "./neuralFeatures.js";
import {
  NEURAL_MODEL_KIND,
  NEURAL_MODEL_VERSION,
  getNeuralModelTargetTier,
  normalizeNeuralPolicyModel,
  scoreEncodedInput,
  selectActionFromNeuralModel,
} from "./neuralModel.js";
import { getMatchPhase } from "../sim/config.js";

export const TRAINING_DATA_VERSION = 2;
export const SELF_MODEL_VERSION = 2;
export const SELF_MODEL_KIND = NEURAL_MODEL_KIND;
export const LEGAL_DECISION_SAMPLE_KIND = "legal_action_decision";
export const LEGACY_CARD_SAMPLE_KIND = "card_bucket_decision";
export const SELF_MODEL_MIN_SAMPLES = 120;
export const SELF_MODEL_MIN_NEW_SAMPLES = 20;
export const MAX_TRAINING_SAMPLES = 1000;
export const SELF_MODEL_MAX_NEGATIVES = 8;
export const SELF_MODEL_DEFAULT_EPOCHS = 4;
export const SELF_MODEL_DEFAULT_LEARNING_RATE = 0.08;

export function createEmptyTrainingStore() {
  return {
    version: TRAINING_DATA_VERSION,
    samples: [],
    updated_at: Date.now(),
  };
}

function normalizeHand(hand) {
  if (!Array.isArray(hand)) {
    return [];
  }

  return hand.filter((cardId) => typeof cardId === "string").slice(0, 4);
}

function normalizeNumberArray(values, expectedLength = null) {
  if (!Array.isArray(values)) {
    return null;
  }
  if (expectedLength !== null && values.length !== expectedLength) {
    return null;
  }
  const normalized = values.map((value) => Number(value));
  return normalized.every(Number.isFinite) ? normalized : null;
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }

  const cardId = typeof action.cardId === "string" ? action.cardId : action.card_id;
  if (action.type !== "PLAY_CARD" || typeof cardId !== "string") {
    return null;
  }

  const x = Number(action.x);
  const y = Number(action.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return {
    type: "PLAY_CARD",
    card_id: cardId,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
  };
}

function sameNormalizedAction(left, right) {
  return (
    left?.type === right?.type &&
    left?.card_id === right?.card_id &&
    Math.abs(Number(left?.x) - Number(right?.x)) < 0.001 &&
    Math.abs(Number(left?.y) - Number(right?.y)) < 0.001
  );
}

function normalizeLegalActionCandidate(rawCandidate, fallbackIndex = 0) {
  if (!rawCandidate || typeof rawCandidate !== "object") {
    return null;
  }

  const action = normalizeAction(rawCandidate.action ?? rawCandidate);
  const actionFeatures = normalizeNumberArray(rawCandidate.action_features, ACTION_FEATURE_SIZE);
  if (!action || !actionFeatures) {
    return null;
  }

  const index = Math.max(0, Math.floor(Number(rawCandidate.index ?? fallbackIndex) || 0));
  return {
    index,
    action,
    action_schema_version: ACTION_SCHEMA_VERSION,
    action_features: actionFeatures,
  };
}

function normalizeLegalDecisionSample(rawSample) {
  const legalActions = Array.isArray(rawSample?.legal_actions)
    ? rawSample.legal_actions
        .map((candidate, index) => normalizeLegalActionCandidate(candidate, index))
        .filter((candidate) => candidate !== null)
    : [];
  if (legalActions.length === 0) {
    return null;
  }

  const chosenIndex = Math.floor(Number(rawSample.chosen_action_index));
  const chosenCandidate = legalActions.find((candidate) => candidate.index === chosenIndex) ?? null;
  if (!chosenCandidate) {
    return null;
  }

  const observationVector = normalizeNumberArray(rawSample.observation?.vector);
  const phase = typeof rawSample.phase === "string" && rawSample.phase.length > 0 ? rawSample.phase : "normal";
  const elixir = Number(rawSample.elixir);

  return {
    kind: LEGAL_DECISION_SAMPLE_KIND,
    phase,
    elixir: Number.isFinite(elixir) ? Math.max(0, Math.min(10, Math.round(elixir))) : 0,
    card_id: chosenCandidate.action.card_id,
    hand: normalizeHand(rawSample.hand),
    tick: Math.max(0, Math.floor(Number(rawSample.tick) || 0)),
    source_tier: typeof rawSample.source_tier === "string" ? rawSample.source_tier : "unknown",
    observation: {
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      vector: observationVector ?? [],
    },
    legal_actions: legalActions,
    chosen_action_index: chosenCandidate.index,
    chosen_action: chosenCandidate.action,
    reward: Number.isFinite(Number(rawSample.reward)) ? Number(rawSample.reward) : 0,
    created_at: Number(rawSample.created_at) || Date.now(),
  };
}

function normalizeSample(rawSample) {
  if (!rawSample || typeof rawSample !== "object") {
    return null;
  }

  if (
    rawSample.kind === LEGAL_DECISION_SAMPLE_KIND ||
    (Array.isArray(rawSample.legal_actions) && rawSample.chosen_action_index !== undefined)
  ) {
    return normalizeLegalDecisionSample(rawSample);
  }

  if (typeof rawSample.card_id !== "string" || typeof rawSample.phase !== "string") {
    return null;
  }

  const elixir = Number(rawSample.elixir);
  if (!Number.isFinite(elixir)) {
    return null;
  }

  return {
    kind: LEGACY_CARD_SAMPLE_KIND,
    phase: rawSample.phase,
    elixir: Math.max(0, Math.min(10, Math.round(elixir))),
    card_id: rawSample.card_id,
    hand: normalizeHand(rawSample.hand),
    tick: Math.max(0, Math.floor(Number(rawSample.tick) || 0)),
    source_tier: typeof rawSample.source_tier === "string" ? rawSample.source_tier : "unknown",
    created_at: Number(rawSample.created_at) || Date.now(),
  };
}

export function normalizeTrainingStore(rawStore) {
  const normalized = createEmptyTrainingStore();

  if (!rawStore || typeof rawStore !== "object") {
    return normalized;
  }

  const samples = Array.isArray(rawStore.samples)
    ? rawStore.samples.map(normalizeSample).filter((sample) => sample !== null)
    : [];

  return {
    version: TRAINING_DATA_VERSION,
    samples,
    updated_at: Number(rawStore.updated_at) || Date.now(),
  };
}

function createLegalDecisionSample({
  engine,
  actor = "blue",
  legalActions,
  chosenAction,
  tick,
  sourceTier = "human",
}) {
  if (!engine || !Array.isArray(legalActions) || legalActions.length === 0) {
    return null;
  }

  const normalizedChosen = normalizeAction(chosenAction);
  if (!normalizedChosen) {
    return null;
  }

  const normalizedCandidates = legalActions
    .map((action, index) => {
      const normalizedAction = normalizeAction(action);
      if (!normalizedAction) {
        return null;
      }
      return {
        index,
        action: normalizedAction,
        action_schema_version: ACTION_SCHEMA_VERSION,
        action_features: encodeActionFeatures({ engine, actor, action }),
      };
    })
    .filter((candidate) => candidate !== null);

  let chosenCandidate = normalizedCandidates.find((candidate) =>
    sameNormalizedAction(candidate.action, normalizedChosen),
  );
  if (!chosenCandidate) {
    chosenCandidate = {
      index: normalizedCandidates.length,
      action: normalizedChosen,
      action_schema_version: ACTION_SCHEMA_VERSION,
      action_features: encodeActionFeatures({ engine, actor, action: chosenAction }),
    };
    normalizedCandidates.push(chosenCandidate);
  }
  const phase = getMatchPhase({ tick: engine.state.tick, isOvertime: engine.state.isOvertime });
  const elixir = engine.state.elixir[actor]?.elixir ?? 0;
  const hand = typeof engine.getHand === "function" ? engine.getHand(actor) : [];

  return normalizeSample({
    kind: LEGAL_DECISION_SAMPLE_KIND,
    phase,
    elixir,
    hand,
    tick,
    source_tier: sourceTier,
    observation: {
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      vector: encodeStateFeatures({ engine, actor }),
    },
    legal_actions: normalizedCandidates,
    chosen_action_index: chosenCandidate.index,
    chosen_action: chosenCandidate.action,
    reward: 0,
    created_at: Date.now(),
  });
}

export function createDecisionSample({
  engine = null,
  actor = "blue",
  legalActions = null,
  chosenAction = null,
  phase,
  elixir,
  hand,
  cardId,
  tick,
  sourceTier = "human",
}) {
  if (engine && chosenAction && Array.isArray(legalActions)) {
    return createLegalDecisionSample({
      engine,
      actor,
      legalActions,
      chosenAction,
      tick,
      sourceTier,
    });
  }

  return normalizeSample({
    phase,
    elixir,
    hand,
    card_id: cardId,
    tick,
    source_tier: sourceTier,
    created_at: Date.now(),
  });
}

export function appendSamples(store, samples, maxSamples = MAX_TRAINING_SAMPLES) {
  const normalized = normalizeTrainingStore(store);
  const validSamples = Array.isArray(samples)
    ? samples.map((sample) => normalizeSample(sample)).filter((sample) => sample !== null)
    : [];

  const merged = [...normalized.samples, ...validSamples];
  const trimmed = merged.slice(Math.max(0, merged.length - maxSamples));

  return {
    version: TRAINING_DATA_VERSION,
    samples: trimmed,
    updated_at: Date.now(),
  };
}

export function bucketElixir(elixir) {
  const safeElixir = Math.max(0, Math.min(10, Math.floor(Number(elixir) || 0)));
  return Math.floor(safeElixir / 2) * 2;
}

export function makeBucketKey({ phase, elixir }) {
  const phaseKey = typeof phase === "string" && phase.length > 0 ? phase : "normal";
  return `${phaseKey}|${bucketElixir(elixir)}`;
}

export function getLegalDecisionSamples(samples) {
  return (Array.isArray(samples) ? samples : [])
    .map((sample) => normalizeSample(sample))
    .filter((sample) => sample?.kind === LEGAL_DECISION_SAMPLE_KIND);
}

function rankCards(cardCounts, hand) {
  const handSet = new Set(hand);
  const ranked = [];

  for (const [cardId, count] of Object.entries(cardCounts ?? {})) {
    if (!handSet.has(cardId)) {
      continue;
    }
    ranked.push({ card_id: cardId, count: Number(count) || 0 });
  }

  ranked.sort((a, b) => {
    if (a.count !== b.count) {
      return b.count - a.count;
    }
    return a.card_id.localeCompare(b.card_id);
  });

  return ranked;
}

export function trainLegacySelfModel(samples, { minSamples = SELF_MODEL_MIN_SAMPLES } = {}) {
  const normalizedSamples = (Array.isArray(samples) ? samples : [])
    .map((sample) => normalizeSample(sample))
    .filter((sample) => sample !== null && sample.kind === LEGACY_CARD_SAMPLE_KIND);

  const buckets = {};

  for (const sample of normalizedSamples) {
    const key = makeBucketKey({ phase: sample.phase, elixir: sample.elixir });
    if (!buckets[key]) {
      buckets[key] = {
        total: 0,
        cards: {},
      };
    }

    buckets[key].total += 1;
    buckets[key].cards[sample.card_id] = (buckets[key].cards[sample.card_id] ?? 0) + 1;
  }

  return {
    version: SELF_MODEL_VERSION,
    kind: "legacy_card_bucket",
    ready: normalizedSamples.length >= minSamples,
    sample_count: normalizedSamples.length,
    trained_sample_count: normalizedSamples.length,
    min_samples_required: minSamples,
    trained_at: Date.now(),
    buckets,
  };
}

export function getSelfTrainingStatus(
  samples,
  {
    currentModel = null,
    minSamples = SELF_MODEL_MIN_SAMPLES,
    minNewSamples = SELF_MODEL_MIN_NEW_SAMPLES,
  } = {},
) {
  const legalSamples = getLegalDecisionSamples(samples);
  const trainedSampleCount = Math.max(
    0,
    Math.floor(Number(currentModel?.training_config?.trained_sample_count ?? currentModel?.trained_sample_count) || 0),
  );
  const newSampleCount = Math.max(0, legalSamples.length - trainedSampleCount);
  const hasReadyModel = Boolean(currentModel?.ready);
  const needsInitialSamples = legalSamples.length < minSamples;
  const needsNewSamples = hasReadyModel && newSampleCount < minNewSamples;

  return {
    legal_sample_count: legalSamples.length,
    trained_sample_count: trainedSampleCount,
    new_sample_count: newSampleCount,
    min_samples_required: minSamples,
    min_new_samples_required: minNewSamples,
    ready_to_train: !needsInitialSamples && !needsNewSamples,
    reason: needsInitialSamples ? "not_enough_samples" : needsNewSamples ? "not_enough_new_samples" : "ready",
  };
}

function makeModelInputFromCandidate(sample, candidate) {
  const observation = normalizeNumberArray(sample?.observation?.vector);
  const actionFeatures = normalizeNumberArray(candidate?.action_features, ACTION_FEATURE_SIZE);
  if (!observation || !actionFeatures) {
    return null;
  }
  const input = [...observation, ...actionFeatures];
  return input.length === MODEL_INPUT_SIZE ? input : null;
}

function sampleRewardWeight(sample) {
  const reward = Number(sample?.reward) || 0;
  if (reward > 0) {
    return 1.25;
  }
  if (reward < 0) {
    return 0.75;
  }
  return 1;
}

function buildSelfTrainingRows(samples, { maxNegatives = SELF_MODEL_MAX_NEGATIVES } = {}) {
  const rows = [];
  const negativeLimit = Math.max(0, Math.floor(Number(maxNegatives) || 0));

  for (const sample of samples) {
    const candidates = sample.legal_actions;
    const chosen = candidates.find((candidate) => candidate.index === sample.chosen_action_index);
    if (!chosen) {
      continue;
    }

    const chosenInput = makeModelInputFromCandidate(sample, chosen);
    if (chosenInput) {
      rows.push({ input: chosenInput, label: 1, weight: sampleRewardWeight(sample) });
    }

    let negatives = 0;
    for (const candidate of candidates) {
      if (candidate.index === sample.chosen_action_index) {
        continue;
      }
      const input = makeModelInputFromCandidate(sample, candidate);
      if (!input) {
        continue;
      }
      rows.push({ input, label: 0, weight: 1 });
      negatives += 1;
      if (negatives >= negativeLimit) {
        break;
      }
    }
  }

  return rows;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, value))));
}

function fitLinearSigmoid(rows, { epochs = SELF_MODEL_DEFAULT_EPOCHS, learningRate = SELF_MODEL_DEFAULT_LEARNING_RATE } = {}) {
  const weights = Array.from({ length: MODEL_INPUT_SIZE }, () => 0);
  let bias = 0;
  const safeEpochs = Math.max(1, Math.floor(Number(epochs) || SELF_MODEL_DEFAULT_EPOCHS));
  const lr = Number.isFinite(Number(learningRate)) && Number(learningRate) > 0
    ? Number(learningRate)
    : SELF_MODEL_DEFAULT_LEARNING_RATE;

  for (let epoch = 0; epoch < safeEpochs; epoch += 1) {
    for (const row of rows) {
      let score = bias;
      for (let i = 0; i < weights.length; i += 1) {
        score += weights[i] * row.input[i];
      }
      const prediction = sigmoid(score);
      const error = (row.label - prediction) * (Number(row.weight) || 1);
      for (let i = 0; i < weights.length; i += 1) {
        weights[i] += lr * error * row.input[i];
      }
      bias += lr * error;
    }
  }

  return {
    weights: weights.map((value) => Number(value.toFixed(8))),
    bias: Number(bias.toFixed(8)),
  };
}

function makeSelfModelArtifact({
  weights,
  bias,
  sampleCount,
  minSamples,
  rowCount,
  heldoutAccuracy,
  algorithm,
}) {
  return {
    version: NEURAL_MODEL_VERSION,
    kind: NEURAL_MODEL_KIND,
    ready: sampleCount >= minSamples && rowCount > 0,
    sample_count: sampleCount,
    trained_sample_count: sampleCount,
    min_samples_required: minSamples,
    trained_at: Date.now(),
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    action_schema_version: ACTION_SCHEMA_VERSION,
    input_size: MODEL_INPUT_SIZE,
    training_config: {
      algorithm,
      target_tier: "self",
      trained_sample_count: sampleCount,
      row_count: rowCount,
      max_negatives_per_decision: SELF_MODEL_MAX_NEGATIVES,
      heldout_top1_accuracy: heldoutAccuracy,
    },
    layers: [
      {
        type: "dense",
        activation: "sigmoid",
        weights: weights.map((value) => [value]),
        bias: [bias],
      },
    ],
  };
}

export function evaluateSelfImitationAccuracy(model, samples) {
  const normalized = normalizeNeuralPolicyModel(model);
  const legalSamples = getLegalDecisionSamples(samples);
  if (!normalized || legalSamples.length === 0) {
    return null;
  }

  let correct = 0;
  let total = 0;
  for (const sample of legalSamples) {
    let bestIndex = null;
    let bestScore = -Infinity;
    for (const candidate of sample.legal_actions) {
      const input = makeModelInputFromCandidate(sample, candidate);
      if (!input) {
        continue;
      }
      const score = scoreEncodedInput(normalized, input);
      if (Number.isFinite(score) && score > bestScore) {
        bestScore = score;
        bestIndex = candidate.index;
      }
    }
    if (bestIndex === null) {
      continue;
    }
    total += 1;
    if (bestIndex === sample.chosen_action_index) {
      correct += 1;
    }
  }

  return total > 0 ? correct / total : null;
}

export function trainSelfModel(
  samples,
  {
    minSamples = SELF_MODEL_MIN_SAMPLES,
    extraSamples = [],
    epochs = SELF_MODEL_DEFAULT_EPOCHS,
    learningRate = SELF_MODEL_DEFAULT_LEARNING_RATE,
    algorithm = "self_imitation_linear_v1",
  } = {},
) {
  const legalSamples = getLegalDecisionSamples(samples);
  const heldout = legalSamples.filter((_, index) => index % 5 === 4);
  const trainSamples = legalSamples.filter((_, index) => index % 5 !== 4);
  const combinedTrainSamples = [...trainSamples, ...getLegalDecisionSamples(extraSamples)];
  const rows = buildSelfTrainingRows(combinedTrainSamples);
  const fitted = fitLinearSigmoid(rows, { epochs, learningRate });
  const model = makeSelfModelArtifact({
    ...fitted,
    sampleCount: legalSamples.length,
    minSamples,
    rowCount: rows.length,
    heldoutAccuracy: null,
    algorithm,
  });
  const heldoutAccuracy = evaluateSelfImitationAccuracy(model, heldout);
  model.training_config.heldout_top1_accuracy = heldoutAccuracy;
  return model;
}

export function selectCardFromModel(model, { phase, elixir, hand }) {
  if (!model || typeof model !== "object") {
    return null;
  }

  const normalizedHand = normalizeHand(hand);
  if (normalizedHand.length === 0) {
    return null;
  }

  const bucket = model.buckets?.[makeBucketKey({ phase, elixir })];
  if (!bucket) {
    return null;
  }

  const ranked = rankCards(bucket.cards, normalizedHand);
  return ranked[0]?.card_id ?? null;
}

function normalizeSelfScorerModel(model) {
  if (!model || typeof model !== "object" || model.kind !== SELF_MODEL_KIND || Number(model.version) !== SELF_MODEL_VERSION) {
    return null;
  }
  if (model.action_schema_version !== ACTION_SCHEMA_VERSION || model.action_feature_size !== ACTION_FEATURE_SIZE) {
    return null;
  }
  const weights = normalizeNumberArray(model.action_feature_weights, ACTION_FEATURE_SIZE);
  if (!weights) {
    return null;
  }

  return {
    ...model,
    action_feature_weights: weights,
  };
}

function actionSortKey(action) {
  return `${action.cardId}|${Number(action.x).toFixed(2)}|${Number(action.y).toFixed(2)}`;
}

export function selectActionFromSelfModel(model, { engine, actor = "red", legalActions }) {
  if (!engine || !Array.isArray(legalActions) || legalActions.length === 0) {
    return null;
  }

  if (getNeuralModelTargetTier(model) === "self") {
    return selectActionFromNeuralModel(model, { engine, actor, legalActions });
  }

  const normalized = normalizeSelfScorerModel(model);
  if (!normalized) {
    return null;
  }

  let bestAction = null;
  let bestScore = -Infinity;
  let bestKey = "";

  for (const action of legalActions) {
    const features = encodeActionFeatures({ engine, actor, action });
    let score = 0;
    for (let i = 0; i < normalized.action_feature_weights.length; i += 1) {
      score += normalized.action_feature_weights[i] * features[i];
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

export function summarizeTrainingStore(store) {
  const normalized = normalizeTrainingStore(store);
  const legalSampleCount = normalized.samples.filter((sample) => sample.kind === LEGAL_DECISION_SAMPLE_KIND).length;
  return {
    sample_count: normalized.samples.length,
    legal_sample_count: legalSampleCount,
    updated_at: normalized.updated_at,
  };
}
