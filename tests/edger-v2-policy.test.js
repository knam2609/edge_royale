import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { HEURISTIC_BOT_ID, enumerateLegalCardActions } from "../src/ai/botRuntime.js";
import { DEFAULT_DECK } from "../src/sim/cards.js";
import {
  EDGER_V2_BOARD_CHANNELS,
  EDGER_V2_BOARD_HEIGHT,
  EDGER_V2_BOARD_WIDTH,
  EDGER_V2_GLOBAL_FEATURES,
  buildEdgerV2LegalMasks,
  buildEdgerV2Observation,
  decodeEdgerV2Action,
  encodeEdgerV2Action,
} from "../src/ai/v2/observation.js";
import {
  computeEdgerV2Logits,
  createEdgerV2BootstrapModel,
  encodeEdgerV2PolicyState,
  selectEdgerV2PolicyDecision,
  validateEdgerV2PolicyModel,
} from "../src/ai/v2/policy.js";
import { createProductionEngine } from "../src/sim/productionMatch.js";
import { buildCandidateParityFixtures } from "../scripts/edger-v2-evaluation-core.mjs";
import { runEdgerV2CadenceMatch } from "../scripts/edger-v2-cadence-core.mjs";

test("v2 oracle observation has fixed production dimensions and relative sides", () => {
  const engine = createProductionEngine({ seed: 7101 });
  const red = buildEdgerV2Observation({ engine, actor: "red" });
  const blue = buildEdgerV2Observation({ engine, actor: "blue" });

  assert.equal(
    red.board.length,
    EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH * EDGER_V2_BOARD_CHANNELS,
  );
  assert.equal(red.global.length, EDGER_V2_GLOBAL_FEATURES);
  assert.equal(blue.board.length, red.board.length);
  assert.equal(blue.global.length, red.global.length);
  assert.ok(red.board.some((value) => value !== 0));
  assert.ok(blue.board.some((value) => value !== 0));
});

test("v2 side canonicalization rotates a symmetric state identically", () => {
  const cards = {
    blue: {
      hand: DEFAULT_DECK.slice(0, 4),
      draw_pile: DEFAULT_DECK.slice(4),
    },
    red: {
      hand: DEFAULT_DECK.slice(0, 4),
      draw_pile: DEFAULT_DECK.slice(4),
    },
  };
  const engine = createProductionEngine({
    seed: 7103,
    initialCardState: cards,
  });
  const red = buildEdgerV2Observation({ engine, actor: "red" });
  const blue = buildEdgerV2Observation({ engine, actor: "blue" });

  assert.deepEqual(red.board, blue.board);
  assert.deepEqual(red.global, blue.global);
});

test("v2 action encoding uses fixed deck, row-major placement, and bounded delay", () => {
  const encoded = encodeEdgerV2Action({
    actor: "red",
    action: {
      type: "PLAY_CARD",
      cardId: "giant",
      x: 3.5,
      y: 4.5,
    },
    delayTicks: 240,
  });
  assert.deepEqual(encoded, {
    card_index: 1,
    placement_index: 4 * 18 + 3,
    delay_index: 199,
  });
  assert.deepEqual(decodeEdgerV2Action({
    actor: "red",
    cardIndex: encoded.card_index,
    placementIndex: encoded.placement_index,
    delayIndex: encoded.delay_index,
  }), {
    action: {
      type: "PLAY_CARD",
      cardId: "giant",
      x: 3.5,
      y: 4.5,
    },
    delayTicks: 200,
  });
});

test("v2 bootstrap inference respects masks and is deterministic", () => {
  const engine = createProductionEngine({ seed: 7102 });
  const legalActions = enumerateLegalCardActions({ engine, actor: "red" });
  const observation = buildEdgerV2Observation({ engine, actor: "red" });
  const masks = buildEdgerV2LegalMasks({
    actor: "red",
    legalActions,
    selectedCardIndex: 0,
  });
  const model = validateEdgerV2PolicyModel(createEdgerV2BootstrapModel());
  const first = computeEdgerV2Logits({
    model,
    observation,
    legalMasks: masks,
    forcedCardIndex: 0,
    forcedPlacementIndex: 0,
  });
  const second = computeEdgerV2Logits({
    model,
    observation,
    legalMasks: masks,
    forcedCardIndex: 0,
    forcedPlacementIndex: 0,
  });
  assert.deepEqual(first.selected, second.selected);
  assert.equal(first.selected.card_index, 0);
  assert.equal(first.selected.delay_index, 199);

  const decision = selectEdgerV2PolicyDecision({
    model,
    engine,
    actor: "red",
    legalActions,
  });
  assert.deepEqual(decision.action, { type: "PASS" });
  assert.equal(decision.delayTicks, 200);
});

