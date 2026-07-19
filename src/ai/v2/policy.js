import {
  EDGER_V2_ACTION_SPACE_VERSION,
  EDGER_V2_BOARD_CHANNELS,
  EDGER_V2_BOARD_HEIGHT,
  EDGER_V2_BOARD_WIDTH,
  EDGER_V2_CARD_ACTIONS,
  EDGER_V2_DELAY_BINS,
  EDGER_V2_GLOBAL_FEATURES,
  EDGER_V2_OBSERVATION_SCHEMA_VERSION,
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
  decodeEdgerV2Action,
} from "./observation.js";

export const EDGER_V2_POLICY_MODEL_SCHEMA_VERSION = "edger_policy_model_v2";
export const EDGER_V2_ACTOR_PARAMETER_LIMIT = 50_000;
export const EDGER_V2_ACTOR_BYTE_LIMIT = 1_000_000;
export const EDGER_V2_ARCHITECTURE = Object.freeze({
  type: "autoregressive_masked_conv_actor",
  board_channels: 16,
  conv_layers: 3,
  conv1_kernel_size: 3,
  conv2_kernel_size: 1,
  conv3_kernel_size: 1,
  global_hidden: 64,
  fused_hidden: 64,
  placement_hidden: 16,
  delay_hidden: 64,
  delay_bins: EDGER_V2_DELAY_BINS,
  activation: "relu",
});

const MODEL_CACHE = new WeakMap();
const CONV_CACHE = new WeakMap();
const MASKED_LOGIT = -1e30;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertFiniteArray(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${label} must be a numeric array of length ${length}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Number.isFinite(value[index])) {
      throw new Error(`${label}[${index}] must be finite`);
    }
  }
}

function validateDense(layer, inputDim, outputDim, label) {
  assertObject(layer, label);
  if (layer.input_dim !== inputDim || layer.output_dim !== outputDim) {
    throw new Error(`${label} dimensions must be ${inputDim}x${outputDim}`);
  }
  assertFiniteArray(layer.weights, inputDim * outputDim, `${label}.weights`);
  assertFiniteArray(layer.bias, outputDim, `${label}.bias`);
}

function validateConv(layer, inputChannels, outputChannels, kernelSize, label) {
  assertObject(layer, label);
  if (
    layer.input_channels !== inputChannels ||
    layer.output_channels !== outputChannels ||
    layer.kernel_size !== kernelSize
  ) {
    throw new Error(
      `${label} dimensions must be ${inputChannels}x${outputChannels}x` +
      `${kernelSize}x${kernelSize}`,
    );
  }
  const weightCount =
    inputChannels *
    outputChannels *
    kernelSize *
    kernelSize;
  assertFiniteArray(layer.weights, weightCount, `${label}.weights`);
  assertFiniteArray(layer.bias, outputChannels, `${label}.bias`);
}

function actorParameterCount(model) {
  const arrays = [
    model.weights.conv1.weights,
    model.weights.conv1.bias,
    model.weights.conv2.weights,
    model.weights.conv2.bias,
    model.weights.conv3.weights,
    model.weights.conv3.bias,
    model.weights.global_encoder.weights,
    model.weights.global_encoder.bias,
    model.weights.fusion.weights,
    model.weights.fusion.bias,
    model.weights.card_head.weights,
    model.weights.card_head.bias,
    model.weights.placement_context.weights,
    model.weights.placement_context.bias,
    model.weights.card_embedding,
    model.weights.placement_scorer.weights,
    model.weights.placement_scorer.bias,
    model.weights.delay_encoder.weights,
    model.weights.delay_encoder.bias,
    model.weights.delay_head.weights,
    model.weights.delay_head.bias,
  ];
  return arrays.reduce((sum, values) => sum + values.length, 0);
}

export function getEdgerV2ActorParameterCount(model) {
  return actorParameterCount(validateEdgerV2PolicyModel(model));
}

