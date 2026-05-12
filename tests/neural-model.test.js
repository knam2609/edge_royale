import test from "node:test";
import assert from "node:assert/strict";

import { makeBenchmarkArena, makeBenchmarkInitialEntities } from "../src/ai/benchmark.js";
import { enumerateLegalCardActions, selectBotAction } from "../src/ai/ladderRuntime.js";
import {
  ACTION_FEATURE_SIZE,
  GOD_FEATURE_SCHEMA_VERSION,
  GOD_MODEL_INPUT_SIZE,
  GOD_STATE_FEATURE_SIZE,
  LEGACY_ACTION_FEATURE_SIZE,
  LEGACY_ACTION_SCHEMA_VERSION,
  MODEL_INPUT_SIZE,
  STATE_FEATURE_SIZE,
  encodeActionFeatures,
  encodeGodStateFeatures,
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
  const passAction = { type: "PASS" };

  assert.equal(encodeStateFeatures({ engine, actor: "red" }).length, STATE_FEATURE_SIZE);
  assert.equal(encodeGodStateFeatures({ engine, actor: "red" }).length, GOD_STATE_FEATURE_SIZE);
  assert.equal(encodeActionFeatures({ engine, actor: "red", action }).length, ACTION_FEATURE_SIZE);
  assert.equal(
    encodeActionFeatures({
      engine,
      actor: "red",
      action,
      actionSchemaVersion: LEGACY_ACTION_SCHEMA_VERSION,
    }).length,
    LEGACY_ACTION_FEATURE_SIZE,
  );
  assert.equal(encodeActionFeatures({ engine, actor: "red", action: passAction }).length, ACTION_FEATURE_SIZE);
  assert.equal(encodeActionFeatures({ engine, actor: "red", action: passAction }).at(-1), 1);
  assert.equal(encodeModelInput({ engine, actor: "red", action }).length, MODEL_INPUT_SIZE);
  assert.equal(
    encodeModelInput({ engine, actor: "red", action, featureSchemaVersion: GOD_FEATURE_SCHEMA_VERSION }).length,
    GOD_MODEL_INPUT_SIZE,
  );
});

test("neural policy model validates and scores deterministically", () => {
  const engine = makeEngine();
  const action = enumerateLegalCardActions({ engine, actor: "red" })[0];
  const model = createZeroNeuralPolicyModel({ hiddenUnits: 3, seed: 101 });

  assert.ok(normalizeNeuralPolicyModel(model));
  assert.equal(scoreActionWithModel(model, { engine, actor: "red", action }), 0.5);
  assert.equal(scoreActionWithModel(model, { engine, actor: "red", action }), 0.5);
});

test("legacy neural policy model stays readable and ignores synthetic pass candidates", () => {
  const engine = makeEngine();
  const action = enumerateLegalCardActions({ engine, actor: "red" })[0];
  const model = createZeroNeuralPolicyModel({
    hiddenUnits: 2,
    seed: 151,
    actionSchemaVersion: LEGACY_ACTION_SCHEMA_VERSION,
  });

  assert.ok(normalizeNeuralPolicyModel(model));
  const selected = selectActionFromNeuralModel(model, {
    engine,
    actor: "red",
    legalActions: [action, { type: "PASS" }],
  });

  assert.deepEqual(selected, action);
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

test("pass-aware neural selector can choose PASS deterministically", () => {
  const engine = makeEngine();
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const model = createZeroNeuralPolicyModel({ hiddenUnits: 1, seed: 252, targetTier: "mid" });
  model.layers[0].weights[STATE_FEATURE_SIZE + ACTION_FEATURE_SIZE - 1][0] = 6;
  model.layers[1].weights[0][0] = 6;

  const selected = selectActionFromNeuralModel(model, {
    engine,
    actor: "red",
    legalActions: [...legalActions, { type: "PASS" }],
  });

  assert.deepEqual(selected, { type: "PASS" });
});

test("God runtime accepts hidden-schema model-backed policy", () => {
  const engine = makeEngine();
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const model = createZeroNeuralPolicyModel({
    hiddenUnits: 2,
    seed: 303,
    featureSchemaVersion: GOD_FEATURE_SCHEMA_VERSION,
    targetTier: "god",
  });

  assert.ok(normalizeNeuralPolicyModel(model));
  const action = selectBotAction({
    tierId: "god",
    engine,
    actor: "red",
    legalActions,
    trainedModel: model,
    rng: () => 0.9,
  });

  assert.ok(legalActions.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action)));
});