function seededModel() {
  const model = createEdgerV2BootstrapModel();
  let seed = 1729;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const layer of Object.values(model.weights)) {
    const arrays = Array.isArray(layer) ? [layer] : [layer.weights, layer.bias];
    for (const values of arrays) {
      values.forEach((_, index) => { values[index] = (random() - 0.5) * 0.25; });
    }
  }
  return { model, random };
}

test("mean pool accumulates in float64 and rounds once to float32", () => {
  const cells = EDGER_V2_BOARD_HEIGHT * EDGER_V2_BOARD_WIDTH;
  const channels = 16;
  // Identity convolutions and fusion expose the pooled mean as fused[0..15].
  const model = createEdgerV2BootstrapModel();
  for (const name of ["conv1", "conv2", "conv3"]) {
    const layer = model.weights[name];
    const center = Math.floor(layer.kernel_size / 2);
    for (let channel = 0; channel < channels; channel += 1) {
      layer.weights[
        (((channel * layer.input_channels + channel) * layer.kernel_size + center) *
          layer.kernel_size) +
        center
      ] = 1;
    }
  }
  for (let channel = 0; channel < channels; channel += 1) {
    model.weights.fusion.weights[channel * model.weights.fusion.output_dim + channel] = 1;
  }
  const board = new Float32Array(cells * EDGER_V2_BOARD_CHANNELS);
  for (let cell = 0; cell < cells; cell += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      board[cell * EDGER_V2_BOARD_CHANNELS + channel] =
        1 + ((cell * (channel + 3)) % 997) / 997;
    }
  }
  const { fused } = encodeEdgerV2PolicyState({
    model,
    observation: { board, global: new Float32Array(EDGER_V2_GLOBAL_FEATURES) },
  });

  const expected = [];
  const float32RunningSum = [];
  for (let channel = 0; channel < channels; channel += 1) {
    let sum64 = 0;
    let sum32 = 0;
    for (let cell = 0; cell < cells; cell += 1) {
      const value = board[cell * EDGER_V2_BOARD_CHANNELS + channel];
      sum64 += value;
      sum32 = Math.fround(sum32 + value);
    }
    expected.push(Math.fround(sum64 / cells));
    float32RunningSum.push(Math.fround(sum32 / cells));
  }
  assert.deepEqual(Array.from(fused.slice(0, channels)), expected);
  // The input must distinguish the previous float32 running sum.
  assert.notDeepEqual(float32RunningSum, expected);
});

test("sparse-input convolution preserves the original dense-runtime golden logits", () => {
  const { model, random } = seededModel();
  const observation = {
    board: Float32Array.from({ length: 32 * 18 * 24 }, (_, index) => index % 7 === 0 ? random() : 0),
    global: Float32Array.from({ length: 96 }, random),
  };
  const logits = computeEdgerV2Logits({
    model, observation,
    legalMasks: {
      card: new Uint8Array(9).fill(1),
      placement: new Uint8Array(576).fill(1),
      delay: new Uint8Array(200).fill(1),
    },
    forcedCardIndex: 3,
    forcedPlacementIndex: 77,
  });
  const hash = createHash("sha256");
  for (const head of ["card", "placement", "delay"]) {
    hash.update(Buffer.from(logits[head].buffer));
  }
  // The pre-optimization implementation at 0270d828 gave a397521e…; the
  // float64 mean pool (October 25, 2026) changes the pooled features only.
  assert.equal(hash.digest("hex"), "87c3a171e936d403765144e6c03a22dc295a21211ca8722b6a5804cca5378a26");
});

test("float64 mean pool keeps a seeded model's bank and full-match decisions", () => {
  const { model } = seededModel();
  const bank = buildCandidateParityFixtures(model).map((fixture) => [
    fixture.id,
    fixture.js.selected.card_index,
    fixture.js.selected.placement_index,
    fixture.js.selected.delay_index,
  ]);
  assert.equal(bank.length, 70);
  assert.equal(new Set(bank.map(([, cardIndex]) => cardIndex)).size, 9);
  const match = runEdgerV2CadenceMatch({
    seed: 20261025,
    candidateActor: "red",
    model,
    cadence: "learned",
    opponentBotId: HEURISTIC_BOT_ID,
    recordRows: true,
  });
  const stream = match.rows.map((row) =>
    [row.tick, row.card_index, row.placement_index, row.delay_index]);
  assert.equal(match.stats.successful_deployments, 4);
  // Captured from the float32 running-sum pool at a3e01e5.
  assert.equal(
    createHash("sha256").update(JSON.stringify(bank)).digest("hex"),
    "60ce4d380bf3434a9d2b1150871db49d959a9a18b2eb14b6f022a1cb263ded2a",
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(stream)).digest("hex"),
    "f4bfcd47aa75dbe1516b856cb40a8d89b90d9c41eb310899de08481c9ef1ad84",
  );
  assert.equal(match.action_stream_hash, "2b93446af1f44d526f782a14f68c807389e1bd09bc32b8e9601b9d530bac13c8");
  assert.equal(match.final_state_hash, "903d268a");
});