export function validateEdgerV2PolicyModel(model) {
  assertObject(model, "model");
  if (model.schema_version !== EDGER_V2_POLICY_MODEL_SCHEMA_VERSION) {
    throw new Error(`model schema_version must be ${EDGER_V2_POLICY_MODEL_SCHEMA_VERSION}`);
  }
  if (model.action_space_version !== EDGER_V2_ACTION_SPACE_VERSION) {
    throw new Error(`model action_space_version must be ${EDGER_V2_ACTION_SPACE_VERSION}`);
  }
  if (model.observation_schema_version !== EDGER_V2_OBSERVATION_SCHEMA_VERSION) {
    throw new Error(`model observation_schema_version must be ${EDGER_V2_OBSERVATION_SCHEMA_VERSION}`);
  }
  assertObject(model.architecture, "model.architecture");
  for (const [key, value] of Object.entries(EDGER_V2_ARCHITECTURE)) {
    if (model.architecture[key] !== value) {
      throw new Error(`model.architecture.${key} must be ${value}`);
    }
  }

  const channels = EDGER_V2_ARCHITECTURE.board_channels;
  const hidden = EDGER_V2_ARCHITECTURE.fused_hidden;
  const placementHidden = EDGER_V2_ARCHITECTURE.placement_hidden;
  assertObject(model.weights, "model.weights");
  validateConv(
    model.weights.conv1,
    EDGER_V2_BOARD_CHANNELS,
    channels,
    EDGER_V2_ARCHITECTURE.conv1_kernel_size,
    "model.weights.conv1",
  );
  validateConv(
    model.weights.conv2,
    channels,
    channels,
    EDGER_V2_ARCHITECTURE.conv2_kernel_size,
    "model.weights.conv2",
  );
  validateConv(
    model.weights.conv3,
    channels,
    channels,
    EDGER_V2_ARCHITECTURE.conv3_kernel_size,
    "model.weights.conv3",
  );
  validateDense(
    model.weights.global_encoder,
    EDGER_V2_GLOBAL_FEATURES,
    EDGER_V2_ARCHITECTURE.global_hidden,
    "model.weights.global_encoder",
  );
  validateDense(
    model.weights.fusion,
    channels + EDGER_V2_ARCHITECTURE.global_hidden,
    hidden,
    "model.weights.fusion",
  );
  validateDense(model.weights.card_head, hidden, EDGER_V2_CARD_ACTIONS.length, "model.weights.card_head");
  validateDense(
    model.weights.placement_context,
    hidden,
    placementHidden,
    "model.weights.placement_context",
  );
  assertFiniteArray(
    model.weights.card_embedding,
    EDGER_V2_CARD_ACTIONS.length * placementHidden,
    "model.weights.card_embedding",
  );
  validateDense(
    model.weights.placement_scorer,
    placementHidden,
    1,
    "model.weights.placement_scorer",
  );
  validateDense(
    model.weights.delay_encoder,
    hidden + channels + placementHidden,
    EDGER_V2_ARCHITECTURE.delay_hidden,
    "model.weights.delay_encoder",
  );
  validateDense(
    model.weights.delay_head,
    EDGER_V2_ARCHITECTURE.delay_hidden,
    EDGER_V2_DELAY_BINS,
    "model.weights.delay_head",
  );

  const parameters = actorParameterCount(model);
  if (parameters > EDGER_V2_ACTOR_PARAMETER_LIMIT) {
    throw new Error(
      `v2 actor has ${parameters} parameters; limit is ${EDGER_V2_ACTOR_PARAMETER_LIMIT}`,
    );
  }
  const serializedBytes = new TextEncoder().encode(JSON.stringify(model)).byteLength;
  if (serializedBytes > EDGER_V2_ACTOR_BYTE_LIMIT) {
    throw new Error(
      `v2 actor JSON is ${serializedBytes} bytes; limit is ${EDGER_V2_ACTOR_BYTE_LIMIT}`,
    );
  }
  return model;
}

function relu(value) {
  return Math.max(0, value);
}

function runDense(input, layer, activate = false) {
  const output = new Float32Array(layer.output_dim);
  for (let outputIndex = 0; outputIndex < layer.output_dim; outputIndex += 1) {
    let value = layer.bias[outputIndex];
    for (let inputIndex = 0; inputIndex < layer.input_dim; inputIndex += 1) {
      value += input[inputIndex] * layer.weights[inputIndex * layer.output_dim + outputIndex];
    }
    output[outputIndex] = activate ? relu(value) : value;
  }
  return output;
}

