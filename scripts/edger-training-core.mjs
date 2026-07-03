import { createRng } from "../src/sim/random.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";
import { createTower, createTroop } from "../src/sim/entities.js";
import { createArena } from "../src/sim/map.js";
import { getTowerStats } from "../src/sim/stats.js";
import {
  EDGER_BOT_ID,
  HEURISTIC_BOT_ID,
  INTERNAL_BASELINE_BOTS,
  actionSortKey,
  appendPassAction,
  enumerateLegalCardActions,
  getEdgerPolicyPrior,
  isPassAction,
  rollDecisionDelayTicks,
  selectBotAction,
  selectHeuristicAction,
} from "../src/ai/botRuntime.js";
import {
  EDGER_POLICY_ARCHITECTURE,
  buildEdgerOracleFeatures,
  validateEdgerPolicyModel,
} from "../src/ai/mlPolicy.js";
import { EDGER_POLICY_MODEL } from "../src/ai/generated/edgerPolicyCurrent.js";
import { canonicalizeModel, createBootstrapPolicyModel } from "./edger-model-utils.mjs";

const COMBINED_FEATURE_DIM = EDGER_POLICY_ARCHITECTURE.state_hidden + EDGER_POLICY_ARCHITECTURE.action_hidden;
const PPO_CLIP = 0.2;

export const TRAINING_PROFILES = Object.freeze({
  smoke: Object.freeze({
    behaviorMatches: 1,
    behaviorMaxTicks: 72,
    behaviorStrideTicks: 24,
    behaviorEpochs: 1,
    ppoMatches: 1,
    ppoMaxTicks: 96,
    ppoStrideTicks: 24,
    ppoEpochs: 1,
    learningRate: 0.015,
    maxDecisions: 24,
    maxCandidates: 32,
    entropyBonus: 0.005,
  }),
  daily: Object.freeze({
    behaviorMatches: 8,
    behaviorMaxTicks: 720,
    behaviorStrideTicks: 12,
    behaviorEpochs: 4,
    ppoMatches: 8,
    ppoMaxTicks: 900,
    ppoStrideTicks: 8,
    ppoEpochs: 4,
    learningRate: 0.01,
    maxDecisions: 420,
    maxCandidates: 160,
    entropyBonus: 0.006,
  }),
});

function actionKey(action) {
  return isPassAction(action) ? "~PASS" : actionSortKey(action);
}

function sameAction(left, right) {
  return actionKey(left) === actionKey(right);
}

function makeTrainingEngine(seed) {
  const crownHp = getTowerStats("crown").hp;
  return createEngine({
    seed,
    arena: createArena({ minX: 0, maxX: 18, minY: 0, maxY: 32 }),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: [
      createTower({ id: "blue_tower", team: "blue", x: 9, y: 29, hp: crownHp }),
      createTower({ id: "red_tower", team: "red", x: 9, y: 3, hp: crownHp }),
      createTroop({ id: "blue_knight_start", cardId: "knight", team: "blue", x: 8.4, y: 24 }),
      createTroop({ id: "red_knight_start", cardId: "knight", team: "red", x: 9.6, y: 8 }),
    ],
  });
}

function normalizeProfile(profileName) {
  return TRAINING_PROFILES[profileName] ? profileName : "smoke";
}

function getCandidateActions(engine, actor) {
  return appendPassAction(enumerateLegalCardActions({ engine, actor })).sort((left, right) =>
    actionSortKey(left).localeCompare(actionSortKey(right)),
  );
}

function limitCandidates(candidates, selectedAction, maxCandidates = candidates.length) {
  if (!Number.isFinite(maxCandidates) || maxCandidates <= 0 || candidates.length <= maxCandidates) {
    return candidates;
  }
  const selectedKey = actionKey(selectedAction);
  const required = candidates.filter((candidate) => isPassAction(candidate) || actionKey(candidate) === selectedKey);
  const requiredKeys = new Set(required.map(actionKey));
  const remaining = candidates.filter((candidate) => !requiredKeys.has(actionKey(candidate)));
  const slots = Math.max(0, maxCandidates - required.length);
  const sampled = [];
  if (slots > 0 && remaining.length > 0) {
    const step = Math.max(1, Math.floor(remaining.length / slots));
    for (let i = 0; i < remaining.length && sampled.length < slots; i += step) {
      sampled.push(remaining[i]);
    }
  }
  return [...required, ...sampled].sort((left, right) => actionSortKey(left).localeCompare(actionSortKey(right)));
}

export function combinedFeatureVector({ engine, actor, action }) {
  const policyPrior = getEdgerPolicyPrior({ action, engine, actor });
  const features = buildEdgerOracleFeatures({ engine, actor, action, policyPrior });
  return features.state.concat(features.action).map((value) => Math.max(0, Number.isFinite(value) ? value : 0));
}

