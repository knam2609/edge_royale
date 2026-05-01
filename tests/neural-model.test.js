import test from "node:test";
import assert from "node:assert/strict";

import { makeBenchmarkArena, makeBenchmarkInitialEntities } from "../src/ai/benchmark.js";
import { enumerateLegalCardActions, selectBotAction } from "../src/ai/ladderRuntime.js";
import {
  ACTION_FEATURE_SIZE,
  MODEL_INPUT_SIZE,
  STATE_FEATURE_SIZE,
  encodeActionFeatures,
  encodeModelInput,
  encodeStateFeatures,
} from "../src/ai/neuralFeatures.js";
import {
  createZeroNeuralPolicyModel,
  normalizeNeuralPolicyModel,
  scoreActionWithModel,
  selectActionFromNeuralModel,
} from "../src/ai/neuralModel.js";
import { FIREBALL_CONFIG } from "../src/sim/config.js";
import { createEngine } from "../src/sim/engine.js";

function makeEngine() {
  return createEngine({
    seed: 909,
    arena: makeBenchmarkArena(),
    fireballConfig: FIREBALL_CONFIG,
    initialEntities: makeBenchmarkInitialEntities(),
  });
}

test("neural feature encoders produce stable vector sizes", () => {
  const engine = makeEngine();
  const action = enumerateLegalCardActions({ engine, actor: "red" })[0];

  assert.equal(encodeStateFeatures({ engine, actor: "red" }).length, STATE_FEATURE_SIZE);
  assert.equal(encodeActionFeatures({ engine, actor: "red", action }).length, ACTION_FEATURE_SIZE);
  assert.equal(encodeModelInput({ engine, actor: "red", action }).length, MODEL_INPUT_SIZE);
});

test("neural policy model validates and scores deterministically", () => {
  const engine = makeEngine();
  const action = enumerateLegalCardActions({ engine, actor: "red" })[0];
  const model = createZeroNeuralPolicyModel({ hiddenUnits: 3, seed: 101 });

  assert.ok(normalizeNeuralPolicyModel(model));
  assert.equal(scoreActionWithModel(model, { engine, actor: "red", action }), 0.5);
  assert.equal(scoreActionWithModel(model, { engine, actor: "red", action }), 0.5);
});

test("neural selector returns a legal action and Goat runtime accepts model-backed policy", () => {
  const engine = makeEngine();
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const model = createZeroNeuralPolicyModel({ hiddenUnits: 2, seed: 202 });

  const selected = selectActionFromNeuralModel(model, { engine, actor: "red", legalActions });
  assert.ok(legalActions.some((action) => JSON.stringify(action) === JSON.stringify(selected)));

  const runtimeAction = selectBotAction({
    tierId: "goat",
    engine,
    actor: "red",
    legalActions,
    trainedModel: model,
    rng: () => 0.9,
  });
  assert.ok(legalActions.some((action) => JSON.stringify(action) === JSON.stringify(runtimeAction)));
});