function compileConv(layer) {
  if (CONV_CACHE.has(layer)) {
    return CONV_CACHE.get(layer);
  }
  const kernels = [];
  for (let kernelY = 0; kernelY < layer.kernel_size; kernelY += 1) {
    for (let kernelX = 0; kernelX < layer.kernel_size; kernelX += 1) {
      const weights = new Float32Array(
        layer.input_channels * layer.output_channels,
      );
      for (let inputChannel = 0; inputChannel < layer.input_channels; inputChannel += 1) {
        for (let outputChannel = 0; outputChannel < layer.output_channels; outputChannel += 1) {
          const sourceOffset =
            (((outputChannel * layer.input_channels + inputChannel) * layer.kernel_size + kernelY) *
              layer.kernel_size) +
            kernelX;
          weights[inputChannel * layer.output_channels + outputChannel] =
            layer.weights[sourceOffset];
        }
      }
      kernels.push(weights);
    }
  }
  CONV_CACHE.set(layer, kernels);
  return kernels;
}

function runConv(input, layer) {
  const output = new Float32Array(
    EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH * layer.output_channels,
  );
  const compiledKernels = compileConv(layer);
  const padding = Math.floor(layer.kernel_size / 2);
  const accumulator = new Float64Array(layer.output_channels);
  for (let row = 0; row < EDGER_V2_BOARD_HEIGHT; row += 1) {
    for (let column = 0; column < EDGER_V2_BOARD_WIDTH; column += 1) {
      accumulator.set(layer.bias);
      for (let kernelY = 0; kernelY < layer.kernel_size; kernelY += 1) {
        const sourceRow = row + kernelY - padding;
        if (sourceRow < 0 || sourceRow >= EDGER_V2_BOARD_HEIGHT) {
          continue;
        }
        for (let kernelX = 0; kernelX < layer.kernel_size; kernelX += 1) {
          const sourceColumn = column + kernelX - padding;
          if (sourceColumn < 0 || sourceColumn >= EDGER_V2_BOARD_WIDTH) {
            continue;
          }
          const sourceBase =
            (sourceRow * EDGER_V2_BOARD_WIDTH + sourceColumn) * layer.input_channels;
          const kernel = compiledKernels[kernelY * layer.kernel_size + kernelX];
          for (let inputChannel = 0; inputChannel < layer.input_channels; inputChannel += 1) {
            const inputValue = input[sourceBase + inputChannel];
            const weightBase = inputChannel * layer.output_channels;
            for (let outputChannel = 0; outputChannel < layer.output_channels; outputChannel += 1) {
              accumulator[outputChannel] +=
                inputValue * kernel[weightBase + outputChannel];
            }
          }
        }
      }
      const outputBase =
        (row * EDGER_V2_BOARD_WIDTH + column) * layer.output_channels;
      for (let outputChannel = 0; outputChannel < layer.output_channels; outputChannel += 1) {
        const outputOffset =
          outputBase + outputChannel;
        output[outputOffset] = relu(accumulator[outputChannel]);
      }
    }
  }
  return output;
}

function meanPool(spatial, channels) {
  const pooled = new Float32Array(channels);
  const cells = EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH;
  for (let cell = 0; cell < cells; cell += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      pooled[channel] += spatial[cell * channels + channel];
    }
  }
  for (let channel = 0; channel < channels; channel += 1) {
    pooled[channel] /= cells;
  }
  return pooled;
}

function concatenate(...arrays) {
  const size = arrays.reduce((sum, array) => sum + array.length, 0);
  const combined = new Float32Array(size);
  let offset = 0;
  for (const array of arrays) {
    combined.set(array, offset);
    offset += array.length;
  }
  return combined;
}

function embeddingForCard(model, cardIndex) {
  const width = EDGER_V2_ARCHITECTURE.placement_hidden;
  return Float32Array.from(
    model.weights.card_embedding.slice(cardIndex * width, (cardIndex + 1) * width),
  );
}

function spatialAt(spatial, placementIndex) {
  const channels = EDGER_V2_ARCHITECTURE.board_channels;
  const offset = placementIndex * channels;
  return spatial.slice(offset, offset + channels);
}

function maskedArgmax(logits, mask) {
  let bestIndex = -1;
  let bestValue = -Infinity;
  for (let index = 0; index < logits.length; index += 1) {
    if (!mask[index]) {
      continue;
    }
    const value = logits[index];
    if (value > bestValue) {
      bestIndex = index;
      bestValue = value;
    }
  }
  return bestIndex >= 0 ? bestIndex : 0;
}

function applyMask(logits, mask) {
  const result = Float32Array.from(logits);
  for (let index = 0; index < result.length; index += 1) {
    if (!mask[index]) {
      result[index] = MASKED_LOGIT;
    }
  }
  return result;
}

