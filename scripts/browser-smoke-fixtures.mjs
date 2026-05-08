import { createDefaultProfile, normalizeProfile } from "../src/ai/profile.js";
import { trainSelfModelWithRl } from "../src/ai/selfTraining.js";
import { createEmptyTrainingStore, getSelfTrainingStatus, normalizeTrainingStore } from "../src/ai/training.js";
import { runTrainingEpisode } from "../src/ai/trainingData.js";
import { PROFILE_STORAGE_KEY, SELF_MODEL_STORAGE_KEY, TRAINING_STORAGE_KEY } from "../src/client/storageKeys.js";

const FIXTURE_RUN_CONFIG = Object.freeze({
  blueTier: "top",
  redTier: "mid",
  episodes: 16,
  seed: 101,
  maxTicks: 1200,
  maxStoredNegatives: 8,
});

const RL_UNLOCKED_TIERS = Object.freeze(["noob", "mid", "top"]);
const SELF_RUNTIME_UNLOCKED_TIERS = Object.freeze(["noob", "mid", "top", "self"]);
const FIXTURE_UPDATED_AT = Date.parse("2026-05-08T00:00:00Z");

export const BROWSER_SMOKE_STORAGE_KEYS = Object.freeze({
  profile: PROFILE_STORAGE_KEY,
  training: TRAINING_STORAGE_KEY,
  selfModel: SELF_MODEL_STORAGE_KEY,
});

function collectBlueSamples(config = FIXTURE_RUN_CONFIG) {
  const samples = [];
  for (let index = 0; index < config.episodes; index += 1) {
    const episode = runTrainingEpisode({
      blueTier: config.blueTier,
      redTier: config.redTier,
      seed: config.seed + index * 17,
      maxTicks: config.maxTicks,
      maxStoredNegatives: config.maxStoredNegatives,
    });
    samples.push(...episode.samples.filter((sample) => sample.actor === "blue"));
  }
  return samples;
}

function selectFirstCandidate(sample) {
  return sample.legal_actions[0] ?? null;
}

function selectHighestYCandidate(sample) {
  let best = null;
  for (const candidate of sample.legal_actions) {
    if (
      !best ||
      candidate.action.y > best.action.y ||
      (candidate.action.y === best.action.y && candidate.index < best.index)
    ) {
      best = candidate;
    }
  }
  return best;
}

function remapSamples(samples, selectCandidate) {
  return samples.map((sample, index) => {
    const chosen = selectCandidate(sample, index);
    if (!chosen) {
      throw new Error(`Smoke fixture remap could not find legal action for sample ${index}.`);
    }
    return {
      ...sample,
      chosen_action_index: chosen.index,
      chosen_action: chosen.action,
      card_id: chosen.action.card_id,
    };
  });
}

function buildTrainingStore(samples) {
  return normalizeTrainingStore({
    ...createEmptyTrainingStore(),
    samples,
    updated_at: FIXTURE_UPDATED_AT,
  });
}

function buildProfile({
  unlockedTiers = RL_UNLOCKED_TIERS,
  selectedTier = "top",
  totalMatches = 40,
  topWins = 2,
} = {}) {
  const profile = createDefaultProfile();
  return normalizeProfile({
    ...profile,
    unlocked_tiers: [...unlockedTiers],
    selected_tier: selectedTier,
    total_matches: totalMatches,
    wins_by_tier: {
      ...profile.wins_by_tier,
      top: topWins,
    },
    updated_at: FIXTURE_UPDATED_AT,
  });
}

function buildStorageState({ profile, trainingStore, selfModel = null }) {
  const storage = {
    [PROFILE_STORAGE_KEY]: profile,
    [TRAINING_STORAGE_KEY]: trainingStore,
  };

  if (selfModel) {
    storage[SELF_MODEL_STORAGE_KEY] = selfModel;
  }

  return storage;
}

export function buildBrowserSmokeFixtures() {
  const baseSamples = collectBlueSamples();
  const acceptedSamples = remapSamples(baseSamples, (sample) => selectFirstCandidate(sample));
  const acceptedTrainingStore = buildTrainingStore(acceptedSamples);
  const acceptedResult = trainSelfModelWithRl(acceptedTrainingStore.samples, {
    unlockedTiers: RL_UNLOCKED_TIERS,
  });
  if (!acceptedResult.accepted || !acceptedResult.model?.ready) {
    throw new Error("Smoke accepted fixture drifted; expected RL acceptance with ready model.");
  }

  const fallbackSamples = remapSamples(baseSamples, (sample, index) =>
    index % 2 === 0 ? selectFirstCandidate(sample) : selectHighestYCandidate(sample),
  );
  const fallbackTrainingStore = buildTrainingStore(fallbackSamples);
  const fallbackResult = trainSelfModelWithRl(fallbackTrainingStore.samples, {
    unlockedTiers: RL_UNLOCKED_TIERS,
  });
  if (fallbackResult.accepted || fallbackResult.reason !== "style_regression" || !fallbackResult.model?.ready) {
    throw new Error("Smoke fallback fixture drifted; expected ready imitation fallback with style regression.");
  }

  const underThresholdTrainingStore = buildTrainingStore(acceptedTrainingStore.samples.slice(0, 119));
  const underThresholdStatus = getSelfTrainingStatus(underThresholdTrainingStore.samples);
  if (underThresholdStatus.reason !== "not_enough_samples") {
    throw new Error("Smoke under-threshold fixture drifted; expected insufficient legal samples.");
  }

  const rlProfile = buildProfile();
  const selfRuntimeProfile = buildProfile({
    unlockedTiers: SELF_RUNTIME_UNLOCKED_TIERS,
    selectedTier: "self",
    totalMatches: 100,
    topWins: 3,
  });

  return {
    keys: BROWSER_SMOKE_STORAGE_KEYS,
    underThreshold: {
      profile: rlProfile,
      trainingStore: underThresholdTrainingStore,
      selfModel: null,
      storageState: buildStorageState({
        profile: rlProfile,
        trainingStore: underThresholdTrainingStore,
      }),
      expectedStatusMessage: "Need 1 more legal decision samples before self model is ready.",
    },
    rlAccepted: {
      profile: rlProfile,
      trainingStore: acceptedTrainingStore,
      selfModel: null,
      storageState: buildStorageState({
        profile: rlProfile,
        trainingStore: acceptedTrainingStore,
      }),
      result: acceptedResult,
    },
    rlFallback: {
      profile: rlProfile,
      trainingStore: fallbackTrainingStore,
      selfModel: null,
      storageState: buildStorageState({
        profile: rlProfile,
        trainingStore: fallbackTrainingStore,
      }),
      result: fallbackResult,
    },
    selfRuntime: {
      profile: selfRuntimeProfile,
      trainingStore: acceptedTrainingStore,
      selfModel: acceptedResult.model,
      storageState: buildStorageState({
        profile: selfRuntimeProfile,
        trainingStore: acceptedTrainingStore,
        selfModel: acceptedResult.model,
      }),
    },
  };
}