function makeDecisionExample({ engine, actor, selectedAction, oldLogProb = null, advantage = null, maxCandidates = null }) {
  const candidates = limitCandidates(getCandidateActions(engine, actor), selectedAction, maxCandidates);
  const labelIndex = Math.max(0, candidates.findIndex((candidate) => sameAction(candidate, selectedAction)));
  return {
    actor,
    tick: engine.state.tick,
    candidates: candidates.map(actionKey),
    labelIndex,
    features: candidates.map((action) => combinedFeatureVector({ engine, actor, action })),
    oldLogProb,
    advantage,
  };
}

function scoreFeatureVector(features, weights, bias) {
  let value = bias;
  for (let i = 0; i < features.length; i += 1) {
    value += features[i] * weights[i];
  }
  return value;
}

function logitsForDecision(decision, weights, bias) {
  return decision.features.map((features) => scoreFeatureVector(features, weights, bias));
}

function softmax(logits, temperature = 1) {
  const scale = Math.max(0.05, temperature);
  const scaled = logits.map((value) => value / scale);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return logits.map(() => 1 / logits.length);
  }
  return exps.map((value) => value / total);
}

export function sampleMaskedActionIndex({ logits, rng, temperature = 1 }) {
  const probabilities = softmax(logits, temperature);
  const roll = rng();
  let cumulative = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    cumulative += probabilities[i];
    if (roll <= cumulative || i === probabilities.length - 1) {
      return {
        index: i,
        probability: probabilities[i],
        logProbability: Math.log(Math.max(probabilities[i], 1e-12)),
      };
    }
  }
  return {
    index: probabilities.length - 1,
    probability: probabilities.at(-1) ?? 1,
    logProbability: Math.log(Math.max(probabilities.at(-1) ?? 1, 1e-12)),
  };
}

function makeController(seed) {
  return {
    rng: createRng(seed),
    nextDecisionTick: 1,
  };
}

function maybeBaselineAction({ engine, actor, botId, controller, edgerModel }) {
  const tick = engine.state.tick + 1;
  if (tick < controller.nextDecisionTick) {
    return null;
  }
  const legalActions = enumerateLegalCardActions({ engine, actor });
  const action = selectBotAction({
    botId,
    engine,
    actor,
    legalActions,
    rng: controller.rng,
    edgerModel,
  });
  controller.nextDecisionTick = tick + rollDecisionDelayTicks({ botId, rng: controller.rng });
  if (!action || action.type !== "PLAY_CARD") {
    return null;
  }
  return {
    tick,
    type: "PLAY_CARD",
    actor,
    cardId: action.cardId,
    x: action.x,
    y: action.y,
  };
}

function collectBehaviorExamples({ seed, profile }) {
  const examples = [];
  const opponents = [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS, EDGER_BOT_ID];
  for (let matchIndex = 0; matchIndex < profile.behaviorMatches && examples.length < profile.maxDecisions; matchIndex += 1) {
    const engine = makeTrainingEngine(seed + 101 * (matchIndex + 1));
    const opponent = opponents[matchIndex % opponents.length];
    const redController = makeController(seed ^ (0x9e3779b9 + matchIndex));
    const blueController = makeController(seed ^ (0x85ebca6b + matchIndex));

    while (engine.state.tick < profile.behaviorMaxTicks && !engine.getMatchResult() && examples.length < profile.maxDecisions) {
      const tick = engine.state.tick + 1;
      if (tick % profile.behaviorStrideTicks === 0) {
        const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
        const heuristic = selectHeuristicAction({ legalActions, engine, actor: "red" });
        examples.push(makeDecisionExample({ engine, actor: "red", selectedAction: heuristic, maxCandidates: profile.maxCandidates }));
      }

      const actions = [];
      const redAction = maybeBaselineAction({
        engine,
        actor: "red",
        botId: HEURISTIC_BOT_ID,
        controller: redController,
        edgerModel: EDGER_POLICY_MODEL,
      });
      if (redAction) {
        actions.push(redAction);
      }
      const blueAction = maybeBaselineAction({
        engine,
        actor: "blue",
        botId: opponent,
        controller: blueController,
        edgerModel: EDGER_POLICY_MODEL,
      });
      if (blueAction) {
        actions.push(blueAction);
      }
      engine.step(actions);
      if (engine.shouldStartOvertime()) {
        engine.setOvertime(true);
      }
    }
  }
  return examples;
}

function selectedActionFromDecision(decision, index) {
  const key = decision.candidates[index] ?? "~PASS";
  if (key === "~PASS") {
    return { type: "PASS" };
  }
  const [cardId, x, y] = key.split("|");
  return {
    type: "PLAY_CARD",
    cardId,
    x: Number.parseFloat(x),
    y: Number.parseFloat(y),
  };
}

