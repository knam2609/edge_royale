import { createHash } from "node:crypto";
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import {
  enumerateLegalCardActions,
  rollDecisionDelayTicks,
  selectBotAction,
  selectEdgerAction,
} from "../src/ai/botRuntime.js";
import {
  EDGER_V2_POLICY_MODEL_SCHEMA_VERSION,
  selectEdgerV2PolicyDecision,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { validateEdgerPolicyModel } from "../src/ai/mlPolicy.js";
import { createRng } from "../src/sim/random.js";
import {
  cloneProductionInitialCardState,
  createProductionEngine,
} from "../src/sim/productionMatch.js";
import { runReplayToCompletion } from "./edger-corpus-core.mjs";

const modelCache = new Map();

function loadModel(modelPath) {
  if (!modelCache.has(modelPath)) {
    const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
    if (model.schema_version === EDGER_V2_POLICY_MODEL_SCHEMA_VERSION) {
      validateEdgerV2PolicyModel(model);
    } else {
      validateEdgerPolicyModel(model);
    }
    modelCache.set(modelPath, model);
  }
  return modelCache.get(modelPath);
}

function controller(seed) {
  return {
    rng: createRng(seed),
    next_decision_tick: 1,
  };
}

function maybePolicyAction({
  engine,
  actor,
  policy,
  policyController,
  countIllegal = false,
}) {
  const tick = engine.state.tick + 1;
  if (tick < policyController.next_decision_tick) {
    return { action: null, illegal: 0 };
  }
  const legalActions = enumerateLegalCardActions({ engine, actor });
  let selected;
  let delayTicks;
  if (policy.kind === "model") {
    const model = loadModel(policy.model_path);
    if (model.schema_version === EDGER_V2_POLICY_MODEL_SCHEMA_VERSION) {
      const decision = selectEdgerV2PolicyDecision({
        model,
        engine,
        actor,
        legalActions,
      });
      selected = decision.action;
      delayTicks = decision.delayTicks;
    } else {
      selected = selectEdgerAction({
        model,
        engine,
        actor,
        legalActions,
      });
      delayTicks = 1;
    }
  } else {
    selected = selectBotAction({
      botId: policy.policy_id,
      engine,
      actor,
      legalActions,
      rng: policyController.rng,
    });
    delayTicks = rollDecisionDelayTicks({
      botId: policy.policy_id,
      rng: policyController.rng,
    });
  }
  policyController.next_decision_tick = tick + delayTicks;
  if (selected?.type !== "PLAY_CARD") {
    return { action: null, illegal: 0 };
  }
  const legal = legalActions.some(
    (candidate) =>
      candidate.cardId === selected.cardId &&
      candidate.x === selected.x &&
      candidate.y === selected.y,
  );
  const action = {
    tick,
    type: "PLAY_CARD",
    actor,
    cardId: selected.cardId,
    x: selected.x,
    y: selected.y,
  };
  return {
    action: legal ? action : null,
    illegal: countIllegal && !legal ? 1 : 0,
  };
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function replayMatch({ seed, initialCardState, actions, tick, expectedHash, expectedEvents }) {
  const replayed = createProductionEngine({
    seed,
    initialCardState,
  });
  runReplayToCompletion({
    engine: replayed,
    actions,
    finalTick: tick,
  });
  return (
    replayed.getStateHash() === expectedHash &&
    JSON.stringify(replayed.state.replay.events) === JSON.stringify(expectedEvents)
  );
}

function runSpec(spec) {
  const engine = createProductionEngine({ seed: spec.seed });
  const initialCardState = cloneProductionInitialCardState(engine);
  const candidateActor = spec.candidate_actor;
  const opponentActor = candidateActor === "blue" ? "red" : "blue";
  const candidate = controller(spec.seed ^ 0xa5a5a5a5);
  const opponent = controller(spec.seed ^ 0x5f3759df);
  const candidatePolicy = {
    kind: "model",
    model_path: workerData.candidateModelPath,
  };
  const actionStream = [];
  let illegalActions = 0;

  while (engine.state.tick < 6040 && !engine.getMatchResult()) {
    const candidateDecision = maybePolicyAction({
      engine,
      actor: candidateActor,
      policy: candidatePolicy,
      policyController: candidate,
      countIllegal: true,
    });
    const opponentDecision = maybePolicyAction({
      engine,
      actor: opponentActor,
      policy: spec.opponent,
      policyController: opponent,
    });
    const actions = [
      candidateDecision.action,
      opponentDecision.action,
    ].filter(Boolean);
    illegalActions += candidateDecision.illegal;
    actionStream.push(...actions);
    engine.step(actions);
    if (engine.shouldStartOvertime()) {
      engine.setOvertime(true);
    }
  }
  if (!engine.getMatchResult()) {
    throw new Error(`evaluation match ${spec.spec_id} did not finish`);
  }
  const result = engine.getMatchResult();
  const candidatePoint = result.winner === null
    ? 0.5
    : result.winner === candidateActor
      ? 1
      : 0;
  const finalHash = engine.getStateHash();
  const replayPassed = !spec.verify_replay || replayMatch({
    seed: spec.seed,
    initialCardState,
    actions: actionStream,
    tick: result.tick,
    expectedHash: finalHash,
    expectedEvents: engine.state.replay.events,
  });
  return {
    spec_id: spec.spec_id,
    group: spec.group,
    block: spec.block ?? null,
    pair_id: spec.pair_id ?? null,
    repeat_id: spec.repeat_id ?? null,
    opponent_id: spec.opponent.policy_id,
    seed: spec.seed,
    candidate_actor: candidateActor,
    candidate_point: candidatePoint,
    winner: result.winner,
    tick: result.tick,
    action_count: actionStream.length,
    action_stream_hash: hashJson(actionStream),
    final_state_hash: finalHash,
    illegal_actions: illegalActions,
    replay_checked: Boolean(spec.verify_replay),
    replay_passed: replayPassed,
  };
}

try {
  loadModel(workerData.candidateModelPath);
  const results = workerData.specs.map(runSpec);
  parentPort.postMessage({ ok: true, results });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack : String(error),
  });
}