function compileModel(model) {
  validateEdgerV2PolicyModel(model);
  return model;
}

function ensureModel(model) {
  if (!MODEL_CACHE.has(model)) {
    MODEL_CACHE.set(model, compileModel(model));
  }
  return MODEL_CACHE.get(model);
}

export function computeEdgerV2Logits({
  model,
  observation,
  legalMasks,
  forcedCardIndex = null,
  forcedPlacementIndex = null,
}) {
  const encodedState = encodeEdgerV2PolicyState({ model, observation });
  const cardLogits = computeEdgerV2CardLogits({
    model,
    encodedState,
    mask: legalMasks.card,
  });
  const cardIndex =
    forcedCardIndex === null ? maskedArgmax(cardLogits, legalMasks.card) : forcedCardIndex;
  const placementMasks = legalMasks.placementByCard
    ? legalMasks.placementByCard[cardIndex]
    : legalMasks.placement;
  const placementMask = placementMasks ?? new Uint8Array(
    EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH,
  ).fill(1);
  const placementLogits = computeEdgerV2PlacementLogits({
    model,
    encodedState,
    cardIndex,
    mask: placementMask,
  });
  const placementIndex = forcedPlacementIndex === null
    ? maskedArgmax(placementLogits, placementMask)
    : forcedPlacementIndex;
  const delayLogits = computeEdgerV2DelayLogits({
    model,
    encodedState,
    cardIndex,
    placementIndex,
    mask: legalMasks.delay,
  });
  return {
    card: cardLogits,
    placement: placementLogits,
    delay: delayLogits,
    selected: {
      card_index: cardIndex,
      placement_index: placementIndex,
      delay_index: maskedArgmax(delayLogits, legalMasks.delay),
    },
  };
}

export function encodeEdgerV2PolicyState({ model, observation }) {
  const checked = ensureModel(model);
  const spatial1 = runConv(observation.board, checked.weights.conv1);
  const spatial2 = runConv(spatial1, checked.weights.conv2);
  const spatial3 = runConv(spatial2, checked.weights.conv3);
  const pooled = meanPool(spatial3, EDGER_V2_ARCHITECTURE.board_channels);
  const globalHidden = runDense(observation.global, checked.weights.global_encoder, true);
  const fused = runDense(
    concatenate(pooled, globalHidden),
    checked.weights.fusion,
    true,
  );
  return { spatial: spatial3, fused };
}

export function computeEdgerV2CardLogits({ model, encodedState, mask }) {
  const checked = ensureModel(model);
  return applyMask(runDense(encodedState.fused, checked.weights.card_head), mask);
}

export function computeEdgerV2PlacementLogits({
  model,
  encodedState,
  cardIndex,
  mask,
}) {
  const checked = ensureModel(model);
  const placementContext = runDense(
    encodedState.fused,
    checked.weights.placement_context,
    true,
  );
  const cardEmbedding = embeddingForCard(checked, cardIndex);
  const placementLogits = new Float32Array(EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH);
  for (let placementIndex = 0; placementIndex < placementLogits.length; placementIndex += 1) {
    const spatial = spatialAt(encodedState.spatial, placementIndex);
    let logit = checked.weights.placement_scorer.bias[0];
    for (let channel = 0; channel < EDGER_V2_ARCHITECTURE.placement_hidden; channel += 1) {
      const hidden = relu(spatial[channel] + placementContext[channel] + cardEmbedding[channel]);
      logit += hidden * checked.weights.placement_scorer.weights[channel];
    }
    placementLogits[placementIndex] = mask[placementIndex] ? logit : MASKED_LOGIT;
  }
  return placementLogits;
}

export function computeEdgerV2DelayLogits({
  model,
  encodedState,
  cardIndex,
  placementIndex,
  mask,
}) {
  const checked = ensureModel(model);
  const cardEmbedding = embeddingForCard(checked, cardIndex);
  const selectedSpatial = spatialAt(encodedState.spatial, placementIndex);
  const delayHidden = runDense(
    concatenate(encodedState.fused, selectedSpatial, cardEmbedding),
    checked.weights.delay_encoder,
    true,
  );
  const rawDelayLogits = runDense(delayHidden, checked.weights.delay_head);
  return applyMask(rawDelayLogits, mask);
}

