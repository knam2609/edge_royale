import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import {
  HEURISTIC_BOT_ID,
  enumerateLegalCardActions,
  rollDecisionDelayTicks,
  selectBotAction,
  selectEdgerAction,
} from "../src/ai/botRuntime.js";
import { validateEdgerPolicyModel } from "../src/ai/mlPolicy.js";
import {
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
  decodeEdgerV2Action,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2CardLogits,
  computeEdgerV2DelayLogits,
  computeEdgerV2PlacementLogits,
  encodeEdgerV2PolicyState,
  selectEdgerV2PolicyDecision,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { createRng } from "../src/sim/random.js";
import {
  cloneProductionInitialCardState,
  createProductionEngine,
} from "../src/sim/productionMatch.js";
import {
  createTrainingEpisode,
  storeTrainingEpisode,
} from "./edger-corpus-core.mjs";

const modelCache = new Map();

function loadModel(modelPath) {
  if (!modelCache.has(modelPath)) {
    const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
    if (model.schema_version === "edger_policy_model_v2") {
      validateEdgerV2PolicyModel(model);
    } else {
      validateEdgerPolicyModel(model);
    }
    modelCache.set(modelPath, model);
  }
  return modelCache.get(modelPath);
}

function sampleMasked(logits, mask, rng, temperature) {
  const valid = [];
  let maximum = -Infinity;
  for (let index = 0; index < logits.length; index += 1) {
    if (!mask[index]) {
      continue;
    }
    const scaled = logits[index] / Math.max(0.05, temperature);
    valid.push({ index, scaled });
    maximum = Math.max(maximum, scaled);
  }
  if (valid.length === 0) {
    return { index: 0, logProbability: 0 };
  }
  let total = 0;
  for (const item of valid) {
    item.weight = Math.exp(item.scaled - maximum);
    total += item.weight;
  }
  const roll = rng() * total;
  let cumulative = 0;
  for (const item of valid) {
    cumulative += item.weight;
    if (roll <= cumulative) {
      return {
        index: item.index,
        logProbability: Math.log(Math.max(1e-12, item.weight / total)),
      };
    }
  }
  const last = valid.at(-1);
  return {
    index: last.index,
    logProbability: Math.log(Math.max(1e-12, last.weight / total)),
  };
}

function sampleMainDecision({
  model,
  engine,
  actor,
  rng,
  temperature,
}) {
  const legalActions = enumerateLegalCardActions({ engine, actor });
  const observation = buildEdgerV2Observation({ engine, actor });
  const encodedState = encodeEdgerV2PolicyState({ model, observation });
  const cardMasks = buildEdgerV2LegalMasks({
    actor,
    legalActions,
    selectedCardIndex: 0,
  });
  const cardLogits = computeEdgerV2CardLogits({
    model,
    encodedState,
    mask: cardMasks.card,
  });
  const card = sampleMasked(
    cardLogits,
    cardMasks.card,
    rng,
    temperature,
  );
  const masks = buildEdgerV2LegalMasks({
    actor,
    legalActions,
    selectedCardIndex: card.index,
  });
  const placementLogits = computeEdgerV2PlacementLogits({
    model,
    encodedState,
    cardIndex: card.index,
    mask: masks.placement,
  });
  const placement = sampleMasked(
    placementLogits,
    masks.placement,
    rng,
    temperature,
  );
  const delayLogits = computeEdgerV2DelayLogits({
    model,
    encodedState,
    cardIndex: card.index,
    placementIndex: placement.index,
    mask: masks.delay,
  });
  const delay = sampleMasked(
    delayLogits,
    masks.delay,
    rng,
    temperature,
  );
  const decoded = decodeEdgerV2Action({
    actor,
    cardIndex: card.index,
    placementIndex: placement.index,
    delayIndex: delay.index,
  });
  return {
    ...decoded,
    behaviorLogProbability:
      card.logProbability +
      (card.index === 0 ? 0 : placement.logProbability) +
      delay.logProbability,
  };
}

function makeOpponentController(seed) {
  return {
    rng: createRng(seed),
    nextDecisionTick: 1,
  };
}

function maybeOpponentDecision({
  engine,
  actor,
  opponent,
  controller,
}) {
  const tick = engine.state.tick + 1;
  if (tick < controller.nextDecisionTick) {
    return null;
  }
  if (opponent.kind === "model") {
    const model = loadModel(opponent.model_path);
    const legalActions = enumerateLegalCardActions({ engine, actor });
    const decision = model.schema_version === "edger_policy_model_v2"
      ? selectEdgerV2PolicyDecision({
          model,
          engine,
          actor,
          legalActions,
        })
      : {
          action: selectEdgerAction({
            model,
            engine,
            actor,
            legalActions,
          }),
          delayTicks: 1,
        };
    controller.nextDecisionTick = tick + decision.delayTicks;
    return decision.action?.type === "PLAY_CARD"
      ? {
          tick,
          type: "PLAY_CARD",
          actor,
          cardId: decision.action.cardId,
          x: decision.action.x,
          y: decision.action.y,
        }
      : null;
  }

  const legalActions = enumerateLegalCardActions({ engine, actor });
  const delay = rollDecisionDelayTicks({
    botId: opponent.policy_id,
    rng: controller.rng,
  });
  controller.nextDecisionTick = tick + delay;
  const selected = selectBotAction({
    botId: opponent.policy_id,
    engine,
    actor,
    legalActions,
    rng: controller.rng,
  });
  return selected?.type === "PLAY_CARD"
    ? {
        tick,
        type: "PLAY_CARD",
        actor,
        cardId: selected.cardId,
        x: selected.x,
        y: selected.y,
      }
    : null;
}

function runSpec(spec) {
  const model = loadModel(workerData.mainModelPath);
  const engine = createProductionEngine({ seed: spec.seed });
  const initialCardState = cloneProductionInitialCardState(engine);
  const mainRng = createRng(spec.seed ^ 0xa5a5a5a5);
  const opponentController = makeOpponentController(spec.seed ^ 0x5f3759df);
  const mainActor = spec.main_actor;
  const opponentActor = mainActor === "blue" ? "red" : "blue";
  let mainNextDecisionTick = 1;
  const decisions = [];

  while (engine.state.tick < 6040 && !engine.getMatchResult()) {
    const tick = engine.state.tick + 1;
    const actions = [];
    if (tick >= mainNextDecisionTick) {
      const decision = sampleMainDecision({
        model,
        engine,
        actor: mainActor,
        rng: mainRng,
        temperature: workerData.temperature,
      });
      decisions.push({
        tick,
        actor: mainActor,
        action: decision.action,
        delay_ticks: decision.delayTicks,
        behavior_log_probability: decision.behaviorLogProbability,
        opponent_stratum: spec.opponent.policy_id,
      });
      mainNextDecisionTick = tick + decision.delayTicks;
      if (decision.action.type === "PLAY_CARD") {
        actions.push({
          tick,
          type: "PLAY_CARD",
          actor: mainActor,
          cardId: decision.action.cardId,
          x: decision.action.x,
          y: decision.action.y,
        });
      }
    }
    const opponentAction = maybeOpponentDecision({
      engine,
      actor: opponentActor,
      opponent: spec.opponent,
      controller: opponentController,
    });
    if (opponentAction) {
      actions.push(opponentAction);
    }
    engine.step(actions);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }
  if (!engine.getMatchResult()) {
    throw new Error(`league match ${spec.match_index} did not finish`);
  }

  const policies = {
    [mainActor]: {
      policy_id: workerData.mainPolicyId,
      checkpoint_id: workerData.mainCheckpointId,
      behavior_probabilities: "known",
      league_rating: workerData.mainLeagueRating,
    },
    [opponentActor]: {
      policy_id: spec.opponent.policy_id,
      checkpoint_id: spec.opponent.checkpoint_id ?? null,
      behavior_probabilities: "unknown",
      league_rating: spec.opponent.league_rating ?? null,
    },
  };
  const episode = createTrainingEpisode({
    seed: spec.seed,
    initialCardState,
    actions: engine.state.replay.actions,
    events: engine.state.replay.events,
    result: engine.getMatchResult(),
    finalStateHash: engine.getStateHash(),
    policies,
    source: {
      kind: "simulator",
      collector: "edger_impala_actor_v1",
    },
    decisions,
  });
  const stored = storeTrainingEpisode({
    episode,
    store: workerData.store,
    verifyReplay: true,
  });
  return {
    match_index: spec.match_index,
    seed: spec.seed,
    main_actor: mainActor,
    opponent: spec.opponent.policy_id,
    winner: episode.result.winner,
    episode_id: episode.episode_id,
    uri: stored.uri,
    decisions: decisions.length,
  };
}

try {
  const results = workerData.specs.map(runSpec);
  parentPort.postMessage({ ok: true, results });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack : String(error),
  });
}
