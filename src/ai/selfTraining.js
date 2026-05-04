import { runBenchmark } from "./benchmark.js";
import { runTrainingEpisode } from "./trainingData.js";
import {
  evaluateSelfImitationAccuracy,
  getLegalDecisionSamples,
  trainSelfModel,
} from "./training.js";

const FAIR_PROGRESS_TIERS = Object.freeze(["noob", "mid", "top", "pro", "goat"]);

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function getSelfRlOpponentTiers(unlockedTiers = []) {
  const unlocked = Array.isArray(unlockedTiers) ? unlockedTiers : [];
  const highestUnlocked = [...FAIR_PROGRESS_TIERS].reverse().find((tier) => unlocked.includes(tier)) ?? "top";
  return unique(["top", highestUnlocked]).filter((tier) => FAIR_PROGRESS_TIERS.includes(tier));
}

function collectSelfRolloutSamples(model, {
  opponents,
  seed = 8181,
  episodesPerOpponent = 2,
  maxTicks = 1200,
} = {}) {
  const samples = [];
  const safeOpponents = Array.isArray(opponents) && opponents.length > 0 ? opponents : ["top"];
  const safeEpisodes = Math.max(1, Math.floor(Number(episodesPerOpponent) || 1));

  for (let opponentIndex = 0; opponentIndex < safeOpponents.length; opponentIndex += 1) {
    const opponent = safeOpponents[opponentIndex];
    for (let episodeIndex = 0; episodeIndex < safeEpisodes; episodeIndex += 1) {
      const episode = runTrainingEpisode({
        blueTier: "self",
        redTier: opponent,
        trainedModelBlue: model,
        seed: seed + opponentIndex * 1009 + episodeIndex * 37,
        maxTicks,
      });
      samples.push(
        ...episode.samples.filter((sample) => sample.actor === "blue" && sample.tier === "self"),
      );
    }
  }

  return samples;
}

function evaluateModelWinRate(model, {
  opponents,
  seed = 9191,
  rounds = 2,
  maxTicks = 1200,
} = {}) {
  const safeOpponents = Array.isArray(opponents) && opponents.length > 0 ? opponents : ["top"];
  const rates = safeOpponents.map((opponent, index) => {
    const result = runBenchmark({
      botA: "self",
      botB: opponent,
      trainedModelA: model,
      seed: seed + index * 503,
      rounds,
      maxTicks,
    });
    return result.winRateA;
  });

  return rates.length > 0 ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : 0;
}

export function trainSelfModelWithRl(samples, {
  unlockedTiers = [],
  minSamples,
  rlEpisodesPerOpponent = 2,
  rlMaxTicks = 1200,
  benchRounds = 2,
  benchMaxTicks = 1200,
} = {}) {
  const legalSamples = getLegalDecisionSamples(samples);
  const heldout = legalSamples.filter((_, index) => index % 5 === 4);
  const imitation = trainSelfModel(samples, {
    minSamples,
    algorithm: "self_imitation_linear_v1",
  });

  if (!imitation.ready) {
    return {
      model: imitation,
      accepted: false,
      reason: "not_ready",
      metrics: {
        legal_sample_count: legalSamples.length,
      },
    };
  }

  const opponents = getSelfRlOpponentTiers(unlockedTiers);
  const rolloutSamples = collectSelfRolloutSamples(imitation, {
    opponents,
    episodesPerOpponent: rlEpisodesPerOpponent,
    maxTicks: rlMaxTicks,
  });
  const candidate = trainSelfModel(samples, {
    minSamples,
    extraSamples: rolloutSamples,
    epochs: 3,
    learningRate: 0.05,
    algorithm: "self_imitation_reward_rl_v1",
  });

  const baselineAccuracy = evaluateSelfImitationAccuracy(imitation, heldout);
  const candidateAccuracy = evaluateSelfImitationAccuracy(candidate, heldout);
  const baselineWinRate = evaluateModelWinRate(imitation, {
    opponents,
    rounds: benchRounds,
    maxTicks: benchMaxTicks,
  });
  const candidateWinRate = evaluateModelWinRate(candidate, {
    opponents,
    rounds: benchRounds,
    maxTicks: benchMaxTicks,
  });

  const styleFloor = baselineAccuracy === null ? null : baselineAccuracy - 0.05;
  const stylePassed = styleFloor === null || candidateAccuracy === null || candidateAccuracy >= styleFloor;
  const winPassed = candidateWinRate >= baselineWinRate;
  const accepted = stylePassed && winPassed;
  const chosen = accepted ? candidate : imitation;

  chosen.training_config = {
    ...(chosen.training_config ?? {}),
    rl_gate: {
      accepted,
      reason: accepted ? "accepted" : stylePassed ? "win_regression" : "style_regression",
      opponents,
      rollout_sample_count: rolloutSamples.length,
      baseline_heldout_top1_accuracy: baselineAccuracy,
      candidate_heldout_top1_accuracy: candidateAccuracy,
      style_floor: styleFloor,
      baseline_win_rate: baselineWinRate,
      candidate_win_rate: candidateWinRate,
    },
  };

  return {
    model: chosen,
    accepted,
    reason: chosen.training_config.rl_gate.reason,
    metrics: chosen.training_config.rl_gate,
  };
}