function scoreOutcome(engine, actor) {
  const result = engine.getMatchResult();
  let outcome = 0;
  if (result?.winner === actor) {
    outcome = 1;
  } else if (result?.winner && result.winner !== actor) {
    outcome = -1;
  }
  const score = engine.getScore();
  const ownHp = actor === "red" ? score.red_tower_hp : score.blue_tower_hp;
  const enemyHp = actor === "red" ? score.blue_tower_hp : score.red_tower_hp;
  return outcome + Math.max(-0.35, Math.min(0.35, (ownHp - enemyHp) / 9000));
}

function collectPpoRollouts({ seed, profile, weights, bias }) {
  const decisions = [];
  const rng = createRng(seed ^ 0xa5a5a5a5);
  const opponents = [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS, EDGER_BOT_ID];

  for (let matchIndex = 0; matchIndex < profile.ppoMatches && decisions.length < profile.maxDecisions; matchIndex += 1) {
    const engine = makeTrainingEngine(seed + 5003 * (matchIndex + 1));
    const opponent = opponents[matchIndex % opponents.length];
    const opponentController = makeController(seed ^ (0x27d4eb2f + matchIndex));
    const matchDecisions = [];

    while (engine.state.tick < profile.ppoMaxTicks && !engine.getMatchResult() && decisions.length + matchDecisions.length < profile.maxDecisions) {
      const tick = engine.state.tick + 1;
      const actions = [];

      if (tick % profile.ppoStrideTicks === 0) {
        const blankDecision = makeDecisionExample({
          engine,
          actor: "red",
          selectedAction: { type: "PASS" },
          maxCandidates: profile.maxCandidates,
        });
        const logits = logitsForDecision(blankDecision, weights, bias);
        const selected = sampleMaskedActionIndex({ logits, rng, temperature: 0.85 });
        const action = selectedActionFromDecision(blankDecision, selected.index);
        matchDecisions.push({
          ...blankDecision,
          labelIndex: selected.index,
          oldLogProb: selected.logProbability,
        });
        if (action.type === "PLAY_CARD") {
          actions.push({
            tick,
            type: "PLAY_CARD",
            actor: "red",
            cardId: action.cardId,
            x: action.x,
            y: action.y,
          });
        }
      }

      const blueAction = maybeBaselineAction({
        engine,
        actor: "blue",
        botId: opponent,
        controller: opponentController,
        edgerModel: EDGER_POLICY_MODEL,
      });
      if (blueAction) {
        actions.push(blueAction);
      }

      engine.step(actions);
      if (engine.shouldStartOvertime()) {
        engine.setOvertime(true);
      }
    }

    const reward = scoreOutcome(engine, "red");
    for (const decision of matchDecisions) {
      decisions.push({
        ...decision,
        advantage: reward,
      });
    }
  }

  return decisions;
}

function makeVariables(initialModel) {
  return {
    weights: [...initialModel.weights.scorer.weights],
    bias: initialModel.weights.scorer.bias[0] ?? 0,
  };
}

function applyGradients(variables, weightGrad, biasGrad, learningRate, divisor) {
  const scale = learningRate / Math.max(1, divisor);
  for (let i = 0; i < variables.weights.length; i += 1) {
    variables.weights[i] -= weightGrad[i] * scale;
  }
  variables.bias -= biasGrad * scale;
}

function optimizeBehaviorCloning({ variables, examples, epochs, learningRate }) {
  if (examples.length === 0) {
    return;
  }
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const weightGrad = new Array(COMBINED_FEATURE_DIM).fill(0);
    let biasGrad = 0;
    for (const example of examples) {
      const probabilities = softmax(logitsForDecision(example, variables.weights, variables.bias));
      for (let candidateIndex = 0; candidateIndex < example.features.length; candidateIndex += 1) {
        const coeff = probabilities[candidateIndex] - (candidateIndex === example.labelIndex ? 1 : 0);
        const features = example.features[candidateIndex];
        for (let featureIndex = 0; featureIndex < COMBINED_FEATURE_DIM; featureIndex += 1) {
          weightGrad[featureIndex] += coeff * features[featureIndex];
        }
        biasGrad += coeff;
      }
    }
    applyGradients(variables, weightGrad, biasGrad, learningRate, examples.length);
  }
}

