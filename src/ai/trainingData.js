import { MATCH_CONFIG, FIREBALL_CONFIG, getMatchPhase } from "../sim/config.js";
import { createEngine } from "../sim/engine.js";
import { hashState } from "../sim/hash.js";
import { createRng } from "../sim/random.js";
import {
  appendPassAction,
  enumerateLegalCardActions,
  ACTION_SPACE_VERSION,
  rollDecisionDelayTicks,
  selectBotAction,
} from "./ladderRuntime.js";
import {
  ACTION_SCHEMA_VERSION,
  FEATURE_SCHEMA_VERSION,
  GOD_FEATURE_SCHEMA_VERSION,
  encodeActionFeatures,
  encodeStateFeaturesForSchema,
} from "./neuralFeatures.js";
import { makeBenchmarkArena, makeBenchmarkInitialEntities } from "./benchmark.js";

export const TRAINING_DATASET_SCHEMA_VERSION = "1.0";
export const TRAINING_EPISODE_SCHEMA_VERSION = "1.0";

function normalizeStoredNegativeLimit(maxStoredNegatives) {
  if (maxStoredNegatives === null || maxStoredNegatives === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const normalized = Math.floor(Number(maxStoredNegatives));
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : Number.POSITIVE_INFINITY;
}

function makeController(seed) {
  return {
    rng: createRng(seed),
    nextDecisionTick: 1,
  };
}

function normalizeAction(action) {
  if (!action) {
    return null;
  }
  if (action.type === "PASS") {
    return {
      type: "PASS",
    };
  }
  if (action.type !== "PLAY_CARD") {
    return null;
  }
  return {
    type: "PLAY_CARD",
    card_id: action.cardId,
    x: Math.round(Number(action.x) * 100) / 100,
    y: Math.round(Number(action.y) * 100) / 100,
  };
}

function sameAction(left, right) {
  if (left?.type === "PASS" || right?.type === "PASS") {
    return left?.type === "PASS" && right?.type === "PASS";
  }
  return (
    left?.type === right?.type &&
    left?.cardId === right?.cardId &&
    Math.abs(Number(left?.x) - Number(right?.x)) < 0.001 &&
    Math.abs(Number(left?.y) - Number(right?.y)) < 0.001
  );
}

function rewardForActor(result, actor) {
  const winner = result?.winner ?? null;
  if (!winner) {
    return 0;
  }
  return winner === actor ? 1 : -1;
}

function makeMatchAction({ tick, actor, action }) {
  return {
    tick,
    type: "PLAY_CARD",
    actor,
    cardId: action.cardId,
    x: action.x,
    y: action.y,
  };
}

function getFeatureSchemaForTier(tierId) {
  return tierId === "god" || tierId === "god_oracle" ? GOD_FEATURE_SCHEMA_VERSION : FEATURE_SCHEMA_VERSION;
}

function getSampleTier(tierId) {
  return tierId === "god_oracle" ? "god" : tierId;
}

function selectStoredLegalActions(legalActions, chosenIndex, maxStoredNegatives) {
  const negativeLimit = normalizeStoredNegativeLimit(maxStoredNegatives);
  const negativeIndices = [];
  const passIndex = legalActions.findIndex((action) => action?.type === "PASS");

  if (negativeLimit > 0 && passIndex >= 0 && passIndex !== chosenIndex) {
    negativeIndices.push(passIndex);
  }

  for (let index = 0; index < legalActions.length && negativeIndices.length < negativeLimit; index += 1) {
    if (index === chosenIndex || index === passIndex) {
      continue;
    }
    negativeIndices.push(index);
  }

  return [chosenIndex, ...negativeIndices]
    .sort((left, right) => left - right)
    .map((index) => ({
      action: legalActions[index],
      originalIndex: index,
    }));
}

function maybeSelectActionAndSample({
  engine,
  actor,
  tierId,
  controller,
  samples,
  episodeSeed,
  trainedModel = null,
  maxStoredNegatives = null,
}) {
  const tick = engine.state.tick + 1;
  if (tick < controller.nextDecisionTick) {
    return null;
  }

  const legalActions = appendPassAction(enumerateLegalCardActions({ engine, actor }));
  const decisionDelay = rollDecisionDelayTicks({ tierId, rng: controller.rng });
  controller.nextDecisionTick = tick + decisionDelay;

  const chosenAction = selectBotAction({
    tierId,
    engine,
    actor,
    legalActions,
    rng: controller.rng,
    trainedModel,
  });

  if (!chosenAction) {
    return null;
  }

  const chosenIndex = legalActions.findIndex((candidate) => sameAction(candidate, chosenAction));
  if (chosenIndex >= 0) {
    const phase = getMatchPhase({ tick: engine.state.tick, isOvertime: engine.state.isOvertime });
    const featureSchemaVersion = getFeatureSchemaForTier(tierId);
    const observation = encodeStateFeaturesForSchema({ engine, actor, featureSchemaVersion });
    const storedLegalActions = selectStoredLegalActions(legalActions, chosenIndex, maxStoredNegatives);
    const storedChosenIndex = storedLegalActions.findIndex((candidate) => candidate.originalIndex === chosenIndex);
    samples.push({
      schema_version: TRAINING_EPISODE_SCHEMA_VERSION,
      episode_seed: episodeSeed,
      actor,
      tier: getSampleTier(tierId),
      tick,
      phase,
      observation: {
        feature_schema_version: featureSchemaVersion,
        vector: observation,
      },
      legal_action_count: legalActions.length,
      stored_legal_action_count: storedLegalActions.length,
      legal_actions: storedLegalActions.map(({ action, originalIndex }, index) => ({
        index,
        source_index: originalIndex,
        action: normalizeAction(action),
        action_space_version: ACTION_SPACE_VERSION,
        action_schema_version: ACTION_SCHEMA_VERSION,
        action_features: encodeActionFeatures({ engine, actor, action }),
      })),
      chosen_action_index: storedChosenIndex,
      chosen_action: normalizeAction(chosenAction),
      reward: 0,
    });
  }

  return chosenAction.type === "PLAY_CARD" ? makeMatchAction({ tick, actor, action: chosenAction }) : null;
}

function finalizeSampleRewards(samples, result) {
  return samples.map((sample) => ({
    ...sample,
    reward: rewardForActor(result, sample.actor),
  }));
}

export function runTrainingEpisode({
  blueTier = "goat",
  redTier = "top",
  seed = 1,
  trainedModelBlue = null,
  trainedModelRed = null,
  maxStoredNegatives = null,
  maxTicks = MATCH_CONFIG.regulation_ticks + MATCH_CONFIG.overtime_ticks + 40,
} = {}) {
  const engine = createEngine({
    seed,
    arena: makeBenchmarkArena(),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeBenchmarkInitialEntities(),
  });
  const blue = makeController(seed ^ 0x9e3779b9);
  const red = makeController(seed ^ 0x85ebca6b);
  const samples = [];

  while (engine.state.tick < maxTicks && !engine.getMatchResult()) {
    const actions = [];
    const blueAction = maybeSelectActionAndSample({
      engine,
      actor: "blue",
      tierId: blueTier,
      controller: blue,
      samples,
      episodeSeed: seed,
      trainedModel: trainedModelBlue,
      maxStoredNegatives,
    });
    if (blueAction) {
      actions.push(blueAction);
    }

    const redAction = maybeSelectActionAndSample({
      engine,
      actor: "red",
      tierId: redTier,
      controller: red,
      samples,
      episodeSeed: seed,
      trainedModel: trainedModelRed,
      maxStoredNegatives,
    });
    if (redAction) {
      actions.push(redAction);
    }

    engine.step(actions);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }

  const result = engine.getMatchResult();
  const finalSamples = finalizeSampleRewards(samples, result);

  return {
    schema_version: TRAINING_EPISODE_SCHEMA_VERSION,
    episode_id: `${seed}:${blueTier}:vs:${redTier}`,
    seed,
    blue_tier: blueTier,
    red_tier: redTier,
    max_ticks: maxTicks,
    final_tick: engine.state.tick,
    result,
    score: engine.getScore(),
    state_hash: engine.getStateHash(),
    replay_hash: hashState(engine.state.replay),
    actions: engine.state.replay.actions,
    samples: finalSamples,
  };
}

export function replayTrainingEpisode(episode) {
  const engine = createEngine({
    seed: episode.seed,
    arena: makeBenchmarkArena(),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeBenchmarkInitialEntities(),
  });
  const actionsByTick = new Map();
  for (const action of Array.isArray(episode.actions) ? episode.actions : []) {
    const list = actionsByTick.get(action.tick) ?? [];
    list.push(action);
    actionsByTick.set(action.tick, list);
  }

  const finalTick = Math.max(0, Math.floor(Number(episode.final_tick) || 0));
  while (engine.state.tick < finalTick && !engine.getMatchResult()) {
    engine.step(actionsByTick.get(engine.state.tick + 1) ?? []);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }

  return {
    result: engine.getMatchResult(),
    score: engine.getScore(),
    final_tick: engine.state.tick,
    state_hash: engine.getStateHash(),
    replay_hash: hashState(engine.state.replay),
  };
}

export function hashTrainingDataset(dataset) {
  const { dataset_hash: _datasetHash, ...withoutHash } = dataset ?? {};
  return hashState(withoutHash);
}

export function hashTrainingDatasetCorpus(datasetHashes) {
  const orderedHashes = Array.isArray(datasetHashes)
    ? datasetHashes.filter((hash) => typeof hash === "string" && hash.length > 0)
    : [];
  return hashState({
    schema_version: TRAINING_DATASET_SCHEMA_VERSION,
    kind: "training_dataset_corpus_v1",
    dataset_hashes: orderedHashes,
  });
}

export function generateTrainingDataset({
  tiers = ["top", "goat"],
  seed = 303,
  episodes = 8,
  maxTicks = 900,
  maxStoredNegatives = null,
} = {}) {
  const normalizedTiers = Array.isArray(tiers) && tiers.length > 0 ? tiers : ["top", "goat"];
  const rng = createRng(seed);
  const generatedEpisodes = [];

  for (let i = 0; i < episodes; i += 1) {
    const blueTier = normalizedTiers[i % normalizedTiers.length];
    const redTier = normalizedTiers[(i + 1) % normalizedTiers.length] ?? blueTier;
    const episodeSeed = 1 + Math.floor(rng() * 2_000_000_000);
    generatedEpisodes.push(
      runTrainingEpisode({
        blueTier,
        redTier,
        seed: episodeSeed,
        maxTicks,
        maxStoredNegatives,
      }),
    );
  }

  const dataset = {
    schema_version: TRAINING_DATASET_SCHEMA_VERSION,
    generator: "edge_royale_psro_lite_v1",
    seed,
    tiers: [...normalizedTiers],
    episodes_requested: episodes,
    max_ticks: maxTicks,
    action_space_version: ACTION_SPACE_VERSION,
    ...(Number.isFinite(normalizeStoredNegativeLimit(maxStoredNegatives))
      ? { max_stored_negatives: normalizeStoredNegativeLimit(maxStoredNegatives) }
      : {}),
    episode_count: generatedEpisodes.length,
    sample_count: generatedEpisodes.reduce((sum, episode) => sum + episode.samples.length, 0),
    episodes: generatedEpisodes,
  };

  return {
    ...dataset,
    dataset_hash: hashTrainingDataset(dataset),
  };
}
