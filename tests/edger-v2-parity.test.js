import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { enumerateLegalCardActions, selectBotDecision } from "../src/ai/botRuntime.js";
import {
  EDGER_FULL_GRID_ACTION_SPACE_VERSION,
  EDGER_V2_CARD_ACTIONS,
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2Logits,
  createEdgerV2BootstrapModel,
  selectEdgerV2PolicyDecision,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { DEFAULT_DECK } from "../src/sim/cards.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import {
  EDGER_V2_PARITY_TOLERANCE,
  EDGER_V2_PARITY_ULP_MULTIPLE,
  buildCandidateParityFixtures,
  checkCandidateParity,
  compareCandidateParity,
  edgerV2ParityTolerance,
  float32Ulp,
} from "../scripts/edger-v2-evaluation-core.mjs";
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

test("learned full-grid coordinates rank new placements in JavaScript and PyTorch", {
  timeout: 30_000,
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-full-grid-parity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = createEdgerV2BootstrapModel();
  model.action_space_version = EDGER_FULL_GRID_ACTION_SPACE_VERSION;
  model.weights.placement_coordinates = new Array(32).fill(0);
  model.weights.placement_coordinates[0] = 1;
  model.weights.placement_coordinates[1] = -0.25;
  model.weights.placement_context.bias[0] = 2;
  model.weights.placement_scorer.weights[0] = 1;
  model.weights.card_head.bias[EDGER_V2_CARD_ACTIONS.indexOf("giant")] = 10;
  const hand = DEFAULT_DECK.slice(0, 4);
  const cards = { hand, draw_pile: DEFAULT_DECK.slice(4) };
  for (const [actor, x, y] of [["red", 0.5, 14.5], ["blue", 17.5, 17.5]]) {
    const engine = createProductionEngine({ initialCardState: { red: cards, blue: cards } });
    const legalActions = enumerateLegalCardActions({ engine, actor, model });
    const { action } = selectEdgerV2PolicyDecision({ engine, actor, model, legalActions });
    assert.deepEqual(action, { type: "PLAY_CARD", cardId: "giant", x, y });
    const gameplay = selectBotDecision({
      engine, actor, edgerModel: model, legalActions: enumerateLegalCardActions({ engine, actor }),
    });
    assert.deepEqual(gameplay.action, action);
    engine.step([{ ...action, actor, tick: 1 }]);
    assert.equal(engine.state.replay.actions.length, 1);
  }

  const modelPath = path.join(root, "model.json");
  fs.writeFileSync(modelPath, JSON.stringify(model));
  const parity = checkCandidateParity(modelPath, model);
  assert.equal(parity.passed, true, JSON.stringify(parity));
  assert.equal(parity.tie_set_agreement, true);
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
  assert.equal(parity.heads.card.maximum_legal_logit_magnitude, 10);
  assert.ok(parity.heads.card.maximum_logit_difference <= 1e-5);
  fs.rmSync(root, { recursive: true, force: true });
});

function denseWeights(model, scale = 1) {
  let seed = 91;
  const weight = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296 - 0.5) * 0.25;
  };
  for (const layer of Object.values(model.weights)) {
    for (const values of Array.isArray(layer) ? [layer] : [layer.weights, layer.bias]) {
      values.forEach((_, index) => { values[index] = weight(); });
    }
  }
  for (const head of ["card_head", "placement_scorer", "delay_head"]) {
    const layer = model.weights[head];
    layer.weights.forEach((value, index) => { layer.weights[index] = value * scale; });
    layer.bias.forEach((value, index) => { layer.bias[index] = value * scale; });
  }
  return model;
}