export function selectEdgerV2PolicyDecision({
  model,
  engine,
  actor = "red",
  legalActions = [],
}) {
  const observation = buildEdgerV2Observation({ engine, actor });
  const cardOnlyMasks = buildEdgerV2LegalMasks({ actor, legalActions });
  const placementByCard = EDGER_V2_CARD_ACTIONS.map((_, cardIndex) =>
    buildEdgerV2LegalMasks({
      actor,
      legalActions,
      selectedCardIndex: cardIndex,
    }).placement,
  );
  const logits = computeEdgerV2Logits({
    model,
    observation,
    legalMasks: {
      ...cardOnlyMasks,
      placementByCard,
    },
  });
  const decoded = decodeEdgerV2Action({
    actor,
    cardIndex: logits.selected.card_index,
    placementIndex: logits.selected.placement_index,
    delayIndex: logits.selected.delay_index,
  });
  return {
    ...decoded,
    indices: logits.selected,
  };
}

function zeros(length) {
  return new Array(length).fill(0);
}

function dense(inputDim, outputDim, bias = null) {
  return {
    input_dim: inputDim,
    output_dim: outputDim,
    weights: zeros(inputDim * outputDim),
    bias: bias ? [...bias] : zeros(outputDim),
  };
}

function conv(inputChannels, outputChannels, kernelSize) {
  return {
    input_channels: inputChannels,
    output_channels: outputChannels,
    kernel_size: kernelSize,
    weights: zeros(
      inputChannels *
      outputChannels *
      kernelSize *
      kernelSize,
    ),
    bias: zeros(outputChannels),
  };
}

export function createEdgerV2BootstrapModel({
  modelId = "edger_policy_v2_shadow_bootstrap",
  seed = 20260718,
  gitCommit = "unknown",
} = {}) {
  const channels = EDGER_V2_ARCHITECTURE.board_channels;
  const hidden = EDGER_V2_ARCHITECTURE.fused_hidden;
  const placementHidden = EDGER_V2_ARCHITECTURE.placement_hidden;
  const cardBias = [0, ...new Array(DEFAULT_CARD_COUNT).fill(-1)];
  const model = {
    model_id: modelId,
    schema_version: EDGER_V2_POLICY_MODEL_SCHEMA_VERSION,
    action_space_version: EDGER_V2_ACTION_SPACE_VERSION,
    observation_schema_version: EDGER_V2_OBSERVATION_SCHEMA_VERSION,
    architecture: { ...EDGER_V2_ARCHITECTURE },
    weights: {
      conv1: conv(
        EDGER_V2_BOARD_CHANNELS,
        channels,
        EDGER_V2_ARCHITECTURE.conv1_kernel_size,
      ),
      conv2: conv(
        channels,
        channels,
        EDGER_V2_ARCHITECTURE.conv2_kernel_size,
      ),
      conv3: conv(
        channels,
        channels,
        EDGER_V2_ARCHITECTURE.conv3_kernel_size,
      ),
      global_encoder: dense(EDGER_V2_GLOBAL_FEATURES, EDGER_V2_ARCHITECTURE.global_hidden),
      fusion: dense(channels + EDGER_V2_ARCHITECTURE.global_hidden, hidden),
      card_head: dense(hidden, EDGER_V2_CARD_ACTIONS.length, cardBias),
      placement_context: dense(hidden, placementHidden),
      card_embedding: zeros(EDGER_V2_CARD_ACTIONS.length * placementHidden),
      placement_scorer: dense(placementHidden, 1),
      delay_encoder: dense(
        hidden + channels + placementHidden,
        EDGER_V2_ARCHITECTURE.delay_hidden,
      ),
      delay_head: dense(
        EDGER_V2_ARCHITECTURE.delay_hidden,
        EDGER_V2_DELAY_BINS,
      ),
    },
    training: {
      seed,
      git_commit: gitCommit,
      method: "shadow_bootstrap_no_heuristic_prior",
      parent_checkpoint: null,
      dataset_manifest_hash: null,
      promotion_status: "shadow_only",
    },
  };
  // The shadow bootstrap has no tactical policy, so avoid an every-tick PASS
  // loop while retaining ascending-delay tie behavior for trained logits.
  model.weights.delay_head.bias[EDGER_V2_DELAY_BINS - 1] = 1;
  return validateEdgerV2PolicyModel(model);
}

const DEFAULT_CARD_COUNT = EDGER_V2_CARD_ACTIONS.length - 1;
