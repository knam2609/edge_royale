import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import {
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2Logits,
  createEdgerV2BootstrapModel,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import { checkCandidateParity } from "../scripts/edger-v2-evaluation-core.mjs";
import { spawnNativePython } from "../scripts/python-runtime.mjs";

function addSparseNonzeroWeights(model) {
  for (const name of ["conv1", "conv2", "conv3"]) {
    const layer = model.weights[name];
    const diagonal = Math.min(layer.input_channels, layer.output_channels);
    for (let channel = 0; channel < diagonal; channel += 1) {
      const center = Math.floor(layer.kernel_size / 2);
      const offset =
        (((channel * layer.input_channels + channel) * layer.kernel_size + center) *
          layer.kernel_size) +
        center;
      layer.weights[offset] = 0.125;
    }
  }
  const denseLayers = [
    "global_encoder",
    "fusion",
    "placement_context",
    "delay_encoder",
  ];
  for (const name of denseLayers) {
    const layer = model.weights[name];
    for (let index = 0; index < Math.min(layer.input_dim, layer.output_dim); index += 1) {
      layer.weights[index * layer.output_dim + index] = 0.0625;
    }
  }
  model.weights.card_head.weights[0] = 0.25;
  model.weights.card_head.bias[0] = 0.1;
  model.weights.card_embedding[0] = 0.03125;
  model.weights.placement_scorer.weights[0] = 0.5;
  model.weights.delay_head.weights[0] = 0.25;
  model.weights.delay_head.bias[0] = 0.2;
  return model;
}

test("PyTorch and generated-JS v2 logits agree on a golden fixture", { timeout: 30_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-parity-"));
  const model = validateEdgerV2PolicyModel(
    addSparseNonzeroWeights(createEdgerV2BootstrapModel()),
  );
  const engine = createProductionEngine({ seed: 7301 });
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const observation = buildEdgerV2Observation({ engine, actor: "red" });
  const legalMasks = buildEdgerV2LegalMasks({
    actor: "red",
    legalActions,
    selectedCardIndex: 0,
  });
  const js = computeEdgerV2Logits({
    model,
    observation,
    legalMasks,
    forcedCardIndex: 0,
    forcedPlacementIndex: 0,
  });
  const modelPath = path.join(root, "model.json");
  const fixturePath = path.join(root, "fixture.json");
  const resultPath = path.join(root, "pytorch.json");
  fs.writeFileSync(modelPath, JSON.stringify(model));
  fs.writeFileSync(fixturePath, JSON.stringify({
    observation: {
      board: Array.from(observation.board),
      global: Array.from(observation.global),
    },
    legal_masks: {
      card: Array.from(legalMasks.card),
      placement: Array.from(legalMasks.placement),
      delay: Array.from(legalMasks.delay),
    },
    forced_card_index: 0,
    forced_placement_index: 0,
  }));
  const result = spawnNativePython([
    "scripts/edger-v2-training.py",
    "parity",
    "--model",
    modelPath,
    "--fixture",
    fixturePath,
    "--out",
    resultPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const pytorch = JSON.parse(fs.readFileSync(resultPath, "utf8"));

  let maximumDifference = 0;
  for (const head of ["card", "placement", "delay"]) {
    const jsValues = Array.from(js[head]);
    assert.equal(pytorch[head].length, jsValues.length);
    for (let index = 0; index < jsValues.length; index += 1) {
      maximumDifference = Math.max(
        maximumDifference,
        Math.abs(jsValues[index] - pytorch[head][index]),
      );
    }
  }
  assert.ok(maximumDifference <= 1e-5, `maximum logit difference ${maximumDifference}`);
  assert.deepEqual(
    [
      pytorch.card_argmax,
      pytorch.placement_argmax,
      pytorch.delay_argmax,
    ],
    [
      js.selected.card_index,
      js.selected.placement_index,
      js.selected.delay_index,
    ],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("candidate parity compares computed argmax when the forced fixture card is not best", {
  timeout: 30_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-candidate-parity-"));
  const model = createEdgerV2BootstrapModel();
  model.weights.card_head.bias[0] = -10;
  model.weights.card_head.bias[1] = 10;
  const modelPath = path.join(root, "model.json");
  fs.writeFileSync(modelPath, JSON.stringify(model));

  const parity = checkCandidateParity(modelPath, validateEdgerV2PolicyModel(model));

  assert.equal(parity.passed, true, JSON.stringify(parity));
  assert.equal(parity.js_argmax.card, 1);
  assert.equal(parity.pytorch_argmax.card, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