test("dense nonzero v2 weights retain the strict absolute parity tolerance", { timeout: 60_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-dense-parity-"));
  try {
    const model = denseWeights(createEdgerV2BootstrapModel());
    const modelPath = path.join(root, "dense.json");
    fs.writeFileSync(modelPath, JSON.stringify(model));
    const parity = checkCandidateParity(modelPath, model);
    assert.equal(parity.passed, true, JSON.stringify(parity.reason ?? null));
    assert.equal(parity.tolerance, 1e-5);
    assert.ok(parity.card_indices_covered.some((index) => index > 0));
    for (const head of ["card", "placement", "delay"]) {
      assert.ok(parity.heads[head].maximum_logit_difference <= 1e-5);
    }
    assert.ok(parity.fixtures.every((fixture) => fixture.argmax_agreement));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The runtime and reference differ only in the PASS bias, so every PASS logit
// differs by exactly `ulps` float32 ULP at magnitude 1024 in both runtimes.
function checkPassBiasOffset(ulps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-parity-offset-"));
  try {
    const runtime = createEdgerV2BootstrapModel();
    runtime.weights.card_head.bias[0] = 1024;
    const reference = structuredClone(runtime);
    reference.weights.card_head.bias[0] = 1024 + ulps * float32Ulp(1024);
    const modelPath = path.join(root, "reference.json");
    fs.writeFileSync(modelPath, JSON.stringify(reference));
    return checkCandidateParity(modelPath, runtime);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("matching argmax does not excuse a logit error beyond 4 float32 ULP", { timeout: 30_000 }, () => {
  const parity = checkPassBiasOffset(5);
  assert.equal(parity.argmax_agreement, true);
  assert.equal(parity.tie_set_agreement, true);
  assert.equal(parity.passed, false);
  assert.match(parity.reason, /exceeded tolerance/);
  const worst = parity.worst_absolute_error;
  assert.equal(worst.absolute_difference, parity.maximum_logit_difference);
  assert.equal(worst.ulp_error, 5);
  assert.equal(parity.worst_tolerance_error.tolerance_ratio, 5 / 4);
});

test("a 4 float32 ULP error above magnitude 32 passes although it exceeds 1e-5", { timeout: 30_000 }, () => {
  const parity = checkPassBiasOffset(4);
  assert.equal(parity.passed, true, JSON.stringify(parity.reason ?? null));
  assert.equal(parity.maximum_logit_difference, 4 * float32Ulp(1024));
  assert.ok(parity.maximum_logit_difference > 1e-5);
  assert.equal(parity.worst_tolerance_error.tolerance_ratio, 1);
  assert.equal(parity.tolerance, 1e-5);
  assert.equal(parity.ulp_tolerance_multiple, 4);
});

test("parity covers mid-match states, not only the opening position", () => {
  const model = validateEdgerV2PolicyModel(
    addSparseNonzeroWeights(createEdgerV2BootstrapModel()),
  );
  const fixtures = buildCandidateParityFixtures(model);
  assert.ok(fixtures.length > 1, `expected a fixture bank, got ${fixtures.length}`);
  assert.match(fixtures[0].id, /^opening-/);
  const midMatch = fixtures.filter((fixture) => /-tick(?!1$)\d+$/.test(fixture.id));
  assert.ok(midMatch.length >= 6, `expected mid-match fixtures, got ${midMatch.length}`);
  const plays = fixtures.filter((fixture) => fixture.payload.forced_card_index > 0);
  assert.ok(plays.length > 0, "must exercise card-conditioned play branches");
  assert.ok(plays.some((fixture) => fixture.payload.legal_masks.placement.reduce((a, b) => a + b, 0) > 1));
  assert.ok(plays.some((fixture) => fixture.payload.forced_placement_index > 0));
  for (const fixture of plays) {
    assert.equal(fixture.payload.legal_masks.card[fixture.payload.forced_card_index], 1);
    assert.equal(fixture.payload.legal_masks.placement[fixture.payload.forced_placement_index], 1);
    assert.equal(fixture.payload.forced_placement_index, fixture.js.selected.placement_index);
  }
  // The bank must be reproducible so a rejected report can be re-derived.
  assert.deepEqual(
    buildCandidateParityFixtures(model).map((fixture) => fixture.id),
    fixtures.map((fixture) => fixture.id),
  );
});

test("float32 ULP is the exact spacing at the measured logit magnitude", () => {
  assert.equal(float32Ulp(1), 2 ** -23);
  assert.equal(float32Ulp(0.8166071176528931), 2 ** -24);
  assert.equal(float32Ulp(1519.18), 0.0001220703125);
  assert.equal(float32Ulp(489_964_320), 32);
  assert.equal(float32Ulp(0), 2 ** -149);
});

test("parity tolerance is exactly 1e-5 below magnitude 32 and 4 float32 ULP above", () => {
  assert.equal(EDGER_V2_PARITY_TOLERANCE, 1e-5);
  assert.equal(EDGER_V2_PARITY_ULP_MULTIPLE, 4);
  for (const magnitude of [0, 1e-3, 0.5, 1, 16, 32 - 2 ** -19]) {
    assert.equal(edgerV2ParityTolerance(magnitude, 0), 1e-5);
    assert.equal(edgerV2ParityTolerance(0, -magnitude), 1e-5);
  }
  assert.equal(edgerV2ParityTolerance(32, 31.99), 4 * 2 ** -18);
  assert.equal(edgerV2ParityTolerance(-500, 499.99), 4 * 2 ** -15);
  assert.equal(edgerV2ParityTolerance(1024, 1024), 4 * 2 ** -13);
});

function compareSynthetic(heads) {
  const fixture = {
    id: "synthetic",
    stateId: "synthetic",
    payload: { forced_card_index: 0, forced_placement_index: 0 },
    masks: {},
    js: {},
  };
  const pytorch = { id: "synthetic" };
  for (const head of ["card", "placement", "delay"]) {
    const [jsValues, pytorchValues] = heads[head] ?? [[1, 0], [1, 0]];
    fixture.masks[head] = new Uint8Array(jsValues.length).fill(1);
    fixture.js[head] = Float32Array.from(jsValues);
    pytorch[head] = Array.from(Float32Array.from(pytorchValues));
    pytorch[`${head}_argmax`] = pytorch[head].indexOf(Math.max(...pytorch[head]));
  }
  return compareCandidateParity([fixture], [pytorch]);
}

test("parity holds the 1e-5 floor below magnitude 32", () => {
  const ulp = float32Ulp(16);
  const within = compareSynthetic({ card: [[16, 0], [16 + 5 * ulp, 0]] });
  assert.equal(within.passed, true);
  const beyond = compareSynthetic({ card: [[16, 0], [16 + 6 * ulp, 0]] });
  assert.equal(beyond.passed, false);
  assert.match(beyond.reason, /exceeded tolerance/);
  assert.equal(beyond.worst_tolerance_error.tolerance, 1e-5);
});

test("parity requires identical legal tie sets, not only the same argmax", () => {
  const ulp = float32Ulp(5);
  const parity = compareSynthetic({ placement: [[5, 5, 1], [5, 5 - ulp, 1]] });
  assert.equal(parity.argmax_agreement, true);
  assert.equal(parity.tolerance_exceedances, 0);
  assert.equal(parity.tie_set_agreement, false);
  assert.equal(parity.passed, false);
  assert.match(parity.reason, /tie-set disagreement/);
  assert.equal(compareSynthetic({ placement: [[5, 5, 1], [5, 5, 1]] }).passed, true);
});

test("parity reports fragile margins for review without failing", () => {
  const ulp = float32Ulp(1.5);
  // The PyTorch margin (2 ULP) is within twice the measured error (6 ULP).
  const fragile = compareSynthetic({ card: [[2, 2 - 8 * ulp], [2 - 6 * ulp, 2 - 8 * ulp]] });
  assert.equal(fragile.passed, true);
  assert.equal(fragile.fragile_margin_count, 1);
  assert.equal(fragile.review_required, true);
  assert.deepEqual(fragile.fragile_margins[0], {
    fixture: "synthetic", head: "card", pytorch_margin: 2 * ulp, maximum_legal_difference: 6 * ulp,
  });
  assert.deepEqual(fragile.fixtures[0].fragile_margin_heads, ["card"]);
  const robust = compareSynthetic({ card: [[2, 1], [2 - 6 * ulp, 1]] });
  assert.equal(robust.fragile_margin_count, 0);
  assert.equal(robust.review_required, false);
});

test("amplified heads are judged by the hybrid tolerance, not by magnitude", {
  timeout: 60_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-parity-scale-"));
  try {
    const model = denseWeights(createEdgerV2BootstrapModel(), 4096);
    const modelPath = path.join(root, "amplified-heads.json");
    fs.writeFileSync(modelPath, JSON.stringify(model));
    const parity = checkCandidateParity(modelPath, model);

    assert.equal(parity.argmax_agreement, true);
    assert.ok(parity.maximum_logit_difference > 1e-5);
    // The verdict depends on the host's PyTorch accumulation order (3 ULP and
    // a pass on the October 2026 M1), so only its consistency is asserted.
    assert.equal(parity.passed, parity.tolerance_exceedances === 0);
    assert.equal(parity.passed, parity.worst_tolerance_error.tolerance_ratio <= 1);
    assert.equal(Object.hasOwn(parity, "absolute_tolerance_feasible"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("large exactly matching logits pass without a magnitude-based rejection", { timeout: 60_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-exact-large-"));
  try {
    const model = createEdgerV2BootstrapModel();
    model.weights.card_head.bias[0] = 1024;
    const modelPath = path.join(root, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(model));
    const parity = checkCandidateParity(modelPath, model);
    assert.equal(parity.maximum_legal_logit_magnitude, 1024);
    assert.equal(parity.maximum_logit_difference, 0);
    assert.equal(parity.tolerance_exceedances, 0);
    assert.equal(parity.passed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parity rejects a discrepancy confined to a non-PASS card embedding", { timeout: 60_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edger-v2-play-parity-"));
  try {
    const runtime = createEdgerV2BootstrapModel();
    runtime.weights.placement_scorer.weights[0] = 1;
    // Delay input: 64 fused features, 16 spatial features, then the embedding.
    runtime.weights.delay_encoder.weights[80 * 64] = 1;
    runtime.weights.delay_head.weights[0] = 1;
    const reference = structuredClone(runtime);
    reference.weights.card_embedding[16] = 1000;
    const modelPath = path.join(root, "reference.json");
    fs.writeFileSync(modelPath, JSON.stringify(reference));
    // Inject a branch-local runtime/reference discrepancy. The old PASS-only
    // fixture bank returned passed=true and zero error for this exact pair.
    const parity = checkCandidateParity(modelPath, runtime);
    assert.equal(parity.passed, false);
    assert.ok(parity.tolerance_exceedances > 0);
    assert.equal(parity.heads.placement.maximum_logit_difference, 1000);
    assert.equal(parity.heads.delay.maximum_logit_difference, 1000);
    assert.ok(parity.fixtures.filter((fixture) => fixture.forced_card_index === 0)
      .every((fixture) => fixture.maximum_logit_difference === 0));
    assert.equal(parity.worst_absolute_error.float32_ulp, float32Ulp(1000));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