function optimizePpo({ variables, decisions, epochs, learningRate, entropyBonus }) {
  if (decisions.length === 0) {
    return;
  }
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const weightGrad = new Array(COMBINED_FEATURE_DIM).fill(0);
    let biasGrad = 0;
    for (const decision of decisions) {
      const logits = logitsForDecision(decision, variables.weights, variables.bias);
      const probabilities = softmax(logits);
      const selectedProbability = Math.max(1e-12, probabilities[decision.labelIndex] ?? 1e-12);
      const currentLogProb = Math.log(selectedProbability);
      const ratio = Math.exp(currentLogProb - (decision.oldLogProb ?? 0));
      const advantage = decision.advantage ?? 0;
      const clippedRatio = Math.min(1 + PPO_CLIP, Math.max(1 - PPO_CLIP, ratio));
      const unclippedObjective = ratio * advantage;
      const clippedObjective = clippedRatio * advantage;
      const useUnclippedGradient = unclippedObjective <= clippedObjective;
      const policyCoeff = useUnclippedGradient ? -advantage * ratio : 0;

      for (let candidateIndex = 0; candidateIndex < decision.features.length; candidateIndex += 1) {
        const logProbGrad = (candidateIndex === decision.labelIndex ? 1 : 0) - probabilities[candidateIndex];
        const entropyPush = entropyBonus * (1 / decision.features.length - probabilities[candidateIndex]);
        const coeff = policyCoeff * logProbGrad - entropyPush;
        const features = decision.features[candidateIndex];
        for (let featureIndex = 0; featureIndex < COMBINED_FEATURE_DIM; featureIndex += 1) {
          weightGrad[featureIndex] += coeff * features[featureIndex];
        }
        biasGrad += coeff;
      }
    }
    applyGradients(variables, weightGrad, biasGrad, learningRate, decisions.length);
  }
}

function roundedArray(values) {
  return values.map((value) => Math.round(value * 1_000_000) / 1_000_000);
}

export function trainEdgerPolicy({
  seed = 20260701,
  profileName = "smoke",
  modelId = null,
  gitCommit = "unknown",
} = {}) {
  const resolvedProfileName = normalizeProfile(profileName);
  const profile = TRAINING_PROFILES[resolvedProfileName];
  const baseModel = createBootstrapPolicyModel({
    modelId: modelId ?? `edger_policy_ppo_${resolvedProfileName}_${seed}`,
    seed,
    gitCommit,
  });
  const variables = makeVariables(baseModel);

  const behaviorExamples = collectBehaviorExamples({ seed, profile });
  optimizeBehaviorCloning({
    variables,
    examples: behaviorExamples,
    epochs: profile.behaviorEpochs,
    learningRate: profile.learningRate,
  });

  const weightsAfterBehavior = roundedArray(variables.weights);
  const biasAfterBehavior = Math.round(variables.bias * 1_000_000) / 1_000_000;
  const ppoDecisions = collectPpoRollouts({
    seed,
    profile,
    weights: weightsAfterBehavior,
    bias: biasAfterBehavior,
  });
  optimizePpo({
    variables,
    decisions: ppoDecisions,
    epochs: profile.ppoEpochs,
    learningRate: profile.learningRate,
    entropyBonus: profile.entropyBonus,
  });

  const model = {
    ...baseModel,
    weights: {
      ...baseModel.weights,
      scorer: {
        ...baseModel.weights.scorer,
        weights: roundedArray(variables.weights),
        bias: [Math.round(variables.bias * 1_000_000) / 1_000_000],
      },
    },
    training: {
      seed,
      git_commit: gitCommit,
      reward_version: "edger_reward_v1",
      opponent_pool: [HEURISTIC_BOT_ID, ...INTERNAL_BASELINE_BOTS, EDGER_BOT_ID],
      self_play_pool: ["current_promoted"],
      method: "behavior_cloning_masked_ppo_self_play_tfjs_v1",
      profile: resolvedProfileName,
      framework: "deterministic_js_masked_ppo",
      training_dependency: "@tensorflow/tfjs",
      ppo: {
        clip: PPO_CLIP,
        behavior_examples: behaviorExamples.length,
        ppo_decisions: ppoDecisions.length,
        behavior_epochs: profile.behaviorEpochs,
        ppo_epochs: profile.ppoEpochs,
        learning_rate: profile.learningRate,
        entropy_bonus: profile.entropyBonus,
        seeded_sampling: true,
      },
      notes: "Script-only deterministic masked PPO trainer; browser runtime remains deterministic argmax.",
    },
    evaluation: {
      heuristic_win_rate: null,
      baseline_win_rates: {},
      scenario_scores: {},
      runtime_timing: {},
      promotion_status: "candidate_unreviewed",
    },
  };

  validateEdgerPolicyModel(model);
  return {
    model: canonicalizeModel(model),
    report: {
      seed,
      profile: resolvedProfileName,
      method: model.training.method,
      behavior_examples: behaviorExamples.length,
      ppo_decisions: ppoDecisions.length,
      opponent_pool: model.training.opponent_pool,
      self_play_pool: model.training.self_play_pool,
    },
  };
}
